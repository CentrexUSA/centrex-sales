// "Log activity" form, used inline on the Lead page and in a sheet from any lead card.
import { h, uid, bindDraft, clearDraft, readForm, fmtDate, daysFrom, isISODate } from './dom.js';
import { post } from './api.js';
import { ACTIVITY_TYPES, statuses, today, upsertLead, invalidate } from './state.js';
import { field, textArea, textInput, select, dateField, formError, withSaving, showFormError, toast } from './ui.js';

/**
 * opts: {onSaved({activity, lead}), onCancel(), compact}
 */
export function buildLogForm(lead, opts = {}) {
  const t = today();
  const draftKey = `log:${lead.id}`;
  const errorBox = formError();

  const typeName = uid('type');
  const typeGroup = h('fieldset', { class: 'type-group' },
    h('legend', null, 'What kind'),
    h('div', { class: 'type-options' },
      ACTIVITY_TYPES.map((tp, i) => {
        const id = uid('t');
        return h('div', { class: 'type-opt' },
          h('input', { type: 'radio', name: 'type', id, value: tp, checked: i === 0, 'data-group': typeName }),
          h('label', { for: id }, tp));
      })));

  const note = textArea('note', '', { rows: 3, required: true, 'aria-required': 'true' });
  const curStep = String(lead.nextStep || '').trim();
  const nextStep = textInput('nextStep', '', { placeholder: curStep ? 'Leave blank to keep the current step' : 'For example: Call back about bid date' });

  const curDate = String(lead.nextDate || '').trim();
  const overdue = isISODate(curDate) && daysFrom(t, curDate) <= 0;
  const dateHint = curDate
    ? `Now: ${isISODate(curDate) ? fmtDate(curDate, t) : curDate}.${overdue ? ' Set a new date so this lead leaves Overdue.' : ' Leave blank to keep it.'}`
    : 'No date set yet.';
  const { wrap: dateWrap, input: dateInput } = dateField('New next step date', 'nextDate', '', { hint: dateHint });

  const curStatus = String(lead.status || '').trim();
  const statusSel = select('status', [{ value: '', label: curStatus ? `Keep as ${curStatus}` : 'Keep as is' }]
    .concat(statuses().filter((s) => s !== curStatus).map((s) => ({ value: s, label: s }))), '');

  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const cancel = opts.onCancel ? h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => { clearDraft(draftKey); opts.onCancel(); } } }, 'Cancel') : null;

  const form = h('form', { class: 'log-form', noValidate: true },
    typeGroup,
    field('What happened', note, { required: true }),
    field('New next step', nextStep, { hint: curStep ? `Now: ${curStep}` : 'No next step set yet.' }),
    dateWrap,
    field('Status', statusSel),
    errorBox,
    h('div', { class: 'form-actions' }, submit, cancel));

  const restored = bindDraft(form, draftKey);
  if (restored) {
    form.insertBefore(h('p', { class: 'note-restored' }, 'Restored what you typed earlier.'), form.firstChild);
    if (dateWrap.refresh) dateWrap.refresh();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    if (!String(v.note || '').trim()) {
      showFormError(errorBox, 'Say what happened before saving.');
      note.focus();
      return;
    }
    if (v.nextDate && !isISODate(v.nextDate)) {
      showFormError(errorBox, 'The next step date needs to be a real date.');
      dateInput.focus();
      return;
    }
    const body = { leadId: lead.id, type: v.type || 'Call', note: v.note.trim() };
    if (String(v.nextStep || '').trim()) body.nextStep = v.nextStep.trim();
    if (v.nextDate) body.nextDate = v.nextDate;
    if (v.status) body.status = v.status;

    const result = await withSaving(form, submit, errorBox, () => post('/api/activity', body));
    if (!result) return;
    clearDraft(draftKey);
    if (result.lead) upsertLead(result.lead);
    invalidate();
    const nl = result.lead || lead;
    const bits = ['Saved.'];
    if (nl.nextStep) bits.push(`Next step: ${nl.nextStep}${isISODate(nl.nextDate) ? `, ${fmtDate(nl.nextDate, t)}` : ''}.`);
    toast(bits.join(' '));
    if (opts.onSaved) opts.onSaved(result);
  });

  form.focusFirst = () => note.focus();
  return form;
}

/** Opens the log form in a modal sheet. Resolves when closed. */
export function openLogDialog(lead, onSaved) {
  const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': 'log-dlg-title' });
  const close = () => { dlg.close(); };
  const form = buildLogForm(lead, {
    onSaved: (r) => { close(); if (onSaved) onSaved(r); },
    onCancel: close,
  });
  dlg.append(h('div', { class: 'sheet-inner' },
    h('div', { class: 'sheet-head' },
      h('div', null,
        h('p', { class: 'sheet-kicker' }, 'Log activity'),
        h('h2', { id: 'log-dlg-title' }, String(lead.project || 'Lead'))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', on: { click: close } }, '×')),
    form));
  dlg.addEventListener('close', () => dlg.remove());
  // Clicking the backdrop closes the sheet; the draft is kept, so nothing typed is lost.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  form.focusFirst();
}
