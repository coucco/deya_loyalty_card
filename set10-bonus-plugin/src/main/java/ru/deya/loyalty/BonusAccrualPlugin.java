package ru.deya.loyalty;

import org.slf4j.Logger;
import ru.crystals.pos.api.ext.loyal.dto.DiscountCancellationResult;
import ru.crystals.pos.api.ext.loyal.dto.LoyaltyResult;
import ru.crystals.pos.api.ext.loyal.dto.auxiliaries.LoyProviderFeedback;
import ru.crystals.pos.api.plugin.LoyaltyPlugin;
import ru.crystals.pos.spi.IntegrationProperties;
import ru.crystals.pos.spi.annotation.Inject;
import ru.crystals.pos.spi.annotation.POSPlugin;
import ru.crystals.pos.spi.receipt.Receipt;

/**
 * Плагин лояльности «начисление бонусов» для кассы гипермаркета (Set Retail 10).
 * <p>
 * Что делает: после пробития (фискализации) чека отправляет данные чека и номер карты покупателя
 * на сервер лояльности. Сервер сам считает, сколько баллов начислить (процент задаётся на сервере).
 * Дополнительно (выключено по умолчанию, redeem.enabled): на подытоге даёт скидку списанием баллов,
 * размер которой решает сервер, см. {@link RedeemOnReceipt}.
 * Что НЕ делает: не считает скидки Set10 (скидки по карте, «цена 3», считает сервер Set10).
 * <p>
 * Где касса вызывает методы (по SDK Set10): doDiscount — расчёт скидок на подытоге (после скидок Set10, поэтому
 * плагин должен стоять последним в порядке провайдеров лояльности); cancelDiscount — возврат из оплаты к товарам
 * или аннулирование; eventReceiptFiscalized — после фискализации (на кассах с API 0.0.46+ через onReceiptFiscalized);
 * onSendFeedback — периодически для очереди неотправленных сообщений.
 * <p>
 * Надёжность: сначала пробуем отправить сразу (с короткими таймаутами). Если не вышло, отправка
 * ставится в очередь кассы (возвращаем «фидбэк»), и касса сама повторяет её через {@link #onSendFeedback}.
 * Повторная отправка безопасна: сервер различает чеки по ключу идемпотентности.
 * <p>
 * Совместимость: переопределён метод {@code eventReceiptFiscalized}. Он помечен устаревшим, но его
 * вызывают (напрямую или через метод по умолчанию {@code onReceiptFiscalized}) кассы любых версий.
 * Любая ошибка внутри плагина перехватывается: плагин не должен мешать пробитию чека.
 */
@POSPlugin(id = BonusAccrualPlugin.PLUGIN_ID)
public class BonusAccrualPlugin implements LoyaltyPlugin {

    /** Должен совпадать с id в metainf.xml. */
    static final String PLUGIN_ID = "ext.deya.bonus.accrual";

    /** Логгер: внедряется кассой, создавать вручную нельзя. */
    @Inject
    Logger log;

    /** Настройки плагина (из «Внешних процессингов» Set10): внедряются кассой. */
    @Inject
    IntegrationProperties properties;

    private final FailureBreaker breaker = new FailureBreaker(3, 30_000L, System::currentTimeMillis);
    private final FailureBreaker redeemBreaker = new FailureBreaker(3, 30_000L, System::currentTimeMillis);
    private volatile BonusServerClient client;
    private volatile RedeemOnReceipt redeem;
    private volatile PluginLog plog;

    // ------------------------------------------------------------------ LoyaltyPlugin

    /**
     * Скидки Set10 («цена 3») уже посчитаны кассой. Здесь — только списание баллов (если включено), иначе пустой результат.
     */
    @Override
    public LoyaltyResult doDiscount(Receipt receipt) {
        try {
            PluginSettings cfg = settings();
            LoyaltyResult res = redeem().reserve(receipt, cfg);
            log().trace("вызван doDiscount (подытог): {} → {}{}", PluginLog.receipt(receipt), PluginLog.result(res),
                    cfg.redeemEnabled() ? ", redeem.mode=" + cfg.redeemMode() : " (списание выключено: redeem.enabled=false)");
            return res;
        } catch (Exception | LinkageError e) {
            log().error("Ошибка плагина при расчёте скидок", e);
            return new LoyaltyResult();
        }
    }

