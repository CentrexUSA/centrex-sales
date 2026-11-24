'use strict';
const { handler, readBody, fail, cleanValue, onlyKeys, queryParam, today } = require('../lib/http');
const auth = require('../lib/auth');
const { findVisibleLead, normalizeContactId, sameId } = require('../lib/leads');

const EDITABLE = ['name', 'title', 'company', 'email', 'phone', 'verifiedAt', 'notes'];
const CREATE_KEYS = new Set(['leadId', ...EDITABLE]);
const PATCH_KEYS = new Set(EDITABLE);

module.exports = handler({
  async POST(ctx) {
    const { req, store, user } = ctx;
    const body = readBody(req);
    onlyKeys(body, CREATE_KEYS);
    const lead = await findVisibleLead(ctx, body.leadId, { fresh: true });

    const contact = { leadId: lead.id };
    for (const key of EDITABLE) {
      contact[key] = body[key] === undefined ? '' : cleanValue(key, body[key]);
    }
    if (!contact.name) fail(400, 'invalid_value', 'Contact name is required.');
    contact.addedBy = user.name;
    contact.addedOn = today();

    const saved = await store.appendContact(contact);
    return { status: 201, body: { contact: saved } };
  },

  async PATCH(ctx) {
    const { req, store, user, users } = ctx;
    const id = normalizeContactId(queryParam(req, 'id'));
    if (!id) fail(404, 'not_found');

    const all = await store.listContacts(undefined, { fresh: true });
    const matches = all.filter((c) => sameId(c.id, id));
    if (matches.length !== 1) fail(404, 'not_found');
    // The contact follows its lead's visibility; 404 either way.
    await findVisibleLead(ctx, matches[0].leadId, { fresh: true });

    const body = readBody(req);
    onlyKeys(body, PATCH_KEYS);
    const fields = {};
    for (const key of Object.keys(body)) {
      const v = cleanValue(key, body[key]);
      if (key === 'name' && !v) fail(400, 'invalid_value', 'Contact name is required.');
      if (v !== matches[0][key]) fields[key] = v;
    }
    if (!Object.keys(fields).length) return { status: 200, body: { contact: matches[0] } };

    const saved = await store.updateContact(id, fields);
    // Re-check in case the row's lead changed underneath us.
    const leads = await store.listLeads();
    const lead = leads.find((l) => sameId(l.id, saved.leadId));
    if (!lead || !auth.canSee(user, lead, users)) fail(404, 'not_found');
    return { status: 200, body: { contact: saved } };
  },
});
