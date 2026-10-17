/**
 * Метрики для админки: регистрации, чеки, начисления/списания по дням, повторные покупки (удержание), обязательства по баллам.
 * Всё считается из журнала (ledger) и users, без отдельного хранилища: для одного ТРЦ запросы быстрые.
 * Для внешней BI-системы (DataLens, Metabase) достаточно read-only доступа к копии БД (scripts/backup.mjs).
 */
import { one, all } from './db.js';

export function metrics(db, days = 30) {
  days = Math.min(Math.max(Number(days) || 30, 1), 366);
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const byDay = new Map();
  const day = (d) => { if (!byDay.has(d)) byDay.set(d, { day: d, registrations: 0, receipts: 0, buyers: 0, accrued: 0, redeemed: 0, salesKop: 0 }); return byDay.get(d); };
  for (const r of all(db, 'SELECT substr(created_at,1,10) d, COUNT(*) n FROM users WHERE stub=0 AND created_at>=? GROUP BY d', since)) day(r.d).registrations = r.n;
  for (const r of all(db, `SELECT substr(created_at,1,10) d, COUNT(*) n, COUNT(DISTINCT user_id) u, SUM(points) p, SUM(COALESCE(base_kop,0)) k
    FROM ledger WHERE type='ACCRUAL' AND created_at>=? GROUP BY d`, since)) Object.assign(day(r.d), { receipts: r.n, buyers: r.u, accrued: r.p, salesKop: r.k });
  for (const r of all(db, "SELECT substr(created_at,1,10) d, SUM(-points) p FROM ledger WHERE type='REDEEM' AND created_at>=? GROUP BY d", since)) day(r.d).redeemed = r.p;

  // удержание: из тех, кто впервые купил в периоде, сколько купили ещё раз (в любой день после первого чека)
  const cohort = one(db, `SELECT COUNT(*) total, SUM(CASE WHEN n>1 THEN 1 ELSE 0 END) repeat FROM (
      SELECT user_id, COUNT(*) n, MIN(created_at) first FROM ledger WHERE type='ACCRUAL' GROUP BY user_id) WHERE first>=?`, since);
  const active30 = one(db, "SELECT COUNT(DISTINCT user_id) n FROM ledger WHERE type IN ('ACCRUAL','REDEEM') AND created_at>=?",
    new Date(Date.now() - 30 * 86400_000).toISOString()).n;
  return {
    days,
    totals: {
      users: one(db, 'SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL AND stub=0').n,
      unboundPhysicalCards: one(db, "SELECT COUNT(*) n FROM cards WHERE kind='physical' AND status='active' AND user_id IN (SELECT id FROM users WHERE stub=1)").n,
      marketingConsents: one(db, 'SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL AND marketing_at IS NOT NULL').n,
      autoRedeemOn: one(db, 'SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL AND auto_redeem=1').n,
      active30,
      liabilityPoints: one(db, 'SELECT COALESCE(SUM(balance),0) s FROM accounts').s,   // обязательства по баллам
      newBuyers: cohort.total || 0,
      repeatBuyers: cohort.repeat || 0,
      repeatRatePct: cohort.total ? Math.round((1000 * cohort.repeat) / cohort.total) / 10 : 0,
    },
    daily: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
  };
}
