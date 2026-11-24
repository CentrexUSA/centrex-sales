// Lead page: header, next step, contacts, activity with Log activity, project facts.
import { h, replace, fmtDate, fmtWhen, isISODate, norm, externalLink, telHref, mailHref,
  bindDraft, clearDraft, hasDraft, readForm } from '../dom.js';
import { get, patch, post } from '../api.js';
import { state, loadLeads, statuses, canClaim, canRelease, canEditDetails, canPickOwner,
  isUnassigned, ownerLabel, upsertLead, invalidate } from '../state.js';
import { statusChip, fitChip, dueLine, loadingView, errorView, emptyState, button, linkButton, field, textInput,
  textArea, select, dateField, formError, withSaving, showFormError, toast } from '../ui.js';
import { buildLogForm } from '../logform.js';

const FACTS = [
  ['type', 'Type'], ['value', 'Value'], ['size', 'Size'], ['stage', 'Stage'], ['opening', 'Opening'],
  ['gc', 'General contractor'], ['architect', 'Architect'], ['whyFits', 'Why it fits'],
  ['nativeNote', 'Native preference note'], ['source', 'Source'], ['notes', 'Notes'],
  ['firstSeen', 'First seen'], ['lastChecked', 'Last checked'],
];

// Manager "Edit details": every Projects field except the Lead ID.
const DETAIL_FIELDS = [
  ['project', 'Project', 'text'], ['owner', 'Customer', 'text'], ['status', 'Status', 'status'], ['fit', 'Fit', 'fit'],
  ['location', 'City', 'text'], ['state', 'State', 'text'], ['type', 'Type', 'text'], ['value', 'Value', 'text'],
  ['size', 'Size', 'text'], ['opening', 'Opening', 'text'], ['gc', 'General contractor', 'text'],
  ['architect', 'Architect', 'text'], ['stage', 'Stage', 'long'], ['whyFits', 'Why it fits', 'long'],
  ['nativeNote', 'Native preference note', 'long'], ['source', 'Source link', 'url'],
  ['nextStep', 'Next step', 'long'], ['nextOwner', 'Owner of next step', 'owner'], ['nextDate', 'Next step date', 'date'],
  ['notes', 'Notes', 'long'], ['firstSeen', 'First seen', 'date'], ['lastChecked', 'Last checked', 'text'],
];

const CONTACT_FIELDS = [
  ['name', 'Name', { required: true, autocomplete: 'off' }],
  ['title', 'Title or role', {}],
  ['company', 'Company', {}],
  ['phone', 'Phone', { type: 'tel', inputmode: 'tel' }],
  ['email', 'Email', { type: 'email', inputmode: 'email' }],
  ['verifiedAt', 'Where verified', { hint: 'Where this contact detail came from: a web page link, a business card, a phone call.' }],
  ['notes', 'Notes', { long: true }],
];

function ownerPicker(current) {
  const people = (state.data && state.data.people) || [];
  const cur = String(current || '').trim();
  const opts = people.map((p) => ({
    value: String(p.name),
    label: `${p.name}${state.user && norm(p.name) === norm(state.user.name) ? ' (you)' : ''}${p.role ? ` · ${p.role}` : ''}`,
  }));
  opts.push({ value: '', label: 'No one (unassigned)' });
  if (cur && !people.some((p) => norm(p.name) === norm(cur))) opts.unshift({ value: cur, label: `${cur} (not a user)` });
  const match = people.find((p) => norm(p.name) === norm(cur));
  return select('nextOwner', opts, match ? String(match.name) : cur);
}

function changed(orig, values, keys) {
  const out = {};
  for (const k of keys) {
    if (!(k in values)) continue;
    const a = String(orig[k] == null ? '' : orig[k]);
    const b = String(values[k] == null ? '' : values[k]);
    if (a.trim() !== b.trim()) out[k] = b.trim();
  }
  return out;
}

