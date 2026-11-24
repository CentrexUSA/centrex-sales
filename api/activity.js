'use strict';
const { handler, readBody, fail, cleanValue, onlyKeys, nowStamp } = require('../lib/http');
const auth = require('../lib/auth');
const S = require('../lib/schema');
const { findVisibleLead, leadChanges } = require('../lib/leads');

const KEYS = new Set(['leadId', 'type', 'note', 'nextStep', 'nextDate', 'status']);

module.exports = handler({
  async POST(ctx) {
    const { req, store, user, users } = ctx;
    const body = readBody(req);
    onlyKeys(body, KEYS);
    const lead = await findVisibleLead(ctx, body.leadId, { fresh: true });

    const typeRaw = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
    const type = S.ACTIVITY_TYPES.find((t) => t.toLowerCase() === typeRaw);
    if (!type) fail(400, 'invalid_value', `Type must be one of: ${S.ACTIVITY_TYPES.join(', ')}.`);
    const note = cleanValue('note', body.note === undefined ? '' : body.note);
    if (!note) fail(400, 'invalid_value', 'Say what happened.');

    // Optional lead updates. An empty value means "no change" here.
    const requested = {};
    for (const key of ['nextStep', 'nextDate', 'status']) {
      const raw = body[key];
      if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue;
      requested[key] = cleanValue(key, raw);
    }
    // Validates role permissions; throws before anything is written.
    const changes = leadChanges(user, lead, requested, users);

    const activity = await store.appendActivity({
      when: nowStamp(),
      leadId: lead.id,
      project: lead.project,
      by: user.name,
      type,
      note,
      nextStep: requested.nextStep || '',
      nextDate: requested.nextDate || '',
    });

    let updated = lead;
    if (Object.keys(changes).length) updated = await store.updateLead(lead.id, changes);
    return {
      status: 201,
      body: { activity, lead: auth.canSee(user, updated, users) ? updated : null },
    };
  },
});
