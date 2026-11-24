// Today: my leads by when the next step is due, then unassigned leads I can claim.
import { h, replace, fmtDate, daysFrom, isISODate, parseISO } from '../dom.js';
import { patch } from '../api.js';
import { state, loadLeads, isMine, isUnassigned, isSales, isManager, canAddLead, upsertLead, invalidate, CLOSED } from '../state.js';
import { leadCard, loadingView, errorView, emptyState, pageHeader, linkButton, button, toast } from '../ui.js';
import { openLogDialog } from '../logform.js';

const HORIZON = 14;

function byDate(a, b) {
  const pa = parseISO(a.nextDate); const pb = parseISO(b.nextDate);
  if (pa && pb && pa.day !== pb.day) return pa.day - pb.day;
  return String(a.project || '').localeCompare(String(b.project || ''));
}

export function groupToday(leads, t) {
  const g = { overdue: [], today: [], soon: [], later: [], nodate: [], unassigned: [] };
  for (const l of leads) {
    const closed = CLOSED.has(String(l.status || '').trim().toLowerCase());
    if (isMine(l)) {
      const d = String(l.nextDate || '').trim();
      if (!d) { if (!closed) g.nodate.push(l); continue; }
      if (!isISODate(d)) { g.nodate.push(l); continue; }
      const n = daysFrom(t, d);
      if (n < 0) g.overdue.push(l);
      else if (n === 0) g.today.push(l);
      else if (n <= HORIZON) g.soon.push(l);
      else g.later.push(l);
    } else if ((isSales() || isManager()) && isUnassigned(l) && !closed) {
      g.unassigned.push(l);
    }
  }
  g.overdue.sort(byDate); g.today.sort(byDate); g.soon.sort(byDate); g.later.sort(byDate);
  g.nodate.sort(byDate); g.unassigned.sort(byDate);
  return g;
}

export async function renderToday(main, ctx) {
  replace(main, loadingView('Loading your leads…'));
  let data;
  try {
    data = await loadLeads(ctx.force);
  } catch (e) {
    if (e.status === 401) return;
    replace(main, errorView(e, () => renderToday(main, { force: true })));
    return;
  }
  if (!ctx.isCurrent()) return;
  draw(main, data, ctx);
}

function draw(main, data, ctx) {
  const t = data.today;
  const g = groupToday(data.leads, t);
  const rerender = () => { if (ctx.isCurrent()) draw(main, state.data, ctx); };

  const actions = {
    onLog: (lead) => openLogDialog(lead, () => rerender()),
    onClaim: async (lead, btn) => {
      btn.disabled = true;
      btn.textContent = 'Claiming…';
      try {
        const r = await patch(`/api/lead?id=${encodeURIComponent(lead.id)}`, { nextOwner: state.user.name });
        upsertLead(r.lead);
        invalidate();
        toast(`Claimed. ${r.lead.project || 'The lead'} is now in your list.`);
        rerender();
      } catch (e) {
        if (e.status === 401) return;
        btn.disabled = false;
        btn.textContent = 'Claim';
        toast(`Not claimed. ${e.message}`);
      }
    },
  };

  const parts = [];
  const counts = [];
  if (g.overdue.length) counts.push(`${g.overdue.length} overdue`);
  if (g.today.length) counts.push(`${g.today.length} due today`);
  if (g.soon.length) counts.push(`${g.soon.length} coming up`);

  parts.push(pageHeader('Today', `${fmtDate(t, t)}${counts.length ? ` · ${counts.join(' · ')}` : ''}`,
    button('Refresh', { variant: 'ghost', class: 'btn-small', onClick: () => renderToday(main, Object.assign({}, ctx, { force: true })) }),
    canAddLead() ? linkButton('Add lead', '#/add', 'secondary') : null));

  const section = (key, title, list, hint, cardOpts) => h('section', { class: `group group-${key}`, 'aria-labelledby': `g-${key}` },
    h('h2', { class: 'group-title', id: `g-${key}` }, title, h('span', { class: 'count' }, String(list.length))),
    hint ? h('p', { class: 'group-hint' }, hint) : null,
    h('div', { class: 'cards' }, list.map((l) => leadCard(l, actions, cardOpts))));

  const dueCount = g.overdue.length + g.today.length + g.soon.length;
  if (!dueCount) {
    const later = g.later.length
      ? `Your next dated step is ${fmtDate(g.later[0].nextDate, t)}.`
      : 'You have no dated next steps.';
    parts.push(emptyState('Nothing due in the next two weeks.',
      `${later} Open Pipeline to pick a lead to move forward${canAddLead() ? ', or add a new one' : ''}.`,
      linkButton('Open Pipeline', '#/pipeline', 'primary'),
      canAddLead() ? linkButton('Add lead', '#/add', 'secondary') : null));
  }
  if (g.overdue.length) parts.push(section('overdue', 'Overdue', g.overdue, 'Log what happened and set a new date.'));
  if (g.today.length) parts.push(section('today', 'Due today', g.today));
  if (g.soon.length) parts.push(section('soon', 'Coming up', g.soon, 'Next 14 days.'));
  if (g.nodate.length) parts.push(section('nodate', 'No date set', g.nodate, 'Give these a next step date so they show up when they are due.'));
  if (dueCount && g.later.length) {
    parts.push(h('p', { class: 'later-note' },
      `${g.later.length} more of your leads ${g.later.length === 1 ? 'has a next step' : 'have next steps'} after ${fmtDate(g.later[0].nextDate, t)}. `,
      h('a', { href: '#/pipeline' }, 'See them in Pipeline')));
  }
  if (isSales() || isManager()) {
    if (g.unassigned.length) {
      parts.push(section('unassigned', 'Unassigned leads you can claim', g.unassigned,
        'No one owns the next step on these. Claim one to put it in your list.', { showOwner: true }));
    }
  }
  if (!data.leads.some((l) => isMine(l)) && !g.unassigned.length) {
    parts.push(h('p', { class: 'later-note' }, 'No leads are assigned to you yet. Ask a manager to assign one.'));
  }
  replace(main, ...parts);
}
