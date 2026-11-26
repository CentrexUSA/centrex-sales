# Centrex Sales: app spec

A small web app for Centrex Flooring salespeople to add, track and update leads. Data lives in one private Google Sheet ("Centrex Sales Lead Tracker"). Users never get access to the sheet; the server reads and writes it with a Google service account and returns only the rows a user's role allows.

Hosting: Vercel, no framework, no build step, **zero npm dependencies**.
- `public/` is served as static files at the site root (`public/index.html`, `public/app.js`, `public/styles.css`).
- `api/*.js` are Vercel Node serverless functions, CommonJS: `module.exports = async (req, res) => { ... }`. Use Vercel's Node helpers: `req.query`, `req.body` (parsed JSON), `req.cookies`, `res.status(n).json(obj)`, `res.setHeader`.
- Shared server code is in `lib/*.js` (CommonJS), required from `api/`.
- Node 20+. Use built-in `fetch` and `crypto` only.

## Environment

| Variable | Meaning |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full contents of the service account key file (JSON string). Secret. |
| `SHEET_ID` | Spreadsheet ID. Defaults to `1PBuH6NeSZAhke2_B_59c8iQTFsg4wKR36c11lhAAWmM` if unset. |
| `MOCK` | `1` = use the in-memory mock store (local development and tests only; refused with `not_configured` whenever `VERCEL` or `VERCEL_ENV` is set). |

If `MOCK` is not `1` and `GOOGLE_SERVICE_ACCOUNT_JSON` is missing or unparsable, every API route answers `503 {"error":"not_configured"}`.

The session-signing key is derived, not configured: `sha256("cx-session:" + private_key)`. In mock mode use a fixed development key.

## Sheet layout

Row 1 of every tab is a header row. Data starts at row 2. Read with `valueRenderOption=FORMATTED_VALUE`. Dates display as `YYYY-MM-DD`.

**Projects** (A to X), one row per lead. JSON key in brackets.
A Fit [fit] (A, B, C or blank) · B Status [status] (New, Researching, Contacted, Bidding, Won, Lost, Watch) · C Project [project] · D Owner [owner] (the customer: tribe or business) · E Location [location] · F State [state] · G Type [type] · H Value [value] · I Size [size] · J Stage [stage] · K Opening [opening] · L General contractor [gc] · M Architect [architect] · N Why it fits [whyFits] · O Next step [nextStep] · P Native preference note [nativeNote] · Q Source [source] (URL) · R Owner of next step [nextOwner] (a user's Name, or free text) · S Next step date [nextDate] · T Notes [notes] · U First seen [firstSeen] · V Last checked [lastChecked] · W Lead ID [id] (`L-0001`, ...) · X Bond required [bondRequired] (Yes, No, Unknown or blank; blank means not checked)

A separate weekly scan appends rows to Projects with A to V filled and W blank (X, Bond required, may be filled or blank). When the server reads Projects and finds a row with a Project name and no Lead ID, it assigns the next ID (max existing number + 1, zero-padded to 4) and writes it to column W before returning. A row with no Project name is ignored.

**Contacts** (A to K): Contact ID [id] (`C-0001`) · Lead ID [leadId] · Name [name] · Title or role [title] · Company [company] · Email [email] · Phone [phone] · Where verified [verifiedAt] (where this contact detail came from) · Notes [notes] · Added by [addedBy] · Added on [addedOn]

**Activity** (A to H), append-only: When [when] (`YYYY-MM-DD HH:mm`, America/Chicago) · Lead ID [leadId] · Project [project] · By [by] (user Name) · Type [type] (Call, Voicemail, Email, Meeting, Site visit, Note, Update) · What happened [note] · Next step set [nextStep] · Next step date set [nextDate]

**Users** (A to E): Name [name] · Email [email] · Role [role] (Manager, Sales, Outside) · Access code [code] · Active [active] (Yes / No)

**Open bids** (A to G), read-only for the app: Title [title] · Nation [nation] · Bid ID [bidId] · Close date [closeDate] · Contact [contact] · Link [link] · Related project [relatedProject]

Other tabs exist and must never be read or written.

### Writing to the sheet
- Use `valueInputOption=USER_ENTERED`.
- Every free-text value is written with a leading apostrophe (`'` + text) so it is stored as plain text and can never become a formula, number or date. Empty string is written as empty string.
- Date fields (`nextDate`, `firstSeen`, `addedOn`) must match `^\d{4}-\d{2}-\d{2}$` (or be empty) and are written without the apostrophe. Reject anything else with 400.
- To update a lead or contact, re-read the ID column fresh to find the row number immediately before writing; never trust a cached row number.
- Cap field lengths: 300 characters for short fields, 5000 for `notes`, `note`, `stage`, `whyFits`.

## Sign-in and sessions

- `POST /api/login` body `{email, code}`. Match a Users row by email (case-insensitive, trimmed) with Active = Yes and an access code of at least 8 characters, compared in constant time. Any failure: wait about 500 ms, answer `401 {"error":"invalid_login"}` (same message for every cause). Add a best-effort in-memory throttle: after 8 failures for the same email or IP within 15 minutes answer `429 {"error":"too_many_attempts"}`.
- On success set cookie `cx_session` = `base64url(JSON {email, exp, v})` + `.` + `base64url(HMAC-SHA256)`, where `v` is a short HMAC tag of the user's access code (so changing a code in Users ends that user's sessions; a session whose `v` does not match the current code is `signed_out`); `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600` (14 days). Omit `Secure` only in mock mode. Answer `{user: {name, email, role}}`.
- Every other route: verify the cookie signature and expiry, then look the email up in Users again (Users may be cached for 60 seconds). If the row is gone, inactive, or has no valid code, answer `401 {"error":"signed_out"}`. Name and role always come from the sheet, never from the cookie.
- `POST /api/logout` clears the cookie. `GET /api/me` answers `{user}` or 401.
- Mutating routes (POST, PATCH) must reject requests whose `Content-Type` is not `application/json` (basic CSRF guard) and whose `Origin` header, when present, does not match the request host.
- Never return access codes, other users' emails, or anything from Users beyond `name` and `role`.

