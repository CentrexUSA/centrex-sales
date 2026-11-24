// Thin JSON client for /api. Turns every failure into an ApiError with a plain message.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let unauthorizedHandler = () => {};
export function onUnauthorized(fn) { unauthorizedHandler = fn; }

export const NOT_CONFIGURED_MESSAGE =
  'The app is not connected to its data yet. Please contact Michael Mason.';

function friendly(status, code, serverMessage) {
  switch (code) {
    case 'network': return 'Could not reach the server. Check your signal and try again.';
    case 'invalid_login': return 'That email and access code do not match. Check both and try again.';
    case 'too_many_attempts': return 'Too many tries. Wait 15 minutes, then try again.';
    case 'not_configured': return NOT_CONFIGURED_MESSAGE;
    case 'signed_out': return 'You have been signed out. Sign in again to continue.';
    case 'not_found': return 'This is not available to you. It may have been reassigned or removed.';
    case 'field_not_allowed': return 'You are not allowed to change one of these fields.';
    case 'sheet_unavailable': return 'The lead sheet could not be reached. Try again in a minute.';
    default: break;
  }
  if (status === 400 && serverMessage) return String(serverMessage);
  if (status === 400) return 'Something in the form was not accepted. Check it and try again.';
  if (status === 429) return 'Too many requests. Wait a minute, then try again.';
  return 'Something went wrong on the server. Try again in a moment.';
}

export async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'network', friendly(0, 'network'));
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const code = (data && typeof data.error === 'string') ? data.error : `http_${res.status}`;
    const err = new ApiError(res.status, code, friendly(res.status, code, data && data.message));
    if (res.status === 401 && path !== '/api/login') unauthorizedHandler(err);
    throw err;
  }
  return data || {};
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b || {});
export const patch = (p, b) => api('PATCH', p, b || {});
