#!/usr/bin/env python3
"""
Сервер-имитация для проверки плагина на кассе ДО появления настоящего сервера лояльности.

Что умеет (как будущий сервер, см. README, «Контракт API»):
  * принимает POST /api/v1/accruals с JSON чека;
  * проверяет ключ доступа (Authorization: Bearer ...), если задан ключ при запуске;
  * по заголовку Idempotency-Key отвечает 409 на повторную отправку того же чека;
  * считает баллы как процент от суммы чека (процент по умолчанию 5, меняется параметром);
  * печатает в консоль, что получил, и хранит принятые чеки в accruals.jsonl.

Запуск:  python3 mock_server.py --port 8080 --percent 5 --api-key secret
Режимы сбоя для проверки очереди кассы:
  --fail-first N   первые N запросов отвечать 500 (проверить повторную отправку)
  --delay SEC      отвечать с задержкой (проверить таймауты)
  --delay-first N  задерживать только первые N запросов: касса не дождётся ответа и повторит,
                   а сервер ответит на повтор кодом 409 (проверка защиты от двойного начисления)
Только стандартная библиотека Python 3.
"""
import argparse
import json
import sys
import threading
import time
from decimal import Decimal, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

seen = {}
lock = threading.Lock()
counter = {"requests": 0}


def make_handler(args):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass

        def _reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                print("    касса не дождалась ответа и оборвала соединение (так и задумано при --delay)")

        def do_POST(self):
            if self.path.rstrip("/") != "/api/v1/accruals":
                return self._reply(404, {"error": "unknown path"})
            with lock:
                counter["requests"] += 1
                n = counter["requests"]
            if args.delay and (not args.delay_first or n <= args.delay_first):
                time.sleep(args.delay)
            if args.fail_first and n <= args.fail_first:
                print(f"[{n}] имитация сбоя: отвечаю 500")
                return self._reply(500, {"error": "simulated failure"})
            if args.api_key:
                if self.headers.get("Authorization") != f"Bearer {args.api_key}":
                    print(f"[{n}] неверный ключ доступа -> 401")
                    return self._reply(401, {"error": "bad api key"})
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            try:
                doc = json.loads(raw.decode("utf-8"))
            except ValueError:
                return self._reply(400, {"error": "invalid json"})
            key = self.headers.get("Idempotency-Key") or doc.get("idempotencyKey")
            if not key:
                return self._reply(400, {"error": "no idempotency key"})
            with lock:
                if key in seen:
                    print(f"[{n}] повтор чека {key} -> 409 (баллы второй раз не начисляются)")
                    return self._reply(409, {"duplicate": True, **seen[key]})
            card = (doc.get("card") or {}).get("number")
            if not card and doc.get("operation") != "REFUND":
                return self._reply(422, {"error": "no card"})
            total = Decimal((doc.get("receipt") or {}).get("total") or "0")
            points = (total * Decimal(args.percent) / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
            sign = -1 if doc.get("operation") == "REFUND" else 1
            result = {"accrued": int(points) * sign, "card": card, "percent": args.percent}
            with lock:
                seen[key] = result
            with open("accruals.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"key": key, **result, "doc": doc}, ensure_ascii=False) + "\n")
            print(f"[{n}] {doc.get('operation')} чек {key}: карта {card}, сумма {total}, баллы {result['accrued']}")
            self._reply(200, result)

    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--percent", type=float, default=5)
    p.add_argument("--api-key", default="")
    p.add_argument("--fail-first", type=int, default=0)
    p.add_argument("--delay", type=float, default=0)
    p.add_argument("--delay-first", type=int, default=0, help="задерживать только первые N запросов (0 = все)")
    args = p.parse_args()
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(args))
    print(f"Сервер-имитация слушает порт {args.port}, процент {args.percent}%, ключ {'задан' if args.api_key else 'не требуется'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
