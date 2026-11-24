// Pipeline: every visible lead, searchable and filterable. Table on desktop, cards on phones.
import { h, replace, uid, norm, parseISO, daysFrom, isISODate } from '../dom.js';
import { state, loadLeads, statuses, isManager, isOutside, canAddLead, isUnassigned, ownerLabel } from '../state.js';
import { leadCard, statusChip, fitChip, dueLine, loadingView, errorView, emptyState, pageHeader, linkButton, button, select } from '../ui.js';
import { openLogDialog } from '../logform.js';

const FILTER_KEY = 'cx-pipeline-filters';
const EMPTY = { q: '', status: '', fit: '', owner: '', state: '', due: '', sort: 'date', dir: 1 };

function loadFilters() {
  try { return Object.assign({}, EMPTY, JSON.parse(sessionStorage.getItem(FILTER_KEY) || '{}')); } catch { return Object.assign({}, EMPTY); }
}
function saveFilters(f) {
  try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

const SEARCH_FIELDS = ['project', 'owner', 'location', 'state', 'type', 'gc', 'architect', 'nextStep', 'nextOwner', 'notes', 'id'];

export function applyFilters(leads, f, t) {
  const q = norm(f.q);
  return leads.filter((l) => {
    if (q && !SEARCH_FIELDS.some((k) => norm(l[k]).includes(q))) return false;
    if (f.status && String(l.status || '').trim() !== f.status) return false;
    if (f.fit === '-' ? String(l.fit || '').trim() : (f.fit && String(l.fit || '').trim() !== f.fit)) return false;
    if (f.owner === '-') { if (!isUnassigned(l)) return false; } else if (f.owner && norm(l.nextOwner) !== norm(f.owner)) return false;
    if (f.state && norm(l.state) !== norm(f.state)) return false;
    if (f.due) {
      const d = String(l.nextDate || '').trim();
      const n = isISODate(d) ? daysFrom(t, d) : null;
      if (f.due === 'overdue' && !(n !== null && n < 0)) return false;
      if (f.due === 'today' && n !== 0) return false;
      if (f.due === 'soon' && !(n !== null && n >= 0 && n <= 14)) return false;
      if (f.due === 'none' && d) return false;
    }
    return true;
  });
}

export function sortLeads(list, key, dir) {
  const val = (l) => {
    if (key === 'date') { const p = parseISO(l.nextDate); return p ? p.day : null; }
    if (key === 'status') { const i = statuses().indexOf(String(l.status || '').trim()); return i < 0 ? null : i; }
    if (key === 'fit') return String(l.fit || '').trim() || null;
    if (key === 'owner') return norm(l.nextOwner) || null;
    return norm(l.project) || null;
  };
  return list.slice().sort((a, b) => {
    const va = val(a); const vb = val(b);
    if (va === null && vb === null) return norm(a.project).localeCompare(norm(b.project));
    if (va === null) return 1; // blanks always last
    if (vb === null) return -1;
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return norm(a.project).localeCompare(norm(b.project));
  });
}

export async function renderPipeline(main, ctx) {
  replace(main, loadingView('Loading pipeline…'));
  let data;
  try {
    data = await loadLeads(ctx.force);
  } catch (e) {
    if (e.status === 401) return;
    replace(main, errorView(e, () => renderPipeline(main, Object.assign({}, ctx, { force: true }))));
    return;
  }
  if (!ctx.isCurrent()) return;
  draw(main, data, ctx);
}

function draw(main, data, ctx) {
  const t = data.today;
  const f = loadFilters();
  const results = h('div', { class: 'results' });
  const countLine = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const clearBtn = button('Clear filters', { variant: 'ghost', class: 'btn-small', onClick: () => { Object.assign(f, EMPTY, { sort: f.sort, dir: f.dir }); saveFilters(f); draw(main, state.data, ctx); } });

  const update = () => {
    saveFilters(f);
    const list = sortLeads(applyFilters(data.leads, f, t), f.sort, f.dir);
    const active = ['q', 'status', 'fit', 'owner', 'state', 'due'].some((k) => f[k]);
    clearBtn.hidden = !active;
    replace(countLine, `${list.length} of ${data.leads.length} lead${data.leads.length === 1 ? '' : 's'}`);
    if (!list.length) {
      replace(results, data.leads.length
        ? emptyState('No leads match these filters.', 'Try a shorter search or clear the filters.', button('Clear filters', { variant: 'secondary', onClick: () => clearBtn.click() }))
        : emptyState('No leads yet.', canAddLead() ? 'Add the first one, or wait for the weekly scan to bring some in.' : 'Leads assigned to you will show up here.',
          canAddLead() ? linkButton('Add lead', '#/add', 'primary') : null));
      return;
    }
    const redraw = () => draw(main, state.data, ctx);
    replace(results, table(list, f, () => update(), redraw), cards(list, redraw));
  };

  // ----- filter controls -----
  const search = h('input', { type: 'search', name: 'q', value: f.q, placeholder: 'Project, customer, city, GC…', autocomplete: 'off' });
  search.addEventListener('input', () => { f.q = search.value; update(); });

  const ctl = (label, name, options) => {
    const sel = select(name, options, f[name]);
    sel.id = uid('flt');
    sel.addEventListener('change', () => { f[name] = sel.value; update(); });
    return h('div', { class: 'filter' }, h('label', { for: sel.id }, label), sel);
  };
  const searchId = uid('flt');
  search.id = searchId;

  const states = [...new Set(data.leads.map((l) => String(l.state || '').trim()).filter(Boolean))].sort();
  const owners = (data.people || []).map((p) => String(p.name || '')).filter(Boolean);

  const activeCount = () => ['status', 'fit', 'owner', 'state', 'due'].filter((k) => f[k]).length;
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-small filters-toggle', 'aria-expanded': 'false' });
  const setToggle = () => {
    const n = activeCount();
    replace(toggle, filters.classList.contains('show-all') ? 'Hide filters' : `Filters${n ? ` (${n} on)` : ''}`);
    toggle.setAttribute('aria-expanded', String(filters.classList.contains('show-all')));
  };
  toggle.addEventListener('click', () => { filters.classList.toggle('show-all'); setToggle(); });
  const filters = h('div', { class: 'filters', role: 'search' },
    h('div', { class: 'filter filter-search' }, h('label', { for: searchId }, 'Search'), h('div', { class: 'search-row' }, search, toggle)),
    ctl('Status', 'status', [{ value: '', label: 'Any status' }].concat(statuses())),
    ctl('Fit', 'fit', [{ value: '', label: 'Any fit' }, 'A', 'B', 'C', { value: '-', label: 'Not rated' }]),
    isOutside() ? null : ctl('Owner of next step', 'owner', [{ value: '', label: 'Anyone' }]
      .concat(owners.map((o) => ({ value: o, label: state.user && norm(o) === norm(state.user.name) ? `${o} (you)` : o })))
      .concat([{ value: '-', label: 'Unassigned' }])),
    ctl('State', 'state', [{ value: '', label: 'Any state' }].concat(states)),
    ctl('Next step date', 'due', [{ value: '', label: 'Any date' }, { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'soon', label: 'Next 14 days' }, { value: 'none', label: 'No date set' }]),
    h('div', { class: 'filter filter-clear' }, clearBtn));

  const parts = [pageHeader('Pipeline', null, canAddLead() ? linkButton('Add lead', '#/add', 'primary') : null)];
  if (isManager()) parts.push(summary(data, t, (patchF) => { Object.assign(f, EMPTY, { sort: f.sort, dir: f.dir }, patchF); saveFilters(f); draw(main, state.data, ctx); }));
  if (activeCount()) filters.classList.add('show-all');
  setToggle();
  parts.push(filters, countLine, results);
  replace(main, ...parts);
  update();
}

function summary(data, t, setFilter) {
  const leads = data.leads;
  const byStatus = statuses().map((s) => [s, leads.filter((l) => String(l.status || '').trim() === s).length]);
  const noOwner = leads.filter((l) => isUnassigned(l)).length;
  const noDate = leads.filter((l) => !String(l.nextDate || '').trim()).length;
  const overdue = leads.filter((l) => isISODate(l.nextDate) && daysFrom(t, l.nextDate) < 0).length;

  const stat = (label, n, onClick, warn) => h('button', {
    type: 'button',
    class: `stat${warn && n ? ' stat-warn' : ''}`,
    'aria-label': `${label}: ${n}. Show these leads.`,
    on: { click: onClick },
  }, h('span', { class: 'stat-n' }, String(n)), h('span', { class: 'stat-label' }, label));

  return h('section', { class: 'summary', 'aria-label': 'Pipeline summary' },
    h('div', { class: 'summary-row summary-status' },
      byStatus.map(([s, n]) => stat(s, n, () => setFilter({ status: s })))),
    h('div', { class: 'summary-row summary-flags' },
      stat('Overdue', overdue, () => setFilter({ due: 'overdue' }), true),
      stat('No owner', noOwner, () => setFilter({ owner: '-' }), true),
      stat('No next step date', noDate, () => setFilter({ due: 'none' }), true)));
}

function table(list, f, onSort, onChange) {
  const th = (label, key) => {
    if (!key) return h('th', { scope: 'col' }, label);
    const active = f.sort === key;
    const btn = h('button', {
      type: 'button',
      class: 'sort-btn',
      on: {
        click: () => {
          if (f.sort === key) f.dir = -f.dir; else { f.sort = key; f.dir = 1; }
          onSort();
        },
      },
    }, label, h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, active ? (f.dir > 0 ? ' ▲' : ' ▼') : ''));
    return h('th', { scope: 'col', 'aria-sort': active ? (f.dir > 0 ? 'ascending' : 'descending') : 'none' }, btn);
  };
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'lead-table' },
      h('caption', { class: 'sr-only' }, 'Leads. Column headers sort the table.'),
      h('thead', null, h('tr', null,
        th('Project', 'project'), th('Status', 'status'), th('Fit', 'fit'), th('Next step'), th('Date', 'date'), th('Owner of next step', 'owner'), th('Where'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', null, list.map((l) => {
        const where = [l.location, l.state].filter((x) => String(x || '').trim()).join(', ');
        return h('tr', null,
          h('td', { class: 'col-project' },
            h('a', { href: `#/lead/${encodeURIComponent(l.id || '')}` }, String(l.project || '(No project name)')),
            l.owner ? h('div', { class: 'sub' }, String(l.owner)) : null),
          h('td', null, statusChip(l.status)),
          h('td', null, fitChip(l.fit) || h('span', { class: 'muted' }, '–')),
          h('td', { class: 'col-next' }, String(l.nextStep || '').trim() ? String(l.nextStep) : h('span', { class: 'muted' }, 'None')),
          h('td', { class: 'col-date' }, dueLine(l.nextDate, { emptyText: 'None' })),
          h('td', null, isUnassigned(l) ? h('span', { class: 'muted' }, ownerLabel(l)) : ownerLabel(l)),
          h('td', null, where),
          h('td', { class: 'col-act' }, h('button', {
            type: 'button',
            class: 'btn btn-small btn-secondary',
            'aria-label': `Log activity for ${l.project || 'this lead'}`,
            on: { click: () => openLogDialog(l, onChange) },
          }, 'Log')));
      }))));
}

function cards(list, onChange) {
  const actions = { onLog: (lead) => openLogDialog(lead, onChange) };
  return h('div', { class: 'cards pipeline-cards' }, list.map((l) => leadCard(l, actions, { showOwner: true })));
}
