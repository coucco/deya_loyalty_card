package ru.deya.loyalty;

import org.slf4j.Logger;
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
 * Что НЕ делает: не считает скидки (скидки по карте, «цена 3», считает сервер Set10), не меняет чек,
 * не показывает ничего кассиру.
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
    private volatile BonusServerClient client;

    // ------------------------------------------------------------------ LoyaltyPlugin

    /** Скидки считает Set10; плагин скидок не даёт. Возвращаем пустой результат. */
    @Override
    public LoyaltyResult doDiscount(Receipt receipt) {
        return new LoyaltyResult();
    }

    @Override
    @SuppressWarnings("deprecation")
    public LoyProviderFeedback eventReceiptFiscalized(Receipt receipt, LoyaltyResult loyResults) {
        AccrualRequestBuilder.Request request = null;
        try {
            PluginSettings cfg = settings();
            if (!cfg.isEnabled()) {
                log.info("Плагин отключён настройкой (enabled=false), чек не отправляется");
                return null;
            }
            request = AccrualRequestBuilder.build(receipt, cfg);
            if (request == null) {
                return null; // нет карты приложения / возврат отключён: ничего отправлять не нужно
            }
            if (breaker.allow()) {
                BonusServerClient.Outcome outcome = client().send(cfg, request.idempotencyKey, request.json);
                switch (outcome) {
                    case DELIVERED:
                        breaker.success();
                        log.info("Чек {} (карта {}) передан серверу лояльности", request.idempotencyKey, request.maskedCard);
                        return null;
                    case REJECTED:
                        log.error("Сервер лояльности отклонил чек {}: повторная отправка не поможет", request.idempotencyKey);
                        return null;
                    default:
                        breaker.failure();
                        break;
                }
            } else {
                log.info("Сервер недавно не отвечал: чек {} поставлен в очередь без немедленной отправки", request.idempotencyKey);
            }
            return queued(request.json);
        } catch (Exception | LinkageError e) {
            log.error("Ошибка плагина начисления бонусов при обработке чека", e);
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
        try {
            if (feedback == null || feedback.getPayload() == null) {
                return null;
            }
            PluginSettings cfg = settings();
            if (!cfg.isEnabled()) {
                return feedback; // выключено: оставляем в очереди, ничего не теряем
            }
            if (!breaker.allow()) {
                return feedback; // сервер недавно не отвечал: не тратим время кассы на таймауты
            }
            String key = extractKey(feedback.getPayload());
            if (key == null) {
                log.error("В очереди сообщение без ключа идемпотентности, пропускаем его");
                return null;
            }
            BonusServerClient.Outcome outcome = client().send(cfg, key, feedback.getPayload());
            switch (outcome) {
                case DELIVERED:
                    breaker.success();
                    log.info("Отложенный чек {} передан серверу лояльности", key);
                    return null;
                case REJECTED:
                    log.error("Сервер лояльности отклонил отложенный чек {}: отправка прекращена", key);
                    return null;
                case RETRY_SERVER:
                    breaker.failure();
                    feedback.setAttemptsCount(feedback.getAttemptsCount() + 1);
                    if (feedback.getAttemptsCount() >= cfg.maxAttempts()) {
                        log.error("Чек {}: исчерпан лимит повторов ({}), сообщение удалено из очереди. Баллы по нему нужно начислить вручную",
                                key, cfg.maxAttempts());
                        return null;
                    }
                    return feedback;
                default: // RETRY_NETWORK: связи нет, попытки не считаем
                    breaker.failure();
                    return feedback;
            }
        } catch (Exception | LinkageError e) {
            log.error("Ошибка плагина начисления бонусов при повторной отправке", e);
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

    private BonusServerClient client() {
        BonusServerClient c = client;
        if (c == null) {
            c = new BonusServerClient(log);
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
