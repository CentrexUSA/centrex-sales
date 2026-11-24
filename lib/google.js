'use strict';
// Google service-account auth and thin Sheets API v4 helpers. No dependencies.
// Errors thrown from here carry only an HTTP status, never response bodies,
// tokens or key material.

const crypto = require('crypto');
const { ALLOWED_TAB_NAMES } = require('./schema');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

class GoogleError extends Error {
  constructor(kind, status) {
    super(`Google ${kind} request failed${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'GoogleError';
    this.kind = kind;
    this.status = status || 0;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Parse GOOGLE_SERVICE_ACCOUNT_JSON. Returns null when missing or unusable.
function parseServiceAccount(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const clientEmail = j.client_email;
  let privateKey = j.private_key;
  if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) return null;
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) return null;
  if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  try { crypto.createPrivateKey(privateKey); } catch { return null; }
  return { clientEmail, privateKey };
}

function buildJwt({ clientEmail, privateKey }, nowSec) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function assertRange(range) {
  const m = /^(?:'((?:[^']|'')+)'|([A-Za-z0-9_]+))!/.exec(range);
  const tab = m ? (m[1] != null ? m[1].replace(/''/g, "'") : m[2]) : null;
  if (!tab || !ALLOWED_TAB_NAMES.has(tab)) throw new Error('Range outside allowed tabs');
}

function createGoogleClient({ credentials, sheetId, fetch: fetchImpl, now }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const clock = now || Date.now;
  let token = null; // { value, expiresAt }
  let inflight = null;

  async function fetchToken() {
    const jwt = buildJwt(credentials, Math.floor(clock() / 1000));
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString();
    let res;
    try {
      res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleError('token', 0);
    }
    if (!res.ok) throw new GoogleError('token', res.status);
    let j;
    try { j = await res.json(); } catch { throw new GoogleError('token', res.status); }
    if (!j || typeof j.access_token !== 'string') throw new GoogleError('token', res.status);
    const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
    token = { value: j.access_token, expiresAt: clock() + ttl * 1000 };
    return token.value;
  }

  async function getAccessToken() {
    if (token && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > clock()) return token.value;
    if (!inflight) {
      inflight = fetchToken().finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function api(method, path, query, body, retried) {
    const accessToken = await getAccessToken();
    const qs = query ? `?${query.toString()}` : '';
    const url = `${SHEETS_BASE}${encodeURIComponent(sheetId)}${path}${qs}`;
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleError('sheets', 0);
    }
    if (res.status === 401 && !retried) {
      token = null;
      return api(method, path, query, body, true);
    }
    if (!res.ok) throw new GoogleError('sheets', res.status);
    try { return await res.json(); } catch { throw new GoogleError('sheets', res.status); }
  }

  function readParams(extra) {
    const p = new URLSearchParams();
    p.set('valueRenderOption', 'FORMATTED_VALUE');
    p.set('majorDimension', 'ROWS');
    if (extra) for (const [k, v] of extra) p.append(k, v);
    return p;
  }

  return {
    getAccessToken,

    async valuesGet(range) {
      assertRange(range);
      const j = await api('GET', `/values/${encodeURIComponent(range)}`, readParams());
      return Array.isArray(j.values) ? j.values : [];
    },

    async valuesBatchGet(ranges) {
      ranges.forEach(assertRange);
      const j = await api('GET', '/values:batchGet', readParams(ranges.map((r) => ['ranges', r])));
      const vr = Array.isArray(j.valueRanges) ? j.valueRanges : [];
      return ranges.map((_, i) => (vr[i] && Array.isArray(vr[i].values) ? vr[i].values : []));
    },

    async valuesUpdate(range, values) {
      assertRange(range);
      const p = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });
      return api('PUT', `/values/${encodeURIComponent(range)}`, p,
        { range, majorDimension: 'ROWS', values });
    },

    // data: [{range, values}]
    async valuesBatchUpdate(data) {
      data.forEach((d) => assertRange(d.range));
      return api('POST', '/values:batchUpdate', null, {
        valueInputOption: 'USER_ENTERED',
        data: data.map((d) => ({ range: d.range, majorDimension: 'ROWS', values: d.values })),
      });
    },

    async valuesAppend(range, values) {
      assertRange(range);
      const p = new URLSearchParams({
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      });
      return api('POST', `/values/${encodeURIComponent(range)}:append`, p,
        { range, majorDimension: 'ROWS', values });
    },
  };
}

module.exports = {
  TOKEN_URL, SCOPE, SHEETS_BASE, GoogleError,
  parseServiceAccount, buildJwt, createGoogleClient, assertRange,
};
