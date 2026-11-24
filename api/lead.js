'use strict';
const { handler, readBody, queryParam, nowStamp } = require('../lib/http');
const auth = require('../lib/auth');
const { findVisibleLead, leadChanges, describeChanges, newestFirst } = require('../lib/leads');

module.exports = handler({
  async GET(ctx) {
    const lead = await findVisibleLead(ctx, queryParam(ctx.req, 'id'));
    const [contacts, activity] = await Promise.all([
      ctx.store.listContacts(lead.id),
      ctx.store.listActivity(lead.id),
    ]);
    return { status: 200, body: { lead, contacts, activity: newestFirst(activity) } };
  },

  async PATCH(ctx) {
    const { req, store, user, users } = ctx;
    const lead = await findVisibleLead(ctx, queryParam(req, 'id'), { fresh: true });
    const body = readBody(req);
    const changes = leadChanges(user, lead, body, users);
    if (!Object.keys(changes).length) return { status: 200, body: { lead } };

    const updated = await store.updateLead(lead.id, changes);
    await store.appendActivity({
      when: nowStamp(),
      leadId: updated.id,
      project: updated.project,
      by: user.name,
      type: 'Update',
      note: describeChanges(changes),
      nextStep: 'nextStep' in changes ? changes.nextStep : '',
      nextDate: 'nextDate' in changes ? changes.nextDate : '',
    });
    return {
      status: 200,
      body: { lead: auth.canSee(user, updated, users) ? updated : null },
    };
  },
});
