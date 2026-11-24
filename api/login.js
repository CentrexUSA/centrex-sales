'use strict';
const { handler, readBody, sendError } = require('../lib/http');
const auth = require('../lib/auth');

const FAIL_DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = handler({
  async POST(ctx) {
    const { req, res, store, config, secure } = ctx;
    const body = readBody(req);
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
    const code = typeof body.code === 'string' ? body.code.slice(0, 300) : '';
    const ip = auth.clientIp(req);

    if (auth.isThrottled(email, ip)) {
      return sendError(res, 429, 'too_many_attempts');
    }

    const users = await store.listUsers();
    const user = email && code ? auth.checkLogin(users, email, code) : null;
    if (!user) {
      auth.recordFailure(email, ip);
      await sleep(FAIL_DELAY_MS + Math.floor(Math.random() * 100));
      return sendError(res, 401, 'invalid_login');
    }

    auth.clearFailures(email);
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.signSession(config.sessionKey, user.email, Date.now(), code), { secure }));
    return { status: 200, body: { user: { name: user.name, email: user.email, role: user.role } } };
  },
}, { auth: false });