    @Override
    public DiscountCancellationResult cancelDiscount(Receipt receipt, LoyaltyResult results) {
        try {
            log().trace("вызван cancelDiscount (отмена расчёта/аннулирование): {}, наш результат: {}", PluginLog.receipt(receipt), PluginLog.result(results));
            redeem().cancel(receipt, results, settings());
        } catch (Exception | LinkageError e) {
            log().error("Ошибка плагина при отмене расчёта скидок", e);
        }
        return null;
    }

    /** Чек пробит. На кассах с API 0.0.46+ касса вызывает onReceiptFiscalized, а он по умолчанию — этот метод. */
    @Override
    @SuppressWarnings("deprecation")
    public LoyProviderFeedback eventReceiptFiscalized(Receipt receipt, LoyaltyResult loyResults) {
        StringBuilder note = new StringBuilder();
        LoyProviderFeedback fb = fiscalized(receipt, loyResults, note);
        log().trace("вызван eventReceiptFiscalized (чек пробит): {} → {}", PluginLog.receipt(receipt), note);
        return fb;
    }

    private LoyProviderFeedback fiscalized(Receipt receipt, LoyaltyResult loyResults, StringBuilder note) {
        AccrualRequestBuilder.Request request = null;
        try {
            PluginSettings cfg = settings();
            if (!cfg.isEnabled()) {
                log().info("Плагин отключён настройкой (enabled=false), чек не отправляется");
                note.append("не отправлено: enabled=false");
                return null;
            }
            request = AccrualRequestBuilder.build(receipt, cfg, redeem().redemptionFor(receipt, loyResults));
            if (request == null) {
                note.append("не отправлено: нет карты ДЕЯ (card.prefix) или возвраты выключены");
                return null; // нет карты приложения / возврат отключён: ничего отправлять не нужно
            }
            if (cfg.logPayload()) {
                log().info("Чек {}, запрос на сервер: {}", request.idempotencyKey, request.json);
            }
            if (breaker.allow()) {
                BonusServerClient.Outcome outcome = client().send(cfg, request.idempotencyKey, request.json);
                switch (outcome) {
                    case DELIVERED:
                        breaker.success();
                        log().info("Чек {} (карта {}) передан серверу лояльности", request.idempotencyKey, request.maskedCard);
                        note.append("отправлен на сервер, ключ ").append(request.idempotencyKey);
                        return null;
                    case REJECTED:
                        log().error("Сервер лояльности отклонил чек {}: повторная отправка не поможет", request.idempotencyKey);
                        note.append("сервер отклонил, ключ ").append(request.idempotencyKey);
                        return null;
                    default:
                        breaker.failure();
                        break;
                }
            } else {
                log().info("Сервер недавно не отвечал: чек {} поставлен в очередь без немедленной отправки", request.idempotencyKey);
            }
            note.append("в очередь кассы (повтор позже), ключ ").append(request.idempotencyKey);
            return queued(request.json);
        } catch (Exception | LinkageError e) {
            log().error("Ошибка плагина начисления бонусов при обработке чека", e);
            note.append("ошибка: ").append(e);
            // если запрос уже собран, не теряем его: ставим в очередь
            return request == null ? null : queued(request.json);
        }
    }

    /**
     * Касса периодически вызывает этот метод для сообщений из очереди (то, что не удалось отправить сразу).
     *
     * @return null, если сообщение больше не нужно повторять (доставлено или окончательно отклонено);
     * иначе это же сообщение: касса повторит позже
     */
    @Override
    public LoyProviderFeedback onSendFeedback(LoyProviderFeedback feedback) {
        StringBuilder note = new StringBuilder();
        LoyProviderFeedback res = resend(feedback, note);
        log().trace("вызван onSendFeedback (очередь): ключ {}, попыток {} → {}",
                feedback == null || feedback.getPayload() == null ? null : extractKey(feedback.getPayload()),
                feedback == null ? 0 : feedback.getAttemptsCount(), note);
        return res;
    }

