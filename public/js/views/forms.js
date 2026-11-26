// Sign in, Add lead and Open bids screens.
import { h, replace, bindDraft, clearDraft, readForm, isISODate, fmtDate, daysFrom, parseISO, norm, safeHttpUrl } from '../dom.js';
import { post, NOT_CONFIGURED_MESSAGE } from '../api.js';
import { state, loadLeads, isManager, isSales, canAddLead, canSeeBids, upsertLead, invalidate } from '../state.js';
import { field, textInput, textArea, select, dateField, formError, withSaving, showFormError, toast, loadingView,
  errorView, emptyState, pageHeader, linkButton } from '../ui.js';

// ---------- Sign in ----------
export function renderSignIn(main, ctx) {
  const errorBox = formError();
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true });
  const code = h('input', { type: 'password', name: 'code', autocomplete: 'current-password', required: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');
  try { email.value = localStorage.getItem('cx-last-email') || ''; } catch { /* ignore */ }

  const notice = ctx.notice ? h('p', { class: 'signin-notice', role: 'status' }, ctx.notice) : null;
  const form = h('form', { class: 'stack', noValidate: true },
    notice,
    field('Email', email),
    field('Access code', code, { hint: 'The code you were given for this app. Ask Michael Mason if you do not have one.' }),
    errorBox,
    submit);


  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !code.value) {
      showFormError(errorBox, 'Enter your email and access code.');
      (email.value.trim() ? code : email).focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    errorBox.hidden = true;
    if (notice) notice.hidden = true;
    try {
      const r = await post('/api/login', { email: email.value.trim(), code: code.value });
      try { localStorage.setItem('cx-last-email', email.value.trim()); } catch { /* ignore */ }
      ctx.onSignedIn(r.user);
    } catch (err) {
      const msg = err.code === 'not_configured' ? NOT_CONFIGURED_MESSAGE : err.message;
      showFormError(errorBox, msg);
      code.select();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  replace(main, h('div', { class: 'signin' },
    h('div', { class: 'signin-card' },
      h('p', { class: 'brand-mark' }, 'Centrex Flooring'),
      h('h1', { id: 'page-h1', tabindex: '-1' }, 'Sign in to Centrex Sales'),
      h('p', { class: 'muted' }, 'Your leads, next steps and contacts.'),
      form)));
  setTimeout(() => (email.value ? code : email).focus(), 0);
}

// ---------- Add lead ----------
const ADD_FIELDS = [
  ['project', 'Project', { required: true, hint: 'Name of the building or job, for example "WinStar Tower 3 corridors".' }],
  ['owner', 'Customer', { hint: 'The tribe or business that owns the project.' }],
  ['location', 'City', {}],
  ['state', 'State', { attrs: { autocapitalize: 'characters', maxlength: '20' } }],
  ['type', 'Type', { hint: 'Hotel, casino, hospital, office, school…' }],
  ['value', 'Value', { hint: 'Rough dollar value if known.' }],
  ['size', 'Size', { hint: 'Square feet, rooms or floors.' }],
  ['stage', 'Stage', { long: true, hint: 'Where the project stands: planning, design, bidding, under construction.' }],
  ['gc', 'General contractor', {}],
  ['architect', 'Architect', {}],
  ['bondRequired', 'Bond required', { bond: true, hint: 'Does the bid or contract call for a bid, performance or payment bond?' }],
  ['source', 'Source link', { attrs: { inputmode: 'url', placeholder: 'https://…' }, hint: 'Where you heard about it.' }],
];

export async function renderAddLead(main, ctx) {
  if (!canAddLead()) {
    replace(main, emptyState('Adding leads is not part of your role.', 'Ask a manager to add the lead and assign it to you.', linkButton('Go to Today', '#/today', 'primary')));
    return;
  }
  replace(main, loadingView());
  try { await loadLeads(); } catch (e) {
    if (e.status === 401) return;
    replace(main, errorView(e, () => renderAddLead(main, ctx)));
    return;
  }
  if (!ctx.isCurrent()) return;

  const key = 'add-lead';
  const errorBox = formError();
  const inputs = {};
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add lead');

  const ctl = ([k, label, o]) => {
    const c = o.bond ? select(k, [{ value: '', label: 'Not checked' }, 'Yes', 'No', 'Unknown'], '')
      : o.long ? textArea(k, '', { rows: 3 }) : textInput(k, '', o.attrs || {});
    inputs[k] = c;
    return field(label, c, { required: o.required, hint: o.hint, class: o.long || k === 'project' || k === 'source' ? 'span-2' : '' });
  };

  const nextStep = textInput('nextStep', '', { placeholder: 'For example: Find the renovation manager' });
  const { wrap: dateWrap, input: dateInput } = dateField('Next step date', 'nextDate', '', { allowClear: true });
  let ownerBlock;
  if (isManager()) {
    const people = (state.data && state.data.people) || [];
    const opts = people.map((p) => ({ value: String(p.name), label: `${p.name}${norm(p.name) === norm(state.user.name) ? ' (you)' : ''}${p.role ? ` · ${p.role}` : ''}` }));
    opts.push({ value: '', label: 'No one (unassigned)' });
    ownerBlock = field('Owner of next step', select('nextOwner', opts, state.user.name));
  } else if (isSales()) {
    ownerBlock = h('p', { class: 'hint span-2' }, 'You will be the owner of the next step.');
  }
  const notes = textArea('notes', '', { rows: 4 });

  const form = h('form', { class: 'stack add-form', noValidate: true },
    h('fieldset', { class: 'group-box' }, h('legend', null, 'The project'),
      h('div', { class: 'form-grid' }, ADD_FIELDS.map(ctl))),
    h('fieldset', { class: 'group-box' }, h('legend', null, 'What happens next'),
      h('div', { class: 'form-grid' },
        field('Next step', nextStep, { class: 'span-2' }),
        dateWrap,
        ownerBlock,
        field('Notes', notes, { class: 'span-2' }))),
    errorBox,
    h('div', { class: 'form-actions' }, submit,
      h('a', { href: state.lastList || '#/today', class: 'btn btn-ghost', on: { click: () => clearDraft(key) } }, 'Cancel')));

  if (bindDraft(form, key)) { form.insertBefore(h('p', { class: 'note-restored' }, 'Restored what you typed earlier.'), form.firstChild); dateWrap.refresh(); }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    if (!String(v.project || '').trim()) { showFormError(errorBox, 'Enter a project name.'); inputs.project.focus(); return; }
    if (v.nextDate && !isISODate(v.nextDate)) { showFormError(errorBox, 'The next step date needs to be a real date.'); dateInput.focus(); return; }
    const body = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'nextOwner') { body.nextOwner = String(val || '').trim(); continue; }
      if (String(val || '').trim()) body[k] = String(val).trim();
    }
    const r = await withSaving(form, submit, errorBox, () => post('/api/leads', body));
    if (!r) return;
    clearDraft(key);
    if (r.lead) upsertLead(r.lead);
    invalidate();
    toast('Lead added.');
    location.hash = r.lead && r.lead.id ? `#/lead/${encodeURIComponent(r.lead.id)}` : '#/pipeline';
  });

  replace(main, pageHeader('Add lead', 'Only the project name is required. You can fill in the rest later.'), form);
}

