'use strict';
const { handler, readBody, fail, cleanValue, today, nowStamp } = require('../lib/http');
const auth = require('../lib/auth');
const S = require('../lib/schema');

const CREATABLE = new Set(auth.LEAD_FIELDS_ALL.filter((k) => k !== 'firstSeen' && k !== 'lastChecked'));

module.exports = handler({
  async GET(ctx) {
    const { store, user, users } = ctx;
    const all = await store.listLeads();
    const leads = all.filter((l) => auth.canSee(user, l, users));
    const people = user.role === 'Outside'
      ? [{ name: user.name, role: user.role }]
      : auth.people(users);
    const openBids = auth.canSeeOpenBids(user) ? await store.listOpenBids() : [];
    return {
      status: 200,
      body: { leads, people, openBids, statuses: S.STATUSES.slice(), today: today() },
    };
  },

  async POST(ctx) {
    const { req, store, user, users } = ctx;
    if (!auth.canAddLeads(user)) fail(400, 'not_allowed', 'Your role cannot add leads.');
    const body = readBody(req);

    const lead = {};
    for (const key of Object.keys(body)) {
      if (!CREATABLE.has(key)) {
        fail(400, 'field_not_allowed', `The field "${String(key).slice(0, 40)}" cannot be set when adding a lead.`);
      }
      if (key === 'status' && (body.status == null || body.status === '')) continue;
      if (key === 'nextOwner') continue;
      lead[key] = cleanValue(key, body[key]);
    }
    if (!lead.project) fail(400, 'invalid_value', 'Project name is required.');
    lead.status = lead.status || 'New';

    if (user.role === 'Sales' && body.nextOwner === undefined) {
      lead.nextOwner = user.name;
    } else if (body.nextOwner !== undefined) {
      const requested = cleanValue('nextOwner', body.nextOwner);
      const r = auth.checkNextOwner(user, null, requested, users);
      if (!r.ok) {
        fail(400, r.code, r.code === 'invalid_value'
          ? 'Owner of next step must be an active user or blank.'
          : 'You can only set the owner of next step to yourself or leave it blank.');
      }
      lead.nextOwner = r.value;
    } else {
      lead.nextOwner = '';
    }

    lead.firstSeen = today();
    lead.lastChecked = '';

    const saved = await store.appendLead(lead);
    await store.appendActivity({
      when: nowStamp(),
      leadId: saved.id,
      project: saved.project,
      by: user.name,
      type: 'Update',
      note: 'Lead added',
      nextStep: saved.nextStep || '',
      nextDate: saved.nextDate || '',
    });
    return { status: 201, body: { lead: saved } };
  },
});
