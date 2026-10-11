import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return { pathMatched };
  }
}

export function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (over) return; if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, 'too_large', 'Слишком большой запрос')); } else chunks.push(c); });
    req.on('end', () => {
      if (over) return;
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid_json', 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(data);
}

/** Простой лимит запросов по ключу (IP) в минуту, в памяти процесса. */
export function makeLimiter(max) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (key) => { const n = (hits.get(key) || 0) + 1; hits.set(key, n); if (n > max) throw new HttpError(429, 'rate_limited', 'Слишком много запросов'); };
}

function serveStatic(publicDir, pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.includes('\0')) return false;
  const aliases = { '/cashier': '/cashier.html', '/admin': '/admin.html' };
  rel = aliases[rel.replace(/\/$/, '')] || rel;
  const root = path.resolve(publicDir);
  let file = path.join(root, path.normalize(rel));
  if (file !== root && !file.startsWith(root + path.sep)) return false;     // выход за пределы папки
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(rel)) return false;         // отсутствующий файл с расширением — 404
    file = path.join(root, 'index.html');   // SPA: любой другой путь → приложение
    if (!fs.existsSync(file)) return false;
  }
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  const noCache = ext === '.html' || path.basename(file) === 'sw.js';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': body.length,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600', ...SEC_HEADERS });
  res.end(body);
  return true;
}

export function createServer({ router, publicDir, log, clientIp }) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    let status = 500;
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        const m = router.match(req.method, url.pathname);
        if (!m.handler) throw m.pathMatched ? new HttpError(405, 'method_not_allowed', 'Метод не поддерживается') : new HttpError(404, 'not_found', 'Не найдено');
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), params: m.params, body, ip: clientIp(req) };
        const out = await m.handler(ctx);
        if (out && out.raw) { res.writeHead(200, { ...out.headers, ...SEC_HEADERS }); res.end(out.raw); status = 200; }
        else if (out && out.http) { status = out.http; sendJson(res, status, out.body); }
        else { status = 200; sendJson(res, 200, out ?? {}); }
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        status = 200;
        if (!serveStatic(publicDir, url.pathname, res)) { status = 404; sendJson(res, 404, { error: 'not_found' }); }
      } else { status = 405; sendJson(res, 405, { error: 'method_not_allowed' }); }
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; if (!res.headersSent) sendJson(res, status, { error: e.code, message: e.message }); }
      else { log.error(`[${req.method} ${url.pathname}]`, e); status = 500; if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Внутренняя ошибка' }); }
    } finally {
      if (url.pathname !== '/healthz') log.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: url.pathname, s: status, ms: Date.now() - started }));
    }
  });
}
