'use strict';
const { handler } = require('../lib/http');
const auth = require('../lib/auth');

module.exports = handler({
  async POST(ctx) {
    ctx.res.setHeader('Set-Cookie', auth.clearCookie({ secure: ctx.secure }));
    return { status: 200, body: { ok: true } };
  },
}, { auth: false });
