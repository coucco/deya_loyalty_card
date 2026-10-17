package ru.deya.loyalty;

import org.slf4j.Logger;
import ru.crystals.pos.api.ext.loyal.dto.Discount;
import ru.crystals.pos.api.ext.loyal.dto.DiscountType;
import ru.crystals.pos.api.ext.loyal.dto.LoyaltyResult;
import ru.crystals.pos.spi.receipt.Card;
import ru.crystals.pos.spi.receipt.Receipt;
import ru.crystals.pos.spi.receipt.ReceiptType;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Списание баллов в чеке гипермаркета скидкой (выключено по умолчанию, настройка redeem.enabled).
 * <ol>
 * <li>Подытог ({@code doDiscount}): сервер получает позиции чека (уже со скидками Set10, «цена 3»), сам решает,
 * сколько можно списать (лимит % в админке, согласие клиента, исключения), резервирует баллы и раскладывает
 * скидку по позициям. Плагин только применяет присланную скидку.</li>
 * <li>Отмена расчёта ({@code cancelDiscount}): резерв снимается (если сервер недоступен, резерв истечёт сам).</li>
 * <li>Фискализация: списание передаётся вместе с начислением (поле redemption) и подтверждается сервером.</li>
 * </ol>
 * Принцип «касса важнее баллов»: при любой ошибке или недоступности сервера скидка не даётся, чек продаётся как обычно.
 */
final class RedeemOnReceipt {

    static final String DISCOUNT_ID = "DEYA_BONUS";
    static final String ATTR_POINTS = "deya.redeem.points";
    static final String ATTR_REF = "deya.redeem.ref";
    private static final int MAX_REMEMBERED = 300;

    private final Logger log;
    private final BonusServerClient client;
    private final FailureBreaker breaker;
    /** ref чека → баллы последнего резерва (на случай, если касса не вернёт наш LoyaltyResult при фискализации). */
    private final Map<String, Integer> reserved = new ConcurrentHashMap<>();

    RedeemOnReceipt(Logger log, BonusServerClient client, FailureBreaker breaker) {
        this.log = log;
        this.client = client;
        this.breaker = breaker;
    }

    /** Подытог: спросить сервер и применить скидку списанием. Никогда не бросает исключений. */
    LoyaltyResult reserve(Receipt receipt, PluginSettings cfg) {
        LoyaltyResult result = new LoyaltyResult();
        String ref = null;
        try {
            if (!cfg.redeemEnabled() || receipt == null || receipt.getType() != ReceiptType.SALE) {
                return result;
            }
            ref = AccrualRequestBuilder.receiptRef(receipt);
            Card card = AccrualRequestBuilder.pickCard(receipt.getCards(), cfg.cardPrefixes());
            if (card == null) {
                cancelIfReserved(cfg, ref); // карту убрали из чека
                return result;
            }
            String base = cfg.redeemBaseUrl();
            if (base == null || !breaker.allow()) {
                return result;
            }
            Map<String, Object> req = new LinkedHashMap<>();
            req.put("ref", ref);
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("number", card.getCardNumber());
            req.put("card", c);
            req.put("lines", AccrualRequestBuilder.lines(receipt, null));
            String json = Json.toJson(req);
            if (cfg.logPayload()) {
                log.info("Резерв списания, запрос: {}", json);
            }
            BonusServerClient.Response r = client.post(cfg, base + "/reserve", null, json, cfg.redeemTimeoutMs(), 64 * 1024);
            if (r.status != 200) {
                if (r.status >= 500) {
                    breaker.failure();
                }
                log.warn("Резерв списания для чека {}: HTTP {} {}", ref, r.status, r.body);
                return result;
            }
            breaker.success();
            apply(result, card.getCardNumber(), ref, Json.parse(r.body), cfg);
            return result;
        } catch (java.io.IOException e) {
            breaker.failure();
            log.warn("Резерв списания: нет связи с сервером ({}), чек без списания баллов", e.toString());
            return new LoyaltyResult();
        } catch (Exception | LinkageError e) {
            log.error("Ошибка резерва списания баллов, чек без списания", e);
            return new LoyaltyResult();
        }
    }

