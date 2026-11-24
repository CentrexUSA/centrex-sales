'use strict';
// Data access: a Google Sheets store and an in-memory mock store with the
// same async interface. Only the five tabs named in lib/schema.js are touched.

const crypto = require('crypto');
const S = require('./schema');
const { parseServiceAccount, createGoogleClient } = require('./google');

const DEFAULT_SHEET_ID = '1PBuH6NeSZAhke2_B_59c8iQTFsg4wKR36c11lhAAWmM';
const CACHE_TTL_MS = 15000;
const MOCK_SESSION_KEY = crypto.createHash('sha256').update('cx-session:mock-development-key').digest();

class StoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StoreError';
    this.code = code; // 'not_found' | 'conflict'
  }
}

// ---------------------------------------------------------------- config

let configMemo = { key: null, value: null };

// Returns {mock: true, sessionKey} | {mock: false, credentials, sheetId, sessionKey} | null.
function getConfig() {
  const env = process.env;
  const memoKey = `${env.MOCK}|${env.VERCEL}|${env.VERCEL_ENV}|${env.SHEET_ID}|${env.GOOGLE_SERVICE_ACCOUNT_JSON}`;
  if (configMemo.key === memoKey) return configMemo.value;
  let value = null;
  if (env.MOCK === '1') {
    // The mock store has public access codes and a public session key; never
    // run it on Vercel at all (production or preview), only locally.
    value = (env.VERCEL || env.VERCEL_ENV) ? null : { mock: true, sessionKey: MOCK_SESSION_KEY };
  } else {
    const credentials = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (credentials) {
      value = {
        mock: false,
        credentials,
        sheetId: (env.SHEET_ID || '').trim() || DEFAULT_SHEET_ID,
        sessionKey: crypto.createHash('sha256').update('cx-session:' + credentials.privateKey).digest(),
      };
    }
  }
  configMemo = { key: memoKey, value };
  return value;
}

// ---------------------------------------------------------------- helpers

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function sameId(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase() && !!String(a || '').trim();
}

function pickKeys(tabKey, obj) {
  const o = {};
  for (const k of S.TABS[tabKey].keys) o[k] = obj[k] == null ? '' : String(obj[k]);
  return o;
}

const LEAD_UPDATABLE = new Set(S.TABS.projects.keys.filter((k) => k !== 'id'));
const CONTACT_UPDATABLE = new Set(['name', 'title', 'company', 'email', 'phone', 'verifiedAt', 'notes']);

function checkKeys(fields, allowed) {
  for (const k of Object.keys(fields)) {
    if (!allowed.has(k)) throw new Error('Field not updatable');
  }
}

// What Sheets keeps after a USER_ENTERED write of encodeCell(): the leading
// apostrophe is consumed. Used by the mock store so both behave alike.
function roundTrip(key, value) {
  const enc = S.encodeCell(key, value);
  return enc.startsWith("'") ? enc.slice(1) : enc;
}

function isBlankRow(o) {
  return Object.values(o).every((v) => v === '');
}

// ---------------------------------------------------------------- Sheets store

