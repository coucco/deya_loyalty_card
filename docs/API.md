# Справочник API

Все ответы — JSON. Ошибки: `{"error": "код", "message": "текст"}`. Суммы чека передаются **строками** (`"1234.50"`), баллы — целые числа.

## Аутентификация

| Кто | Как |
|---|---|
| Клиент | `Authorization: Bearer <токен сессии>` (получается при входе по коду) |
| Точка / плагин / кассир | `Authorization: Bearer <ключ точки>` (админка → «Новый ключ»). Заголовок `X-Point-Id` необязателен; если есть, должен совпасть с точкой ключа |
| Администратор | `Authorization: Bearer <ADMIN_TOKEN>` |

## Начисление по чеку (плагин Set10)

`POST /api/v1/accruals`. Формат запроса — как в `set10-bonus-plugin/README.md` («Контракт API»).

| Ответ | Смысл | Действие плагина |
|---|---|---|
| `200` `{duplicate:false, accrued, balance}` | начислено (`accrued` со знаком; для возврата отрицательное) | готово |
| `409` `{duplicate:true, accrued, balance}` | этот чек уже обработан | готово |
| `400` | неверный запрос (нет ключа, плохая сумма) | отказ |
| `422` | карта неизвестна/закрыта | отказ |
| `401`, `403` (точка отключена/не начисляет), `429`, `5xx` | временная ошибка | повтор позже |

База: сумма `lines[].sum` по строкам, где `accrueAllowed ≠ false`; если `lines` пусты, то `receipt.total`.
Возврат (`operation: "REFUND"`): ищется исходное начисление по `originalReceipt.key`; если не найдено, ответ `200` с `accrued: 0, note: "original_not_found"`.

## Списание (точки трат)

Все методы с ключом точки; `card` — номер карты, либо `phone` вместо него.

| Метод | Тело | Ответ |
|---|---|---|
| `POST /api/v1/redeem/quote` | `{card, checkTotal}` | `{available, maxPoints, maxDiscount}` |
| `POST /api/v1/redeem/hold` | `{card, checkTotal, points, idempotencyKey}` | `201 {holdId, points, discount, expiresAt}`; `422 over_limit` если больше лимита; повтор с тем же ключом отдаёт тот же резерв |
| `POST /api/v1/redeem/:holdId/commit` | — | `{status:"COMMITTED", balance}`; `410` если резерв истёк |
| `POST /api/v1/redeem/:holdId/cancel` | — | `{status:"CANCELLED"}` |
| `POST /api/v1/redeem/:holdId/reverse` | — | вернуть баллы после подтверждённого списания |

## Страница кассира

| Метод | Тело | Ответ |
|---|---|---|
| `POST /api/v1/cashier/lookup` | `{card}` или `{phone}` | имя, маскированный телефон, баланс, тип точки, проценты |
| `POST /api/v1/cashier/accrual` | `{card|phone, total, idempotencyKey}` | как начисление |

## Клиент

| Метод | Назначение |
|---|---|
| `POST /api/auth/request-code` `{phone}` | отправить код (4 цифры) |
| `POST /api/auth/verify` `{phone, code, consent}` | вход; `consent:true` обязателен при первой регистрации. Ответ `{token, isNew}` |
| `POST /api/auth/logout` | выход |
| `GET /api/me` | баланс, карта, QR (`qr.value`), последняя операция (`last`) |
| `GET /api/me/history?limit=&before=` | журнал |
| `PATCH /api/me` `{name}` | имя |
| `DELETE /api/me` | удалить аккаунт |
| `GET /api/points` | публичные проценты: места трат и начисления |

## Администратор

`GET/POST /api/admin/points`, `PATCH /api/admin/points/:id` (`accrualPct`, `redeemPct`, `active`, `name`, `kind`), `POST /api/admin/points/:id/rotate-key`, `PUT /api/admin/settings` (`rub_per_point`, `rounding`), `GET /api/admin/users?q=`, `GET /api/admin/users/:id`, `POST /api/admin/users/:id/adjust` `{points, reason}`, `GET /api/admin/cards.csv`, `GET /api/admin/stats`, `GET /api/admin/audit`.
