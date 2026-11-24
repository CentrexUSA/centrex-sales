'use strict';
const { handler } = require('../lib/http');

module.exports = handler({
  async GET(ctx) {
    const { name, email, role } = ctx.user;
    return { status: 200, body: { user: { name, email, role } } };
  },
});
