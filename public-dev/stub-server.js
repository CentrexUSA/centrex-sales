// Front-end development stub. Not shipped.
// Serves ../public and answers every route in SPEC.md "API" from in-memory data.
//
//   node public-dev/stub-server.js            (port 3100, or PORT=...)
//
// Users (email / code):
//   maria@centrex.test / manager-code-1   Manager  "Maria Lopez"
//   sam@centrex.test   / sales-code-1     Sales    "Sam Reyes"
//   olive@centrex.test / outside-code-1   Outside  "Olive Hart"
//
// Dev controls (GET):
//   /__dev/fail?n=1             the next n API mutations answer 500
//   /__dev/not-configured?on=1  every API route answers 503 not_configured (on=0 to stop)
//   /__dev/delay?ms=800         add latency to every API response
//   /__dev/expire               forget all sessions (next call answers 401)
//   /__dev/reset                reseed data and clear all modes

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3100);
const PUBLIC = path.join(__dirname, '..', 'public');
const STATUSES = ['New', 'Researching', 'Contacted', 'Bidding', 'Won', 'Lost', 'Watch'];
const ACTIVITY_TYPES = ['Call', 'Voicemail', 'Email', 'Meeting', 'Site visit', 'Note'];
const LONG = new Set(['notes', 'note', 'stage', 'whyFits']);
const DATE_FIELDS = new Set(['nextDate', 'firstSeen', 'addedOn']);
const LEAD_FIELDS = ['fit', 'status', 'project', 'owner', 'location', 'state', 'type', 'value', 'size', 'stage',
  'opening', 'gc', 'architect', 'whyFits', 'nextStep', 'nativeNote', 'source', 'nextOwner', 'nextDate', 'notes',
  'firstSeen', 'lastChecked', 'id', 'bondRequired'];
const CONTACT_FIELDS = ['name', 'title', 'company', 'email', 'phone', 'verifiedAt', 'notes'];

let modes = { fail: 0, notConfigured: false, delay: 0 };
const sessions = new Map();

function chicagoNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
function today() { return chicagoNow().date; }
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

