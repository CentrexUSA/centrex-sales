'use strict';
// Local development server: serves public/ and mounts api/*.js with the
// request/response helpers Vercel's Node runtime provides.
//   node dev/server.js          (port 3000, MOCK=1 unless MOCK is set)

const http = require('http');
const fs = require('fs');
const path = require('path');

if (process.env.MOCK === undefined) process.env.MOCK = '1';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');
const MAX_BODY = 1024 * 1024;

// Apply the catch-all headers from vercel.json so local runs match production
// (Content-Security-Policy, frame and referrer rules).
const SITE_HEADERS = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const all = (cfg.headers || []).find((x) => x.source === '/(.*)');
    return all ? all.headers : [];
  } catch { return []; }
})();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function parseQuery(searchParams) {
  const q = {};
  for (const [k, v] of searchParams) {
    if (k in q) q[k] = Array.isArray(q[k]) ? [...q[k], v] : [q[k], v];
    else q[k] = v;
  }
  return q;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Mirrors Vercel: JSON bodies are parsed lazily and an invalid body throws on access.
function defineBody(req, raw) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let parsed;
  let done = false;
  Object.defineProperty(req, 'body', {
    configurable: true,
    enumerable: true,
    get() {
      if (done) return parsed;
      if (!raw.length) { parsed = undefined; done = true; return parsed; }
      const text = raw.toString('utf8');
      if (ct === 'application/json') {
        try { parsed = JSON.parse(text); } catch {
          const e = new Error('Invalid JSON'); e.statusCode = 400; throw e;
        }
      } else if (ct === 'application/x-www-form-urlencoded') {
        parsed = parseQuery(new URLSearchParams(text));
      } else if (ct === 'text/plain') {
        parsed = text;
      } else {
        parsed = raw;
      }
      done = true;
      return parsed;
    },
  });
}

function addResponseHelpers(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    if (typeof body === 'string' && !res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
    return res;
  };
}

function apiHandlerFor(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  const file = path.join(API_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  return require(file);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = null; }
  if (rel == null || rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    let target = file;
    if (!err && st.isDirectory()) target = path.join(file, 'index.html');
    fs.readFile(target, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    for (const { key, value } of SITE_HEADERS) res.setHeader(key, value);
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/api\/([^/]+?)\/?$/.exec(url.pathname);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      addResponseHelpers(res);
      const fn = m ? apiHandlerFor(m[1]) : null;
      if (!fn) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'not_found', message: 'That item was not found.' });
      }
      let raw;
      try { raw = await readRaw(req); } catch {
        return res.status(400).json({ error: 'bad_request', message: 'The request body is too large.' });
      }
      req.query = parseQuery(url.searchParams);
      req.cookies = parseCookies(req.headers.cookie);
      defineBody(req, raw);
      try {
        await fn(req, res);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'server_error', message: 'Something went wrong. Try again.' });
      }
      if (!res.writableEnded) res.end();
      return;
    }
    serveStatic(req, res, url.pathname);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`Centrex Sales dev server on http://localhost:${port} (MOCK=${process.env.MOCK})`);
  });
}

module.exports = { createServer };
