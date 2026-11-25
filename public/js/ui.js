// Shared UI pieces: chips, cards, fields, date picker, saving state, toasts.
import { h, uid, fmtDate, relLabel, daysFrom, addDays, weekday, isISODate, replace } from './dom.js';
import { state, today, ownerLabel, canClaim, isMine } from './state.js';

// ---------- chips ----------
export function statusChip(status) {
  const s = String(status || '').trim();
  if (!s) return h('span', { class: 'chip chip-none' }, 'No status');
  const key = s.toLowerCase().replace(/[^a-z]/g, '');
  return h('span', { class: `chip chip-status st-${key}` }, s);
}

export function fitChip(fit) {
  const f = String(fit || '').trim();
  if (!f) return null;
  return h('span', { class: 'chip chip-fit', title: `Fit ${f}` }, `Fit ${f}`);
}

/** Shown only when a bond is required, so these leads stand out in lists. */
export function bondChip(bondRequired) {
  if (String(bondRequired || '').trim().toLowerCase() !== 'yes') return null;
  return h('span', { class: 'chip chip-bond', title: 'This job requires a surety bond' }, 'Bond required');
}

/** Date with a relative hint; overdue shown in words and colour. */
export function dueLine(dateStr, opts = {}) {
  const t = today();
  const s = String(dateStr || '').trim();
  if (!s) return h('span', { class: 'due due-none' }, opts.emptyText || 'No date set');
  if (!isISODate(s)) return h('span', { class: 'due' }, s);
  const n = daysFrom(t, s);
  let cls = 'due';
  if (n < 0) cls += ' due-overdue';
  else if (n === 0) cls += ' due-today';
  const rel = relLabel(t, s);
  return h('span', { class: cls },
    h('span', { class: 'due-date' }, fmtDate(s, t)),
    rel ? h('span', { class: 'due-rel' }, rel) : null);
}

// ---------- buttons ----------
export function button(label, opts = {}) {
  return h('button', {
    type: opts.type || 'button',
    class: `btn ${opts.variant ? `btn-${opts.variant}` : ''} ${opts.class || ''}`.trim(),
    on: opts.onClick ? { click: opts.onClick } : null,
    'aria-label': opts.ariaLabel,
    disabled: opts.disabled,
  }, label);
}

export function linkButton(label, href, variant) {
  return h('a', { href, class: `btn ${variant ? `btn-${variant}` : ''}`.trim() }, label);
}

/**
 * Runs an async save with a clear saving state on the form.
 * On failure, the form stays as typed and the message shows in the form's alert box.
 */
export async function withSaving(form, submitBtn, errorBox, fn) {
  const label = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';
  form.setAttribute('aria-busy', 'true');
  replace(errorBox);
  errorBox.hidden = true;
  try {
    return await fn();
  } catch (e) {
    if (e && e.status === 401) return undefined; // app is taking them to sign in; draft is kept
    showFormError(errorBox, `Not saved. ${e && e.message ? e.message : 'Try again.'} What you typed is still here.`);
    return undefined;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = label;
    form.removeAttribute('aria-busy');
  }
}

export function formError() {
  return h('div', { class: 'form-error', role: 'alert', hidden: true });
}

