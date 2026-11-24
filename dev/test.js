'use strict';
// API and unit tests. Node built-ins only.   node dev/test.js

process.env.MOCK = '1';
delete process.env.VERCEL_ENV;
delete process.env.VERCEL;

const assert = require('assert/strict');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const S = require('../lib/schema');
const G = require('../lib/google');
const store = require('../lib/store');
const auth = require('../lib/auth');
const { describeChanges } = require('../lib/leads');
const { createServer } = require('./server');
const { USERS, chicagoToday, addDays } = require('./mock-data');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ====================================================================== unit: schema

test('schema: column letters and A1 ranges', () => {
  assert.equal(S.colLetter(0), 'A');
  assert.equal(S.colLetter(22), 'W');
  assert.equal(S.colLetter(26), 'AA');
  assert.equal(S.lastCol('projects'), 'W');
  assert.equal(S.lastCol('contacts'), 'K');
  assert.equal(S.lastCol('activity'), 'H');
  assert.equal(S.lastCol('users'), 'E');
  assert.equal(S.lastCol('openBids'), 'G');
  assert.equal(S.colOf('projects', 'id'), 'W');
  assert.equal(S.colOf('projects', 'nextOwner'), 'R');
  assert.equal(S.colOf('projects', 'nextDate'), 'S');
  assert.equal(S.a1('Open bids', 'A', 2, 'G'), "'Open bids'!A2:G");
  assert.equal(S.a1('Projects', 'A', 2, 'W'), 'Projects!A2:W');
  assert.equal(S.a1('Projects', 'W', 5), 'Projects!W5');
  assert.equal(S.a1('Projects', 'A', null, 'W'), 'Projects!A:W');
  assert.equal(S.a1('Contacts', 'A', 7, 'K', 7), 'Contacts!A7:K7');
  assert.throws(() => S.a1('Budget', 'A', 1, 'B'));
  assert.throws(() => S.quoteTab('Projects2'));
});

test('schema: text and date write encoding', () => {
  assert.equal(S.encodeCell('notes', 'hello'), "'hello");
  assert.equal(S.encodeCell('notes', '=SUM(A1)'), "'=SUM(A1)");
  assert.equal(S.encodeCell('value', '1200'), "'1200");
  assert.equal(S.encodeCell('phone', '+1 580 555 0144'), "'+1 580 555 0144");
  assert.equal(S.encodeCell('lastChecked', '2026-11-01'), "'2026-11-01"); // not a date field
  assert.equal(S.encodeCell('when', '2026-11-01 09:00'), "'2026-11-01 09:00");
  assert.equal(S.encodeCell('notes', "'quoted"), "''quoted");
  assert.equal(S.encodeCell('notes', ''), '');
  assert.equal(S.encodeCell('nextDate', ''), '');
  assert.equal(S.encodeCell('nextDate', '2026-12-02'), '2026-12-02');
  assert.equal(S.encodeCell('firstSeen', '2026-01-31'), '2026-01-31');
  assert.equal(S.encodeCell('addedOn', '2028-02-29'), '2028-02-29');
  assert.throws(() => S.encodeCell('nextDate', '12/02/2026'));
  assert.throws(() => S.encodeCell('nextDate', '2026-02-30'));
  assert.throws(() => S.encodeCell('nextDate', '=TODAY()'));
});

test('schema: row <-> object mapping for every tab', () => {
  for (const tabKey of Object.keys(S.TABS)) {
    const keys = S.TABS[tabKey].keys;
    const obj = {};
    keys.forEach((k, i) => { obj[k] = S.DATE_KEYS.has(k) ? `2026-01-${String(i + 1).padStart(2, '0')}` : `v${i}`; });
    const row = S.objectToRow(tabKey, obj);
    assert.equal(row.length, keys.length, tabKey);
    keys.forEach((k, i) => {
      assert.equal(row[i], S.DATE_KEYS.has(k) ? obj[k] : `'${obj[k]}`, `${tabKey}.${k}`);
    });
    // Short rows from the API (trailing blanks omitted) pad to ''.
    const back = S.rowToObject(tabKey, [' a ', 'b']);
    assert.equal(Object.keys(back).length, keys.length);
    assert.equal(back[keys[0]], 'a');
    assert.equal(back[keys[1]], 'b');
    assert.equal(back[keys[keys.length - 1]], '');
  }
  const lead = S.rowToObject('projects', ['A', 'New', 'Proj', ...Array(19).fill(''), 'L-0004']);
  assert.equal(lead.fit, 'A');
  assert.equal(lead.project, 'Proj');
  assert.equal(lead.id, 'L-0004');
  const user = S.rowToObject('users', ['Name', 'e@x.com', 'Sales', 'code12345', 'Yes']);
  assert.deepEqual(user, { name: 'Name', email: 'e@x.com', role: 'Sales', code: 'code12345', active: 'Yes' });
  const bid = S.rowToObject('openBids', ['T', 'N', 'B1', '2026-12-01', 'C', 'https://x', 'R']);
  assert.equal(bid.relatedProject, 'R');
  const act = S.rowToObject('activity', ['2026-11-01 09:00', 'L-0001', 'P', 'By', 'Call', 'n', 's', '2026-11-02']);
  assert.equal(act.nextDate, '2026-11-02');
  const con = S.rowToObject('contacts', ['C-0001', 'L-0001', 'N', 'T', 'Co', 'e', 'p', 'v', 'n', 'by', '2026-11-01']);
  assert.equal(con.addedOn, '2026-11-01');
});

test('schema: lead ID planning and next IDs', () => {
  const rows = [
    { project: 'a', id: 'L-0002' },
    { project: 'b', id: '' },
    { project: '', id: '' },
    { project: 'c', id: 'L-0009' },
    { project: 'd', id: '' },
  ];
  assert.deepEqual(S.planLeadIds(rows), [{ index: 1, id: 'L-0010' }, { index: 4, id: 'L-0011' }]);
  assert.deepEqual(S.planLeadIds([{ project: 'x', id: '' }]), [{ index: 0, id: 'L-0001' }]);
  assert.equal(S.nextId('C', S.CONTACT_ID_RE, ['C-0001', 'junk', '', 'C-0010']), 'C-0011');
  assert.equal(S.nextId('L', S.LEAD_ID_RE, ['L-9999']), 'L-10000');
});

// ====================================================================== unit: google

const { privateKey: TEST_PRIVATE_PEM, publicKey: TEST_PUBLIC_KEY } = (() => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: kp.publicKey };
})();
const TEST_CREDS = { clientEmail: 'svc@test-project.iam.gserviceaccount.com', privateKey: TEST_PRIVATE_PEM };

test('google: parse service account JSON', () => {
  assert.equal(G.parseServiceAccount(undefined), null);
  assert.equal(G.parseServiceAccount(''), null);
  assert.equal(G.parseServiceAccount('{not json'), null);
  assert.equal(G.parseServiceAccount('{"client_email":"a@b"}'), null);
  assert.equal(G.parseServiceAccount(JSON.stringify({ client_email: 'a@b', private_key: '-----BEGIN PRIVATE KEY-----\nbad\n-----END PRIVATE KEY-----' })), null);
  const ok = G.parseServiceAccount(JSON.stringify({ client_email: TEST_CREDS.clientEmail, private_key: TEST_PRIVATE_PEM }));
  assert.equal(ok.clientEmail, TEST_CREDS.clientEmail);
  // Escaped newlines (key pasted as a single line) are accepted.
  const escaped = JSON.stringify({ client_email: 'a@b', private_key: TEST_PRIVATE_PEM.replace(/\n/g, '\\n') });
  assert.ok(G.parseServiceAccount(escaped));
});

