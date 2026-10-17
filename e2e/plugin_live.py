#!/usr/bin/env python3
"""Настоящий плагин (класс BonusAccrualPlugin из set10-bonus-plugin) -> настоящий сервер лояльности.
Проверяет, что формат запроса плагина принимается сервером: продажа, дубль, возврат без карты, неизвестная карта.
Запуск: python3 e2e/plugin_live.py [путь к папке set10-bonus-plugin]  (нужны JDK и собранный плагин: gradle selfTest)"""
import json, os, re, signal, subprocess, sys, tempfile, time, urllib.request
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'set10-bonus-plugin')
PORT = 3918; BASE = f'http://127.0.0.1:{PORT}'; ADMIN = 'live-admin-token-0123456789abcd'

def req(method, path, body=None, token=None):
    r = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={**({'Content-Type': 'application/json'} if body is not None else {}), **({'Authorization': 'Bearer ' + token} if token else {})})
    with urllib.request.urlopen(r) as resp: return json.loads(resp.read() or b'{}')

tmp = tempfile.mkdtemp(prefix='deya-live-'); log = open(tmp + '/s.log', 'w+')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', ROOT + '/server/src/index.js'],
    env={**os.environ, 'PORT': str(PORT), 'DB_FILE': tmp + '/l.db', 'ADMIN_TOKEN': ADMIN, 'SEED_DEMO': '1', 'OTP_RESEND_SEC': '0'}, stdout=log, stderr=subprocess.STDOUT)
ok = True
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/healthz'); break
        except Exception: time.sleep(0.1)
    key = req('POST', '/api/admin/points/hypermarket/rotate-key', token=ADMIN)['apiKey']
    req('POST', '/api/auth/request-code', {'phone': '+79990001122'}); time.sleep(0.2); log.flush(); log.seek(0)
    code = re.findall(r'Код входа в Дея: (\d{4})', log.read())[-1]
    tok = req('POST', '/api/auth/verify', {'phone': '+79990001122', 'code': code, 'consent': True})['token']
    card = req('GET', '/api/me', token=tok)['card']['number']
    cp = [f'{PLUGIN}/build/classes/java/{d}' for d in ('main', 'test', 'stubs')] + [f'{PLUGIN}/build/resources/main'] + [f'{PLUGIN}/libs/set10pos-api-0.0.0_DO_NOT_CHANGE_VERSION-SNAPSHOT.jar']
    out = subprocess.run(['java', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', f'-Ddeya.live.url={BASE}/api/v1/accruals', f'-Ddeya.live.key={key}', f'-Ddeya.live.card={card}',
        '-cp', ':'.join(cp), 'ru.deya.loyalty.SelfTest'], capture_output=True, text=True)
    print(out.stdout.strip(), out.stderr.strip()[-500:])
    ok = out.returncode == 0
    me = req('GET', '/api/me', token=tok)
    hist = req('GET', '/api/me/history', token=tok)['items']
    # продажа: позиция 150.00 ₽ при 5% = 7.5 -> 8 баллов; возврат на 100.00 ₽ по ставке продажи = -5; итог 3
    types = [(h['type'], h['points']) for h in hist]
    print('история на сервере:', types, '| баланс:', me['balance'])
    exp_ok = ('ACCRUAL', 8) in types and ('ACCRUAL_REVERSAL', -5) in types and me['balance'] == 3 and len(hist) == 2
    print('сервер записал ровно одну продажу (дубль не задвоил) и один возврат:', 'ДА' if exp_ok else 'НЕТ')
    ok = ok and exp_ok
    # списание в чеке: клиент включил «списывать баллы в гипермаркете», лимит 5% чека.
    # чек 150.00: 5% = 7 баллов, но на счёте 3 -> списать 3 (скидка 3.00). Поддельный чек не уменьшает сумму позиции
    # (это делает настоящая касса), поэтому начисление здесь от 150.00 = 8; на кассе будет от 147.00 = 7
    req('PATCH', '/api/me', {'autoRedeem': True}, token=tok)
    req('PATCH', '/api/admin/points/hypermarket', {'redeemPct': 5}, token=ADMIN)
    out = subprocess.run(['java', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', f'-Ddeya.live.url={BASE}/api/v1/accruals', f'-Ddeya.live.key={key}', f'-Ddeya.live.card={card}',
        '-Ddeya.live.redeem=1', '-Ddeya.live.expectPoints=3', '-cp', ':'.join(cp), 'ru.deya.loyalty.SelfTest'], capture_output=True, text=True)
    print(out.stdout.strip(), out.stderr.strip()[-500:])
    me = req('GET', '/api/me', token=tok)
    types = [(h['type'], h['points']) for h in req('GET', '/api/me/history', token=tok)['items']][:2]
    print('списание в чеке:', types, '| баланс:', me['balance'], '| резерв:', me['balance'] - me['available'])
    red_ok = out.returncode == 0 and ('REDEEM', -3) in types and ('ACCRUAL', 8) in types and me['balance'] == 8 and me['available'] == 8
    print('списано 3, начислено 8, резерв снят:', 'ДА' if red_ok else 'НЕТ')
    ok = ok and red_ok
    # плагин карт: активация пластика на кассе по СМС и «оплатить бонусами» кнопкой кассира (режим external)
    req('POST', '/api/admin/cards/import', {'kind': 'physical', 'text': '999000000000006;1111'}, token=ADMIN)
    plastic_key = 'live-plastic-1'
    req('POST', '/api/v1/accruals', {'idempotencyKey': plastic_key, 'operation': 'SALE', 'card': {'number': '999000000000006'},
        'receipt': {'total': '2000.00'}, 'lines': [{'number': 1, 'sum': '2000.00'}]}, token=key)   # гостевой счёт: +100
    log.flush()
    out = subprocess.run(['java', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', f'-Ddeya.live.url={BASE}/api/v1/accruals', f'-Ddeya.live.key={key}',
        '-Ddeya.live.cardplugin=1', '-Ddeya.live.plastic=999000000000006', f'-Ddeya.live.smslog={tmp}/s.log', '-cp', ':'.join(cp), 'ru.deya.loyalty.SelfTest'], capture_output=True, text=True)
    print(out.stdout.strip(), out.stderr.strip()[-300:])
    st = req('POST', '/api/v1/pos/card/status', {'card': '999000000000006'}, token=key)
    print('карта после активации и оплаты баллами:', st)
    # 100 гостевых − 5 списано кнопкой + 8 (поддельный чек не уменьшает сумму позиции: начисление от 150 ₽; на кассе будет от 145 ₽)
    card_ok = out.returncode == 0 and st['state'] == 'bound' and st['balance'] == 100 - 5 + 8
    print('пластик активирован на кассе, списано 5 кнопкой (один раз), начислено 8:', 'ДА' if card_ok else 'НЕТ')
    ok = ok and card_ok
finally:
    srv.send_signal(signal.SIGTERM)
    try: srv.wait(5)
    except Exception: srv.kill()
sys.exit(0 if ok else 1)
