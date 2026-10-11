// Сверка: баланс каждого клиента должен равняться сумме его журнала. node scripts/reconcile.mjs data/deya.db
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2] || 'data/deya.db', { readOnly: true });
const bad = db.prepare(`SELECT a.user_id, a.balance, COALESCE(SUM(l.points),0) AS ledger_sum FROM accounts a LEFT JOIN ledger l ON l.user_id=a.user_id
  GROUP BY a.user_id HAVING a.balance != COALESCE(SUM(l.points),0)`).all();
const total = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
if (bad.length) { console.error('РАСХОЖДЕНИЯ:', bad); process.exit(1); }
console.log(`Сверка пройдена: ${total} счетов, расхождений нет`);