export async function renderLead(main, ctx) {
  const id = ctx.params[0] || '';
  replace(main, loadingView('Loading lead…'));
  let model;
  try {
    const [d] = await Promise.all([get(`/api/lead?id=${encodeURIComponent(id)}`), loadLeads()]);
    model = {
      lead: d.lead || {},
      contacts: Array.isArray(d.contacts) ? d.contacts : [],
      activity: Array.isArray(d.activity) ? d.activity : [],
    };
  } catch (e) {
    if (e.status === 401) return;
    if (!ctx.isCurrent()) return;
    if (e.status === 404) {
      replace(main, backLink(), emptyState('This lead is not available to you.',
        'It may have been reassigned to someone else. Check Today or Pipeline for your current leads.',
        linkButton('Go to Today', '#/today', 'primary'), linkButton('Open Pipeline', '#/pipeline', 'secondary')));
      return;
    }
    replace(main, backLink(), errorView(e, () => renderLead(main, ctx)));
    return;
  }
  if (!ctx.isCurrent()) return;
  upsertLead(model.lead);
  new LeadPage(main, model, ctx).mount();
}

function backLink() {
  const target = state.lastList || '#/today';
  return h('a', { class: 'back', href: target }, `Back to ${target.startsWith('#/pipeline') ? 'Pipeline' : 'Today'}`);
}

class LeadPage {
  constructor(main, model, ctx) {
    this.main = main;
    this.m = model;
    this.ctx = ctx;
    this.id = model.lead.id;
    this.edit = { next: false, details: false, log: false, newContact: false, contacts: new Set() };
    this.el = {
      head: h('header', { class: 'lead-head' }),
      next: h('section', { class: 'panel next-block', 'aria-labelledby': 'next-h' }),
      contacts: h('section', { class: 'panel', 'aria-labelledby': 'contacts-h' }),
      activity: h('section', { class: 'panel', 'aria-labelledby': 'activity-h', id: 'activity' }),
      facts: h('section', { class: 'panel', 'aria-labelledby': 'facts-h' }),
    };
    this.logHost = h('div', { class: 'log-host' });
    this.timeline = h('div', { class: 'timeline-host' });
  }

  mount() {
    // Reopen any form that still holds a draft (after a failed save, a sign-in, or navigating away).
    this.edit.next = hasDraft(`next:${this.id}`);
    this.edit.details = canEditDetails() && hasDraft(`details:${this.id}`);
    this.edit.log = hasDraft(`log:${this.id}`) || this.ctx.query.get('log') === '1';
    this.edit.newContact = hasDraft(`contact-new:${this.id}`);
    for (const c of this.m.contacts) if (hasDraft(`contact:${c.id}`)) this.edit.contacts.add(c.id);

    replace(this.main,
      backLink(),
      this.el.head,
      h('div', { class: 'lead-grid' },
        h('div', { class: 'lead-main' }, this.el.next, this.el.activity),
        h('div', { class: 'lead-side' }, this.el.contacts, this.el.facts)));
    this.renderAll();
    if (this.ctx.query.get('log') === '1') this.focusLog();
  }

  renderAll() {
    this.renderHead();
    this.renderNext();
    this.renderContacts();
    this.renderActivity();
    this.renderFacts();
  }

  async reload() {
    try {
      const d = await get(`/api/lead?id=${encodeURIComponent(this.id)}`);
      this.m.lead = d.lead || this.m.lead;
      this.m.contacts = Array.isArray(d.contacts) ? d.contacts : this.m.contacts;
      this.m.activity = Array.isArray(d.activity) ? d.activity : this.m.activity;
      upsertLead(this.m.lead);
    } catch (e) {
      if (e.status === 404 && this.ctx.isCurrent()) { renderLead(this.main, this.ctx); return; }
      // Keep showing what we have; the save itself already succeeded.
    }
    if (!this.ctx.isCurrent()) return;
    this.renderHead();
    if (!this.edit.next) this.renderNext();
    if (!this.edit.details) this.renderFacts();
    this.renderTimeline();
    if (!this.edit.newContact && !this.edit.contacts.size) this.renderContacts();
  }

  // ---------- header ----------
  renderHead() {
    const l = this.m.lead;
    const where = [l.location, l.state].filter((x) => String(x || '').trim()).join(', ');
    replace(this.el.head,
      h('p', { class: 'kicker' }, String(l.id || '')),
      h('h1', { id: 'page-h1', tabindex: '-1' }, String(l.project || '(No project name)')),
      (l.owner || where) ? h('p', { class: 'lead-sub' },
        l.owner ? h('span', { class: 'customer' }, String(l.owner)) : null,
        l.owner && where ? ' · ' : null,
        where || null) : null,
      h('div', { class: 'chips' }, statusChip(l.status), fitChip(l.fit) || h('span', { class: 'chip chip-none' }, 'Fit not rated')));
    document.title = `${l.project || 'Lead'} · Centrex Sales`;
  }

