import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const silent = { log() {}, error: (...a) => { if (process.env.DEBUG_TESTS) console.error(...a); } };

export async function startApp(over = {}) {
  const cfg = loadConfig({ dbFile: ':memory:', port: 0, adminToken: 'test-admin-token-1234567890', otpResendSec: 0, ...over });
  cfg.secret = 'test-secret';
  const app = buildApp(cfg, { log: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, { body, token, headers } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* не json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const api = { ...app, cfg, base, call, admin: cfg.adminToken };
  api.stop = () => app.close();
  /** Создаёт точку с ключом через админ-API. */
  api.makePoint = async (id, kind, accrualPct = 0, redeemPct = 0) => {
    const ex = await call('GET', '/api/admin/points', { token: cfg.adminToken });
    if (!ex.json.points.find((p) => p.id === id)) await call('POST', '/api/admin/points', { token: cfg.adminToken, body: { id, name: id, kind, accrualPct, redeemPct } });
    else await call('PATCH', '/api/admin/points/' + id, { token: cfg.adminToken, body: { accrualPct, redeemPct, kind } });
    const k = await call('POST', `/api/admin/points/${id}/rotate-key`, { token: cfg.adminToken });
    return k.json.apiKey;
  };
  /** Регистрирует пользователя через настоящий OTP-поток, возвращает {token, card, phone}. */
  api.makeUser = async (phone = '+7 999 123-45-67') => {
    await call('POST', '/api/auth/request-code', { body: { phone } });
    const code = app.sms.outbox.at(-1).text.match(/(\d{4})/)[1];
    const v = await call('POST', '/api/auth/verify', { body: { phone, code, consent: true } });
    const me = await call('GET', '/api/me', { token: v.json.token });
    return { token: v.json.token, card: me.json.card.number, phone, me: me.json };
  };
  return api;
}

export const receipt = (card, key, lines, extra = {}) => ({
  schemaVersion: 1, idempotencyKey: key, pointId: 'hypermarket', registerId: 'K1', operation: 'SALE',
  card: { number: card, type: 'INTERNAL' },
  receipt: { key, total: lines.reduce((s, l) => s + Number(l.sum), 0).toFixed(2) },
  lines: lines.map((l, i) => ({ number: i + 1, name: 'T' + i, accrueAllowed: true, ...l })), ...extra,
});

export function tmpDbFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deya-')), 'test.db'); }