export function showFormError(box, msg) {
  replace(box, msg);
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- fields ----------
/** Labelled field. control is an input/select/textarea; id is assigned and tied to the label. */
export function field(labelText, control, opts = {}) {
  const id = control.id || uid('f');
  control.id = id;
  const hintId = opts.hint ? `${id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: `field ${opts.class || ''}`.trim() },
    h('label', { for: id }, labelText, opts.required ? h('span', { class: 'req' }, ' (required)') : null),
    control,
    opts.hint ? h('p', { class: 'hint', id: hintId }, opts.hint) : null,
    opts.after || null);
}

export function textInput(name, value, attrs = {}) {
  return h('input', Object.assign({ type: 'text', name, value: value || '', autocomplete: 'off' }, attrs));
}

export function textArea(name, value, attrs = {}) {
  const t = h('textarea', Object.assign({ name, rows: 3 }, attrs));
  t.value = value || '';
  return t;
}

export function select(name, options, value, attrs = {}) {
  const sel = h('select', Object.assign({ name }, attrs));
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    sel.appendChild(h('option', { value: opt.value }, opt.label));
  }
  sel.value = value == null ? '' : String(value);
  if (sel.value !== String(value == null ? '' : value) && options.length) sel.selectedIndex = 0;
  return sel;
}

/**
 * Date input with one-tap picks (Tomorrow, Next Monday, 1 week, 2 weeks) and a readable echo.
 * Falls back to a text input if the existing value is not YYYY-MM-DD, so nothing is silently blanked.
 */
export function dateField(labelText, name, value, opts = {}) {
  const v = String(value || '').trim();
  const usable = !v || isISODate(v);
  const input = h('input', { type: usable ? 'date' : 'text', name, value: v, autocomplete: 'off' });
  if (!usable) input.setAttribute('placeholder', 'YYYY-MM-DD');
  const echo = h('span', { class: 'date-echo', 'aria-live': 'polite' });
  const t = today();
  const updateEcho = () => {
    const val = input.value;
    if (!val) { replace(echo, opts.emptyEcho || ''); return; }
    if (!isISODate(val)) { replace(echo, 'Use the form YYYY-MM-DD'); return; }
    replace(echo, opts.relative === false ? fmtDate(val, t) : `${fmtDate(val, t)} · ${relLabel(t, val)}`);
  };
  input.addEventListener('input', updateEcho);
  input.addEventListener('change', updateEcho);

  const wd = weekday(t);
  const toMonday = wd === null ? 7 : ((8 - wd) % 7) || 7;
  const picks = [
    ['Tomorrow', addDays(t, 1)],
    ['Next Mon', addDays(t, toMonday)],
    ['1 week', addDays(t, 7)],
    ['2 weeks', addDays(t, 14)],
  ];
  const pickRow = h('div', { class: 'quick-picks', role: 'group', 'aria-label': `Quick picks for ${labelText}` },
    picks.map(([lbl, iso]) => h('button', {
      type: 'button',
      class: 'pick',
      'aria-label': `${lbl}, ${fmtDate(iso, t)}`,
      on: {
        click: () => {
          input.value = iso;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      },
    }, lbl)),
    opts.allowClear ? h('button', {
      type: 'button',
      class: 'pick pick-clear',
      on: {
        click: () => {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      },
    }, 'No date') : null);

  const wrap = field(labelText, input, {
    hint: opts.hint,
    class: 'field-date',
    after: h('div', { class: 'date-extra' }, opts.picks === false ? null : pickRow, echo),
  });
  // Echo after restore of drafts too.
  queueMicrotask(updateEcho);
  wrap.refresh = updateEcho;
  return { wrap, input };
}

// ---------- lead card ----------
/**
 * Card used on Today and on Pipeline (phone).
 * actions: {onLog(lead), onClaim(lead)}
 */
export function leadCard(lead, actions = {}, opts = {}) {
  const href = `#/lead/${encodeURIComponent(lead.id || '')}`;
  const where = [lead.location, lead.state].filter((x) => String(x || '').trim()).join(', ');
  const customerLine = [lead.owner, where].filter((x) => String(x || '').trim()).join(' · ');
  const showOwner = opts.showOwner || !isMine(lead);
  const nextStep = String(lead.nextStep || '').trim();

  return h('article', { class: 'card lead-card' },
    h('div', { class: 'card-top' },
      statusChip(lead.status),
      fitChip(lead.fit),
      bondChip(lead.bondRequired),
      showOwner ? h('span', { class: 'card-owner' }, ownerLabel(lead)) : null),
    h('h3', { class: 'card-title' },
      h('a', { href, class: 'card-link' }, String(lead.project || '(No project name)'))),
    customerLine ? h('p', { class: 'card-sub' }, customerLine) : null,
    h('div', { class: 'card-next' },
      h('span', { class: 'label' }, 'Next step'),
      nextStep ? h('p', { class: 'next-text' }, nextStep) : h('p', { class: 'next-text muted' }, 'No next step set'),
      dueLine(lead.nextDate)),
    h('div', { class: 'card-actions' },
      actions.onLog ? h('button', {
        type: 'button',
        class: 'btn btn-primary btn-log',
        'aria-label': `Log activity for ${lead.project || 'this lead'}`,
        on: { click: () => actions.onLog(lead) },
      }, 'Log') : null,
      actions.onClaim && canClaim(lead) ? h('button', {
        type: 'button',
        class: 'btn btn-secondary',
        'aria-label': `Claim ${lead.project || 'this lead'}`,
        on: { click: (e) => actions.onClaim(lead, e.currentTarget) },
      }, 'Claim') : null));
}

// ---------- toasts ----------
let toastTimer = null;
export function toast(msg) {
  const box = document.getElementById('toast');
  if (!box) return;
  replace(box, msg);
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 4000);
}

// ---------- page states ----------
export function loadingView(text = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

export function errorView(err, onRetry) {
  return h('div', { class: 'panel panel-error', role: 'alert' },
    h('p', null, err && err.message ? err.message : 'Something went wrong.'),
    onRetry ? button('Try again', { variant: 'secondary', onClick: onRetry }) : null);
}

export function emptyState(title, body, ...actions) {
  return h('div', { class: 'empty' },
    h('p', { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

export function pageHeader(title, sub, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-title' },
      h('h1', { tabindex: '-1', id: 'page-h1' }, title),
      sub ? h('p', { class: 'page-sub' }, sub) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export { state };
