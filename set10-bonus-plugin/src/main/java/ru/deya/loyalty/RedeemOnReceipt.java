package ru.deya.loyalty;

import org.slf4j.Logger;
import ru.crystals.pos.api.ext.loyal.dto.Discount;
import ru.crystals.pos.api.ext.loyal.dto.DiscountType;
import ru.crystals.pos.api.ext.loyal.dto.LoyaltyResult;
import ru.crystals.pos.api.ext.loyal.dto.WriteOffInfo;
import ru.crystals.pos.spi.receipt.BonusBalance;
import ru.crystals.pos.spi.receipt.Card;
import ru.crystals.pos.spi.receipt.Receipt;
import ru.crystals.pos.spi.receipt.ReceiptType;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Списание баллов в чеке гипермаркета скидкой (настройки redeem.enabled, redeem.mode).
 * <p>
 * Режим auto: на подытоге сервер сам решает, сколько списать (лимит % из админки, «цена 3», согласие клиента в приложении),
 * резервирует баллы и раскладывает скидку по позициям.
 * <p>
 * Режим cashier (кнопка «оплатить бонусами», по документации Crystals — «скидка бонусами в два расчёта»):
 * 1-й doDiscount отдаёт кассе потолок списания (writeOffsLimits), кассир вводит сумму по просьбе клиента,
 * 2-й doDiscount получает её в {@link BonusBalance#getSumToChargeOff()} и превращает в скидку BONUSES;
 * сами баллы списывает плагин карт ({@link DeyaCardPlugin#writeOff}). Для этого карта должна прийти от нашего плагина карт
 * (card.mode=external), иначе касса не знает баланса.
 * <p>
 * Отмена расчёта ({@code cancelDiscount}) снимает резерв; при фискализации списание подтверждается вместе с начислением.
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

    /** Подытог: скидка списанием (auto или по сумме кассира) и/или потолок списания для кассы. Никогда не бросает исключений. */
    LoyaltyResult reserve(Receipt receipt, PluginSettings cfg) {
        LoyaltyResult result = new LoyaltyResult();
        try {
            if (!cfg.redeemEnabled() || receipt == null || receipt.getType() != ReceiptType.SALE) {
                return result;
            }
            String ref = AccrualRequestBuilder.receiptRef(receipt);
            Card card = AccrualRequestBuilder.pickCard(receipt.getCards(), cfg.cardPrefixes());
            if (card == null) {
                cancelIfReserved(cfg, ref); // карту убрали из чека
                return result;
            }
            String base = cfg.redeemBaseUrl();
            if (base == null || !breaker.allow()) {
                return result;
            }
            List<Object> lines = AccrualRequestBuilder.lines(receipt, null);
            BigDecimal asked = cfg.redeemCashier() ? AccrualRequestBuilder.safe(() -> card.getBonusBalance().getSumToChargeOff()) : null;
            boolean byCashier = asked != null && asked.signum() > 0;
            if (byCashier || cfg.redeemAuto()) {
                Map<String, Object> req = request(ref, card, lines);
                if (byCashier) {
                    req.put("mode", "cashier");
                    req.put("points", asked.setScale(0, RoundingMode.DOWN).intValue());
                }
                Map<String, Object> answer = call(cfg, base + "/reserve", req);
                if (answer != null) {
                    apply(result, card, ref, answer, cfg, byCashier);
                }
            }
            if (cfg.redeemCashier() && result.getDiscounts().isEmpty() && card.getId() != null) {
                offerLimit(result, card, ref, lines, cfg, base);
            }
            return result;
        } catch (java.io.IOException e) {
            breaker.failure();
            log.warn("Списание: нет связи с сервером ({}), чек без списания баллов", e.toString());
            return new LoyaltyResult();
        } catch (Exception | LinkageError e) {
            log.error("Ошибка расчёта списания баллов, чек без списания", e);
            return new LoyaltyResult();
        }
    }

    private static Map<String, Object> request(String ref, Card card, List<Object> lines) {
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("ref", ref);
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("number", card.getCardNumber());
        req.put("card", c);
        req.put("lines", lines);
        return req;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> call(PluginSettings cfg, String url, Map<String, Object> req) throws java.io.IOException {
        String json = Json.toJson(req);
        if (cfg.logPayload()) {
            log.info("Списание, запрос {}: {}", url, json);
        }
        BonusServerClient.Response r = client.post(cfg, url, null, json, cfg.redeemTimeoutMs(), 64 * 1024);
        if (r.status != 200) {
            if (r.status >= 500) {
                breaker.failure();
            }
            log.warn("Списание {}: HTTP {} {}", url, r.status, r.body);
            return null;
        }
        breaker.success();
        Object parsed = Json.parse(r.body);
        return parsed instanceof Map ? (Map<String, Object>) parsed : null;
    }

    /** Потолок списания для кнопки «оплатить бонусами» (1-й расчёт). */
    private void offerLimit(LoyaltyResult result, Card card, String ref, List<Object> lines, PluginSettings cfg, String base) throws java.io.IOException {
        Map<String, Object> req = request(ref, card, lines);
        Map<String, Object> q = call(cfg, base + "/quote", req);
        int max = q != null && q.get("maxPoints") instanceof BigDecimal ? ((BigDecimal) q.get("maxPoints")).intValue() : 0;
        if (max <= 0) {
            return;
        }
        final BigDecimal limit = BigDecimal.valueOf(max);
        final BonusBalance balance = AccrualRequestBuilder.safe(card::getBonusBalance);
        AccrualRequestBuilder.safe(() -> {                          // API 0.0.60+
            Collection<WriteOffInfo> infos = new ArrayList<>();
            infos.add(new WriteOffInfo(balance, limit));
            result.getWriteOffsLimits().put(card.getId(), infos);
            return null;
        });
        result.getBonusWriteOffsLimits().put(card.getId(), limit);   // старые кассы
        log.info("Чек {}: можно оплатить баллами до {}", ref, max);
    }

    @SuppressWarnings("unchecked")
    private void apply(LoyaltyResult result, Card card, String ref, Map<String, Object> a, PluginSettings cfg, boolean byCashier) {
        int points = a.get("points") instanceof BigDecimal ? ((BigDecimal) a.get("points")).intValue() : 0;
        if (points <= 0 || !(a.get("lines") instanceof List)) {
            reserved.remove(ref);
            if (a.get("reason") != null) {
                log.info("Списание по чеку {} не применяется: {}", ref, a.get("reason"));
            }
            return;
        }
        BigDecimal total = BigDecimal.ZERO;
        boolean asBonuses = byCashier || cfg.redeemAsBonusesDiscount();
        for (Object o : (List<Object>) a.get("lines")) {
            Map<String, Object> l = (Map<String, Object>) o;
            int posNo = ((BigDecimal) l.get("number")).intValue();
            BigDecimal value = new BigDecimal(String.valueOf(l.get("discount"))).setScale(2, RoundingMode.HALF_UP);
            Discount d = new Discount(posNo, card.getCardNumber(), value, DISCOUNT_ID, "Оплата баллами ДЕЯ");
            if (asBonuses) {
                AccrualRequestBuilder.safe(() -> {
                    d.setDiscountType(DiscountType.BONUSES);
                    d.setDisableRedistribution(true);
                    return null;
                });
            }
            result.getDiscounts().add(d);
            total = total.add(value);
        }
        if (byCashier && card.getId() != null) {
            // касса сверяет: учтённые в скидке баллы должны совпасть с суммой, которую ввёл кассир
            result.getBonusesTakenIntoAccount().put(card.getId(), BigDecimal.valueOf(points));
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
            String ref = refOf(receipt, ours);
            boolean had = reserved.containsKey(ref) || (ours != null && ours.getExtendedReceiptAttributesMap().containsKey(ATTR_POINTS));
            if (had) {
                send(cfg, ref);
            }
        } catch (Exception | LinkageError e) {
            log.warn("Не удалось снять резерв баллов (истечёт сам): {}", e.toString());
        }
    }

    /** ref, под которым резервировали: из нашего результата расчёта (надёжнее), иначе вычисляем заново. */
    private static String refOf(Receipt receipt, LoyaltyResult ours) {
        String r = ours == null ? null : ours.getExtendedReceiptAttributesMap().get(ATTR_REF);
        return r != null ? r : AccrualRequestBuilder.receiptRef(receipt);
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
            String ref = refOf(receipt, ours);
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