## Roles and visibility

A lead is **mine** when `nextOwner` equals my Name (case-insensitive, trimmed). A lead is **unassigned** when `nextOwner` does not equal the Name of any active user (blank or free text such as "To be named").

| Role | Sees | May change |
|---|---|---|
| Manager | every lead, Open bids | any Projects field on any lead; add leads; assign `nextOwner` to any active user or clear it |
| Sales | mine + unassigned, Open bids | on visible leads: `status`, `nextStep`, `nextDate`, `bondRequired`, and may set `nextOwner` to their own Name (claim) or clear it when it is theirs; add leads; add and edit contacts; log activity |
| Outside | mine only; no Open bids | on mine: `status`, `nextStep`, `nextDate`; add and edit contacts; log activity. Cannot add leads or change `nextOwner` |

Contacts and activity for a lead follow that lead's visibility. Asking for a lead you cannot see answers `404 {"error":"not_found"}` (never 403, so existence is not revealed).

## API

All responses are JSON. Errors: `{"error": "<code>", "message": "<plain sentence>"}` with 400, 401, 404, 405, 429, 503 or 500. Send `Cache-Control: no-store` on every API response.

- `GET /api/leads` → `{leads: [Lead], people: [{name, role}], openBids: [OpenBid], statuses: [...], today: "YYYY-MM-DD"}`. `leads` is filtered by role. `people` is the list of active users' names and roles (Manager and Sales get everyone; Outside gets only themself). `openBids` is `[]` for Outside. `today` is the current date in America/Chicago.
- `POST /api/leads` body: any Lead fields except `id`, `firstSeen`, `lastChecked`. `project` is required. Server sets `id`, `firstSeen` = today, `status` default `New`; for Sales, `nextOwner` defaults to their Name if not given and may only be their Name or blank. Appends a row. → `201 {lead}`. Also appends an Activity row of type `Update`, note `Lead added`.
- `GET /api/lead?id=L-0001` → `{lead, contacts: [Contact], activity: [Activity]}` (activity newest first).
- `PATCH /api/lead?id=L-0001` body: subset of fields. Fields the role may not change → `400 {"error":"field_not_allowed"}`. `status` must be one of the seven. → `{lead}`. Appends an Activity row of type `Update` listing which fields changed (for example `Changed status to Contacted; next step date to 2026-12-02`).
- `POST /api/activity` body `{leadId, type, note, nextStep?, nextDate?, status?}`. `type` must be one of Call, Voicemail, Email, Meeting, Site visit, Note. `note` required. Appends the Activity row, then applies `nextStep`, `nextDate`, `status` to the lead when given. → `201 {activity, lead}`.
- `POST /api/contacts` body `{leadId, name, title?, company?, email?, phone?, verifiedAt?, notes?}`; `name` required. → `201 {contact}`.
- `PATCH /api/contacts?id=C-0001` body: subset of the same fields (not `leadId`). → `{contact}`.

