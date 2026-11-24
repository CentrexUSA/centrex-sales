// Centrex Sales front end: boot, session, hash router and app shell.
import { h, replace, clearAllDrafts } from './js/dom.js';
import { get, post, onUnauthorized, NOT_CONFIGURED_MESSAGE } from './js/api.js';
import { state, canAddLead, canSeeBids } from './js/state.js';
import { emptyState, linkButton, button } from './js/ui.js';
import { renderToday } from './js/views/today.js';
import { renderPipeline } from './js/views/pipeline.js';
import { renderLead } from './js/views/lead.js';
import { renderSignIn, renderAddLead, renderBids } from './js/views/forms.js';

const main = document.getElementById('main');
const header = document.getElementById('app-header');
const nav = document.getElementById('app-nav');
const RETURN_KEY = 'cx-return-to';

const TITLES = { today: 'Today', pipeline: 'Pipeline', add: 'Add lead', bids: 'Open bids', signin: 'Sign in' };
const ROUTES = { today: renderToday, pipeline: renderPipeline, lead: renderLead, add: renderAddLead, bids: renderBids };

let routeSeq = 0;
let signInNotice = '';
let firstRoute = true;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const qs = qi >= 0 ? raw.slice(qi + 1) : '';
  const segs = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  return { name: segs[0] || 'today', params: segs.slice(1), query: new URLSearchParams(qs) };
}

function rememberReturn(hash) {
  if (!hash || /^#\/?signin/.test(hash)) return;
  try { sessionStorage.setItem(RETURN_KEY, hash); } catch { /* ignore */ }
}
function takeReturn() {
  let v = '';
  try { v = sessionStorage.getItem(RETURN_KEY) || ''; sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
  return v && v.startsWith('#/') ? v : '#/today';
}

// ---------- shell ----------
function navLink(name, label, current) {
  return h('a', {
    href: `#/${name}`,
    class: `nav-link${current === name ? ' active' : ''}`,
    'aria-current': current === name ? 'page' : null,
  }, h('span', { class: `nav-ico ico-${name}`, 'aria-hidden': 'true' }), h('span', { class: 'nav-text' }, label));
}

function renderShell(current) {
  header.hidden = false;
  nav.hidden = false;
  document.body.classList.add('signed-in');
  const u = state.user;
  replace(header,
    h('a', { href: '#/today', class: 'brand' }, h('span', { class: 'brand-name' }, 'Centrex'), h('span', { class: 'brand-app' }, 'Sales')),
    h('div', { class: 'who' },
      h('span', { class: 'who-name' }, String(u.name || '')),
      h('span', { class: 'who-role' }, String(u.role || '')),
      button('Sign out', { variant: 'ghost', class: 'btn-small', onClick: signOut })));
  replace(nav,
    navLink('today', 'Today', current),
    navLink('pipeline', 'Pipeline', current),
    canSeeBids() ? navLink('bids', 'Open bids', current) : null,
    canAddLead() ? navLink('add', 'Add lead', current) : null);
  nav.dataset.count = String(nav.children.length);
}

function hideShell() {
  header.hidden = true;
  nav.hidden = true;
  document.body.classList.remove('signed-in');
}

function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
}

// ---------- routing ----------
async function route(opts = {}) {
  const r = parseHash();
  const seq = ++routeSeq;
  const ctx = {
    params: r.params,
    query: r.query,
    force: !!opts.force,
    isCurrent: () => seq === routeSeq,
  };
  closeDialogs();

  if (!state.user) {
    if (r.name !== 'signin') {
      rememberReturn(location.hash || '#/today');
      location.replace('#/signin');
      return; // hashchange re-enters route()
    }
    hideShell();
    document.getElementById('toast').classList.remove('show');
    document.title = 'Sign in · Centrex Sales';
    renderSignIn(main, { notice: signInNotice, onSignedIn });
    return;
  }
  if (r.name === 'signin') { location.replace('#/today'); return; }

  renderShell(r.name === 'lead' ? '' : r.name);
  if (r.name === 'today' || r.name === 'pipeline') state.lastList = `#/${r.name}`;
  document.title = `${TITLES[r.name] || 'Lead'} · Centrex Sales`;
  if (!firstRoute) window.scrollTo(0, 0);

  const fn = ROUTES[r.name];
  if (!fn) {
    replace(main, emptyState('That page does not exist.', null, linkButton('Go to Today', '#/today', 'primary')));
    return;
  }
  await fn(main, ctx);
  if (ctx.isCurrent() && !firstRoute) {
    const h1 = document.getElementById('page-h1');
    if (h1 && !main.contains(document.activeElement)) h1.focus({ preventScroll: true });
  }
  firstRoute = false;
}

const DRAFT_OWNER_KEY = 'cx-draft-owner';

function onSignedIn(user) {
  // Typed drafts and the return page survive a sign-out caused by an expired
  // session, but only for the same person: drop them if someone else signs in.
  try {
    const who = String((user && user.email) || '').toLowerCase();
    const prev = sessionStorage.getItem(DRAFT_OWNER_KEY);
    if (prev !== null && prev !== who) {
      clearAllDrafts();
      sessionStorage.removeItem(RETURN_KEY);
      sessionStorage.removeItem('cx-pipeline-filters');
    }
    sessionStorage.setItem(DRAFT_OWNER_KEY, who);
  } catch { /* ignore */ }
  state.user = user;
  state.data = null;
  state.loadedAt = 0;
  signInNotice = '';
  const target = takeReturn();
  if (location.hash === target) route(); else location.hash = target;
}

async function signOut() {
  try { await post('/api/logout', {}); } catch { /* signing out locally regardless */ }
  clearAllDrafts();
  try { sessionStorage.removeItem('cx-pipeline-filters'); } catch { /* ignore */ }
  state.user = null;
  state.data = null;
  signInNotice = '';
  location.hash = '#/signin';
}

onUnauthorized(() => {
  if (!state.user) return;
  state.user = null;
  state.data = null;
  rememberReturn(location.hash);
  signInNotice = 'You have been signed out. Sign in again and you will come back here. Anything you were typing has been kept.';
  closeDialogs();
  location.hash = '#/signin';
});

window.addEventListener('hashchange', () => route());
document.getElementById('skip-link').addEventListener('click', () => {
  const target = document.getElementById('page-h1') || main;
  target.focus();
});

// ---------- boot ----------
async function boot() {
  try {
    const r = await get('/api/me');
    state.user = r.user || null;
  } catch (e) {
    state.user = null;
    if (e.code === 'not_configured') signInNotice = NOT_CONFIGURED_MESSAGE;
    else if (e.status !== 401) signInNotice = e.message;
  }
  if (!location.hash) location.replace('#/today');
  route();
}

boot();