function verifyJwt(jwt) {
  const [h, c, sig] = jwt.split('.');
  const okSig = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), TEST_PUBLIC_KEY, Buffer.from(sig, 'base64url'));
  return { okSig, header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

test('google: JWT is RS256, signed by the key, with the right claims', () => {
  const jwt = G.buildJwt(TEST_CREDS, 1_800_000_000);
  const { okSig, header, claims } = verifyJwt(jwt);
  assert.ok(okSig);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.iss, TEST_CREDS.clientEmail);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, 1_800_000_000);
  assert.equal(claims.exp, 1_800_003_600);
  // Tampered payload fails verification.
  const parts = jwt.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, iss: 'evil@x' })).toString('base64url');
  assert.equal(verifyJwt(`${parts[0]}.${forged}.${parts[2]}`).okSig, false);
});

test('google: range guard rejects other tabs', () => {
  G.assertRange('Projects!A2:W');
  G.assertRange("'Open bids'!A2:G");
  assert.throws(() => G.assertRange('Payroll!A1:Z'));
  assert.throws(() => G.assertRange("'Open bids 2'!A1"));
  assert.throws(() => G.assertRange('A1:B2'));
});

// ---------------------------------------------------------------- fake Google backend

const SHEET_ID = 'sheet-123';

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseRange(r) {
  const m = /^(?:'((?:[^']|'')+)'|([A-Za-z0-9_]+))!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(r);
  if (!m) throw new Error('bad range ' + r);
  const tab = m[1] != null ? m[1].replace(/''/g, "'") : m[2];
  const c1 = colIndex(m[3]);
  const r1 = m[4] ? Number(m[4]) : 1;
  const c2 = m[5] ? colIndex(m[5]) : c1;
  const r2 = m[5] ? (m[6] ? Number(m[6]) : Infinity) : r1;
  return { tab, c1, r1, c2, r2 };
}