let db;
function seed() {
  const t = today();
  const users = [
    { name: 'Maria Lopez', email: 'maria@centrex.test', role: 'Manager', code: 'manager-code-1', active: 'Yes' },
    { name: 'Sam Reyes', email: 'sam@centrex.test', role: 'Sales', code: 'sales-code-1', active: 'Yes' },
    { name: 'Olive Hart', email: 'olive@centrex.test', role: 'Outside', code: 'outside-code-1', active: 'Yes' },
    { name: 'Former Rep', email: 'former@centrex.test', role: 'Sales', code: 'former-code-1', active: 'No' },
  ];
  const L = (o) => Object.assign(Object.fromEntries(LEAD_FIELDS.map((k) => [k, ''])), o);
  const leads = [
    L({ id: 'L-0001', fit: 'A', status: 'Contacted', project: 'WinStar Tower 3 corridor carpet', owner: 'Chickasaw Nation', location: 'Thackerville', state: 'OK', type: 'Casino hotel', value: '$480,000', size: '62,000 sq ft', stage: 'Design development; carpet spec under review', opening: '2027-09', gc: 'Flintco', architect: 'JCJ Architecture', whyFits: 'Repeat customer. Woven carpet like the 2024 replacement.', nextStep: 'Call renovation manager about bid schedule', nativeNote: 'Tribal preference applies.', source: 'https://example.com/winstar-expansion', nextOwner: 'Sam Reyes', nextDate: addDays(t, -3), notes: 'Kevin knows the facilities director.', firstSeen: addDays(t, -40), lastChecked: addDays(t, -2) }),
    L({ id: 'L-0002', fit: 'A', status: 'Bidding', project: 'Choctaw Durant phase 4 guest rooms', owner: 'Choctaw Nation', location: 'Durant', state: 'OK', type: 'Hotel', value: '$1.2M', size: '900 rooms', stage: 'Bid documents issued', gc: 'Manhattan Construction', nextStep: 'Send revised carpet tile alternate to estimator', source: 'https://example.com/choctaw-phase4', nextOwner: 'Sam Reyes', nextDate: t, firstSeen: addDays(t, -60), lastChecked: addDays(t, -1) }),
    L({ id: 'L-0003', fit: 'B', status: 'Researching', project: 'Medical City Denton patient tower', owner: 'Medical City Healthcare', location: 'Denton', state: 'TX', type: 'Hospital', value: '', stage: 'Early', nextStep: 'Find the construction manager', nextOwner: 'Sam Reyes', nextDate: addDays(t, 4), firstSeen: addDays(t, -10) }),
    L({ id: 'L-0004', fit: 'B', status: 'New', project: 'Legacy West office tower lobby refresh', owner: 'Hillwood Properties', location: 'Plano', state: 'TX', type: 'Office', nextStep: 'Look up asset manager', nextOwner: 'To be named', nextDate: '', source: 'javascript:alert(1)', firstSeen: addDays(t, -2), lastChecked: t }),
    L({ id: 'L-0005', fit: 'C', status: 'Watch', project: 'Norman Public Schools bond, phase 2', owner: 'Norman Public Schools', location: 'Norman', state: 'OK', type: 'School', nextStep: 'Check procurement portal for flooring package', nextOwner: 'Olive Hart', nextDate: addDays(t, 9), firstSeen: addDays(t, -30) }),
    L({ id: 'L-0006', fit: 'A', status: 'Contacted', project: 'Riverwind Casino hotel renovation', owner: 'Chickasaw Nation', location: 'Norman', state: 'OK', type: 'Casino hotel', value: '$350,000', nextStep: 'Site walk with facilities team', nextOwner: 'Olive Hart', nextDate: addDays(t, -1), firstSeen: addDays(t, -20) }),
    L({ id: 'L-0007', fit: '', status: 'New', project: '<img src=x onerror=alert(1)> Tulsa hotel rebrand', owner: 'Unknown owner LLC', location: 'Tulsa', state: 'OK', type: 'Hotel', nextStep: '', nextOwner: '', nextDate: '', firstSeen: addDays(t, -1), lastChecked: t, source: 'https://example.com/tulsa-rebrand' }),
    L({ id: 'L-0008', fit: 'B', status: 'Won', project: 'Westin Galleria ballroom repair', owner: 'Westin Galleria Dallas', location: 'Dallas', state: 'TX', type: 'Hotel', value: '$85,000', nextStep: 'Hand off to Bridger for scheduling', nextOwner: 'Maria Lopez', nextDate: addDays(t, 2), firstSeen: addDays(t, -90) }),
    L({ id: 'L-0009', fit: 'C', status: 'Lost', project: 'Frisco corporate campus TI', owner: 'Undisclosed tenant', location: 'Frisco', state: 'TX', type: 'Office', nextStep: '', nextOwner: 'Sam Reyes', nextDate: '', firstSeen: addDays(t, -120) }),
    L({ id: 'L-0010', fit: 'A', status: 'Bidding', project: 'OU Health clinic flooring package', owner: 'OU Health', location: 'Oklahoma City', state: 'OK', type: 'Healthcare', value: '$210,000', nextStep: 'Confirm bid due date with GC', nextOwner: 'Maria Lopez', nextDate: addDays(t, 20), gc: 'Lingo Construction', firstSeen: addDays(t, -15) }),
    L({ id: 'L-0011', fit: 'B', status: 'Researching', project: 'Gainesville hospital wing', owner: 'North Texas Medical Center', location: 'Gainesville', state: 'TX', type: 'Hospital', nextStep: 'Ask Kevin for an introduction', nextOwner: 'Maria Lopez', nextDate: '', firstSeen: addDays(t, -5) }),
    L({ id: 'L-0012', fit: 'B', status: 'New', project: 'Hotel Drover second building', owner: 'Crescent Real Estate', location: 'Fort Worth', state: 'TX', type: 'Hotel', nextStep: 'Identify designer', nextOwner: 'Former Rep', nextDate: addDays(t, 1), firstSeen: addDays(t, -8) }),
  ];
  const contacts = [
    { id: 'C-0001', leadId: 'L-0001', name: 'Dana Whitfield', title: 'Renovation manager', company: 'Chickasaw Nation Commerce', email: 'dana@example.com', phone: '(580) 555-0142', verifiedAt: 'https://example.com/staff', notes: 'Prefers calls before 10am.', addedBy: 'Sam Reyes', addedOn: addDays(t, -30) },
    { id: 'C-0002', leadId: 'L-0001', name: 'Mark Ellis', title: 'Estimator', company: 'Flintco', email: 'not an email', phone: '', verifiedAt: 'Business card from site visit', notes: '', addedBy: 'Maria Lopez', addedOn: addDays(t, -12) },
    { id: 'C-0003', leadId: 'L-0006', name: 'Ray Tsosie', title: 'Facilities director', company: 'Riverwind', email: 'ray@example.com', phone: '405-555-0199', verifiedAt: 'Phone call', notes: '', addedBy: 'Olive Hart', addedOn: addDays(t, -10) },
  ];
  const activity = [
    { when: `${addDays(t, -30)} 14:02`, leadId: 'L-0001', project: 'WinStar Tower 3 corridor carpet', by: 'Sam Reyes', type: 'Update', note: 'Lead added', nextStep: '', nextDate: '' },
    { when: `${addDays(t, -10)} 09:15`, leadId: 'L-0001', project: 'WinStar Tower 3 corridor carpet', by: 'Sam Reyes', type: 'Call', note: 'Spoke with Dana. Bid schedule not set yet; design team still choosing between woven and tile.', nextStep: 'Call renovation manager about bid schedule', nextDate: addDays(t, -3) },
    { when: `${addDays(t, -5)} 11:40`, leadId: 'L-0006', project: 'Riverwind Casino hotel renovation', by: 'Olive Hart', type: 'Meeting', note: 'Met Ray at the property. Wants a site walk.', nextStep: 'Site walk with facilities team', nextDate: addDays(t, -1) },
  ];
  const openBids = [
    { title: 'Flooring replacement, Ada clinic', nation: 'Chickasaw Nation', bidId: 'CN-26-0412', closeDate: addDays(t, 6), contact: 'Procurement office', link: 'https://example.com/bids/cn-26-0412', relatedProject: '' },
    { title: 'Carpet tile, travel plaza remodel', nation: 'Choctaw Nation', bidId: 'CNO-8812', closeDate: addDays(t, 1), contact: 'J. Bond, buyer', link: 'https://example.com/bids/cno-8812', relatedProject: 'Choctaw Durant phase 4 guest rooms' },
    { title: 'Gym floor refinishing', nation: 'Cherokee Nation', bidId: 'CHN-554', closeDate: addDays(t, -4), contact: '', link: 'ftp://example.com/bad', relatedProject: '' },
    { title: 'LVT install, admin building', nation: 'Muscogee Nation', bidId: 'MCN-19', closeDate: 'TBD', contact: '', link: '', relatedProject: '' },
  ];
  db = { users, leads, contacts, activity, openBids };
}
seed();