  // ---------- next step ----------
  renderNext() {
    const l = this.m.lead;
    const box = this.el.next;
    if (this.edit.next) { replace(box, this.nextForm()); return; }
    const step = String(l.nextStep || '').trim();
    const actions = [
      button('Log activity', { variant: 'primary', onClick: () => this.focusLog() }),
      button('Change next step', { variant: 'secondary', onClick: () => { this.edit.next = true; this.renderNext(); this.focusIn(box); } }),
    ];
    if (canClaim(l) && !canPickOwner()) actions.push(button('Claim this lead', { variant: 'secondary', onClick: (e) => this.setOwner(state.user.name, e.currentTarget, 'Claimed. This lead is now yours.') }));
    if (canClaim(l) && canPickOwner()) actions.push(button('Take it myself', { variant: 'ghost', onClick: (e) => this.setOwner(state.user.name, e.currentTarget, 'You are now the owner of the next step.') }));
    if (canRelease(l)) actions.push(button('Unassign me', { variant: 'ghost', onClick: (e) => this.setOwner('', e.currentTarget, 'You are no longer the owner. The lead is now unassigned.') }));

    replace(box,
      h('h2', { id: 'next-h', class: 'section-title' }, 'Next step'),
      step ? h('p', { class: 'next-big' }, step) : h('p', { class: 'next-big muted' }, 'No next step set'),
      h('dl', { class: 'next-meta' },
        h('div', null, h('dt', null, 'Date'), h('dd', null, dueLine(l.nextDate))),
        h('div', null, h('dt', null, 'Owner of next step'), h('dd', { class: isUnassigned(l) ? 'muted' : '' }, ownerLabel(l)))),
      h('div', { class: 'btn-row' }, actions));
  }

