'use strict';
// Sign-in, session cookies, per-request user re-validation, throttle, and
// role/visibility rules.

const crypto = require('crypto');
const { norm, ROLES } = require('./schema');

const COOKIE_NAME = 'cx_session';
const SESSION_MAX_AGE_S = 14 * 24 * 60 * 60; // 1209600
const MIN_CODE_LENGTH = 8;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_FAILURES = 8;
const MAX_COOKIE_LENGTH = 2048;

// ---------------------------------------------------------------- users

function canonicalRole(role) {
  const r = norm(role);
  return ROLES.find((x) => x.toLowerCase() === r) || null;
}

function isActive(u) {
  return norm(u.active) === 'yes';
}

// A user who may sign in: Active = Yes, a name, a known role, an email, and an
// access code of at least 8 characters.
function isValidUser(u) {
  return isActive(u)
    && String(u.name || '').trim() !== ''
    && norm(u.email) !== ''
    && !!canonicalRole(u.role)
    && String(u.code || '').trim().length >= MIN_CODE_LENGTH;
}

// Returns the single valid Users row for an email, or null. Duplicate valid
// rows for one email are treated as no match (fail closed).
function findUserRow(users, email) {
  const e = norm(email);
  if (!e) return null;
  const rows = users.filter((u) => norm(u.email) === e && isValidUser(u));
  return rows.length === 1 ? rows[0] : null;
}

function sessionUser(row) {
  return { name: String(row.name).trim(), email: String(row.email).trim(), role: canonicalRole(row.role) };
}

function activeNames(users) {
  const set = new Set();
  for (const u of users) {
    if (isActive(u) && String(u.name || '').trim()) set.add(norm(u.name));
  }
  return set;
}

// Active users' names and roles, for the `people` list.
function people(users) {
  const out = [];
  const seen = new Set();
  for (const u of users) {
    const role = canonicalRole(u.role);
    const name = String(u.name || '').trim();
    if (!isActive(u) || !name || !role || seen.has(norm(name))) continue;
    seen.add(norm(name));
    out.push({ name, role });
  }
  return out;
}

// Canonical Name of an active user matching `name`, or null.
function activeUserName(users, name) {
  const n = norm(name);
  if (!n) return null;
  for (const u of users) {
    if (isActive(u) && norm(u.name) === n && canonicalRole(u.role)) return String(u.name).trim();
  }
  return null;
}

// ---------------------------------------------------------------- login

function codeMatches(given, stored) {
  const a = crypto.createHash('sha256').update(String(given || '').trim()).digest();
  const b = crypto.createHash('sha256').update(String(stored || '').trim()).digest();
  const ok = crypto.timingSafeEqual(a, b);
  return ok && String(stored || '').trim().length >= MIN_CODE_LENGTH;
}

// Returns the session user or null. Always does one constant-time compare.
function checkLogin(users, email, code) {
  const row = findUserRow(users, email);
  const stored = row ? row.code : 'x'.repeat(32) + crypto.randomBytes(8).toString('hex');
  const ok = codeMatches(code, stored);
  return row && ok ? sessionUser(row) : null;
}

// ---------------------------------------------------------------- throttle

const failures = new Map(); // key -> [timestamps]

