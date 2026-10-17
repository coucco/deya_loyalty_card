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

## Списание в чеке гипермаркета (плагин Set10)

| Метод | Тело | Ответ |
|---|---|---|
| `POST /api/v1/pos/redeem/reserve` | `{ref, card:{number}, lines:[{number, sum, discount, discounts, payBonusAllowed, minSum}]}` | `{holdId, points, discount, lines:[{number, discount}]}` или `{points:0, reason}` (`not_opted_in`, `point_no_redeem`, `card_not_bound`, `no_balance`, `nothing_eligible`, `unknown_card`). Повтор с тем же `ref` обновляет резерв |
| `POST /api/v1/pos/redeem/cancel` | `{ref}` | `{cancelled}` |
| `POST /api/v1/accruals` с `redemption:{ref, points}` | | списание подтверждается вместе с начислением (`redeemed` в ответе); без `redemption`, но с `receipt.ref` — висящий резерв снимается |

Лимит = сумма позиций с `payBonusAllowed≠false` и без скидки Set10 (если не разрешено в настройках) × «Макс. оплата баллами, %» точки; не больше доступных баллов; только если клиент включил `autoRedeem`.

## Списание (точки трат)

Все методы с ключом точки; `card` — номер карты, либо `phone` вместо него.

| Метод | Тело | Ответ |
|---|---|---|
| `POST /api/v1/redeem/quote` | `{card, checkTotal}` | `{available, maxPoints, maxDiscount}` |
| `POST /api/v1/redeem/hold` | `{card, checkTotal, points, idempotencyKey}` | `201 {holdId, points, discount, expiresAt}`; `422 over_limit` если больше лимита; повтор с тем же ключом отдаёт тот же резерв |
| `POST /api/v1/redeem/:holdId/commit` | `{code}` — если у точки включён «Код подтверждения» | `{status:"COMMITTED", balance}`; `410` если резерв истёк; `400 confirm_required / wrong_code`; `409 confirm_failed` после 5 ошибок (резерв отменён) |
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
| `POST /api/auth/verify` `{phone, code, consents:{pd, rules, marketing}}` | вход; `pd` и `rules` обязательны при первой регистрации (`consent:true` = оба, для старых клиентов). Согласия пишутся в журнал с версией документов. Ответ `{token, isNew}` |
| `GET /api/legal` | ссылки на документы и их версия |
| `POST /api/auth/logout` | выход |
| `GET /api/me` | баланс, карта (`null`, если пул пуст — выдаётся при следующем запросе), `physicalCards`, QR, `settings {autoRedeem, marketing}`, `pending` (коды подтверждения списаний), последняя операция |
| `GET /api/me/history?limit=&before=` | журнал |
| `PATCH /api/me` `{name?, autoRedeem?, marketing?}` | имя; списание в гипермаркете; согласие на рассылки (пишется в журнал) |
| `POST /api/me/cards/bind` `{number, code}` | привязать пластиковую карту, баллы с неё переносятся |
| `DELETE /api/me` | удалить аккаунт |
| `GET /api/points` | публичные проценты: места трат и начисления |

## Администратор

`GET/POST /api/admin/points`, `PATCH /api/admin/points/:id` (`accrualPct`, `redeemPct`, `active`, `name`, `kind`, `confirmRedeem`),
`GET /api/admin/cards/pool`, `POST /api/admin/cards/import` (`{kind: virtual|physical, text: "номер[;код]\n…"}` или `{kind, range:{from,to}}`), `GET /api/admin/metrics?days=30`,
`PUT /api/admin/settings` также `accrue_on_discounted`, `redeem_on_discounted`, `price3_action_ids`, `POST /api/admin/points/:id/rotate-key`, `PUT /api/admin/settings` (`rub_per_point`, `rounding`), `GET /api/admin/users?q=`, `GET /api/admin/users/:id`, `POST /api/admin/users/:id/adjust` `{points, reason}`, `GET /api/admin/cards.csv`, `GET /api/admin/stats`, `GET /api/admin/audit`.