  nextForm() {
    const l = this.m.lead;
    const key = `next:${this.id}`;
    const errorBox = formError();
    const stepInput = textArea('nextStep', l.nextStep || '', { rows: 2 });
    const { wrap: dateWrap, input: dateInput } = dateField('Next step date', 'nextDate', l.nextDate || '', { allowClear: true });
    const statusSel = select('status', statuses(), String(l.status || '').trim() || statuses()[0]);
    if (String(l.status || '').trim() && !statuses().includes(String(l.status).trim())) {
      statusSel.insertBefore(h('option', { value: String(l.status) }, String(l.status)), statusSel.firstChild);
      statusSel.value = String(l.status);
    }
    const ownerSel = canPickOwner() ? ownerPicker(l.nextOwner) : null;
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
    const form = h('form', { class: 'stack', noValidate: true },
      h('h2', { id: 'next-h', class: 'section-title' }, 'Change next step'),
      field('Next step', stepInput),
      dateWrap,
      field('Status', statusSel),
      ownerSel ? field('Owner of next step', ownerSel) : null,
      errorBox,
      h('div', { class: 'form-actions' }, submit,
        button('Cancel', { variant: 'ghost', onClick: () => { clearDraft(key); this.edit.next = false; this.renderNext(); } })));
    if (bindDraft(form, key)) { form.insertBefore(h('p', { class: 'note-restored' }, 'Restored what you typed earlier.'), form.children[1]); dateWrap.refresh(); }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = readForm(form);
      if (v.nextDate && !isISODate(v.nextDate)) { showFormError(errorBox, 'The next step date needs to be a real date.'); dateInput.focus(); return; }
      const keys = ['nextStep', 'nextDate', 'status'].concat(ownerSel ? ['nextOwner'] : []);
      const body = changed(l, v, keys);
      if (!Object.keys(body).length) { clearDraft(key); this.edit.next = false; this.renderNext(); toast('No changes to save.'); return; }
      const r = await withSaving(form, submit, errorBox, () => patch(`/api/lead?id=${encodeURIComponent(this.id)}`, body));
      if (!r) return;
      clearDraft(key);
      this.edit.next = false;
      this.m.lead = r.lead || this.m.lead;
      upsertLead(this.m.lead);
      invalidate();
      toast('Next step saved.');
      this.renderHead();
      this.renderNext();
      this.reload();
    });
    return form;
  }

  async setOwner(name, btn, message) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await patch(`/api/lead?id=${encodeURIComponent(this.id)}`, { nextOwner: name });
      this.m.lead = r.lead || this.m.lead;
      upsertLead(this.m.lead);
      invalidate();
      toast(message);
      this.renderNext();
      this.reload();
    } catch (e) {
      if (e.status === 401) return;
      btn.disabled = false;
      btn.textContent = label;
      toast(`Not saved. ${e.message}`);
    }
  }

  // ---------- activity ----------
  focusLog() {
    this.edit.log = true;
    this.renderLog();
    const form = this.logHost.querySelector('form');
    this.el.activity.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (form && form.focusFirst) setTimeout(() => form.focusFirst(), 50);
  }

  renderActivity() {
    replace(this.el.activity,
      h('div', { class: 'section-head' },
        h('h2', { id: 'activity-h', class: 'section-title' }, 'Activity'),
        this.edit.log ? null : button('Log activity', { variant: 'secondary', class: 'btn-small', onClick: () => this.focusLog() })),
      this.logHost,
      this.timeline);
    this.renderLog();
    this.renderTimeline();
  }

  renderLog() {
    if (!this.edit.log) { replace(this.logHost); return; }
    const head = this.el.activity.querySelector('.section-head .btn');
    if (head) head.remove();
    const form = buildLogForm(this.m.lead, {
      onSaved: (r) => {
        this.edit.log = false;
        if (r.lead) this.m.lead = r.lead;
        if (r.activity) this.m.activity.unshift(r.activity);
        this.renderHead();
        this.renderNext();
        this.renderActivity();
        this.reload();
      },
      onCancel: () => { this.edit.log = false; this.renderActivity(); },
    });
    replace(this.logHost, h('div', { class: 'log-box' }, h('h3', { class: 'sub-title' }, 'Log activity'), form));
  }

  renderTimeline() {
    const t = state.data ? state.data.today : '';
    const items = this.m.activity;
    if (!items.length) {
      replace(this.timeline, h('p', { class: 'muted empty-inline' }, 'Nothing logged yet. After your first call or email, log it here.'));
      return;
    }
    const LIMIT = 15;
    const draw = (all) => {
      const list = all ? items : items.slice(0, LIMIT);
      replace(this.timeline,
        h('ol', { class: 'timeline' }, list.map((a) => {
          const isUpdate = String(a.type || '') === 'Update';
          return h('li', { class: `tl-item${isUpdate ? ' tl-update' : ''}` },
            h('div', { class: 'tl-meta' },
              h('span', { class: 'chip chip-type' }, String(a.type || 'Note')),
              h('span', { class: 'tl-when' }, fmtWhen(a.when, t)),
              a.by ? h('span', { class: 'tl-by' }, String(a.by)) : null),
            a.note ? h('p', { class: 'tl-note' }, String(a.note)) : null,
            (a.nextStep || a.nextDate) ? h('p', { class: 'tl-next' },
              h('span', { class: 'label' }, 'Next step set: '),
              String(a.nextStep || ''),
              a.nextStep && a.nextDate ? ', ' : '',
              a.nextDate ? (isISODate(a.nextDate) ? fmtDate(a.nextDate, t) : String(a.nextDate)) : '') : null);
        })),
        !all && items.length > LIMIT ? button(`Show all ${items.length}`, { variant: 'ghost', class: 'btn-small', onClick: () => draw(true) }) : null);
    };
    draw(false);
  }

  // ---------- contacts ----------
  renderContacts() {
    const box = this.el.contacts;
    const list = this.m.contacts;
    const addBtn = this.edit.newContact ? null
      : button('Add contact', { variant: 'secondary', class: 'btn-small', onClick: () => { this.edit.newContact = true; this.renderContacts(); this.focusIn(box.querySelector('.contact-form')); } });
    replace(box,
      h('div', { class: 'section-head' }, h('h2', { id: 'contacts-h', class: 'section-title' }, 'Contacts', h('span', { class: 'count' }, String(list.length))), addBtn),
      this.edit.newContact ? this.contactForm(null) : null,
      list.length ? h('ul', { class: 'contacts' }, list.map((c) => h('li', null, this.edit.contacts.has(c.id) ? this.contactForm(c) : this.contactCard(c))))
        : (this.edit.newContact ? null : h('p', { class: 'muted empty-inline' }, 'No contacts yet. Add the person you need to reach, and note where you found their details.')));
  }

  contactCard(c) {
    const t = state.data ? state.data.today : '';
    const tel = telHref(c.phone);
    const mail = mailHref(c.email);
    const sub = [c.title, c.company].filter((x) => String(x || '').trim()).join(' · ');
    return h('div', { class: 'contact' },
      h('div', { class: 'contact-head' },
        h('div', null,
          h('p', { class: 'contact-name' }, String(c.name || '(No name)')),
          sub ? h('p', { class: 'contact-sub' }, sub) : null),
        button('Edit', { variant: 'ghost', class: 'btn-small', ariaLabel: `Edit ${c.name || 'contact'}`, onClick: () => { this.edit.contacts.add(c.id); this.renderContacts(); } })),
      (c.phone || c.email) ? h('div', { class: 'contact-links' },
        c.phone ? (tel ? h('a', { class: 'btn btn-secondary btn-contact', href: tel }, `Call ${c.phone}`) : h('span', { class: 'plain' }, `Phone: ${c.phone}`)) : null,
        c.email ? (mail ? h('a', { class: 'btn btn-secondary btn-contact', href: mail }, `Email ${c.email}`) : h('span', { class: 'plain' }, `Email: ${c.email}`)) : null) : null,
      h('p', { class: 'contact-verified' }, h('span', { class: 'label' }, 'Where verified: '),
        String(c.verifiedAt || '').trim() ? externalLink(c.verifiedAt) : h('span', { class: 'muted' }, 'Not recorded')),
      c.notes ? h('p', { class: 'contact-notes' }, String(c.notes)) : null,
      (c.addedBy || c.addedOn) ? h('p', { class: 'contact-added' },
        'Added', c.addedBy ? ` by ${c.addedBy}` : '', c.addedOn ? ` on ${isISODate(c.addedOn) ? fmtDate(c.addedOn, t) : c.addedOn}` : '') : null);
  }

  contactForm(c) {
    const isNew = !c;
    const key = isNew ? `contact-new:${this.id}` : `contact:${c.id}`;
    const orig = c || {};
    const errorBox = formError();
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Add contact' : 'Save contact');
    const close = () => {
      clearDraft(key);
      if (isNew) this.edit.newContact = false; else this.edit.contacts.delete(c.id);
      this.renderContacts();
    };
    const inputs = {};
    const form = h('form', { class: 'contact-form stack', noValidate: true },
      h('h3', { class: 'sub-title' }, isNew ? 'Add contact' : `Edit ${c.name || 'contact'}`),
      h('div', { class: 'form-grid' }, CONTACT_FIELDS.map(([k, label, o]) => {
        const attrs = {};
        if (o.type) attrs.type = o.type;
        if (o.inputmode) attrs.inputmode = o.inputmode;
        const ctl = o.long ? textArea(k, orig[k] || '', { rows: 2 }) : textInput(k, orig[k] || '', attrs);
        inputs[k] = ctl;
        return field(label, ctl, { required: o.required, hint: o.hint, class: o.long || k === 'verifiedAt' ? 'span-2' : '' });
      })),
      errorBox,
      h('div', { class: 'form-actions' }, submit, button('Cancel', { variant: 'ghost', onClick: close })));
    if (bindDraft(form, key)) form.insertBefore(h('p', { class: 'note-restored' }, 'Restored what you typed earlier.'), form.children[1]);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = readForm(form);
      if (!String(v.name || '').trim()) { showFormError(errorBox, 'Enter the contact’s name.'); inputs.name.focus(); return; }
      let call;
      if (isNew) {
        const body = { leadId: this.id };
        for (const [k] of CONTACT_FIELDS) if (String(v[k] || '').trim()) body[k] = v[k].trim();
        call = () => post('/api/contacts', body);
      } else {
        const body = changed(orig, v, CONTACT_FIELDS.map(([k]) => k));
        if (!Object.keys(body).length) { close(); toast('No changes to save.'); return; }
        call = () => patch(`/api/contacts?id=${encodeURIComponent(c.id)}`, body);
      }
      const r = await withSaving(form, submit, errorBox, call);
      if (!r) return;
      clearDraft(key);
      if (r.contact) {
        if (isNew) this.m.contacts.push(r.contact);
        else this.m.contacts = this.m.contacts.map((x) => (x.id === c.id ? r.contact : x));
      }
      if (isNew) this.edit.newContact = false; else this.edit.contacts.delete(c.id);
      toast(isNew ? 'Contact added.' : 'Contact saved.');
      this.renderContacts();
    });
    return form;
  }

  // ---------- facts ----------
  renderFacts() {
    const box = this.el.facts;
    const l = this.m.lead;
    const t = state.data ? state.data.today : '';
    if (this.edit.details) { replace(box, this.detailsForm()); return; }
    replace(box,
      h('div', { class: 'section-head' },
        h('h2', { id: 'facts-h', class: 'section-title' }, 'Project facts'),
        canEditDetails() ? button('Edit details', { variant: 'secondary', class: 'btn-small', onClick: () => { this.edit.details = true; this.renderFacts(); this.focusIn(box); } }) : null),
      h('dl', { class: 'facts' }, FACTS.map(([k, label]) => {
        const raw = String(l[k] == null ? '' : l[k]).trim();
        let val;
        if (!raw) val = h('span', { class: 'muted' }, '–');
        else if (k === 'source') val = externalLink(raw);
        else if ((k === 'firstSeen' || k === 'lastChecked') && isISODate(raw)) val = fmtDate(raw, t);
        else val = raw;
        const long = ['stage', 'whyFits', 'nativeNote', 'notes', 'source'].includes(k);
        return h('div', { class: `fact${long ? ' fact-long' : ''}` }, h('dt', null, label), h('dd', null, val));
      })));
  }

  detailsForm() {
    const l = this.m.lead;
    const key = `details:${this.id}`;
    const errorBox = formError();
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save details');
    const close = () => { clearDraft(key); this.edit.details = false; this.renderFacts(); };
    let projectInput = null;
    const dateWraps = [];
    const form = h('form', { class: 'stack details-form', noValidate: true },
      h('h2', { id: 'facts-h', class: 'section-title' }, 'Edit details'),
      h('div', { class: 'form-grid' }, DETAIL_FIELDS.map(([k, label, kind]) => {
        const v = l[k] == null ? '' : String(l[k]);
        if (kind === 'date') {
          const { wrap } = dateField(label, k, v, k === 'firstSeen' ? { picks: false, relative: false } : { allowClear: true });
          dateWraps.push(wrap);
          return wrap;
        }
        let ctl;
        if (kind === 'status') {
          const opts = statuses().slice();
          if (v.trim() && !opts.includes(v.trim())) opts.unshift(v.trim());
          ctl = select(k, opts, v.trim() || opts[0]);
        } else if (kind === 'fit') {
          const opts = [{ value: '', label: 'Not rated' }, 'A', 'B', 'C'];
          if (v.trim() && !['A', 'B', 'C'].includes(v.trim())) opts.push(v.trim());
          ctl = select(k, opts, v.trim());
        } else if (kind === 'owner') {
          ctl = ownerPicker(v);
        } else if (kind === 'long') {
          ctl = textArea(k, v, { rows: 3 });
        } else {
          ctl = textInput(k, v, kind === 'url' ? { inputmode: 'url', placeholder: 'https://…' } : {});
        }
        if (k === 'project') { projectInput = ctl; }
        return field(label, ctl, { required: k === 'project', class: kind === 'long' || kind === 'url' ? 'span-2' : '' });
      })),
      errorBox,
      h('div', { class: 'form-actions' }, submit, button('Cancel', { variant: 'ghost', onClick: close })));
    if (bindDraft(form, key)) { form.insertBefore(h('p', { class: 'note-restored' }, 'Restored what you typed earlier.'), form.children[1]); dateWraps.forEach((w) => w.refresh()); }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = readForm(form);
      if (!String(v.project || '').trim()) { showFormError(errorBox, 'Project name is required.'); projectInput.focus(); return; }
      for (const k of ['nextDate', 'firstSeen']) {
        if (v[k] && !isISODate(v[k])) { showFormError(errorBox, 'Dates need to be real dates in the form YYYY-MM-DD.'); return; }
      }
      const body = changed(l, v, DETAIL_FIELDS.map(([k]) => k));
      if (!Object.keys(body).length) { close(); toast('No changes to save.'); return; }
      const r = await withSaving(form, submit, errorBox, () => patch(`/api/lead?id=${encodeURIComponent(this.id)}`, body));
      if (!r) return;
      clearDraft(key);
      this.edit.details = false;
      this.m.lead = r.lead || this.m.lead;
      upsertLead(this.m.lead);
      invalidate();
      toast('Details saved.');
      this.renderHead();
      this.renderFacts();
      if (!this.edit.next) this.renderNext();
      this.reload();
    });
    return form;
  }

  focusIn(container) {
    if (!container) return;
    const first = container.querySelector('input:not([type=hidden]), textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
  }
}

// Exposed for Node checks.
export { changed as _changed };
