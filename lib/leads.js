'use strict';
// Lead rules shared by api/leads.js, api/lead.js, api/activity.js, api/contacts.js.

const auth = require('./auth');
const { fail, cleanValue, label } = require('./http');
const S = require('./schema');

function normalizeLeadId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^L-\d{1,9}$/i.test(s) ? s.toUpperCase() : null;
}

function normalizeContactId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^C-\d{1,9}$/i.test(s) ? s.toUpperCase() : null;
}

function sameId(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
}

// Returns the lead if it exists and the user may see it; otherwise 404.
// `fresh` re-reads the sheet (used before writes).
async function findVisibleLead(ctx, rawId, { fresh } = {}) {
  const id = normalizeLeadId(rawId);
  if (!id) fail(404, 'not_found');
  const leads = await ctx.store.listLeads(fresh ? { fresh: true } : undefined);
  const matches = leads.filter((l) => sameId(l.id, id));
  if (matches.length !== 1) fail(404, 'not_found');
  const lead = matches[0];
  if (!auth.canSee(ctx.user, lead, ctx.users)) fail(404, 'not_found');
  return lead;
}

// Work out which lead fields change. Disallowed fields are rejected unless the
// value sent equals the stored value. Unknown fields are always rejected.
function leadChanges(user, lead, body, users) {
  const known = new Set(auth.LEAD_FIELDS_ALL);
  const editable = auth.editableLeadFields(user);
  const changes = {};
  for (const key of Object.keys(body)) {
    if (!known.has(key)) {
      fail(400, 'field_not_allowed', `The field "${String(key).slice(0, 40)}" cannot be changed.`);
    }
    const value = cleanValue(key, body[key]);
    if (key === 'project' && value === '') fail(400, 'invalid_value', 'Project name is required.');
    const current = lead[key] || '';
    if (key === 'nextOwner') {
      if (!editable.has('nextOwner')) {
        if (S.norm(value) === S.norm(current)) continue;
        fail(400, 'field_not_allowed', 'Your role cannot change the owner of next step.');
      }
      const r = auth.checkNextOwner(user, lead, value, users);
      if (!r.ok) {
        fail(400, r.code, r.code === 'invalid_value'
          ? 'Owner of next step must be an active user or blank.'
          : 'You can only claim a lead for yourself or clear your own name.');
      }
      if (r.value !== current) changes.nextOwner = r.value;
      continue;
    }
    if (!editable.has(key)) {
      if (value === current) continue;
      fail(400, 'field_not_allowed', `Your role cannot change ${label(key).toLowerCase()}.`);
    }
    if (value !== current) changes[key] = value;
  }
  return changes;
}

const ORDER = auth.LEAD_FIELDS_ALL;

function describeChanges(changes) {
  const parts = [];
  for (const key of ORDER) {
    if (!(key in changes)) continue;
    const name = label(key);
    const lower = key === 'gc' ? 'general contractor' : name.charAt(0).toLowerCase() + name.slice(1);
    const v = changes[key];
    if (v === '') parts.push(`cleared ${lower}`);
    else if (S.LONG_KEYS.has(key) || v.length > 120) parts.push(`updated ${lower}`);
    else parts.push(`${lower} to ${v}`);
  }
  if (!parts.length) return '';
  const first = parts[0];
  const head = first.startsWith('cleared ') || first.startsWith('updated ')
    ? first.charAt(0).toUpperCase() + first.slice(1)
    : `Changed ${first}`;
  return [head, ...parts.slice(1)].join('; ');
}

function newestFirst(rows) {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.when < b.r.when ? 1 : a.r.when > b.r.when ? -1 : b.i - a.i))
    .map((x) => x.r);
}

module.exports = {
  newestFirst, normalizeLeadId, normalizeContactId, findVisibleLead, leadChanges, describeChanges, sameId,
};
