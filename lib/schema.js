'use strict';
// Column layout of the five tabs the app may touch, the text/date write
// encoding, and input validation. Pure functions only (no I/O).

const TABS = {
  projects: {
    name: 'Projects',
    keys: ['fit', 'status', 'project', 'owner', 'location', 'state', 'type', 'value', 'size',
      'stage', 'opening', 'gc', 'architect', 'whyFits', 'nextStep', 'nativeNote', 'source',
      'nextOwner', 'nextDate', 'notes', 'firstSeen', 'lastChecked', 'id'],
  },
  contacts: {
    name: 'Contacts',
    keys: ['id', 'leadId', 'name', 'title', 'company', 'email', 'phone', 'verifiedAt', 'notes',
      'addedBy', 'addedOn'],
  },
  activity: {
    name: 'Activity',
    keys: ['when', 'leadId', 'project', 'by', 'type', 'note', 'nextStep', 'nextDate'],
  },
  users: {
    name: 'Users',
    keys: ['name', 'email', 'role', 'code', 'active'],
  },
  openBids: {
    name: 'Open bids',
    keys: ['title', 'nation', 'bidId', 'closeDate', 'contact', 'link', 'relatedProject'],
  },
};

const ALLOWED_TAB_NAMES = new Set(Object.values(TABS).map((t) => t.name));

const STATUSES = ['New', 'Researching', 'Contacted', 'Bidding', 'Won', 'Lost', 'Watch'];
const ACTIVITY_TYPES = ['Call', 'Voicemail', 'Email', 'Meeting', 'Site visit', 'Note'];
const FITS = ['A', 'B', 'C', ''];
const ROLES = ['Manager', 'Sales', 'Outside'];

// Date fields per tab (written without the apostrophe). Activity's nextDate too.
const DATE_KEYS = new Set(['nextDate', 'firstSeen', 'addedOn']);
const LONG_KEYS = new Set(['notes', 'note', 'stage', 'whyFits']);
const SHORT_MAX = 300;
const LONG_MAX = 5000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

function colLetter(index) {
  // 0 -> A, 25 -> Z, 26 -> AA
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function lastCol(tabKey) {
  return colLetter(TABS[tabKey].keys.length - 1);
}

function colOf(tabKey, key) {
  const i = TABS[tabKey].keys.indexOf(key);
  if (i < 0) throw new Error('Unknown column');
  return colLetter(i);
}

function quoteTab(name) {
  if (!ALLOWED_TAB_NAMES.has(name)) throw new Error('Tab not allowed');
  if (/^[A-Za-z0-9_]+$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

// a1('Open bids', 'A', 2, 'G') -> "'Open bids'!A2:G"
// a1('Projects', 'W', 5)       -> "Projects!W5"
function a1(tabName, startCol, startRow, endCol, endRow) {
  const q = quoteTab(tabName);
  const start = `${startCol}${startRow == null ? '' : startRow}`;
  if (endCol == null) return `${q}!${start}`;
  return `${q}!${start}:${endCol}${endRow == null ? '' : endRow}`;
}

function cellToString(v) {
  if (v == null) return '';
  return String(v);
}

function rowToObject(tabKey, row) {
  const keys = TABS[tabKey].keys;
  const o = {};
  for (let i = 0; i < keys.length; i++) {
    o[keys[i]] = cellToString(Array.isArray(row) ? row[i] : undefined).trim();
  }
  return o;
}

// Encode one value for USER_ENTERED: free text gets a leading apostrophe so
// it is stored as plain text; dates are written raw; empty stays empty.
function encodeCell(key, value) {
  const s = value == null ? '' : String(value);
  if (s === '') return '';
  if (DATE_KEYS.has(key)) {
    if (!isValidDate(s)) throw new Error('Invalid date value');
    return s;
  }
  return "'" + s;
}

function objectToRow(tabKey, obj) {
  return TABS[tabKey].keys.map((k) => encodeCell(k, obj[k]));
}

function maxLenFor(key) {
  return LONG_KEYS.has(key) ? LONG_MAX : SHORT_MAX;
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

const LEAD_ID_RE = /^L-(\d+)$/i;
const CONTACT_ID_RE = /^C-(\d+)$/i;

function nextId(prefix, re, existing) {
  let max = 0;
  for (const v of existing) {
    const m = re.exec(String(v == null ? '' : v).trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

// Given Projects rows (objects, sheet order), return [{index, id}] for rows
// that have a Project name but no Lead ID, numbered from max existing + 1.
function planLeadIds(rows) {
  let max = 0;
  for (const r of rows) {
    const m = LEAD_ID_RE.exec(r.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const plan = [];
  rows.forEach((r, index) => {
    if (r.project && !r.id) {
      max += 1;
      plan.push({ index, id: `L-${String(max).padStart(4, '0')}` });
    }
  });
  return plan;
}

module.exports = {
  TABS, ALLOWED_TAB_NAMES, STATUSES, ACTIVITY_TYPES, FITS, ROLES, DATE_KEYS, LONG_KEYS,
  SHORT_MAX, LONG_MAX, DATE_RE, LEAD_ID_RE, CONTACT_ID_RE,
  isValidDate, colLetter, lastCol, colOf, quoteTab, a1, rowToObject, encodeCell,
  objectToRow, maxLenFor, norm, nextId, planLeadIds,
};
