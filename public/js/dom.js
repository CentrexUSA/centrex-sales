// DOM and formatting helpers. Every piece of API data goes through
// textContent or a DOM property; nothing here ever uses innerHTML.

/**
 * h('div', {class: 'x', on: {click: fn}, attrs...}, child, ...)
 * Children may be nodes, strings (become text nodes), arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'required' || k === 'hidden' || k === 'open' || k === 'noValidate') el[k] = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

let idSeq = 0;
export function uid(prefix = 'f') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

// ---------- links ----------

/** Returns a safe absolute http(s) URL string, or null. */
export function safeHttpUrl(raw) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** An external link if the URL is http(s); otherwise plain text. */
export function externalLink(raw, label) {
  const url = safeHttpUrl(raw);
  const text = label || String(raw || '');
  if (!url) return h('span', { class: 'plain-url' }, text);
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'ext' }, text);
}

export function telHref(phone) {
  const s = String(phone || '');
  const digits = s.replace(/[^\d+]/g, '');
  if ((digits.match(/\d/g) || []).length < 7) return null;
  return `tel:${digits}`;
}

export function mailHref(email) {
  const s = String(email || '').trim();
  // No ? & # % so a stored address cannot add cc/bcc/body parameters to the mailto link.
  if (!/^[^\s@<>"'(),;:\\?&#%]+@[^\s@<>"'(),;:\\?&#%]+\.[^\s@<>"'(),;:\\?&#%]+$/.test(s)) return null;
  return `mailto:${s}`;
}

// ---------- dates (calendar dates, never UTC timestamps) ----------

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const chk = new Date(t);
  if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return { y, mo, d, day: Math.round(t / 86400000), wd: chk.getUTCDay() };
}

export const isISODate = (s) => parseISO(s) !== null;

/** "Mon, Nov 30"; adds the year when it differs from the reference year. */
export function fmtDate(s, todayIso) {
  const p = parseISO(s);
  if (!p) return String(s || '');
  const ref = parseISO(todayIso);
  const base = `${WD[p.wd]}, ${MO[p.mo - 1]} ${p.d}`;
  return ref && ref.y !== p.y ? `${base}, ${p.y}` : base;
}

/** Whole days from today to s (negative = past), or null. */
export function daysFrom(todayIso, s) {
  const a = parseISO(todayIso); const b = parseISO(s);
  if (!a || !b) return null;
  return b.day - a.day;
}

export function addDays(iso, n) {
  const p = parseISO(iso);
  if (!p) return '';
  return new Date((p.day + n) * 86400000).toISOString().slice(0, 10);
}

export function weekday(iso) {
  const p = parseISO(iso);
  return p ? p.wd : null;
}

export function relLabel(todayIso, s) {
  const n = daysFrom(todayIso, s);
  if (n === null) return '';
  if (n < -1) return `${-n} days overdue`;
  if (n === -1) return '1 day overdue';
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  return `In ${n} days`;
}

/** "YYYY-MM-DD HH:mm" -> "Mon, Nov 30, 2:15 pm" */
export function fmtWhen(s, todayIso) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || '').trim());
  if (!m || !isISODate(m[1])) return String(s || '');
  let out = fmtDate(m[1], todayIso);
  if (m[2] !== undefined) {
    const hr = +m[2];
    const ampm = hr >= 12 ? 'pm' : 'am';
    const h12 = hr % 12 === 0 ? 12 : hr % 12;
    out += `, ${h12}:${m[3]} ${ampm}`;
  }
  return out;
}

// ---------- names ----------
export const norm = (s) => String(s || '').trim().toLowerCase();

// ---------- drafts (keep typed input across failures, 401s and navigation) ----------

const DRAFT_PREFIX = 'cx-draft:';

function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button') continue;
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    out[el.name] = el.value;
  }
  return out;
}

export function readForm(form) { return formValues(form); }

/**
 * Restores a saved draft into the form (if any) and saves on every edit.
 * Returns true when a draft was restored.
 */
export function bindDraft(form, key) {
  const k = DRAFT_PREFIX + key;
  let restored = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(k) || 'null');
    if (saved && typeof saved === 'object') {
      for (const el of form.elements) {
        if (!el.name || !(el.name in saved)) continue;
        if (el.type === 'radio') el.checked = el.value === saved[el.name];
        else if (el.type === 'checkbox') el.checked = !!saved[el.name];
        else el.value = String(saved[el.name]);
        restored = true;
      }
    }
  } catch { /* ignore bad draft */ }
  const save = () => {
    try { sessionStorage.setItem(k, JSON.stringify(formValues(form))); } catch { /* storage full or blocked */ }
  };
  form.addEventListener('input', save);
  form.addEventListener('change', save);
  return restored;
}

export function hasDraft(key) {
  try { return sessionStorage.getItem(DRAFT_PREFIX + key) !== null; } catch { return false; }
}

export function clearDraft(key) {
  try { sessionStorage.removeItem(DRAFT_PREFIX + key); } catch { /* ignore */ }
}

export function clearAllDrafts() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}