    @SuppressWarnings("unchecked")
    private void apply(LoyaltyResult result, String cardNumber, String ref, Object answer, PluginSettings cfg) {
        if (!(answer instanceof Map)) {
            return;
        }
        Map<String, Object> a = (Map<String, Object>) answer;
        int points = a.get("points") instanceof BigDecimal ? ((BigDecimal) a.get("points")).intValue() : 0;
        if (points <= 0 || !(a.get("lines") instanceof List)) {
            reserved.remove(ref);
            if (a.get("reason") != null) {
                log.info("Списание по чеку {} не применяется: {}", ref, a.get("reason"));
            }
            return;
        }
        BigDecimal total = BigDecimal.ZERO;
        for (Object o : (List<Object>) a.get("lines")) {
            Map<String, Object> l = (Map<String, Object>) o;
            int posNo = ((BigDecimal) l.get("number")).intValue();
            BigDecimal value = new BigDecimal(String.valueOf(l.get("discount"))).setScale(2, RoundingMode.HALF_UP);
            Discount d = new Discount(posNo, cardNumber, value, DISCOUNT_ID, "Оплата баллами ДЕЯ");
            if (cfg.redeemAsBonusesDiscount()) {
                AccrualRequestBuilder.safe(() -> {
                    d.setDiscountType(DiscountType.BONUSES);
                    d.setDisableRedistribution(true);
                    return null;
                });
            }
            result.getDiscounts().add(d);
            total = total.add(value);
        }
        result.getExtendedReceiptAttributesMap().put(ATTR_POINTS, String.valueOf(points));
        result.getExtendedReceiptAttributesMap().put(ATTR_REF, ref);
        result.getMessagesToCashier().add("Оплата баллами ДЕЯ: " + points + " б. (скидка " + total.toPlainString() + " ₽)");
        if (reserved.size() > MAX_REMEMBERED) {
            reserved.clear();
        }
        reserved.put(ref, points);
        log.info("Чек {}: применено списание {} баллов, скидка {}", ref, points, total.toPlainString());
    }

    /** Отмена расчёта скидок / аннулирование чека: снять резерв. */
    void cancel(Receipt receipt, LoyaltyResult ours, PluginSettings cfg) {
        try {
            if (!cfg.redeemEnabled() || receipt == null) {
                return;
            }
            String ref = AccrualRequestBuilder.receiptRef(receipt);
            boolean had = reserved.containsKey(ref) || (ours != null && ours.getExtendedReceiptAttributesMap().containsKey(ATTR_POINTS));
            if (had) {
                send(cfg, ref);
            }
        } catch (Exception | LinkageError e) {
            log.warn("Не удалось снять резерв баллов (истечёт сам): {}", e.toString());
        }
    }

    private void cancelIfReserved(PluginSettings cfg, String ref) {
        if (reserved.containsKey(ref)) {
            send(cfg, ref);
        }
    }

    private void send(PluginSettings cfg, String ref) {
        reserved.remove(ref);
        String base = cfg.redeemBaseUrl();
        if (base == null || !breaker.allow()) {
            return;
        }
        try {
            Map<String, Object> req = new HashMap<>();
            req.put("ref", ref);
            client.post(cfg, base + "/cancel", null, Json.toJson(req), cfg.redeemTimeoutMs(), 512);
        } catch (java.io.IOException e) {
            log.warn("Снятие резерва {}: нет связи ({}), резерв истечёт сам", ref, e.toString());
        }
    }

    /**
     * Списание, реально применённое в фискализированном чеке: из нашего LoyaltyResult (скидки DEYA_BONUS),
     * иначе из памяти плагина. null — списания не было.
     */
    AccrualRequestBuilder.Redemption redemptionFor(Receipt receipt, LoyaltyResult ours) {
        try {
            if (receipt == null || receipt.getType() != ReceiptType.SALE) {
                return null;
            }
            String ref = AccrualRequestBuilder.receiptRef(receipt);
            Integer remembered = reserved.remove(ref);
            Map<Integer, BigDecimal> perLine = new HashMap<>();
            Integer points = null;
            if (ours != null) {
                for (Discount d : ours.getDiscounts()) {
                    if (d != null && DISCOUNT_ID.equals(d.getDiscountId()) && d.getValue() != null) {
                        BigDecimal prev = perLine.get(d.getPosNo());
                        perLine.put(d.getPosNo(), prev == null ? d.getValue() : prev.add(d.getValue()));
                    }
                }
                String p = ours.getExtendedReceiptAttributesMap().get(ATTR_POINTS);
                if (p != null && !perLine.isEmpty()) {
                    points = Integer.valueOf(p);
                }
            }
            if (ours == null) {
                points = remembered; // касса не передала наш результат: берём то, что запомнили на подытоге
            }
            return points == null || points <= 0 ? null : new AccrualRequestBuilder.Redemption(ref, points, perLine);
        } catch (Exception | LinkageError e) {
            log.error("Не удалось определить списание баллов в чеке", e);
            return null;
        }
    }
}
