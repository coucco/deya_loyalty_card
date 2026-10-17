#!/usr/bin/env python3
"""Сквозная проверка в настоящем браузере (Chromium): весь путь клиента + касса + админка.
Запуск: python3 e2e/e2e.py   (поднимает сервер сам, БД во временной папке)"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request, signal
import cv2, numpy as np
import zxingcpp
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'e2e', 'shots'); os.makedirs(SHOTS, exist_ok=True)
PORT = 3917; BASE = f'http://127.0.0.1:{PORT}'; ADMIN = 'e2e-admin-token-0123456789abc'
PHONE_DIGITS = '9991234567'
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('  ok  ' if cond else ' FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond: print('       ', extra)

def req(method, path, body=None, token=None, headers=None):
    r = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={**({'Content-Type': 'application/json'} if body is not None else {}), **({'Authorization': 'Bearer ' + token} if token else {}), **(headers or {})})
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

tmp = tempfile.mkdtemp(prefix='deya-e2e-')
logf = open(os.path.join(tmp, 'server.log'), 'w+')
env = {**os.environ, 'PORT': str(PORT), 'DB_FILE': os.path.join(tmp, 'e2e.db'), 'ADMIN_TOKEN': ADMIN, 'SMS_PROVIDER': 'console', 'SEED_DEMO': '1', 'OTP_RESEND_SEC': '1'}
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', os.path.join(ROOT, 'server/src/index.js')], env=env, stdout=logf, stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/healthz'); break
        except Exception: time.sleep(0.1)
    else: raise SystemExit('сервер не стартовал')
    def sms_code():
        for _ in range(40):
            logf.flush(); logf.seek(0)
            m = re.findall(r'\[SMS→\d+\] Код входа в Дея: (\d{4})', logf.read())
            if m: return m[-1]
            time.sleep(0.1)
        raise SystemExit('код не пришёл')
    # ключи точек
    _, hk = req('POST', '/api/admin/points/hypermarket/rotate-key', token=ADMIN); HKEY = hk['apiKey']
    _, ck = req('POST', '/api/admin/points/cinema/rotate-key', token=ADMIN); CKEY = ck['apiKey']

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        ctx = b.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2, locale='ru-RU')
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        print('1. Вход')
        page.goto(BASE + '/')
        page.wait_for_selector('input[type=tel]')
        page.screenshot(path=f'{SHOTS}/01-login.png')
        check('кнопка «Получить код» неактивна без номера', page.is_disabled('text=Получить код'))
        page.fill('input[type=tel]', '9991234567')
        check('номер форматируется как 999 123-45-67', page.input_value('input[type=tel]') == '999 123-45-67')
        check('без обязательных галочек кнопка неактивна', page.is_disabled('text=Получить код'))
        check('ссылки на документы на экране входа', page.locator('a[href="/legal/rules.html"]').count() == 1 and page.locator('a[href="/legal/pd-consent.html"]').count() == 1
              and page.locator('a[href="/legal/privacy.html"]').count() == 1 and page.locator('a[href="/legal/marketing-consent.html"]').count() == 1)
        check('галочки не отмечены заранее', page.locator('.consent input:checked').count() == 0)
        page.check('input[aria-label=rules]'); page.check('input[aria-label=pd]')
        check('с обязательными галочками кнопка активна (рассылки — по желанию)', not page.is_disabled('text=Получить код'))
        page.screenshot(path=f'{SHOTS}/01-login.png')
        page.click('text=Получить код')
        page.wait_for_selector('text=Введите код')
        check('экран кода показывает «Отправили код в СМС на номер +7 999 123-45-67»', page.locator('text=+7 999 123-45-67').count() == 1)
        page.screenshot(path=f'{SHOTS}/02-code.png')
        page.fill('input[autocomplete=one-time-code]', '0000' if sms_code() != '0000' else '1111')
        page.wait_for_selector('text=Неверный код')
        check('неверный код — сообщение об ошибке', True)
        page.fill('input[autocomplete=one-time-code]', sms_code())
        page.wait_for_selector('text=Показать QR на кассе')
        check('после верного кода открывается главная', True)
        page.screenshot(path=f'{SHOTS}/03-home-empty.png')
        check('на главной 0 баллов и «5% баллами с каждой покупки»', page.locator('.balance .sum').inner_text().startswith('0') and page.locator('text=5% баллами с каждой покупки').count() == 1)

        print('2. QR и начисление')
        page.click('text=Показать QR на кассе'); page.wait_for_selector('canvas')
        page.wait_for_timeout(300)
        page.screenshot(path=f'{SHOTS}/04-qr.png')
        card = page.locator('.qrcard .num').inner_text().replace(' ', '')
        png = page.locator('canvas').screenshot()
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
        check('QR на экране считывается декодером и содержит номер карты', decoded == card and len(card) == 13, f'{decoded!r} vs {card!r}')
        # касса: чек из плагина
        st, r = req('POST', '/api/v1/accruals', token=HKEY, headers={'Idempotency-Key': 'fd:E2E:1'}, body={
            'schemaVersion': 1, 'idempotencyKey': 'fd:E2E:1', 'pointId': 'hypermarket', 'operation': 'SALE', 'card': {'number': card},
            'receipt': {'key': 'fd:E2E:1', 'total': '2400.00'}, 'lines': [{'number': 1, 'name': 'Товары', 'sum': '2400.00', 'accrueAllowed': True}]})
        check('касса: чек 2400 ₽ принят, +120 баллов', st == 200 and r['accrued'] == 120, str(r))
        page.wait_for_selector('text=баллов начислено', timeout=8000)
        check('экран «Начисление прошло» появился сам (без обновления страницы)', page.locator('.big').inner_text() == '+120')
        check('на экране успеха: чек 2 400 ₽ и 5% от чека', page.locator('text=чек 2 400 ₽').count() == 1 and page.locator('text=5% от чека').count() == 1)
        page.screenshot(path=f'{SHOTS}/05-success.png')
        page.click('text=Отлично'); page.wait_for_selector('text=Последние операции')
        check('баланс на главной = 120', page.locator('.balance .sum').inner_text().startswith('120'))
        st, r = req('POST', '/api/v1/accruals', token=HKEY, body={'idempotencyKey': 'fd:E2E:1', 'operation': 'SALE', 'card': {'number': card}, 'receipt': {'total': '2400.00'}, 'lines': [{'sum': '2400.00'}]})
        check('повтор того же чека -> 409, баланс не меняется', st == 409 and r['accrued'] == 120)
        page.screenshot(path=f'{SHOTS}/06-home.png')

        print('3. Как тратить / история / профиль')
        page.click('text=Как можно тратить баллы?'); page.wait_for_selector('.place')
        check('карусель: 2 карточки, у кино «Скидка на билеты 10%»', page.locator('.place').count() == 2 and page.locator('text=Скидка на билеты').count() == 1 and page.locator('.place >> text=10%').count() >= 1)
        page.screenshot(path=f'{SHOTS}/07-spend.png')
        page.click('.nav.r'); page.wait_for_timeout(600)
        check('стрелка › прокручивает карусель к боулингу', page.evaluate("document.querySelector('.car-track').scrollLeft") > 50 or page.locator('.dots i.on').count() == 1)
        page.click('.back'); page.click('text=История'); page.wait_for_selector('.day')
        check('история: «Сегодня», гипермаркет, +120', page.locator('.day').first.inner_text().lower() == 'сегодня' and page.locator('.item .pl').first.inner_text() == '+120')
        page.screenshot(path=f'{SHOTS}/08-history.png')
        page.click('text=Профиль'); page.wait_for_selector('text=Выйти')
        page.fill('input[placeholder="Как к вам обращаться"]', '<b>Анна</b>'); page.press('input[placeholder="Как к вам обращаться"]', 'Tab')
        page.wait_for_selector('text=Сохранено')
        page.screenshot(path=f'{SHOTS}/09-profile.png')
        page.click('text=Главная'); page.wait_for_selector('text=Здравствуйте')
        check('имя с HTML-тегами показывается как текст, а не разметка', page.locator('p b').first.inner_text() == '<b>Анна</b>' and page.locator('p b b').count() == 0)

        print('4. Списание на точке трат (API)')
        st, q = req('POST', '/api/v1/redeem/quote', token=CKEY, body={'card': card, 'checkTotal': '500.00'})
        check('кино: чек 500 ₽, лимит 10% -> до 50 баллов', st == 200 and q['maxPoints'] == 50, str(q))
        st, hd = req('POST', '/api/v1/redeem/hold', token=CKEY, body={'card': card, 'checkTotal': '500.00', 'points': 50, 'idempotencyKey': 'e2e-h1'})
        st2, cm = req('POST', f"/api/v1/redeem/{hd['holdId']}/commit", token=CKEY)
        check('списание 50 баллов подтверждено, остаток 70', st == 201 and st2 == 200 and cm['balance'] == 70, str(cm))
        page.reload(); page.wait_for_selector('.balance .sum')
        check('в приложении остаток 70', page.locator('.balance .sum').inner_text().startswith('70'))
        page.click('text=Все'); page.wait_for_selector('.day')
        check('в истории есть «Оплата баллами» −50', page.locator('text=Оплата баллами').count() == 1 and page.locator('.pl.minus').first.inner_text() == '−50')

        print('5. Страница кассира')
        cp = ctx.new_page(); cp.goto(BASE + '/cashier')
        cp.fill('input[type=password]', HKEY); cp.click('text=Войти')
        cp.wait_for_selector('text=Клиент')
        cp.fill('input[placeholder="Номер карты или телефон"]', card); cp.click('text=Найти клиента')
        cp.wait_for_selector('text=на счёте 70 баллов')
        cp.fill('input[placeholder="0"]', '1000'); cp.wait_for_selector('text=50 баллов')
        cp.screenshot(path=f'{SHOTS}/10-cashier.png')
        cp.click('text=Начислить'); cp.wait_for_selector('text=Начислено 50 баллов')
        check('кассир: чек 1000 ₽ -> +50, баланс 120', cp.locator('text=Баланс клиента: 120').count() == 1)
        cp.screenshot(path=f'{SHOTS}/11-cashier-done.png')

        print('6. Админка')
        ap = ctx.new_page(); ap.goto(BASE + '/admin')
        ap.fill('input[type=password]', 'wrong'); ap.click('text=Войти'); ap.wait_for_selector('text=Неверный токен')
        ap.fill('input[type=password]', ADMIN); ap.click('text=Войти'); ap.wait_for_selector('text=Точки и проценты')
        row = ap.locator('tr', has_text='Гипермаркет')
        row.locator('input[type=number]').first.fill('7'); row.locator('text=Сохранить').click(); ap.wait_for_timeout(500)
        ap.screenshot(path=f'{SHOTS}/12-admin.png', full_page=True)
        st, r = req('POST', '/api/v1/accruals', token=HKEY, body={'idempotencyKey': 'fd:E2E:2', 'operation': 'SALE', 'card': {'number': card}, 'receipt': {'total': '1000.00'}, 'lines': [{'sum': '1000.00'}]})
        check('процент изменён в админке на 7% -> новый чек 1000 ₽ даёт 70 баллов', st == 200 and r['accrued'] == 70, str(r))
        check('сверка журнала и балансов без расхождений', req('GET', '/api/admin/stats', token=ADMIN)[1]['mismatches'] == 0)

        print('7. Выход и вход заново')
        page.click('text=Профиль'); page.click('text=Выйти'); page.wait_for_selector('input[type=tel]')
        time.sleep(1.2)
        page.fill('input[type=tel]', '9991234567'); page.click('text=Получить код'); page.wait_for_selector('text=Введите код')
        page.fill('input[autocomplete=one-time-code]', sms_code()); page.wait_for_selector('text=Показать QR на кассе')
        check('повторный вход — тот же аккаунт и баланс 190', page.locator('.balance .sum').inner_text().startswith('190'))

        print('8. Штрихкод, пластиковая карта, автосписание, код подтверждения')
        token = page.evaluate("localStorage.getItem('deya_token')")
        card = req('GET', '/api/me', token=token)[1]['card']['number']
        page.click('text=Показать QR на кассе'); page.wait_for_selector('canvas')
        page.click('text=Касса не читает QR? Показать штрихкод'); page.wait_for_selector('.codebox svg')
        png = page.locator('.codebox').screenshot(); page.screenshot(path=f'{SHOTS}/14-barcode.png')
        dec = zxingcpp.read_barcodes(cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE))
        check('штрихкод Code128 на экране считывается и содержит номер карты', len(dec) == 1 and dec[0].text == card and dec[0].format == zxingcpp.BarcodeFormat.Code128, str([(d.text, d.format) for d in dec]) + ' card=' + repr(card))
        page.click('text=Показать QR-код'); page.click('button.back'); page.wait_for_selector('text=Показать QR на кассе')
        st, imp = req('POST', '/api/admin/cards/import', {'kind': 'physical', 'text': '5550000000001;4821'}, token=ADMIN)
        st, r = req('POST', '/api/v1/accruals', {'idempotencyKey': 'e2e-plastic-1', 'operation': 'SALE', 'card': {'number': '5550000000001'}, 'receipt': {'total': '1000.00'}, 'lines': [{'number': 1, 'sum': '1000.00'}]}, token=HKEY)
        check('пластиковая карта без привязки копит баллы (+70)', st == 200 and r['accrued'] == 70, str(r))
        page.click('text=Профиль'); page.click('text=Привязать пластиковую карту')
        page.fill('input[placeholder="Номер с лицевой стороны"]', '5550 0000 0000 1'); page.fill('input[placeholder="Код активации (на обороте)"]', '4821')
        page.screenshot(path=f'{SHOTS}/15-bind.png')
        page.click('.sheet button.btn:not(.light)')
        try: page.wait_for_selector('text=Карта привязана, перенесено 70 баллов', timeout=8000)
        except Exception: print('       sheet:', page.locator('.sheet').inner_text() if page.locator('.sheet').count() else 'нет'); raise
        page.wait_for_selector('text=Пластиковая карта')
        check('карта привязана в приложении, баллы перенесены (баланс 260)', req('GET', '/api/me', token=token)[1]['balance'] == 260)
        page.click('label.row-set:has-text("Списывать баллы в гипермаркете")'); page.wait_for_selector('text=Сохранено')
        check('переключатель «Списывать баллы в гипермаркете» сохраняется', req('GET', '/api/me', token=token)[1]['settings']['autoRedeem'] is True)
        page.screenshot(path=f'{SHOTS}/16-profile-settings.png')
        req('PATCH', '/api/admin/points/cinema', {'confirmRedeem': True}, token=ADMIN)
        st, hold = req('POST', '/api/v1/redeem/hold', {'card': card, 'checkTotal': '500', 'points': 30, 'idempotencyKey': 'e2e-confirm'}, token=CKEY)
        page.click('text=Главная'); page.wait_for_selector('.pending', timeout=8000)
        code = page.locator('.pending b').inner_text()
        page.screenshot(path=f'{SHOTS}/17-confirm-code.png')
        st, cm = req('POST', f"/api/v1/redeem/{hold['holdId']}/commit", {'code': code}, token=CKEY)
        check('код подтверждения виден клиенту, кассир списывает с ним', hold.get('confirmRequired') and st == 200 and cm['status'] == 'COMMITTED', str(cm))
        req('PATCH', '/api/admin/points/cinema', {'confirmRedeem': False}, token=ADMIN)
        check('сверка журнала и балансов без расхождений (после новых операций)', req('GET', '/api/admin/stats', token=ADMIN)[1]['mismatches'] == 0)

        print('8b. Профиль: ID, поддержка, смена номера; карточка клиента в админке')
        page.click('text=Профиль'); page.wait_for_selector('text=ID профиля')
        pid = req('GET', '/api/me', token=token)[1]['user']['profileId']
        check('в профиле виден неизменный ID профиля', page.locator(f'text=ID профиля {pid}').count() == 1)
        check('контакты поддержки: телефон и почта (с ID профиля в теме письма)', page.locator('a[href="tel:+79298384516"]').count() >= 1
              and page.locator(f'a[href*="mailto:timurshokarov1001@gmail.com"][href*="{pid}"]').count() >= 1)
        page.click('text=Сменить ›'); page.fill('input[placeholder="Новый номер: 999 123-45-67"]', '9997776655')
        page.click('.sheet >> text=Получить код'); page.wait_for_selector('input[placeholder="Код из СМС"]:visible')
        time.sleep(0.3); logf.flush(); logf.seek(0)
        newcode = re.findall(r'Код (\d{4}) для смены номера', logf.read())[-1]
        page.fill('input[placeholder="Код из СМС"]', newcode); page.click('.sheet >> text=Подтвердить'); page.wait_for_selector('text=Номер изменён')
        me2 = req('GET', '/api/me', token=token)[1]
        check('смена номера по СМС: тот же профиль и баланс, новый номер', me2['user']['profileId'] == pid and me2['user']['phone'].endswith('55') and me2['balance'] == 230)
        page.screenshot(path=f'{SHOTS}/18-profile-support.png')
        ap = b.new_context(viewport={'width': 1200, 'height': 900}).new_page()
        ap.goto(BASE + '/admin'); ap.fill('input[type=password]', ADMIN); ap.click('text=Войти'); ap.wait_for_selector('text=Клиенты')
        ap.fill('input[placeholder="телефон, карта или ID профиля"]', pid); ap.click('text=Найти'); ap.click(f'a:has-text("{pid}")')
        ap.wait_for_selector(f'h3:has-text("Профиль {pid}")')
        check('админка: карточка клиента — карты, согласия, журнал действий', ap.locator('text=Журнал действий').count() == 2 and ap.locator('td:has-text("пластик")').count() >= 1
              and ap.locator('td:has-text("phone_changed")').count() >= 1)
        ap.screenshot(path=f'{SHOTS}/19-admin-client.png', full_page=True)

        print('9. Узкий экран и PWA')
        small = b.new_context(viewport={'width': 320, 'height': 568}, device_scale_factor=2).new_page()
        small.goto(BASE + '/'); small.wait_for_selector('input[type=tel]')
        check('на экране 320 px нет горизонтальной прокрутки', small.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'))
        small.screenshot(path=f'{SHOTS}/13-login-320.png')
        man = req('GET', '/manifest.webmanifest')
        check('manifest.webmanifest отдаётся и содержит иконки', man[0] == 200 and len(man[1]['icons']) == 2)
        errors = [e for e in errors if '400 (Bad Request)' not in e or errors.count(e) > 1]   # один 400 — это намеренный неверный код на шаге 1
        check('в консоли браузера нет ошибок (кроме намеренного неверного кода)', not errors, '; '.join(errors[:5]))
        b.close()
finally:
    srv.send_signal(signal.SIGTERM)
    try: srv.wait(5)
    except Exception: srv.kill()

fails = [n for n, ok in results if not ok]
print(f'\nИтого: {len(results) - len(fails)} из {len(results)} проверок прошли' + (f'; провалены: {fails}' if fails else ''))
sys.exit(1 if fails else 0)
