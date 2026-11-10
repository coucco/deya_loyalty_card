# Какие документы актуальны

## Команде внедрения и тестирования (Set10)
| Документ | Зачем |
|---|---|
| `set10-bonus-plugin/dist/DeyaBonusAccrualPlugin.jar` (1.2.2) | плагин; манифест внутри |
| `set10-bonus-plugin/dist/INSTALL.pdf` | куда положить jar, какие 7 настроек вписать |
| `docs/TEST_PLAN.pdf` | что проверять, по этапам, критерии успеха |
| + лично от владельца | ключ `pk_…` |

## Владельцу (вам)
| Документ | Когда открывать |
|---|---|
| `docs/QUICKSTART.md` | сервер, `.env`, админка, первый чек — пошагово |
| `docs/TEST_PLAN.md` | раздел «Где мы сейчас» — текущий статус теста |
| `docs/BACKLOG.md` | что осталось до боя (СМС, домен, ИБ, юр. часть) |
| `docs/GO_LIVE.md` | переход в прод: откат, риски, что поменять, пилот |
| `docs/CARD_PRINT_SPEC.md` | ТЗ типографии на пластик |
| `docs/ONBOARDING.md` | как устроена система (для нового человека) |

## Справочники (по необходимости)
`docs/PARAMETERS.md` — все параметры (`.env`, админка, Set10) · `docs/SET10_PLUGINS.md` — подробно о плагинах Set10 · `docs/DEPLOY.md` — развёртывание, копии · `docs/API.md` — API сервера.

## Для разработчика
`docs/ARCHITECTURE.md`, `docs/TESTING.md`, `set10-bonus-plugin/README.md`, `docs/IDEAS.md`.

`docs/INTEGRATION.md` — **устарел**, заменён `QUICKSTART.md` + `TEST_PLAN.md`.