function prune(key, now) {
  const list = (failures.get(key) || []).filter((t) => now - t < THROTTLE_WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
}

function throttleKeys(email, ip) {
  const keys = [];
  const e = norm(email);
  if (e) keys.push('e:' + e);
  if (ip) keys.push('i:' + ip);
  return keys;
}

function isThrottled(email, ip, now = Date.now()) {
  return throttleKeys(email, ip).some((k) => prune(k, now).length >= THROTTLE_MAX_FAILURES);
}

function recordFailure(email, ip, now = Date.now()) {
  if (failures.size > 10000) {
    for (const k of failures.keys()) prune(k, now);
    if (failures.size > 10000) failures.clear();
  }
  for (const k of throttleKeys(email, ip)) {
    const list = prune(k, now);
    list.push(now);
    failures.set(k, list);
  }
}

function clearFailures(email) {
  const e = norm(email);
  if (e) failures.delete('e:' + e);
}

function resetThrottle() {
  failures.clear();
}

function clientIp(req) {
  const h = req.headers || {};
  const real = typeof h['x-real-ip'] === 'string' ? h['x-real-ip'].trim() : '';
  if (real) return real;
  const fwd = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  if (fwd) return fwd;
  return (req.socket && req.socket.remoteAddress) || '';
}

// ---------------------------------------------------------------- cookies

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// A short keyed tag of the user's access code. Stored in the signed session so
// that changing a user's code in Users ends their existing sessions. It does
// not reveal the code: it is an HMAC under the server's session key.
function codeTag(key, code) {
  return hmac(key, 'code:' + String(code == null ? '' : code).trim()).subarray(0, 12).toString('base64url');
}

function signSession(key, email, nowMs = Date.now(), code) {
  const claims = {
    email: String(email).trim().toLowerCase(),
    exp: Math.floor(nowMs / 1000) + SESSION_MAX_AGE_S,
  };
  if (code !== undefined) claims.v = codeTag(key, code);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${hmac(key, payload).toString('base64url')}`;
}

// Returns the email in a valid, unexpired cookie value, or null.
function verifySession(key, value, nowMs = Date.now()) {
  const claims = verifySessionClaims(key, value, nowMs);
  return claims ? claims.email : null;
}

// Returns the signed claims {email, exp, v?} of a valid, unexpired cookie, or null.
function verifySessionClaims(key, value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value || value.length > MAX_COOKIE_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = hmac(key, payload);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!obj || typeof obj.email !== 'string' || !obj.email || typeof obj.exp !== 'number') return null;
  if (obj.exp * 1000 <= nowMs) return null;
  return obj;
}

function sessionCookie(value, { secure }) {
  return `${COOKIE_NAME}=${value}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
}

function clearCookie({ secure }) {
  return `${COOKIE_NAME}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(req) {
  const c = req.cookies && req.cookies[COOKIE_NAME];
  if (typeof c === 'string') return c;
  // Fallback if req.cookies is not populated.
  const raw = req.headers && req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return null;
}

// Re-validates the signed-in user against Users. Returns {name, email, role} or null.
// The session must carry the tag of the user's current access code, so a
// changed code signs out every session made with the old one.
function userFromSession(key, cookieValue, users, nowMs) {
  const claims = verifySessionClaims(key, cookieValue, nowMs);
  if (!claims) return null;
  const row = findUserRow(users, claims.email);
  if (!row || typeof claims.v !== 'string' || claims.v !== codeTag(key, row.code)) return null;
  return sessionUser(row);
}

// ---------------------------------------------------------------- visibility

function isMine(user, lead) {
  const me = norm(user.name);
  return me !== '' && norm(lead.nextOwner) === me;
}

function isUnassigned(lead, users) {
  return !activeNames(users).has(norm(lead.nextOwner));
}

function canSee(user, lead, users) {
  if (!user || !lead) return false;
  switch (user.role) {
    case 'Manager': return true;
    case 'Sales': return isMine(user, lead) || isUnassigned(lead, users);
    case 'Outside': return isMine(user, lead);
    default: return false;
  }
}

function canSeeOpenBids(user) {
  return user.role === 'Manager' || user.role === 'Sales';
}

function canAddLeads(user) {
  return user.role === 'Manager' || user.role === 'Sales';
}

const LEAD_FIELDS_ALL = ['fit', 'status', 'project', 'owner', 'location', 'state', 'type', 'value',
  'size', 'stage', 'opening', 'gc', 'architect', 'whyFits', 'nextStep', 'nativeNote', 'source',
  'nextOwner', 'nextDate', 'notes', 'firstSeen', 'lastChecked', 'bondRequired'];

// Fields a role may change on a lead it can see (nextOwner has extra value rules).
function editableLeadFields(user) {
  switch (user.role) {
    case 'Manager': return new Set(LEAD_FIELDS_ALL);
    case 'Sales': return new Set(['status', 'nextStep', 'nextDate', 'nextOwner', 'bondRequired']);
    case 'Outside': return new Set(['status', 'nextStep', 'nextDate']);
    default: return new Set();
  }
}

// Check a requested nextOwner change. Returns {ok: true, value} with the value
// to store, or {ok: false, code} where code is 'field_not_allowed' or 'invalid_value'.
function checkNextOwner(user, lead, requested, users) {
  const current = lead ? lead.nextOwner : '';
  const req = String(requested).trim();
  if (lead && norm(req) === norm(current)) return { ok: true, value: current };
  if (user.role === 'Manager') {
    if (req === '') return { ok: true, value: '' };
    const name = activeUserName(users, req);
    return name ? { ok: true, value: name } : { ok: false, code: 'invalid_value' };
  }
  if (user.role === 'Sales') {
    if (norm(req) === norm(user.name)) return { ok: true, value: user.name };
    if (req === '' && (!lead || isMine(user, lead))) return { ok: true, value: '' };
    return { ok: false, code: 'field_not_allowed' };
  }
  return { ok: false, code: 'field_not_allowed' };
}

module.exports = {
  COOKIE_NAME, SESSION_MAX_AGE_S, MIN_CODE_LENGTH, THROTTLE_MAX_FAILURES, THROTTLE_WINDOW_MS,
  canonicalRole, isActive, isValidUser, findUserRow, sessionUser, people, activeUserName,
  checkLogin, codeMatches, isThrottled, recordFailure, clearFailures, resetThrottle, clientIp,
  signSession, verifySession, verifySessionClaims, codeTag, sessionCookie, clearCookie, readCookie, userFromSession,
  isMine, isUnassigned, canSee, canSeeOpenBids, canAddLeads, editableLeadFields, checkNextOwner,
  LEAD_FIELDS_ALL,
};