function createSheetsStore({ client, now, ttlMs }) {
  const clock = now || Date.now;
  const ttl = ttlMs == null ? CACHE_TTL_MS : ttlMs;
  const cache = new Map(); // key -> {at, promise}

  function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && clock() - hit.at < ttl) return hit.promise.then(clone);
    const promise = loader();
    const entry = { at: clock(), promise };
    cache.set(key, entry);
    promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return promise.then(clone);
  }
  function invalidate(key) { cache.delete(key); }

  const P = S.TABS.projects.name;
  const projLast = S.lastCol('projects');
  const idCol = S.colOf('projects', 'id');
  const projCol = S.colOf('projects', 'project');

  async function readProjectsFresh() {
    const rows = (await client.valuesGet(S.a1(P, 'A', 2, projLast))).map((r) => S.rowToObject('projects', r));
    const plan = S.planLeadIds(rows);
    if (plan.length) {
      // Re-read Project name and Lead ID columns right before writing, and only
      // write rows that still have the same project and a blank ID.
      const [names, ids] = await client.valuesBatchGet([
        S.a1(P, projCol, 2, projCol),
        S.a1(P, idCol, 2, idCol),
      ]);
      const data = [];
      for (const { index, id } of plan) {
        const freshName = String((names[index] || [])[0] || '').trim();
        const freshId = String((ids[index] || [])[0] || '').trim();
        if (freshName === rows[index].project && freshId === '') {
          data.push({ range: S.a1(P, idCol, index + 2), values: [[S.encodeCell('id', id)]] });
          rows[index].id = id;
        }
      }
      if (data.length) await client.valuesBatchUpdate(data);
    }
    return rows;
  }

  function leadsFromRows(rows) {
    return rows.filter((r) => r.project && r.id);
  }

  async function findRowById(tabName, col, id) {
    const values = await client.valuesGet(S.a1(tabName, col, 2, col));
    const matches = [];
    values.forEach((r, i) => { if (sameId((r || [])[0], id)) matches.push(i + 2); });
    if (matches.length === 0) throw new StoreError('not_found');
    if (matches.length > 1) throw new StoreError('conflict', 'Duplicate ID in sheet');
    return matches[0];
  }

  async function readTab(tabKey) {
    const tab = S.TABS[tabKey];
    const rows = await client.valuesGet(S.a1(tab.name, 'A', 2, S.lastCol(tabKey)));
    return rows.map((r) => S.rowToObject(tabKey, r)).filter((o) => !isBlankRow(o));
  }

  async function writeCells(tabKey, rowNum, fields) {
    const tab = S.TABS[tabKey];
    const data = Object.keys(fields).map((k) => ({
      range: S.a1(tab.name, S.colOf(tabKey, k), rowNum),
      values: [[S.encodeCell(k, fields[k])]],
    }));
    if (data.length) await client.valuesBatchUpdate(data);
  }

  async function readRow(tabKey, rowNum) {
    const tab = S.TABS[tabKey];
    const rows = await client.valuesGet(S.a1(tab.name, 'A', rowNum, S.lastCol(tabKey), rowNum));
    return S.rowToObject(tabKey, rows[0] || []);
  }

  return {
    kind: 'sheets',

    async listUsers() {
      return cached('users', () => readTab('users'));
    },

    async listLeads(opts) {
      if (opts && opts.fresh) {
        invalidate('projects');
      }
      const rows = await cached('projects', readProjectsFresh);
      return leadsFromRows(rows);
    },

    async appendLead(lead) {
      invalidate('projects');
      const rows = await readProjectsFresh();
      const id = S.nextId('L', S.LEAD_ID_RE, rows.map((r) => r.id));
      const full = pickKeys('projects', { ...lead, id });
      await client.valuesAppend(S.a1(P, 'A', null, projLast), [S.objectToRow('projects', full)]);
      invalidate('projects');
      return full;
    },

    async updateLead(id, fields) {
      checkKeys(fields, LEAD_UPDATABLE);
      const rowNum = await findRowById(P, idCol, id);
      await writeCells('projects', rowNum, fields);
      invalidate('projects');
      const row = await readRow('projects', rowNum);
      if (!sameId(row.id, id)) throw new StoreError('conflict', 'Row moved during update');
      return row;
    },

    async listContacts(leadId, opts) {
      if (opts && opts.fresh) invalidate('contacts');
      const rows = await cached('contacts', () => readTab('contacts'));
      return leadId === undefined ? rows : rows.filter((c) => sameId(c.leadId, leadId));
    },

    async appendContact(c) {
      const C = S.TABS.contacts.name;
      const ids = await client.valuesGet(S.a1(C, 'A', 2, 'A'));
      const id = S.nextId('C', S.CONTACT_ID_RE, ids.map((r) => (r || [])[0]));
      const full = pickKeys('contacts', { ...c, id });
      await client.valuesAppend(S.a1(C, 'A', null, S.lastCol('contacts')), [S.objectToRow('contacts', full)]);
      invalidate('contacts');
      return full;
    },

    async updateContact(id, fields) {
      checkKeys(fields, CONTACT_UPDATABLE);
      const C = S.TABS.contacts.name;
      const rowNum = await findRowById(C, 'A', id);
      await writeCells('contacts', rowNum, fields);
      invalidate('contacts');
      const row = await readRow('contacts', rowNum);
      if (!sameId(row.id, id)) throw new StoreError('conflict', 'Row moved during update');
      return row;
    },

    async listActivity(leadId) {
      const rows = await cached('activity', () => readTab('activity'));
      return rows.filter((a) => sameId(a.leadId, leadId));
    },

    async appendActivity(a) {
      const A = S.TABS.activity.name;
      const full = pickKeys('activity', a);
      await client.valuesAppend(S.a1(A, 'A', null, S.lastCol('activity')), [S.objectToRow('activity', full)]);
      invalidate('activity');
      return full;
    },

    async listOpenBids() {
      return cached('openBids', () => readTab('openBids'));
    },
  };
}

