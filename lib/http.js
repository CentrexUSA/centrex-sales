'use strict';
// Shared handler wrapper for api/*.js and request-level helpers.

const { getConfig, getStore, StoreError } = require('./store');
const auth = require('./auth');
const S = require('./schema');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

const DEFAULT_MESSAGES = {
  not_configured: 'The app is not connected to its data yet.',
  method_not_allowed: 'That request method is not supported here.',
  bad_request: 'The request could not be read.',
  signed_out: 'You are signed out. Sign in again.',
  invalid_login: 'That email and access code did not match.',
  too_many_attempts: 'Too many sign-in attempts. Wait 15 minutes and try again.',
  not_found: 'That item was not found.',
  not_allowed: 'Your role cannot do that.',
  field_not_allowed: 'Your role cannot change that field.',
  invalid_value: 'One of the values is not valid.',
  sheet_unavailable: 'The lead sheet could not be reached. Try again in a minute.',
  server_error: 'Something went wrong. Try again.',
};

function fail(status, code, message) {
  throw new HttpError(status, code, message || DEFAULT_MESSAGES[code]);
}

function send(res, status, obj) {
  res.status(status).json(obj);
}

function sendError(res, status, code, message) {
  send(res, status, { error: code, message: message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.server_error });
}

function isJsonContentType(req) {
  const ct = req.headers && req.headers['content-type'];
  if (typeof ct !== 'string') return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

function originAllowed(req) {
  const origin = req.headers && req.headers.origin;
  if (origin == null) return true;
  if (typeof origin !== 'string') return false;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const reqHost = String((req.headers && req.headers.host) || '').trim().toLowerCase();
  return !!reqHost && host === reqHost;
}

function readBody(req, { optional } = {}) {
  let body;
  try { body = req.body; } catch { fail(400, 'bad_request', 'The request body is not valid JSON.'); }
  if (body == null || body === '') {
    if (optional) return {};
    fail(400, 'bad_request', 'The request body is missing.');
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { fail(400, 'bad_request', 'The request body is not valid JSON.'); }
  }
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')); } catch { fail(400, 'bad_request', 'The request body is not valid JSON.'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'bad_request', 'The request body must be a JSON object.');
  }
  return body;
}

function queryParam(req, name) {
  const v = req.query ? req.query[name] : undefined;
  return typeof v === 'string' ? v.trim() : '';
}

// ---------------------------------------------------------------- time (America/Chicago)

function chicagoParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return p;
}

function today(date) {
  const p = chicagoParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function nowStamp(date) {
  const p = chicagoParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------- validation

const FIELD_LABELS = {
  fit: 'Fit', status: 'Status', project: 'Project', owner: 'Customer', location: 'Location',
  state: 'State', type: 'Type', value: 'Value', size: 'Size', stage: 'Stage', opening: 'Opening',
  gc: 'General contractor', architect: 'Architect', whyFits: 'Why it fits', nextStep: 'Next step',
  nativeNote: 'Native preference note', source: 'Source', nextOwner: 'Owner of next step',
  nextDate: 'Next step date', notes: 'Notes', firstSeen: 'First seen', lastChecked: 'Last checked',
  bondRequired: 'Bond required',
  leadId: 'Lead ID', name: 'Name', title: 'Title or role', company: 'Company', email: 'Email',
  phone: 'Phone', verifiedAt: 'Where verified', type_activity: 'Type', note: 'What happened',
};

function label(key) {
  return FIELD_LABELS[key] || key;
}

// Validate and normalise one string value. Returns the trimmed string.
function cleanValue(key, value) {
  if (value === null) value = '';
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') fail(400, 'invalid_value', `${label(key)} must be text.`);
  const s = value.trim();
  if (s.length > S.maxLenFor(key)) {
    fail(400, 'invalid_value', `${label(key)} is too long (limit ${S.maxLenFor(key)} characters).`);
  }
  if (S.DATE_KEYS.has(key) && s !== '' && !S.isValidDate(s)) {
    fail(400, 'invalid_value', `${label(key)} must be a date written as YYYY-MM-DD.`);
  }
  if (key === 'status') {
    const st = S.STATUSES.find((x) => x.toLowerCase() === s.toLowerCase());
    if (!st) fail(400, 'invalid_value', `Status must be one of: ${S.STATUSES.join(', ')}.`);
    return st;
  }
  if (key === 'fit') {
    if (!S.FITS.includes(s.toUpperCase())) fail(400, 'invalid_value', 'Fit must be A, B, C or blank.');
    return s.toUpperCase();
  }
  if (key === 'bondRequired') {
    const b = S.BONDS.find((x) => x.toLowerCase() === s.toLowerCase());
    if (b === undefined) fail(400, 'invalid_value', 'Bond required must be Yes, No, Unknown or blank.');
    return b;
  }
  return s;
}

// Throws field_not_allowed for any key outside `allowed`.
function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) fail(400, 'field_not_allowed', `The field "${String(k).slice(0, 40)}" cannot be set here.`);
  }
}

