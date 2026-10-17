package ru.deya.loyalty;

import ru.crystals.pos.spi.receipt.AppliedDiscount;
import ru.crystals.pos.spi.receipt.Card;
import ru.crystals.pos.spi.receipt.CardType;
import ru.crystals.pos.spi.receipt.LineItem;
import ru.crystals.pos.spi.receipt.Merchandise;
import ru.crystals.pos.spi.receipt.ProcessedPayment;
import ru.crystals.pos.spi.receipt.Receipt;
import ru.crystals.pos.spi.receipt.ReceiptType;
import ru.crystals.pos.spi.receipt.Shift;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.InetAddress;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Превращает чек кассы в JSON-запрос к серверу лояльности (формат описан в README, «Контракт API»).
 * <p>
 * ВАЖНО про версии касс: часть методов чека появилась только в новых версиях API Set10
 * (например, фискальный номер документа и данные смены, с API 0.0.73). Если касса старая,
 * вызов такого метода вызывает {@link LinkageError}. Поэтому все «необязательные» поля читаются
 * через {@link #safe(Getter)} и при отсутствии просто опускаются; плагин продолжает работать.
 */
final class AccrualRequestBuilder {

    static final int SCHEMA_VERSION = 1;

    private AccrualRequestBuilder() {
    }

    /** Готовый к отправке запрос. */
    static final class Request {
        final String idempotencyKey;
        final String json;
        final String maskedCard;

        Request(String idempotencyKey, String json, String maskedCard) {
            this.idempotencyKey = idempotencyKey;
            this.json = json;
            this.maskedCard = maskedCard;
        }
    }

    /** Списание баллов, реально применённое нашим плагином в этом чеке (из результатов doDiscount). */
    static final class Redemption {
        final String ref;
        final int points;
        /** Номер позиции → скидка списанием на ней. */
        final Map<Integer, BigDecimal> lineDiscounts;

        Redemption(String ref, int points, Map<Integer, BigDecimal> lineDiscounts) {
            this.ref = ref;
            this.points = points;
            this.lineDiscounts = lineDiscounts == null ? Collections.<Integer, BigDecimal>emptyMap() : lineDiscounts;
        }
    }

    interface Getter<T> {
        T get() throws Exception;
    }

    /** Читает значение, которого может не быть на старой кассе: при любой ошибке вернёт null. */
    static <T> T safe(Getter<T> getter) {
        try {
            return getter.get();
        } catch (Exception | LinkageError e) {
            return null;
        }
    }

    /**
     * Собирает запрос для фискализированного чека.
     *
     * @return запрос или null, если чек не нужно отправлять (нет карты приложения, возврат отключён и т.п.)
     */
    static Request build(Receipt receipt, PluginSettings cfg) {
        return build(receipt, cfg, null);
    }

    /**
     * @param redemption списание баллов в этом чеке (null — не было); сервер подтверждает его вместе с начислением
     */
    static Request build(Receipt receipt, PluginSettings cfg, Redemption redemption) {
        if (receipt == null) {
            return null;
        }
        ReceiptType type = receipt.getType();
        boolean refund = type == ReceiptType.REFUND;
        if (refund && !cfg.sendRefunds()) {
            return null;
        }
        Receipt saleReceipt = refund ? safe(receipt::getSaleReceipt) : null;

        Card card = pickCard(receipt.getCards(), cfg.cardPrefixes());
        if (card == null && refund && saleReceipt != null) {
            // при возврате карту могли не прикладывать: берём карту из исходного чека продажи
            card = pickCard(saleReceipt.getCards(), cfg.cardPrefixes());
        }
        if (card == null && !(refund && saleReceipt != null)) {
            return null; // чек без карты приложения: начислять некому
        }

        String registerId = registerId(receipt);
        String key = idempotencyKey(receipt, registerId);

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("schemaVersion", SCHEMA_VERSION);
        root.put("idempotencyKey", key);
        root.put("pointId", cfg.pointId());
        root.put("registerId", registerId);
        root.put("operation", refund ? "REFUND" : "SALE");

        if (card != null) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("number", card.getCardNumber());
            c.put("type", card.getCardType() == null ? null : card.getCardType().name());
            root.put("card", c);
        }
        root.put("receipt", receiptInfo(receipt, registerId, key));
        if (refund && saleReceipt != null) {
            String saleRegister = registerId(saleReceipt);
            root.put("originalReceipt", receiptInfo(saleReceipt, saleRegister, idempotencyKey(saleReceipt, saleRegister)));
        }
        root.put("payments", payments(receipt));
        Map<Integer, BigDecimal> own = !refund && redemption != null ? redemption.lineDiscounts : null;
        root.put("lines", lines(receipt, own));
        if (!refund && redemption != null && redemption.points > 0) {
            Map<String, Object> red = new LinkedHashMap<>();
            red.put("ref", redemption.ref);
            red.put("points", redemption.points);
            root.put("redemption", red);
        }

        return new Request(key, Json.toJson(root), card == null ? null : mask(card.getCardNumber()));
    }

    // ------------------------------------------------------------------ карта

    static Card pickCard(Collection<Card> cards, List<String> prefixes) {
        if (cards == null) {
            return null;
        }
        for (Card c : cards) {
            if (c == null) {
                continue;
            }
            String number = c.getCardNumber();
            if (number == null || number.trim().isEmpty()) {
                continue;
            }
            CardType t = c.getCardType();
            if (t == CardType.COUPON || t == CardType.GIFT) {
                continue;
            }
            if (!prefixes.isEmpty() && !startsWithAny(number, prefixes)) {
                continue;
            }
            return c;
        }
        return null;
    }

    private static boolean startsWithAny(String number, List<String> prefixes) {
        for (String p : prefixes) {
            if (number.startsWith(p)) {
                return true;
            }
        }
        return false;
    }

    static String mask(String cardNumber) {
        if (cardNumber == null) {
            return null;
        }
        int n = cardNumber.length();
        return n <= 4 ? "****" : "****" + cardNumber.substring(n - 4);
    }

    // ------------------------------------------------------------------ чек

    private static Map<String, Object> receiptInfo(Receipt r, String registerId, String key) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("ref", receiptRef(r, registerId));
        m.put("registerId", registerId);
        m.put("number", r.getNumber());
        m.put("shiftNo", r.getShiftNo());
        m.put("fiscalDocId", safe(r::getFiscalDocId));
        m.put("fiscalSign", safe(r::getFiscalSign));
        m.put("fiscalizedAt", iso(safe(r::getFiscalizationTimestamp)));
        m.put("createdAt", iso(r.getDateCreate()));
        m.put("total", money(r.getSumWithDiscount()));
        Shift shift = safe(r::getShift);
        if (shift != null) {
            m.put("fnNumber", safe(shift::getFnNumber));
            m.put("registerFactoryNumber", safe(shift::getFiscalFactoryNumber));
        }
        return m;
    }

    private static List<Object> payments(Receipt r) {
        List<Object> res = new ArrayList<>();
        Collection<ProcessedPayment> payments = safe(r::getPayments);
        if (payments == null) {
            return res;
        }
        for (ProcessedPayment p : payments) {
            if (p == null) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", p.getPluginId());
            m.put("sum", money(p.getSum()));
            m.put("annulling", p.isAnnulling());
            res.add(m);
        }
        return res;
    }

    /**
     * Позиции чека. Для каждой: сумма после всех скидок, скидка, применённые акции Set10 (по ним сервер узнаёт «цену 3»),
     * признаки «можно начислять/списывать бонусы», минимальная сумма позиции.
     *
     * @param own скидка нашего плагина (списание баллов) по номерам позиций; null — не было
     */
    static List<Object> lines(Receipt r, Map<Integer, BigDecimal> own) {
        List<Object> res = new ArrayList<>();
        List<LineItem> items = r.getLineItems();
        if (items == null) {
            return res;
        }
        for (LineItem li : items) {
            if (li == null) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("number", li.getNumber());
            Merchandise g = li.getMerchandise();
            if (g != null) {
                m.put("name", g.getName());
                m.put("barcode", g.getBarcode());
                m.put("marking", g.getMarking());
                m.put("groupCode", g.getGroupCode());
            }
            // количество в кассе хранится в тысячных долях (1000 = 1 шт. или 1 кг)
            m.put("quantity", new BigDecimal(li.getQuantity()).movePointLeft(3).setScale(3, RoundingMode.HALF_UP).toPlainString());
            m.put("price", money(li.getOriginalPrice()));
            m.put("sum", money(li.getSum()));
            m.put("discount", money(li.getDiscountValue()));
            Boolean accrueAllowed = safe(li::isAccrueBonusAllowed);
            m.put("accrueAllowed", accrueAllowed == null ? Boolean.TRUE : accrueAllowed);
            Boolean payAllowed = safe(li::isPayBonusAllowed);
            m.put("payBonusAllowed", payAllowed == null ? Boolean.TRUE : payAllowed);
            BigDecimal minPrice = safe(li::getMinPrice);
            if (minPrice != null && minPrice.signum() > 0) {
                m.put("minSum", money(minPrice.multiply(new BigDecimal(li.getQuantity()).movePointLeft(3))));
            }
            List<Object> applied = appliedDiscounts(li);
            if (!applied.isEmpty()) {
                m.put("discounts", applied);
            }
            BigDecimal mine = own == null ? null : own.get(li.getNumber());
            if (mine != null) {
                m.put("ownDiscount", money(mine));
            }
            res.add(m);
        }
        return res;
    }

    private static List<Object> appliedDiscounts(LineItem li) {
        List<Object> res = new ArrayList<>();
        Collection<AppliedDiscount> list = safe(li::getAppliedDiscounts);
        if (list == null) {
            return res;
        }
        for (AppliedDiscount d : list) {
            if (d == null) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", safe(d::getDiscountId));
            m.put("guid", safe(d::getAdvertisingActionGuid));
            m.put("amount", money(safe(d::getAmount)));
            res.add(m);
        }
        return res;
    }

    // ------------------------------------------------------------------ идентификаторы

    /**
     * Ссылка на чек, известная уже на подытоге (до фискализации): касса + смена + время создания чека (мс).
     * Номер чека сюда НЕ входит: по документации Crystals номер на расчёте скидок может отличаться от номера
     * при фискализации (если между ними печатались X-отчёт, копия чека и т.п.).
     * По ref сервер связывает резерв/списание баллов (doDiscount, writeOff) с пробитым чеком.
     */
    static String receiptRef(Receipt r, String registerId) {
        Date created = r.getDateCreate();
        return "ref:" + registerId + ":" + r.getShiftNo() + ":" + (created == null ? 0L : created.getTime());
    }

    static String receiptRef(Receipt r) {
        return receiptRef(r, registerId(r));
    }

    /**
     * Идентификатор кассы: номер ФН (если касса его отдаёт), иначе заводской номер ФР, иначе имя компьютера.
     */
    static String registerId(Receipt r) {
        Shift shift = safe(r::getShift);
        if (shift != null) {
            String fn = safe(shift::getFnNumber);
            if (notBlank(fn)) {
                return sanitize(fn);
            }
            String factory = safe(shift::getFiscalFactoryNumber);
            if (notBlank(factory)) {
                return sanitize(factory);
            }
        }
        String host = safe(() -> InetAddress.getLocalHost().getHostName());
        return notBlank(host) ? sanitize(host) : "unknown";
    }

    /**
     * Ключ идемпотентности: одинаков при повторной отправке того же чека, различается у разных чеков.
     * Предпочтительно по фискальному документу (ФН + номер ФД). На старых кассах без этих данных:
     * касса + смена + номер чека + время создания.
     */
    static String idempotencyKey(Receipt r, String registerId) {
        Long fd = safe(r::getFiscalDocId);
        Shift shift = safe(r::getShift);
        String fn = shift == null ? null : safe(shift::getFnNumber);
        if (fd != null && notBlank(fn)) {
            return "fd:" + sanitize(fn) + ":" + fd;
        }
        Date created = r.getDateCreate();
        long epochSec = created == null ? 0L : created.getTime() / 1000L;
        return "rc:" + registerId + ":" + r.getShiftNo() + ":" + r.getNumber() + ":" + epochSec;
    }

    // ------------------------------------------------------------------ форматирование

    static String money(BigDecimal v) {
        return v == null ? null : v.setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    static String iso(Date d) {
        return d == null ? null : new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX").format(d);
    }

    private static boolean notBlank(String s) {
        return s != null && !s.trim().isEmpty();
    }

    /** Оставляет в ключе только безопасные для HTTP-заголовка символы. */
    private static String sanitize(String s) {
        return s.trim().replaceAll("[^A-Za-z0-9._-]", "_");
    }
}