function createFakeGoogle(tabs, { now } = {}) {
  const calls = [];
  const writes = []; // {range, values} as sent (raw, before USER_ENTERED parsing)
  let tokenCalls = 0;
  let tokenCounter = 0;
  let validToken = null;

  function grid(tab) {
    if (!tabs[tab]) throw new Error('fake: no tab ' + tab);
    return tabs[tab];
  }
  function read(range) {
    const { tab, c1, r1, c2, r2 } = parseRange(range);
    const g = grid(tab);
    const out = [];
    for (let r = r1; r <= Math.min(r2, g.length); r++) {
      const row = (g[r - 1] || []).slice(c1, c2 + 1).map((v) => (v == null ? '' : String(v)));
      while (row.length && row[row.length - 1] === '') row.pop();
      out.push(row);
    }
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  }
  function userEntered(v) {
    const s = String(v);
    return s.startsWith("'") ? s.slice(1) : s;
  }
  function write(range, values) {
    writes.push({ range, values });
    const { tab, c1, r1 } = parseRange(range);
    const g = grid(tab);
    values.forEach((row, i) => {
      const rr = r1 - 1 + i;
      while (g.length <= rr) g.push([]);
      row.forEach((v, j) => { g[rr][c1 + j] = userEntered(v); });
    });
  }
  function append(range, values) {
    const { tab, c1, c2 } = parseRange(range);
    const g = grid(tab);
    let last = 0;
    g.forEach((row, i) => { if (row.slice(c1, c2 + 1).some((v) => v != null && v !== '')) last = i + 1; });
    const start = last + 1;
    const q = tabs[tab] === g ? tab : tab;
    write(`${/^[A-Za-z0-9_]+$/.test(q) ? q : `'${q}'`}!${S.colLetter(c1)}${start}`, values);
    return start;
  }
  const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

  async function fetch(url, init = {}) {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenCalls++;
      const p = new URLSearchParams(init.body);
      assert.equal(p.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const { okSig, claims } = verifyJwt(p.get('assertion'));
      if (!okSig || claims.aud !== 'https://oauth2.googleapis.com/token') return json(400, { error: 'invalid_grant' });
      validToken = `tok-${++tokenCounter}`;
      return json(200, { access_token: validToken, expires_in: 3600, token_type: 'Bearer' });
    }
    const u = new URL(url);
    const prefix = `/v4/spreadsheets/${SHEET_ID}/`;
    if (u.origin !== 'https://sheets.googleapis.com' || !u.pathname.startsWith(prefix)) throw new Error('fake: unexpected URL ' + url);
    if ((init.headers || {}).Authorization !== `Bearer ${validToken}`) return json(401, { error: 'unauthenticated' });
    const rest = u.pathname.slice(prefix.length);
    if (rest === 'values:batchGet') {
      assert.equal(u.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
      return json(200, { valueRanges: u.searchParams.getAll('ranges').map((r) => ({ range: r, values: read(r) })) });
    }
    if (rest === 'values:batchUpdate') {
      const b = JSON.parse(init.body);
      assert.equal(b.valueInputOption, 'USER_ENTERED');
      for (const d of b.data) write(d.range, d.values);
      return json(200, { totalUpdatedCells: b.data.length });
    }
    const m = /^values\/([^:]+)(:append)?$/.exec(rest);
    if (!m) throw new Error('fake: unexpected path ' + rest);
    const range = decodeURIComponent(m[1]);
    if (m[2]) {
      assert.equal(init.method, 'POST');
      assert.equal(u.searchParams.get('valueInputOption'), 'USER_ENTERED');
      assert.equal(u.searchParams.get('insertDataOption'), 'INSERT_ROWS');
      const b = JSON.parse(init.body);
      const row = append(range, b.values);
      return json(200, { updates: { updatedRange: `${range}${row}` } });
    }
    if (init.method === 'PUT') {
      assert.equal(u.searchParams.get('valueInputOption'), 'USER_ENTERED');
      write(range, JSON.parse(init.body).values);
      return json(200, {});
    }
    assert.equal(u.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    return json(200, { range, values: read(range) });
  }

  return {
    fetch, calls, writes, tabs,
    get tokenCalls() { return tokenCalls; },
    expireToken() { validToken = 'expired'; },
  };
}

const PROJ_HEADER = S.TABS.projects.keys.slice();

function projRow(o) {
  return S.TABS.projects.keys.map((k) => o[k] || '');
}

function makeTabs() {
  return {
    Projects: [
      PROJ_HEADER,
      projRow({ status: 'New', project: 'Alpha hotel', nextOwner: 'Sam Ortiz', id: 'L-0001' }),
      projRow({ status: 'Watch', project: 'Bravo clinic', id: 'L-0002' }),
      projRow({ status: 'New', project: 'Scan find', firstSeen: '2026-11-20' }), // no ID
      projRow({ notes: 'stray' }), // no project: ignored
      projRow({ status: 'New', project: 'Charlie campus', id: 'L-0007' }),
    ],
    Contacts: [S.TABS.contacts.keys, ['C-0001', 'L-0001', 'Pat', '', '', 'pat@example.com']],
    Activity: [S.TABS.activity.keys, ['2026-11-01 09:00', 'L-0001', 'Alpha hotel', 'Sam Ortiz', 'Call', 'Hi']],
    Users: [S.TABS.users.keys, ['Sam Ortiz', 'sam@example.com', 'Sales', 'sales-code-1', 'Yes']],
    'Open bids': [S.TABS.openBids.keys, ['Bid one', 'Nation', 'B-1', '2026-12-01', '', 'https://x.test', '']],
    Payroll: [['secret'], ['do not touch']],
  };
}

function sheetsStoreWithFake(opts = {}) {
  let t = opts.start || 1_800_000_000_000;
  const fake = createFakeGoogle(makeTabs());
  const client = G.createGoogleClient({ credentials: TEST_CREDS, sheetId: SHEET_ID, fetch: fake.fetch, now: () => t });
  const st = store.createSheetsStore({ client, now: () => t });
  return { fake, client, st, advance: (ms) => { t += ms; } };
}

function assertOnlyAllowedTabs(fake) {
  for (const c of fake.calls) {
    if (c.url.startsWith('https://oauth2')) continue;
    const u = new URL(c.url);
    const ranges = [];
    const m = /\/values\/([^:]+)/.exec(u.pathname);
    if (m) ranges.push(decodeURIComponent(m[1]));
    ranges.push(...u.searchParams.getAll('ranges'));
    if (c.body && c.body.startsWith('{')) {
      const b = JSON.parse(c.body);
      if (b.range) ranges.push(b.range);
      if (b.data) ranges.push(...b.data.map((d) => d.range));
    }
    for (const r of ranges) assert.ok(S.ALLOWED_TAB_NAMES.has(parseRange(r).tab), `touched ${r}`);
  }
  assert.deepEqual(fake.tabs.Payroll, [['secret'], ['do not touch']]);
}

test('google client: token fetched once, cached, refreshed near expiry and after 401', async () => {
  const { fake, client, advance } = sheetsStoreWithFake();
  await client.valuesGet('Projects!A2:W');
  await client.valuesGet('Users!A2:E');
  assert.equal(fake.tokenCalls, 1);
  advance(56 * 60 * 1000); // inside the refresh margin of a 60-minute token
  await client.valuesGet('Users!A2:E');
  assert.equal(fake.tokenCalls, 2);
  fake.expireToken();
  await client.valuesGet('Users!A2:E'); // 401 -> new token -> retry
  assert.equal(fake.tokenCalls, 3);
});

test('google client: request URLs and options', async () => {
  const { fake, client } = sheetsStoreWithFake();
  await client.valuesGet("'Open bids'!A2:G");
  const get = fake.calls.find((c) => c.url.includes('/values/'));
  assert.ok(get.url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/'Open%20bids'!A2%3AG?`), get.url);
  assert.ok(get.url.includes('valueRenderOption=FORMATTED_VALUE'));
  await client.valuesAppend('Activity!A:H', [["'x"]]);
  const app = fake.calls[fake.calls.length - 1];
  assert.ok(app.url.includes('/values/Activity!A%3AH:append?'));
  assert.ok(app.url.includes('insertDataOption=INSERT_ROWS'));
  assert.ok(app.url.includes('valueInputOption=USER_ENTERED'));
  await assert.rejects(client.valuesGet('Payroll!A1:B'));
  assert.ok(!fake.calls.some((c) => c.url.includes('Payroll')));
});

test('google client: errors carry only the status, never the response body', async () => {
  const fetch = async (url) => (url.includes('oauth2')
    ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }
    : { ok: false, status: 403, json: async () => ({ error: { message: 'SECRET-CELL-CONTENT' } }), text: async () => 'SECRET-CELL-CONTENT' });
  const client = G.createGoogleClient({ credentials: TEST_CREDS, sheetId: SHEET_ID, fetch });
  const err = await client.valuesGet('Projects!A2:W').catch((e) => e);
  assert.equal(err.name, 'GoogleError');
  assert.equal(err.status, 403);
  assert.ok(!String(err.message).includes('SECRET'));
  assert.ok(!String(err.message).includes('PRIVATE KEY'));
  const badToken = G.createGoogleClient({ credentials: TEST_CREDS, sheetId: SHEET_ID,
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', detail: 'SECRET' }) }) });
  const err2 = await badToken.valuesGet('Projects!A2:W').catch((e) => e);
  assert.equal(err2.kind, 'token');
  assert.ok(!String(err2.message).includes('SECRET'));
});

// ---------------------------------------------------------------- Sheets store

test('sheets store: listLeads assigns IDs to scan rows and writes only column W', async () => {
  const { fake, st } = sheetsStoreWithFake();
  const leads = await st.listLeads();
  assert.deepEqual(leads.map((l) => l.id), ['L-0001', 'L-0002', 'L-0008', 'L-0007']);
  assert.equal(leads[2].project, 'Scan find');
  assert.ok(!leads.some((l) => l.notes === 'stray'));
  assert.deepEqual(fake.writes, [{ range: 'Projects!W4', values: [["'L-0008"]] }]);
  assert.equal(fake.tabs.Projects[3][22], 'L-0008');
  assertOnlyAllowedTabs(fake);
});

test('sheets store: ID assignment skips a row that changed before the write', async () => {
  const fake = createFakeGoogle(makeTabs());
  const realFetch = fake.fetch;
  let first = true;
  const fetch = async (url, init) => {
    // After the first full read, someone fills the scan row's ID by hand.
    const res = await realFetch(url, init);
    if (first && url.includes('/values/Projects!A2%3AW')) { first = false; fake.tabs.Projects[3][22] = 'L-0050'; }
    return res;
  };
  const client = G.createGoogleClient({ credentials: TEST_CREDS, sheetId: SHEET_ID, fetch });
  const st = store.createSheetsStore({ client });
  await st.listLeads();
  assert.equal(fake.writes.length, 0);
});

test('sheets store: read cache (15 s) and invalidation after writes', async () => {
  const { fake, st, advance } = sheetsStoreWithFake();
  await st.listLeads();
  const n = fake.calls.length;
  await st.listLeads();
  await st.listUsers();
  await st.listUsers();
  assert.equal(fake.calls.length, n + 1); // only the first Users read
  advance(16000);
  await st.listUsers();
  assert.equal(fake.calls.length, n + 2);
  const m = fake.calls.length;
  await st.listLeads();
  assert.equal(fake.calls.length, m + 1); // expired
  await st.updateLead('L-0002', { status: 'Contacted' });
  const k = fake.calls.length;
  const after = await st.listLeads();
  assert.ok(fake.calls.length > k); // cache cleared by the write
  assert.equal(after.find((l) => l.id === 'L-0002').status, 'Contacted');
  // fresh option bypasses the cache
  const j = fake.calls.length;
  await st.listLeads({ fresh: true });
  assert.ok(fake.calls.length > j);
});

test('sheets store: updateLead re-reads the ID column and writes the right row and columns', async () => {
  const { fake, st } = sheetsStoreWithFake();
  await st.listLeads(); // caches rows; L-0007 is on row 6
  // Someone inserts a row above it in the sheet.
  fake.tabs.Projects.splice(2, 0, projRow({ project: 'Inserted', id: 'L-0003' }));
  fake.writes.length = 0;
  const updated = await st.updateLead('l-0007', {
    status: 'Bidding', nextStep: '=HYPERLINK("http://evil")', nextDate: '2026-12-02', notes: '',
  });
  assert.deepEqual(fake.writes.map((w) => w.range).sort(), ['Projects!B7', 'Projects!O7', 'Projects!S7', 'Projects!T7']);
  const byRange = Object.fromEntries(fake.writes[0] ? fake.writes.map((w) => [w.range, w.values[0][0]]) : []);
  assert.equal(byRange['Projects!B7'], "'Bidding");
  assert.equal(byRange['Projects!O7'], "'=HYPERLINK(\"http://evil\")");
  assert.equal(byRange['Projects!S7'], '2026-12-02');
  assert.equal(byRange['Projects!T7'], '');
  assert.equal(updated.id, 'L-0007');
  assert.equal(updated.project, 'Charlie campus');
  assert.equal(updated.nextStep, '=HYPERLINK("http://evil")');
  assert.equal(fake.tabs.Projects[2][1], ''); // inserted row untouched
  await assert.rejects(st.updateLead('L-0404', { status: 'New' }), (e) => e.code === 'not_found');
  await assert.rejects(st.updateLead('L-0007', { id: 'L-0001' }));
  // Duplicate IDs are refused rather than guessing a row.
  fake.tabs.Projects.push(projRow({ project: 'Dup', id: 'L-0007' }));
  await assert.rejects(st.updateLead('L-0007', { status: 'New' }), (e) => e.code === 'conflict');
  assertOnlyAllowedTabs(fake);
});

test('sheets store: appendLead encodes text and dates and uses the next ID', async () => {
  const { fake, st } = sheetsStoreWithFake();
  fake.writes.length = 0;
  const lead = await st.appendLead({
    project: '+1 Tower', status: 'New', value: '1200', nextDate: '2026-12-05', firstSeen: '2026-11-24', nextOwner: 'Sam Ortiz',
  });
  assert.equal(lead.id, 'L-0009'); // L-0008 was assigned to the scan row first
  const app = fake.writes[fake.writes.length - 1];
  const row = app.values[0];
  assert.equal(row.length, 23);
  assert.equal(row[2], "'+1 Tower");
  assert.equal(row[1], "'New");
  assert.equal(row[7], "'1200");
  assert.equal(row[18], '2026-12-05');
  assert.equal(row[20], '2026-11-24');
  assert.equal(row[22], "'L-0009");
  assert.equal(row[0], '');
  const leads = await st.listLeads();
  assert.ok(leads.some((l) => l.id === 'L-0009' && l.project === '+1 Tower'));
  assertOnlyAllowedTabs(fake);
});

test('sheets store: contacts, activity, users and open bids', async () => {
  const { fake, st } = sheetsStoreWithFake();
  const users = await st.listUsers();
  assert.equal(users[0].code, 'sales-code-1');
  const bids = await st.listOpenBids();
  assert.equal(bids[0].bidId, 'B-1');
  assert.ok(fake.calls.some((c) => c.url.includes("/values/'Open%20bids'!A2%3AG")));

  const c = await st.appendContact({ leadId: 'L-0001', name: 'New Person', phone: '0123', addedBy: 'Sam Ortiz', addedOn: '2026-11-24' });
  assert.equal(c.id, 'C-0002');
  const crow = fake.writes[fake.writes.length - 1].values[0];
  assert.equal(crow.length, 11);
  assert.equal(crow[0], "'C-0002");
  assert.equal(crow[6], "'0123");
  assert.equal(crow[10], '2026-11-24');
  assert.deepEqual((await st.listContacts('L-0001')).map((x) => x.id), ['C-0001', 'C-0002']);
  assert.equal(fake.tabs.Contacts[2][6], '0123');

  const uc = await st.updateContact('C-0002', { email: 'np@example.com' });
  assert.equal(uc.email, 'np@example.com');
  assert.deepEqual(fake.writes[fake.writes.length - 1], { range: 'Contacts!F3', values: [["'np@example.com"]] });
  await assert.rejects(st.updateContact('C-0002', { leadId: 'L-0002' }));

  const a = await st.appendActivity({ when: '2026-11-24 10:00', leadId: 'L-0001', project: 'Alpha hotel', by: 'Sam Ortiz', type: 'Call', note: '-5 minutes', nextStep: '', nextDate: '2026-11-30' });
  const arow = fake.writes[fake.writes.length - 1].values[0];
  assert.deepEqual(arow, ["'2026-11-24 10:00", "'L-0001", "'Alpha hotel", "'Sam Ortiz", "'Call", "'-5 minutes", '', '2026-11-30']);
  assert.equal(a.note, '-5 minutes');
  const acts = await st.listActivity('L-0001');
  assert.equal(acts.length, 2);
  assertOnlyAllowedTabs(fake);
});

// ---------------------------------------------------------------- auth units

test('auth: cookies sign, verify, reject tampering and expiry', () => {
  const key = crypto.randomBytes(32);
  const v = auth.signSession(key, 'A@B.com');
  assert.equal(auth.verifySession(key, v), 'a@b.com');
  const [p, s] = v.split('.');
  const p2 = Buffer.from(JSON.stringify({ email: 'boss@b.com', exp: 9e9 })).toString('base64url');
  assert.equal(auth.verifySession(key, `${p2}.${s}`), null);
  assert.equal(auth.verifySession(crypto.randomBytes(32), v), null);
  assert.equal(auth.verifySession(key, `${p}.${s}x`), null);
  assert.equal(auth.verifySession(key, `${p}`), null);
  assert.equal(auth.verifySession(key, `${p}.${s}.x`), null);
  const old = auth.signSession(key, 'a@b.com', Date.now() - 15 * 24 * 3600 * 1000);
  assert.equal(auth.verifySession(key, old), null);
});

test('auth: visibility rules', () => {
  const users = [
    { name: 'M', role: 'Manager', active: 'Yes' }, { name: 'S', role: 'Sales', active: 'Yes' },
    { name: 'O', role: 'Outside', active: 'Yes' }, { name: 'Gone', role: 'Sales', active: 'No' },
  ];
  const s = { name: 'S', role: 'Sales' };
  const o = { name: 'O', role: 'Outside' };
  assert.equal(auth.canSee(s, { nextOwner: ' s ' }, users), true);
  assert.equal(auth.canSee(s, { nextOwner: '' }, users), true);
  assert.equal(auth.canSee(s, { nextOwner: 'Gone' }, users), true);
  assert.equal(auth.canSee(s, { nextOwner: 'To be named' }, users), true);
  assert.equal(auth.canSee(s, { nextOwner: 'O' }, users), false);
  assert.equal(auth.canSee(s, { nextOwner: 'm' }, users), false);
  assert.equal(auth.canSee(o, { nextOwner: '' }, users), false);
  assert.equal(auth.canSee(o, { nextOwner: 'o' }, users), true);
  assert.equal(auth.canSee({ name: 'X', role: 'Admin' }, { nextOwner: '' }, users), false);
  assert.equal(auth.canSee({ name: '', role: 'Outside' }, { nextOwner: '' }, users), false);
});

test('lead change descriptions', () => {
  assert.equal(describeChanges({ status: 'Contacted', nextDate: '2026-12-02' }), 'Changed status to Contacted; next step date to 2026-12-02');
  assert.equal(describeChanges({ nextOwner: '' }), 'Cleared owner of next step');
  assert.equal(describeChanges({ notes: 'x'.repeat(10) }), 'Updated notes');
});

// ====================================================================== API tests (mock store)

let server;
let base;
let port;

function cfgKey() { return store.getConfig().sessionKey; }

async function call(method, path, { body, cookie, headers = {}, contentType = 'application/json', raw } = {}) {
  const h = { ...headers };
  if (body !== undefined || raw !== undefined) h['Content-Type'] = contentType;
  if (cookie) h.Cookie = `cx_session=${cookie}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.get('set-cookie') };
}

const sessions = {};
async function login(who) {
  const u = USERS[who];
  const r = await call('POST', '/api/login', { body: { email: u.email, code: u.code } });
  assert.equal(r.status, 200, `login ${who}: ${r.text}`);
  const m = /cx_session=([^;]+)/.exec(r.setCookie);
  return m[1];
}

function freshState() {
  store.resetMockStore();
  auth.resetThrottle();
}

async function sessionsFor() {
  sessions.manager = await login('manager');
  sessions.sales = await login('sales');
  sessions.outside = await login('outside');
}

function mockData() { return store.getStore()._data; }

const SECRETS = [USERS.manager.code, USERS.sales.code, USERS.outside.code, USERS.former.code];
function assertNoSecrets(r, ownEmail) {
  for (const s of SECRETS) assert.ok(!r.text.includes(s), `response leaked an access code`);
  for (const u of Object.values(USERS)) {
    if (u.email !== ownEmail) assert.ok(!r.text.toLowerCase().includes(u.email), `leaked ${u.email}`);
  }
  assert.ok(!/\bat .+\.js:\d+/.test(r.text), 'stack trace in response');
}

test('api: not_configured when MOCK is off and the key is missing or bad', async () => {
  const saved = { ...process.env };
  try {
    process.env.MOCK = '0';
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/leads'], ['POST', '/api/login'], ['POST', '/api/logout'], ['GET', '/api/lead?id=L-0001'], ['POST', '/api/activity'], ['POST', '/api/contacts']]) {
      const r = await call(m, p, m === 'POST' ? { body: {} } : {});
      assert.equal(r.status, 503, p);
      assert.equal(r.json.error, 'not_configured');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"client_email": "x@y", "private_key": "nope"';
    assert.equal((await call('GET', '/api/me')).json.error, 'not_configured');
    process.env.MOCK = '1';
    process.env.VERCEL_ENV = 'production';
    assert.equal((await call('GET', '/api/me')).json.error, 'not_configured');
    process.env.VERCEL_ENV = 'preview';
    assert.equal((await call('GET', '/api/me')).json.error, 'not_configured');
    delete process.env.VERCEL_ENV;
    process.env.VERCEL = '1';
    assert.equal((await call('GET', '/api/me')).json.error, 'not_configured');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('api: /api/me without a session is 401 signed_out; unknown routes 404', async () => {
  freshState();
  const r = await call('GET', '/api/me');
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'signed_out');
  assert.equal(typeof r.json.message, 'string');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(r.headers.get('content-type').startsWith('application/json'));
  const nf = await call('GET', '/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error, 'not_found');
});

test('api: wrong methods answer 405', async () => {
  for (const [m, p] of [['GET', '/api/login'], ['DELETE', '/api/lead?id=L-0001'], ['PUT', '/api/leads'], ['GET', '/api/activity'], ['GET', '/api/contacts'], ['POST', '/api/me']]) {
    const r = await call(m, p, m === 'GET' || m === 'DELETE' ? {} : { body: {} });
    assert.equal(r.status, 405, `${m} ${p}`);
    assert.equal(r.json.error, 'method_not_allowed');
    assert.ok(r.headers.get('allow'));
  }
});

test('api: login success sets the cookie and returns only name, email, role', async () => {
  freshState();
  const r = await call('POST', '/api/login', { body: { email: '  SAM.ORTIZ@Example.com ', code: 'sales-code-1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { user: { name: 'Sam Ortiz', email: 'sam.ortiz@example.com', role: 'Sales' } });
  assert.match(r.setCookie, /^cx_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  assert.match(r.setCookie, /Path=\//);
  assert.match(r.setCookie, /Max-Age=1209600/);
  assert.doesNotMatch(r.setCookie, /Secure/); // mock mode only
  const cookie = /cx_session=([^;]+)/.exec(r.setCookie)[1];
  const payload = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url'));
  assert.deepEqual(Object.keys(payload).sort(), ['email', 'exp', 'v']);
  assert.ok(!cookie.includes('sales-code-1') && !Buffer.from(cookie.split('.')[0], 'base64url').toString().includes('sales-code-1'));
  const me = await call('GET', '/api/me', { cookie });
  assert.deepEqual(me.json, { user: { name: 'Sam Ortiz', email: 'sam.ortiz@example.com', role: 'Sales' } });
  const out = await call('POST', '/api/logout', { body: {} });
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /cx_session=;.*Max-Age=0/);
});

test('api: login failures all answer 401 invalid_login after a delay', async () => {
  freshState();
  mockData().users.push({ name: 'Short Code', email: 'short@example.com', role: 'Sales', code: 'abc1234', active: 'Yes' });
  mockData().users.push({ name: 'Bad Role', email: 'role@example.com', role: 'Admin', code: 'role-code-1', active: 'Yes' });
  const cases = [
    { email: USERS.sales.email, code: 'wrong-code-1' },
    { email: 'nobody@example.com', code: 'sales-code-1' },
    { email: USERS.former.email, code: USERS.former.code }, // inactive
    { email: 'short@example.com', code: 'abc1234' }, // code under 8 characters
    { email: 'role@example.com', code: 'role-code-1' }, // unknown role
    { email: USERS.sales.email, code: '' },
    { email: '', code: 'sales-code-1' },
    { email: 42, code: ['x'] },
  ];
  const bodies = new Set();
  for (const [i, body] of cases.entries()) {
    const t0 = Date.now();
    const r = await call('POST', '/api/login', { body, headers: { 'X-Real-IP': `10.0.0.${i}` } });
    assert.ok(Date.now() - t0 >= 450, 'delay');
    assert.equal(r.status, 401, JSON.stringify(body));
    assert.equal(r.json.error, 'invalid_login');
    assert.equal(r.setCookie, null);
    bodies.add(r.text);
  }
  assert.equal(bodies.size, 1, 'same message for every cause');
});

test('api: login throttle by email and by IP', async () => {
  freshState();
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/login', { body: { email: USERS.sales.email, code: 'nope-nope' }, headers: { 'X-Real-IP': `10.1.0.${i}` } });
    assert.equal(r.status, 401);
  }
  const blocked = await call('POST', '/api/login', { body: { email: USERS.sales.email, code: USERS.sales.code }, headers: { 'X-Real-IP': '10.1.1.1' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'too_many_attempts');
  assert.equal(blocked.setCookie, null);
  // Other emails from other IPs are unaffected.
  assert.equal((await call('POST', '/api/login', { body: { email: USERS.outside.email, code: USERS.outside.code }, headers: { 'X-Real-IP': '10.1.1.2' } })).status, 200);

  auth.resetThrottle();
  for (let i = 0; i < 8; i++) {
    await call('POST', '/api/login', { body: { email: `x${i}@example.com`, code: 'nope-nope' }, headers: { 'X-Real-IP': '10.2.0.9' } });
  }
  const ipBlocked = await call('POST', '/api/login', { body: { email: USERS.manager.email, code: USERS.manager.code }, headers: { 'X-Real-IP': '10.2.0.9' } });
  assert.equal(ipBlocked.status, 429);
  auth.resetThrottle();
});

test('api: mutations require JSON content type and a same-host Origin', async () => {
  freshState();
  const cookie = await login('outside');
  const before = JSON.stringify(mockData().leads);
  const r1 = await call('PATCH', '/api/lead?id=L-0003', { cookie, raw: JSON.stringify({ status: 'Won' }), contentType: 'text/plain' });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error, 'bad_request');
  const r2 = await call('POST', '/api/activity', { cookie, raw: 'leadId=L-0003&type=Call&note=x', contentType: 'application/x-www-form-urlencoded' });
  assert.equal(r2.status, 400);
  const r3 = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email: USERS.sales.email, code: USERS.sales.code }) });
  assert.equal(r3.status, 400); // no content type at all
  const r4 = await call('PATCH', '/api/lead?id=L-0003', { cookie, body: { status: 'Won' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r4.status, 400);
  assert.equal(r4.json.error, 'bad_request');
  const r5 = await call('POST', '/api/login', { body: { email: USERS.sales.email, code: USERS.sales.code }, headers: { Origin: 'null' } });
  assert.equal(r5.status, 400);
  assert.equal(JSON.stringify(mockData().leads), before);
  const ok = await call('PATCH', '/api/lead?id=L-0003', { cookie, body: { status: 'Won' }, headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(ok.status, 200);
  const bad = await call('PATCH', '/api/lead?id=L-0003', { cookie, raw: '{"status":', contentType: 'application/json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_request');
  const arr = await call('PATCH', '/api/lead?id=L-0003', { cookie, body: ['status'] });
  assert.equal(arr.status, 400);
});

test('api: tampered, forged, expired and foreign-key cookies are signed_out', async () => {
  freshState();
  const good = await login('sales');
  const [p, s] = good.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ email: USERS.manager.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const flip = (str) => str.slice(0, -2) + (str.slice(-2, -1) === 'A' ? 'B' : 'A') + str.slice(-1);
  const expired = auth.signSession(cfgKey(), USERS.sales.email, Date.now() - 15 * 24 * 3600 * 1000);
  const otherKey = auth.signSession(crypto.randomBytes(32), USERS.manager.email);
  const realKeyForUnknown = auth.signSession(cfgKey(), 'nobody@example.com');
  for (const c of [`${forgedPayload}.${s}`, `${p}.${flip(s)}`, `${flip(p)}.${s}`, expired, otherKey, realKeyForUnknown, 'garbage', `${p}.`, `.${s}`]) {
    const r = await call('GET', '/api/leads', { cookie: c });
    assert.equal(r.status, 401, c);
    assert.equal(r.json.error, 'signed_out');
    assert.equal(r.json.leads, undefined);
  }
  assert.equal((await call('GET', '/api/leads', { cookie: good })).status, 200);
});

test('api: user deactivated, removed or downgraded after sign-in', async () => {
  freshState();
  const cookie = await login('sales');
  const row = mockData().users.find((u) => u.email === USERS.sales.email);
  row.role = 'Outside';
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.json.user.role, 'Outside'); // role comes from the sheet, not the cookie
  const leads = await call('GET', '/api/leads', { cookie });
  assert.deepEqual(leads.json.openBids, []);
  row.role = 'Sales';
  row.active = 'No';
  for (const [m, p, body] of [['GET', '/api/me'], ['GET', '/api/leads'], ['GET', '/api/lead?id=L-0002'], ['PATCH', '/api/lead?id=L-0002', { status: 'Won' }], ['POST', '/api/activity', { leadId: 'L-0002', type: 'Call', note: 'x' }]]) {
    const r = await call(m, p, { cookie, body });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.json.error, 'signed_out');
  }
  assert.equal(mockData().leads.find((l) => l.id === 'L-0002').status, 'Contacted');
  row.active = 'Yes';
  row.code = 'short';
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
  row.code = USERS.sales.code;
  assert.equal((await call('GET', '/api/me', { cookie })).status, 200);
  mockData().users.splice(mockData().users.indexOf(row), 1);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
});

test('api: changing an access code ends sessions made with the old code', async () => {
  freshState();
  const cookie = await login('sales');
  assert.equal((await call('GET', '/api/me', { cookie })).status, 200);
  const row = mockData().users.find((u) => u.email === USERS.sales.email);
  row.code = 'a-brand-new-code';
  const r = await call('GET', '/api/leads', { cookie });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'signed_out');
  // A session without a code tag is refused; putting the old code back revives the old session.
  const legacy = auth.signSession(cfgKey(), USERS.sales.email);
  row.code = USERS.sales.code;
  assert.equal((await call('GET', '/api/me', { cookie: legacy })).status, 401);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 200);
  const fresh = await call('POST', '/api/login', { body: { email: USERS.sales.email, code: USERS.sales.code } });
  assert.equal(fresh.status, 200);
});

test('api: GET /api/leads visibility per role', async () => {
  freshState();
  await sessionsFor();
  const ids = (r) => r.json.leads.map((l) => l.id).sort();

  const m = await call('GET', '/api/leads', { cookie: sessions.manager });
  assert.equal(m.status, 200);
  assert.deepEqual(ids(m), ['L-0001', 'L-0002', 'L-0003', 'L-0004', 'L-0005', 'L-0006', 'L-0007', 'L-0008', 'L-0009', 'L-0010', 'L-0011']);
  assert.equal(m.json.openBids.length, 3);
  assert.deepEqual(m.json.statuses, ['New', 'Researching', 'Contacted', 'Bidding', 'Won', 'Lost', 'Watch']);
  assert.equal(m.json.today, chicagoToday());
  assert.deepEqual(m.json.people, [
    { name: 'Dana Reyes', role: 'Manager' }, { name: 'Sam Ortiz', role: 'Sales' }, { name: 'Olivia Park', role: 'Outside' },
  ]);
  assert.equal(m.json.leads.find((l) => l.id === 'L-0011').project, 'Durant event center flooring');
  assertNoSecrets(m, USERS.manager.email);

  const s = await call('GET', '/api/leads', { cookie: sessions.sales });
  assert.deepEqual(ids(s), ['L-0001', 'L-0002', 'L-0005', 'L-0006', 'L-0009', 'L-0010', 'L-0011']);
  assert.equal(s.json.openBids.length, 3);
  assert.equal(s.json.people.length, 3);
  for (const p of s.json.people) assert.deepEqual(Object.keys(p).sort(), ['name', 'role']);
  assertNoSecrets(s, USERS.sales.email);

  const o = await call('GET', '/api/leads', { cookie: sessions.outside });
  assert.deepEqual(ids(o), ['L-0003', 'L-0004']);
  assert.deepEqual(o.json.openBids, []);
  assert.deepEqual(o.json.people, [{ name: 'Olivia Park', role: 'Outside' }]);
  assertNoSecrets(o, USERS.outside.email);
  assert.ok(!o.text.includes('Lakeview'));
  for (const l of o.json.leads) assert.equal(Object.keys(l).length, 23);
});

test('api: GET /api/lead visibility, 404 for hidden, missing and malformed IDs', async () => {
  freshState();
  await sessionsFor();
  const get = (who, id) => call('GET', `/api/lead?id=${encodeURIComponent(id)}`, { cookie: sessions[who] });

  const r = await get('manager', 'L-0002');
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.project, 'Lakeview Medical Center expansion');
  assert.deepEqual(r.json.contacts.map((c) => c.id), ['C-0001']);
  assert.equal(r.json.activity.length, 2);
  assert.ok(r.json.activity[0].when > r.json.activity[1].when, 'newest first');
  assertNoSecrets(r, USERS.manager.email);

  assert.equal((await get('sales', 'L-0002')).status, 200);
  assert.equal((await get('sales', 'l-0005')).status, 200);
  assert.equal((await get('sales', 'L-0009')).status, 200); // owner inactive = unassigned
  assert.equal((await get('outside', 'L-0003')).json.contacts[0].name, 'Casey Lone Elk');

  const hidden = [['sales', 'L-0003'], ['sales', 'L-0004'], ['sales', 'L-0007'], ['sales', 'L-0008'],
    ['outside', 'L-0001'], ['outside', 'L-0002'], ['outside', 'L-0005'], ['outside', 'L-0006'], ['outside', 'L-0007']];
  const missing = [['manager', 'L-9999'], ['sales', 'L-0099'], ['outside', 'L-0000'], ['manager', 'C-0001'], ['manager', ''], ['manager', "L-0001' OR 1=1"], ['manager', 'L-0001;L-0002']];
  const bodies = new Set();
  for (const [who, id] of [...hidden, ...missing]) {
    const x = await get(who, id);
    assert.equal(x.status, 404, `${who} ${id}`);
    assert.equal(x.json.error, 'not_found');
    assert.equal(x.json.lead, undefined);
    bodies.add(x.text);
  }
  assert.equal(bodies.size, 1, 'hidden and missing look the same');
  const multi = await call('GET', '/api/lead?id=L-0003&id=L-0001', { cookie: sessions.outside });
  assert.equal(multi.status, 404);
  assert.equal((await call('GET', '/api/lead', { cookie: sessions.manager })).status, 404);
});

test('api: PATCH /api/lead for Outside', async () => {
  freshState();
  await sessionsFor();
  const patch = (id, body, who = 'outside') => call('PATCH', `/api/lead?id=${id}`, { cookie: sessions[who], body });
  const before = mockData().activity.length;

  const r = await patch('L-0003', { status: 'contacted', nextDate: '2026-12-02' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.lead.status, 'Contacted');
  assert.equal(r.json.lead.nextDate, '2026-12-02');
  const act = mockData().activity[mockData().activity.length - 1];
  assert.equal(mockData().activity.length, before + 1);
  assert.equal(act.type, 'Update');
  assert.equal(act.by, 'Olivia Park');
  assert.equal(act.leadId, 'L-0003');
  assert.equal(act.note, 'Changed status to Contacted; next step date to 2026-12-02');
  assert.match(act.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  for (const body of [{ project: 'Renamed' }, { nextOwner: 'Sam Ortiz' }, { nextOwner: '' }, { notes: 'x' }, { fit: 'A' }, { id: 'L-0001' }, { lastChecked: '2026-01-01' }, { bogus: 1 }]) {
    const x = await patch('L-0003', body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.equal(x.json.error, 'field_not_allowed');
  }
  // A disallowed field sent with its current value is not a change.
  const same = await patch('L-0003', { project: 'Cedar Hills travel plaza', nextOwner: 'olivia park', nextStep: 'Call again' });
  assert.equal(same.status, 200);
  assert.equal(same.json.lead.nextStep, 'Call again');
  assert.equal(same.json.lead.nextOwner, 'Olivia Park');

  for (const id of ['L-0001', 'L-0005', 'L-0007']) {
    const x = await patch(id, { status: 'Won' });
    assert.equal(x.status, 404);
  }
  assert.equal(mockData().leads.find((l) => l.id === 'L-0001').status, 'Won');
  assert.equal(mockData().leads.find((l) => l.id === 'L-0005').status, 'New');
});

test('api: PATCH /api/lead for Sales (claim, clear, limits)', async () => {
  freshState();
  await sessionsFor();
  const patch = (id, body) => call('PATCH', `/api/lead?id=${id}`, { cookie: sessions.sales, body });

  const step = await patch('L-0002', { nextStep: 'Email bid list request', nextDate: '2026-12-01' });
  assert.equal(step.status, 200);
  assert.equal(mockData().activity.at(-1).note, 'Changed next step to Email bid list request; next step date to 2026-12-01');
  assert.equal(mockData().activity.at(-1).nextDate, '2026-12-01');

  const claim = await patch('L-0005', { nextOwner: ' sam ortiz ' });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.lead.nextOwner, 'Sam Ortiz');

  const clear = await patch('L-0010', { nextOwner: '' });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.lead.nextOwner, '');
  assert.equal((await call('GET', '/api/lead?id=L-0010', { cookie: sessions.sales })).status, 200); // now unassigned

  const claimFormer = await patch('L-0009', { nextOwner: 'Sam Ortiz' });
  assert.equal(claimFormer.status, 200);

  for (const [id, body] of [['L-0002', { nextOwner: 'Olivia Park' }], ['L-0006', { nextOwner: '' }], ['L-0006', { nextOwner: 'Dana Reyes' }],
    ['L-0002', { notes: 'x' }], ['L-0002', { project: 'X' }], ['L-0002', { value: '$1' }], ['L-0002', { firstSeen: '2026-01-01' }]]) {
    const x = await patch(id, body);
    assert.equal(x.status, 400, `${id} ${JSON.stringify(body)}`);
    assert.equal(x.json.error, 'field_not_allowed');
  }
  assert.equal(mockData().leads.find((l) => l.id === 'L-0006').nextOwner, 'To be named');
  for (const id of ['L-0003', 'L-0007', 'L-0008']) {
    const x = await patch(id, { nextOwner: 'Sam Ortiz' });
    assert.equal(x.status, 404, id);
  }
  assert.equal(mockData().leads.find((l) => l.id === 'L-0007').nextOwner, 'Dana Reyes');
});

test('api: PATCH /api/lead for Manager and value validation', async () => {
  freshState();
  await sessionsFor();
  const patch = (id, body) => call('PATCH', `/api/lead?id=${id}`, { cookie: sessions.manager, body });

  const all = await patch('L-0007', { notes: '=IMPORTXML("http://x")', fit: 'b', whyFits: 'Big campus', lastChecked: 'yesterday', firstSeen: '2026-10-01', nextOwner: 'olivia park' });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.lead.notes, '=IMPORTXML("http://x")');
  assert.equal(all.json.lead.fit, 'B');
  assert.equal(all.json.lead.nextOwner, 'Olivia Park');
  assert.equal((await call('GET', '/api/lead?id=L-0007', { cookie: sessions.outside })).status, 200);
  assert.equal((await call('GET', '/api/lead?id=L-0007', { cookie: sessions.sales })).status, 404);

  assert.equal((await patch('L-0007', { nextOwner: '' })).json.lead.nextOwner, '');
  assert.equal(mockData().activity.at(-1).note, 'Cleared owner of next step');

  const invalid = [
    { nextOwner: 'Pat Former' }, { nextOwner: 'Someone Else' }, { status: 'Bogus' }, { status: '' },
    { nextDate: '12/02/2026' }, { nextDate: '2026-02-30' }, { firstSeen: 'today' }, { fit: 'D' },
    { project: '' }, { notes: 'x'.repeat(5001) }, { nextStep: 'x'.repeat(301) }, { owner: { a: 1 } }, { owner: ['a'] },
  ];
  for (const body of invalid) {
    const x = await patch('L-0001', body);
    assert.equal(x.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(x.json.error, 'invalid_value');
  }
  assert.equal((await patch('L-0001', { notes: 'x'.repeat(5000), stage: 'y'.repeat(5000), nextStep: 'z'.repeat(300) })).status, 200);
  for (const body of [{ id: 'L-0002' }, { foo: 'bar' }, { leadId: 'x' }]) {
    const x = await patch('L-0001', body);
    assert.equal(x.json.error, 'field_not_allowed');
  }
  const n = mockData().activity.length;
  const noop = await patch('L-0001', { status: 'Won' });
  assert.equal(noop.status, 200);
  assert.equal(mockData().activity.length, n, 'no activity row for a no-op');
});

test('api: POST /api/leads', async () => {
  freshState();
  await sessionsFor();
  const post = (who, body) => call('POST', '/api/leads', { cookie: sessions[who], body });

  const o = await post('outside', { project: 'Nope' });
  assert.equal(o.status, 400);
  assert.equal(o.json.error, 'not_allowed');
  assert.equal(mockData().leads.length, 12);

  const s = await post('sales', { project: '  New hotel  ', owner: 'Acme', nextDate: '2026-12-10', notes: '@SUM(1)' });
  assert.equal(s.status, 201, s.text);
  assert.equal(s.json.lead.id, 'L-0012');
  assert.equal(s.json.lead.project, 'New hotel');
  assert.equal(s.json.lead.status, 'New');
  assert.equal(s.json.lead.nextOwner, 'Sam Ortiz');
  assert.equal(s.json.lead.firstSeen, chicagoToday());
  assert.equal(s.json.lead.lastChecked, '');
  const act = mockData().activity.at(-1);
  assert.deepEqual([act.type, act.note, act.leadId, act.by, act.project], ['Update', 'Lead added', 'L-0012', 'Sam Ortiz', 'New hotel']);

  const s2 = await post('sales', { project: 'Open lead', nextOwner: '' });
  assert.equal(s2.status, 201);
  assert.equal(s2.json.lead.nextOwner, '');
  for (const body of [{ project: 'X', nextOwner: 'Olivia Park' }, { project: 'X', nextOwner: 'Free text' }, { project: 'X', id: 'L-0500' }, { project: 'X', firstSeen: '2020-01-01' }, { project: 'X', lastChecked: 'x' }, { project: 'X', other: 1 }]) {
    const x = await post('sales', body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.equal(x.json.error, 'field_not_allowed');
  }
  for (const body of [{}, { project: '   ' }, { project: 'X', status: 'Maybe' }, { project: 'X', nextDate: 'soon' }, { project: 'x'.repeat(301) }]) {
    const x = await post('manager', body);
    assert.equal(x.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(x.json.error, 'invalid_value');
  }
  const mOk = await post('manager', { project: 'Assigned', status: 'Bidding', nextOwner: 'olivia park', fit: 'a' });
  assert.equal(mOk.status, 201);
  assert.equal(mOk.json.lead.nextOwner, 'Olivia Park');
  assert.equal(mOk.json.lead.status, 'Bidding');
  assert.equal(mOk.json.lead.fit, 'A');
  assert.equal((await call('GET', `/api/lead?id=${mOk.json.lead.id}`, { cookie: sessions.outside })).status, 200);
  assert.equal((await post('manager', { project: 'X', nextOwner: 'Nobody' })).json.error, 'invalid_value');
  assert.equal((await post('manager', { project: 'Blank owner' })).json.lead.nextOwner, '');
});

test('api: POST /api/activity', async () => {
  freshState();
  await sessionsFor();
  const post = (who, body) => call('POST', '/api/activity', { cookie: sessions[who], body });

  const r = await post('outside', { leadId: 'L-0003', type: 'site visit', note: 'Measured lobby.', nextStep: 'Send numbers', nextDate: '2026-12-03', status: 'Bidding' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(
    [r.json.activity.type, r.json.activity.by, r.json.activity.project, r.json.activity.nextStep, r.json.activity.nextDate],
    ['Site visit', 'Olivia Park', 'Cedar Hills travel plaza', 'Send numbers', '2026-12-03'],
  );
  assert.equal(r.json.lead.nextStep, 'Send numbers');
  assert.equal(r.json.lead.nextDate, '2026-12-03');

  const keep = await post('outside', { leadId: 'L-0003', type: 'Call', note: 'No answer.', nextStep: '', nextDate: '', status: '' });
  assert.equal(keep.status, 201);
  assert.equal(keep.json.lead.nextStep, 'Send numbers', 'blank means no change');

  const lead = await call('GET', '/api/lead?id=L-0003', { cookie: sessions.outside });
  assert.equal(lead.json.activity[0].note, 'No answer.');

  for (const [who, id] of [['outside', 'L-0001'], ['outside', 'L-0005'], ['sales', 'L-0007'], ['sales', 'L-9999'], ['manager', 'bad']]) {
    const x = await post(who, { leadId: id, type: 'Call', note: 'x' });
    assert.equal(x.status, 404, `${who} ${id}`);
  }
  const n = mockData().activity.length;
  for (const body of [{ leadId: 'L-0003', type: 'Update', note: 'x' }, { leadId: 'L-0003', type: 'Fax', note: 'x' }, { leadId: 'L-0003', type: 'Call', note: '  ' }, { leadId: 'L-0003', type: 'Call' }, { leadId: 'L-0003', type: 'Call', note: 'x', nextDate: 'Friday' }, { leadId: 'L-0003', type: 'Call', note: 'x', status: 'Done' }]) {
    const x = await post('outside', body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.equal(x.json.error, 'invalid_value');
  }
  for (const body of [{ leadId: 'L-0003', type: 'Call', note: 'x', nextOwner: 'Sam Ortiz' }, { leadId: 'L-0003', type: 'Call', note: 'x', by: 'Dana Reyes' }]) {
    const x = await post('outside', body);
    assert.equal(x.json.error, 'field_not_allowed');
  }
  assert.equal(mockData().activity.length, n, 'nothing written on rejected requests');
  const sales = await post('sales', { leadId: 'L-0005', type: 'Email', note: 'Sent intro.' });
  assert.equal(sales.status, 201);
  assert.equal(sales.json.lead.id, 'L-0005');
});

test('api: POST and PATCH /api/contacts', async () => {
  freshState();
  await sessionsFor();
  const post = (who, body) => call('POST', '/api/contacts', { cookie: sessions[who], body });
  const patch = (who, id, body) => call('PATCH', `/api/contacts?id=${id}`, { cookie: sessions[who], body });

  const c = await post('sales', { leadId: 'L-0005', name: 'Jamie Fox', phone: '+1 940 555 0199', email: 'jamie@example.org', verifiedAt: 'Phone call' });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.contact.id, 'C-0005');
  assert.equal(c.json.contact.addedBy, 'Sam Ortiz');
  assert.equal(c.json.contact.addedOn, chicagoToday());
  assert.equal(c.json.contact.leadId, 'L-0005');
  assert.equal(c.json.contact.phone, '+1 940 555 0199');

  assert.equal((await post('outside', { leadId: 'L-0002', name: 'X' })).status, 404);
  assert.equal((await post('sales', { leadId: 'L-0007', name: 'X' })).status, 404);
  assert.equal((await post('outside', { leadId: 'L-0003', name: ' ' })).json.error, 'invalid_value');
  assert.equal((await post('outside', { leadId: 'L-0003', name: 'X', addedBy: 'Dana Reyes' })).json.error, 'field_not_allowed');
  assert.equal((await post('outside', { leadId: 'L-0003', name: 'X', id: 'C-0001' })).json.error, 'field_not_allowed');
  const oc = await post('outside', { leadId: 'L-0003', name: 'Site lead' });
  assert.equal(oc.status, 201);

  const e = await patch('outside', 'C-0002', { title: 'Facilities manager', notes: 'Call mornings.' });
  assert.equal(e.status, 200, e.text);
  assert.equal(e.json.contact.title, 'Facilities manager');
  assert.equal(e.json.contact.name, 'Casey Lone Elk');
  assert.equal((await patch('outside', 'C-0002', { leadId: 'L-0004' })).json.error, 'field_not_allowed');
  assert.equal((await patch('outside', 'C-0002', { name: '' })).json.error, 'invalid_value');
  for (const [who, id] of [['outside', 'C-0001'], ['outside', 'C-0003'], ['sales', 'C-0003'], ['sales', 'C-0002'], ['manager', 'C-9999'], ['manager', 'L-0001'], ['manager', '']]) {
    const x = await patch(who, id, { notes: 'hijack' });
    assert.equal(x.status, 404, `${who} ${id}`);
    assert.equal(x.json.error, 'not_found');
  }
  assert.ok(!mockData().contacts.some((x) => x.notes === 'hijack'));
  assert.equal((await patch('manager', 'C-0003', { email: 'r.chen@example.com' })).status, 200);
  assert.equal((await patch('sales', 'c-0001', { phone: '940-555-0102' })).json.contact.phone, '940-555-0102');
});

test('api: reassigning a lead moves its contacts and activity with it', async () => {
  freshState();
  await sessionsFor();
  assert.equal((await call('GET', '/api/lead?id=L-0002', { cookie: sessions.sales })).status, 200);
  const r = await call('PATCH', '/api/lead?id=L-0002', { cookie: sessions.manager, body: { nextOwner: 'Olivia Park' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/lead?id=L-0002', { cookie: sessions.sales })).status, 404);
  assert.equal((await call('PATCH', '/api/contacts?id=C-0001', { cookie: sessions.sales, body: { notes: 'x' } })).status, 404);
  assert.equal((await call('POST', '/api/activity', { cookie: sessions.sales, body: { leadId: 'L-0002', type: 'Call', note: 'x' } })).status, 404);
  const o = await call('GET', '/api/lead?id=L-0002', { cookie: sessions.outside });
  assert.equal(o.status, 200);
  assert.equal(o.json.contacts.length, 1);
  assertNoSecrets(o, USERS.outside.email);
});

test('api: internal and Google errors never leak details', async () => {
  freshState();
  await sessionsFor();
  const st = store.getStore();
  const orig = st.listLeads;
  const origErr = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    st.listLeads = async () => { throw new Error('SECRET row 5: Jane Doe, 555-0100'); };
    const r = await call('GET', '/api/leads', { cookie: sessions.manager });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'server_error');
    assert.ok(!r.text.includes('SECRET'));
    assert.ok(!r.text.includes('.js:'));
    assert.ok(!logged.join(' ').includes('SECRET'), 'logs omit error messages');
    st.listLeads = async () => { throw new G.GoogleError('sheets', 403); };
    const g = await call('GET', '/api/lead?id=L-0001', { cookie: sessions.manager });
    assert.equal(g.status, 500);
    assert.equal(g.json.error, 'sheet_unavailable');
  } finally {
    st.listLeads = orig;
    console.error = origErr;
  }
});

test('dev server: serves public/ and blocks path traversal', async () => {
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
  for (const p of ['/%2e%2e/package.json', '/../package.json', '/..%2fpackage.json', '/%2e%2e%2flib/auth.js']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.includes('centrex-sales') && !r.body.includes('timingSafeEqual'), p);
  }
  const root = await get('/');
  if (root.status === 200) assert.match(root.type, /text\/html/);
  else assert.equal(root.status, 404); // front end not written yet
});

test('vercel.json: only public/ is static, and pages get a strict CSP', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.equal(cfg.outputDirectory, 'public');
  const all = cfg.headers.find((x) => x.source === '/(.*)').headers;
  const csp = all.find((x) => x.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('content-security-policy'), csp); // dev server mirrors vercel.json
});

// ====================================================================== runner

(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  let passed = 0;
  const failed = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed.push(t.name);
      console.log(`FAIL ${t.name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    }
  }
  server.close();
  console.log(`\n${passed} passed, ${failed.length} failed, ${tests.length} total`);
  process.exit(failed.length ? 1 : 0);
})();