// ---------------------------------------------------------------- wrapper

function logError(err) {
  // Log only the error class and, for our own errors, the code/status.
  const parts = [err && err.name ? err.name : 'Error'];
  if (err && err.code && typeof err.code === 'string') parts.push(err.code);
  if (err && typeof err.status === 'number') parts.push(String(err.status));
  console.error('[api] request failed:', parts.join(' '));
}

/**
 * handler({ GET: fn, POST: fn, ... }, { auth: true })
 * fn(ctx) receives { req, res, store, config, user, body } and returns
 * { status, body, headers } or sends itself.
 */
function handler(methods, opts = {}) {
  const requireAuth = opts.auth !== false;
  return async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const method = String(req.method || 'GET').toUpperCase();
      const config = getConfig();
      if (!config) return sendError(res, 503, 'not_configured');

      const fn = methods[method];
      if (!fn) {
        res.setHeader('Allow', Object.keys(methods).join(', '));
        return sendError(res, 405, 'method_not_allowed');
      }

      const mutating = method === 'POST' || method === 'PATCH';
      if (mutating) {
        if (!isJsonContentType(req)) {
          return sendError(res, 400, 'bad_request', 'Requests that change data must be sent as JSON.');
        }
        if (!originAllowed(req)) {
          return sendError(res, 400, 'bad_request', 'This request came from another site.');
        }
      }

      const store = getStore();
      const secure = !config.mock;
      const ctx = { req, res, store, config, secure, user: null, users: null };

      if (requireAuth) {
        const cookie = auth.readCookie(req);
        if (!cookie) return sendError(res, 401, 'signed_out');
        const email = auth.verifySession(config.sessionKey, cookie);
        if (!email) {
          res.setHeader('Set-Cookie', auth.clearCookie({ secure }));
          return sendError(res, 401, 'signed_out');
        }
        const users = await store.listUsers();
        const user = auth.userFromSession(config.sessionKey, cookie, users);
        if (!user) {
          res.setHeader('Set-Cookie', auth.clearCookie({ secure }));
          return sendError(res, 401, 'signed_out');
        }
        ctx.user = user;
        ctx.users = users;
      }

      const out = await fn(ctx);
      if (out && !res.writableEnded && !res.headersSent) {
        send(res, out.status || 200, out.body);
      }
    } catch (err) {
      if (res.headersSent || res.writableEnded) { logError(err); return; }
      if (err instanceof HttpError) {
        return sendError(res, err.status, err.code, err.publicMessage);
      }
      if (err instanceof StoreError && err.code === 'not_found') {
        return sendError(res, 404, 'not_found');
      }
      logError(err);
      if (err && err.name === 'GoogleError') return sendError(res, 500, 'sheet_unavailable');
      return sendError(res, 500, 'server_error');
    }
  };
}

module.exports = {
  HttpError, fail, handler, send, sendError, readBody, queryParam, isJsonContentType,
  originAllowed, today, nowStamp, cleanValue, onlyKeys, label, DEFAULT_MESSAGES,
};