// ---------- Open bids ----------
export async function renderBids(main, ctx) {
  if (!canSeeBids()) {
    replace(main, emptyState('Open bids are not part of your role.', null, linkButton('Go to Today', '#/today', 'primary')));
    return;
  }
  replace(main, loadingView('Loading open bids…'));
  let data;
  try { data = await loadLeads(ctx.force); } catch (e) {
    if (e.status === 401) return;
    replace(main, errorView(e, () => renderBids(main, ctx)));
    return;
  }
  if (!ctx.isCurrent()) return;
  const t = data.today;
  const bids = data.openBids.slice().sort((a, b) => {
    const pa = parseISO(a.closeDate); const pb = parseISO(b.closeDate);
    if (pa && pb) return pa.day - pb.day;
    if (pa) return -1;
    if (pb) return 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
  const open = bids.filter((b) => !(isISODate(b.closeDate) && daysFrom(t, b.closeDate) < 0));
  const closed = bids.filter((b) => isISODate(b.closeDate) && daysFrom(t, b.closeDate) < 0).reverse();

  const card = (b) => {
    const cd = String(b.closeDate || '').trim();
    const n = isISODate(cd) ? daysFrom(t, cd) : null;
    let when = cd ? cd : 'No close date';
    let cls = 'bid-close';
    if (n !== null) {
      when = fmtDate(cd, t);
      if (n < 0) { when += ' · Closed'; cls += ' muted'; } else if (n === 0) { when += ' · Closes today'; cls += ' due-today'; } else if (n === 1) { when += ' · Closes tomorrow'; cls += ' due-soon'; } else { when += ` · ${n} days left`; if (n <= 7) cls += ' due-soon'; }
    }
    const url = safeHttpUrl(b.link);
    const details = [
      ['Nation', b.nation], ['Bid ID', b.bidId], ['Contact', b.contact], ['Related project', b.relatedProject],
    ].filter(([, v]) => String(v || '').trim());
    return h('article', { class: 'card bid-card' },
      h('p', { class: cls }, h('span', { class: 'label' }, 'Closes '), when),
      h('h3', { class: 'card-title' }, String(b.title || '(No title)')),
      details.length ? h('dl', { class: 'bid-facts' }, details.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, String(v))))) : null,
      url ? h('a', { class: 'btn btn-secondary btn-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open bid page')
        : (String(b.link || '').trim() ? h('p', { class: 'muted small' }, `Link: ${b.link}`) : null));
  };

  const parts = [pageHeader('Open bids', 'Read-only. Sorted by close date.')];
  if (!bids.length) parts.push(emptyState('No open bids right now.', 'New tribal bid notices show up here when they are added to the tracker.'));
  if (open.length) parts.push(h('div', { class: 'cards bid-cards' }, open.map(card)));
  else if (bids.length) parts.push(emptyState('No bids are open right now.', 'Recently closed bids are listed below.'));
  if (closed.length) {
    parts.push(h('h2', { class: 'group-title' }, 'Closed', h('span', { class: 'count' }, String(closed.length))),
      h('div', { class: 'cards bid-cards bids-closed' }, closed.map(card)));
  }
  replace(main, ...parts);
}