// ---------------------------------------------------------------- mock store

function createMockStore(seed) {
  const data = clone(seed || require('../dev/mock-data').createSeed());
  const norm = (tabKey, obj) => {
    const o = pickKeys(tabKey, obj);
    for (const k of Object.keys(o)) o[k] = roundTrip(k, o[k]).trim();
    return o;
  };
  data.leads = data.leads.map((r) => norm('projects', r));
  data.contacts = data.contacts.map((r) => norm('contacts', r));
  data.activity = data.activity.map((r) => norm('activity', r));
  data.users = data.users.map((r) => pickKeys('users', r));
  data.openBids = data.openBids.map((r) => pickKeys('openBids', r));

  function assignIds() {
    for (const { index, id } of S.planLeadIds(data.leads)) data.leads[index].id = id;
  }

  return {
    kind: 'mock',
    _data: data, // test hook only

    async listUsers() { return clone(data.users); },

    async listLeads() {
      assignIds();
      return clone(data.leads.filter((r) => r.project && r.id));
    },

    async appendLead(lead) {
      assignIds();
      const id = S.nextId('L', S.LEAD_ID_RE, data.leads.map((r) => r.id));
      const full = norm('projects', { ...lead, id });
      data.leads.push(full);
      return clone(full);
    },

    async updateLead(id, fields) {
      checkKeys(fields, LEAD_UPDATABLE);
      const matches = data.leads.filter((r) => sameId(r.id, id));
      if (matches.length !== 1) throw new StoreError(matches.length ? 'conflict' : 'not_found');
      for (const k of Object.keys(fields)) matches[0][k] = roundTrip(k, fields[k]).trim();
      return clone(matches[0]);
    },

    async listContacts(leadId) {
      const rows = leadId === undefined ? data.contacts : data.contacts.filter((c) => sameId(c.leadId, leadId));
      return clone(rows);
    },

    async appendContact(c) {
      const id = S.nextId('C', S.CONTACT_ID_RE, data.contacts.map((r) => r.id));
      const full = norm('contacts', { ...c, id });
      data.contacts.push(full);
      return clone(full);
    },

    async updateContact(id, fields) {
      checkKeys(fields, CONTACT_UPDATABLE);
      const matches = data.contacts.filter((r) => sameId(r.id, id));
      if (matches.length !== 1) throw new StoreError(matches.length ? 'conflict' : 'not_found');
      for (const k of Object.keys(fields)) matches[0][k] = roundTrip(k, fields[k]).trim();
      return clone(matches[0]);
    },

    async listActivity(leadId) {
      return clone(data.activity.filter((a) => sameId(a.leadId, leadId)));
    },

    async appendActivity(a) {
      const full = norm('activity', a);
      data.activity.push(full);
      return clone(full);
    },

    async listOpenBids() { return clone(data.openBids); },
  };
}

// ---------------------------------------------------------------- getStore

let mockStore = null;
let sheetsStore = { key: null, store: null };

function getStore() {
  const cfg = getConfig();
  if (!cfg) return null;
  if (cfg.mock) {
    if (!mockStore) mockStore = createMockStore();
    return mockStore;
  }
  const key = `${cfg.sheetId}|${cfg.credentials.clientEmail}`;
  if (sheetsStore.key !== key) {
    const client = createGoogleClient({ credentials: cfg.credentials, sheetId: cfg.sheetId });
    sheetsStore = { key, store: createSheetsStore({ client }) };
  }
  return sheetsStore.store;
}

function resetMockStore() {
  mockStore = null;
}

module.exports = {
  DEFAULT_SHEET_ID, CACHE_TTL_MS, StoreError,
  getConfig, getStore, createSheetsStore, createMockStore, resetMockStore,
};
