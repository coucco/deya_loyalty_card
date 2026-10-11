.PHONY: test e2e up logs backup dev
test:            ## автотесты сервера
	cd server && npm test
e2e:             ## проверка в браузере и плагина с живым сервером
	python3 e2e/e2e.py && python3 e2e/plugin_live.py
dev:             ## локальный запуск без Docker (коды из СМС печатаются в консоль)
	cd server && SEED_DEMO=1 node --disable-warning=ExperimentalWarning src/index.js
up:
	docker compose up -d --build
logs:
	docker compose logs -f app
backup:          ## копия БД в ./backups (для cron)
	docker compose exec -T app node scripts/backup.mjs /data/deya.db /data/backup-$$(date +%F).db