    private LoyProviderFeedback resend(LoyProviderFeedback feedback, StringBuilder note) {
        try {
            if (feedback == null || feedback.getPayload() == null) {
                note.append("пустое сообщение, удалено");
                return null;
            }
            PluginSettings cfg = settings();
            if (!cfg.isEnabled()) {
                note.append("enabled=false, оставлено в очереди");
                return feedback; // выключено: оставляем в очереди, ничего не теряем
            }
            if (!breaker.allow()) {
                note.append("сервер недавно не отвечал, оставлено в очереди");
                return feedback; // сервер недавно не отвечал: не тратим время кассы на таймауты
            }
            String key = extractKey(feedback.getPayload());
            if (key == null) {
                log().error("В очереди сообщение без ключа идемпотентности, пропускаем его");
                note.append("нет ключа, удалено");
                return null;
            }
            BonusServerClient.Outcome outcome = client().send(cfg, key, feedback.getPayload());
            switch (outcome) {
                case DELIVERED:
                    breaker.success();
                    log().info("Отложенный чек {} передан серверу лояльности", key);
                    note.append("доставлено");
                    return null;
                case REJECTED:
                    log().error("Сервер лояльности отклонил отложенный чек {}: отправка прекращена", key);
                    note.append("сервер отклонил, удалено");
                    return null;
                case RETRY_SERVER:
                    breaker.failure();
                    feedback.setAttemptsCount(feedback.getAttemptsCount() + 1);
                    if (feedback.getAttemptsCount() >= cfg.maxAttempts()) {
                        log().error("Чек {}: исчерпан лимит повторов ({}), сообщение удалено из очереди. Баллы по нему нужно начислить вручную",
                                key, cfg.maxAttempts());
                        note.append("лимит повторов исчерпан, удалено");
                        return null;
                    }
                    note.append("ошибка сервера, повтор позже");
                    return feedback;
                default: // RETRY_NETWORK: связи нет, попытки не считаем
                    breaker.failure();
                    note.append("нет связи, повтор позже");
                    return feedback;
            }
        } catch (Exception | LinkageError e) {
            log().error("Ошибка плагина начисления бонусов при повторной отправке", e);
            note.append("ошибка: ").append(e);
            return feedback;
        }
    }

    // ------------------------------------------------------------------ вспомогательное

    private LoyProviderFeedback queued(String json) {
        LoyProviderFeedback fb = new LoyProviderFeedback();
        fb.setPayload(json);
        return fb;
    }

    private PluginSettings settings() {
        return new PluginSettings(properties);
    }

    /** Журнал: лог кассы + свой файл (см. {@link PluginLog}). */
    PluginLog log() {
        PluginLog l = plog;
        if (l == null) {
            l = new PluginLog(log, this::settings);
            plog = l;
        }
        return l;
    }

    private RedeemOnReceipt redeem() {
        RedeemOnReceipt r = redeem;
        if (r == null) {
            r = new RedeemOnReceipt(log(), client(), redeemBreaker);
            redeem = r;
        }
        return r;
    }

    private BonusServerClient client() {
        BonusServerClient c = client;
        if (c == null) {
            c = new BonusServerClient(log());
            client = c;
        }
        return c;
    }

    /** Достаёт ключ идемпотентности из сохранённого JSON (без полноценного разбора). */
    static String extractKey(String json) {
        String marker = "\"idempotencyKey\":\"";
        int i = json.indexOf(marker);
        if (i < 0) {
            return null;
        }
        int start = i + marker.length();
        int end = json.indexOf('"', start);
        return end < 0 ? null : json.substring(start, end);
    }
}
