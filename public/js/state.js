// Shared app state, role rules and the leads cache.
import { get } from './api.js';
import { norm } from './dom.js';

export const DEFAULT_STATUSES = ['New', 'Researching', 'Contacted', 'Bidding', 'Won', 'Lost', 'Watch'];
export const ACTIVITY_TYPES = ['Call', 'Voicemail', 'Email', 'Meeting', 'Site visit', 'Note'];
export const CLOSED = new Set(['won', 'lost']);

export const state = {
  user: null, // {name, email, role}
  data: null, // {leads, people, openBids, statuses, today}
  loadedAt: 0,
  lastList: '#/today',
};

// ---------- roles ----------
export const role = () => (state.user ? state.user.role : '');
export const isManager = () => role() === 'Manager';
export const isSales = () => role() === 'Sales';
export const isOutside = () => role() === 'Outside';
export const canAddLead = () => isManager() || isSales();
export const canSeeBids = () => isManager() || isSales();
export const canEditDetails = () => isManager();
export const canPickOwner = () => isManager();

export function isMine(lead) {
  return !!state.user && norm(lead.nextOwner) === norm(state.user.name) && norm(lead.nextOwner) !== '';
}

export function isUnassigned(lead) {
  const people = (state.data && state.data.people) || [];
  const owner = norm(lead.nextOwner);
  return !people.some((p) => norm(p.name) === owner);
}

/** Sales and Managers can claim an unassigned lead (set themselves as owner). */
export const canClaim = (lead) => (isSales() || isManager()) && isUnassigned(lead);
/** Sales can clear the owner when it is them. Managers use the owner picker instead. */
export const canRelease = (lead) => isSales() && isMine(lead);

export function statuses() {
  const s = state.data && Array.isArray(state.data.statuses) && state.data.statuses.length
    ? state.data.statuses : DEFAULT_STATUSES;
  return s.map(String);
}

export function today() {
  if (state.data && state.data.today) return state.data.today;
  // Fallback before the first load: local calendar date.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- leads cache ----------
const MAX_AGE = 20000;

function asArray(x) { return Array.isArray(x) ? x : []; }

export async function loadLeads(force = false) {
  if (!force && state.data && Date.now() - state.loadedAt < MAX_AGE) return state.data;
  const d = await get('/api/leads');
  state.data = {
    leads: asArray(d.leads).filter((l) => l && typeof l === 'object'),
    people: asArray(d.people).filter((p) => p && typeof p === 'object'),
    openBids: asArray(d.openBids).filter((b) => b && typeof b === 'object'),
    statuses: asArray(d.statuses),
    today: typeof d.today === 'string' ? d.today : '',
  };
  state.loadedAt = Date.now();
  return state.data;
}

export function invalidate() { state.loadedAt = 0; }

/** Replace one lead in the cache after a save so lists stay current without a refetch. */
export function upsertLead(lead) {
  if (!state.data || !lead || !lead.id) return;
  const i = state.data.leads.findIndex((l) => l.id === lead.id);
  if (i >= 0) state.data.leads[i] = lead; else state.data.leads.push(lead);
}

export function findCachedLead(id) {
  return state.data ? state.data.leads.find((l) => l.id === id) || null : null;
}

// ---------- owner label ----------
export function ownerLabel(lead) {
  const o = String(lead.nextOwner || '').trim();
  if (!o) return 'No owner';
  if (isUnassigned(lead)) return `Unassigned (${o})`;
  if (isMine(lead)) return `${o} (you)`;
  return o;
}
