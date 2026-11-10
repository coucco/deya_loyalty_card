import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
const app = buildApp(cfg);
app.server.listen(cfg.port, () => {
  console.log(`Дея-лояльность: порт ${cfg.port}, БД ${cfg.dbFile}`);
  if (!process.env.ADMIN_TOKEN) console.log(`ADMIN_TOKEN (dev, случайный на этот запуск): ${cfg.adminToken}`);
  if (cfg.isProd && cfg.smsProvider === 'console') {
    console.log('!!! ТЕСТОВЫЙ РЕЖИМ СМС: коды входа НЕ отправляются, а пишутся в этот лог (строки [SMS→…]). Не для боя: уберите SMS_CONSOLE_TEST и SMS_PROVIDER=console');
  }
});
const stop = () => { console.log('останавливаюсь…'); app.server.close(() => { app.db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