// ---------- helpers ----------
const norm = (s) => String(s || '').trim().toLowerCase();
function activeUsers() { return db.users.filter((u) => u.active === 'Yes' && String(u.code).length >= 8); }
function isMine(lead, user) { return norm(lead.nextOwner) === norm(user.name); }
function isUnassigned(lead) { return !activeUsers().some((u) => norm(u.name) === norm(lead.nextOwner)); }
function canSee(lead, user) {
  if (user.role === 'Manager') return true;
  if (user.role === 'Sales') return isMine(lead, user) || isUnassigned(lead);
  return isMine(lead, user);
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function err(res, status, code, message) { send(res, status, { error: code, message }); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req).cx_session;
  const email = sid && sessions.get(sid);
  if (!email) return null;
  return activeUsers().find((u) => norm(u.email) === norm(email)) || null;
}
function nextId(list, prefix) {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).split('-')[1]) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
// Validate and clean a body subset; returns {fields} or {error}
function clean(body, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!allowed.includes(k)) return { error: ['field_not_allowed', `You cannot change ${k}.`] };
    const s = v == null ? '' : String(v);
    if (DATE_FIELDS.has(k) && s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: ['bad_date', `${k} must be a date like 2026-12-02.`] };
    out[k] = s.slice(0, LONG.has(k) ? 5000 : 300);
  }
  if ('status' in out && !STATUSES.includes(out.status)) return { error: ['bad_status', 'Status is not one of the allowed values.'] };
  return { fields: out };
}
function logActivity(user, lead, type, note, nextStep = '', nextDate = '') {
  const n = chicagoNow();
  const a = { when: `${n.date} ${n.time}`, leadId: lead.id, project: lead.project, by: user.name, type, note, nextStep, nextDate };
  db.activity.push(a);
  return a;
}
const LABELS = { status: 'status', nextStep: 'next step', nextDate: 'next step date', nextOwner: 'owner of next step' };
function describeChanges(fields) {
  return 'Changed ' + Object.entries(fields).map(([k, v]) => `${LABELS[k] || k} to ${v || '(blank)'}`).join('; ');
}
function allowedPatch(user, lead, body) {
  if (user.role === 'Manager') return LEAD_FIELDS.filter((f) => f !== 'id');
  const base = ['status', 'nextStep', 'nextDate'];
  if (user.role === 'Sales' && 'nextOwner' in body) {
    const v = norm(body.nextOwner);
    if (v === norm(user.name) || (v === '' && isMine(lead, user))) return base.concat('nextOwner');
  }
  return base;
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------- API ----------
async function api(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  if (modes.delay) await new Promise((r) => setTimeout(r, modes.delay));
  if (modes.notConfigured) return err(res, 503, 'not_configured', 'The app is not connected to its data yet.');

  let body = {};
  if (method === 'POST' || method === 'PATCH') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return err(res, 400, 'bad_request', 'Expected JSON.');
    body = await readBody(req);
    if (body === null) return err(res, 400, 'bad_request', 'Body is not valid JSON.');
    if (modes.fail > 0 && route !== '/api/login' && route !== '/api/logout') {
      modes.fail -= 1;
      return err(res, 500, 'server_error', 'Simulated failure.');
    }
  }

  if (route === '/api/login') {
    if (method !== 'POST') return err(res, 405, 'method_not_allowed', 'Use POST.');
    const u = activeUsers().find((x) => norm(x.email) === norm(body.email));
    if (!u || String(body.code || '') !== u.code) {
      await new Promise((r) => setTimeout(r, 500));
      return err(res, 401, 'invalid_login', 'That email and access code did not match.');
    }
    const sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, u.email);
    res.setHeader('Set-Cookie', `cx_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
    return send(res, 200, { user: { name: u.name, email: u.email, role: u.role } });
  }
  if (route === '/api/logout') {
    const sid = parseCookies(req).cx_session;
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'cx_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  const user = currentUser(req);
  if (!user) return err(res, 401, 'signed_out', 'Please sign in again.');

  if (route === '/api/me') return send(res, 200, { user: { name: user.name, email: user.email, role: user.role } });

  if (route === '/api/leads') {
    if (method === 'GET') {
      const people = user.role === 'Outside'
        ? [{ name: user.name, role: user.role }]
        : activeUsers().map((u) => ({ name: u.name, role: u.role }));
      return send(res, 200, {
        leads: db.leads.filter((l) => canSee(l, user)),
        people,
        openBids: user.role === 'Outside' ? [] : db.openBids,
        statuses: STATUSES,
        today: today(),
      });
    }
    if (method === 'POST') {
      if (user.role === 'Outside') return err(res, 404, 'not_found', 'Not found.');
      const allowed = LEAD_FIELDS.filter((f) => !['id', 'firstSeen', 'lastChecked'].includes(f));
      const c = clean(body, allowed);
      if (c.error) return err(res, 400, ...c.error);
      const f = c.fields;
      if (!String(f.project || '').trim()) return err(res, 400, 'missing_project', 'Project is required.');
      if (user.role === 'Sales') {
        if (!('nextOwner' in f)) f.nextOwner = user.name;
        if (f.nextOwner && norm(f.nextOwner) !== norm(user.name)) return err(res, 400, 'field_not_allowed', 'Sales can only assign leads to themselves.');
      }
      const lead = Object.assign(Object.fromEntries(LEAD_FIELDS.map((k) => [k, ''])), f, {
        id: nextId(db.leads, 'L'), firstSeen: today(), status: f.status || 'New',
      });
      db.leads.push(lead);
      logActivity(user, lead, 'Update', 'Lead added');
      return send(res, 201, { lead });
    }
    return err(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  if (route === '/api/lead') {
    const lead = db.leads.find((l) => l.id === url.searchParams.get('id'));
    if (!lead || !canSee(lead, user)) return err(res, 404, 'not_found', 'That lead was not found.');
    if (method === 'GET') {
      return send(res, 200, {
        lead,
        contacts: db.contacts.filter((c) => c.leadId === lead.id),
        activity: db.activity.filter((a) => a.leadId === lead.id).slice().reverse(),
      });
    }
    if (method === 'PATCH') {
      const c = clean(body, allowedPatch(user, lead, body));
      if (c.error) return err(res, 400, ...c.error);
      if (user.role === 'Manager' && 'nextOwner' in c.fields && c.fields.nextOwner &&
        !activeUsers().some((u) => norm(u.name) === norm(c.fields.nextOwner)) && c.fields.nextOwner !== lead.nextOwner) {
        return err(res, 400, 'bad_owner', 'Owner of next step must be an active user or blank.');
      }
      const changed = {};
      for (const [k, v] of Object.entries(c.fields)) if (lead[k] !== v) changed[k] = v;
      Object.assign(lead, c.fields);
      if (Object.keys(changed).length) logActivity(user, lead, 'Update', describeChanges(changed));
      return send(res, 200, { lead });
    }
    return err(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  if (route === '/api/activity') {
    if (method !== 'POST') return err(res, 405, 'method_not_allowed', 'Use POST.');
    const lead = db.leads.find((l) => l.id === body.leadId);
    if (!lead || !canSee(lead, user)) return err(res, 404, 'not_found', 'That lead was not found.');
    if (!ACTIVITY_TYPES.includes(body.type)) return err(res, 400, 'bad_type', 'Pick what kind of activity this was.');
    if (!String(body.note || '').trim()) return err(res, 400, 'missing_note', 'Say what happened.');
    const sub = {};
    for (const k of ['nextStep', 'nextDate', 'status']) if (body[k] !== undefined && body[k] !== '') sub[k] = body[k];
    const c = clean(sub, ['nextStep', 'nextDate', 'status']);
    if (c.error) return err(res, 400, ...c.error);
    const a = logActivity(user, lead, body.type, String(body.note).slice(0, 5000), c.fields.nextStep || '', c.fields.nextDate || '');
    for (const [k, v] of Object.entries(c.fields)) if (v !== '') lead[k] = v;
    return send(res, 201, { activity: a, lead });
  }

  if (route === '/api/contacts') {
    if (method === 'POST') {
      const lead = db.leads.find((l) => l.id === body.leadId);
      if (!lead || !canSee(lead, user)) return err(res, 404, 'not_found', 'That lead was not found.');
      const { leadId, ...rest } = body;
      const c = clean(rest, CONTACT_FIELDS);
      if (c.error) return err(res, 400, ...c.error);
      if (!String(c.fields.name || '').trim()) return err(res, 400, 'missing_name', 'Name is required.');
      const contact = Object.assign(Object.fromEntries(CONTACT_FIELDS.map((k) => [k, ''])), c.fields, {
        id: nextId(db.contacts, 'C'), leadId, addedBy: user.name, addedOn: today(),
      });
      db.contacts.push(contact);
      return send(res, 201, { contact });
    }
    if (method === 'PATCH') {
      const contact = db.contacts.find((x) => x.id === url.searchParams.get('id'));
      const lead = contact && db.leads.find((l) => l.id === contact.leadId);
      if (!contact || !lead || !canSee(lead, user)) return err(res, 404, 'not_found', 'That contact was not found.');
      const c = clean(body, CONTACT_FIELDS);
      if (c.error) return err(res, 400, ...c.error);
      if ('name' in c.fields && !c.fields.name.trim()) return err(res, 400, 'missing_name', 'Name is required.');
      Object.assign(contact, c.fields);
      return send(res, 200, { contact });
    }
    return err(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  return err(res, 404, 'not_found', 'No such route.');
}

// ---------- static ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/__dev/')) {
      const q = url.searchParams;
      if (url.pathname === '/__dev/fail') modes.fail = Number(q.get('n') || 1);
      else if (url.pathname === '/__dev/not-configured') modes.notConfigured = q.get('on') !== '0';
      else if (url.pathname === '/__dev/delay') modes.delay = Number(q.get('ms') || 0);
      else if (url.pathname === '/__dev/expire') sessions.clear();
      else if (url.pathname === '/__dev/reset') { seed(); modes = { fail: 0, notConfigured: false, delay: 0 }; }
      return send(res, 200, { modes });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return err(res, 500, 'server_error', 'Something went wrong.');
  }
}).listen(PORT, () => console.log(`Stub server on http://localhost:${PORT}`));