No delete routes.

## Store interface (`lib/store.js`)

`getStore()` returns the Sheets store or the mock store, both with the same async methods: `listUsers()`, `listLeads()`, `appendLead(lead)`, `updateLead(id, fields)`, `listContacts(leadId)`, `appendContact(c)`, `updateContact(id, fields)`, `listActivity(leadId)`, `appendActivity(a)`, `listOpenBids()`. The Sheets store may cache reads for up to 15 seconds per function instance and must clear the relevant cache after a write.

Mock store: in-memory, seeded from `dev/mock-data.js` with about 10 leads across all statuses, 3 users (one per role, codes `manager-code-1`, `sales-code-1`, `outside-code-1`), a few contacts, activity rows and open bids. Seed next-step dates relative to today so some are overdue, some due today, some upcoming.

## Front end (`public/`)

Vanilla JS single page, hash routing, no build, no external scripts or fonts. Must work well on a phone (a salesperson logging a call from a truck) and on a desktop.

Screens:
1. **Sign in**: email + access code. Plain errors. If the API answers `not_configured`, say the app is not connected to its data yet and to contact Michael Mason.
2. **Today** (default after sign-in): my leads grouped as Overdue, Due today, Coming up (next 14 days), No date set; then Unassigned leads I can claim (Sales/Manager). Each card: project, customer, status, next step, date, and a one-tap "Log" button.
3. **Pipeline**: all visible leads. Search box; filters for status, fit, owner of next step, state. Desktop: table. Phone: cards. Sort by next step date by default. Managers also see a summary strip: count by status, leads with no owner, leads with no next step date, overdue count.
4. **Lead**: header (project, customer, location, status, fit); "Next step" block (step, owner, date) with quick edit; **Contacts** list with add/edit, `tel:` and `mailto:` links, and where each was verified; **Activity** timeline with a "Log activity" form (type, what happened, new next step, new date, optional new status); **Project facts** (type, value, size, stage, opening, GC, architect, bond required, why it fits, native preference note, source link, notes, first seen, last checked). Managers get "Edit details" for every field and an owner picker.
5. **Add lead** (Manager, Sales): project (required), customer, location, state, type, value, size, stage, GC, architect, bond required, source link, next step, next step date, notes.
6. **Open bids** (Manager, Sales): read-only list sorted by close date, with links.

Rules: treat every value from the API as untrusted text (set `textContent`, never `innerHTML` with data; only allow `http:`/`https:` in links). Show dates as `Mon, Nov 30`. On a 401 from any call, go to the sign-in screen. Show a clear saving state and a clear failure message; never lose what the user typed on a failed save.

Copy style: plain words a salesperson uses. Sentence case. No emoji. Labels say what things are ("Next step", "Owner of next step", "Where verified").

Look: calm and professional, built for scanning. System font stack. Neutral greys with one deep accent colour; status shown as small labelled chips that do not rely on colour alone. Large tap targets on phones. Respect `prefers-color-scheme` is optional; light theme is required.

## Local development

`node dev/server.js` (port 3000, `MOCK=1` by default) serves `public/` and mounts each `api/*.js` handler with the same helpers Vercel provides (`req.query`, `req.body`, `req.cookies`, `res.status().json()`). `node dev/test.js` runs API tests against the mock store using only Node built-ins.
