package ru.deya.loyalty;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.slf4j.Logger;
import ru.crystals.pos.api.ext.loyal.dto.Discount;
import ru.crystals.pos.api.ext.loyal.dto.LoyaltyResult;
import ru.crystals.pos.api.ext.loyal.dto.auxiliaries.LoyProviderFeedback;
import ru.crystals.pos.spi.IntegrationProperties;
import ru.crystals.pos.spi.PropertiesReader;
import ru.crystals.pos.api.plugin.card.BonusOperationStatus;
import ru.crystals.pos.api.plugin.card.BonusWriteOffOperationResponse;
import ru.crystals.pos.api.plugin.card.CardInfo;
import ru.crystals.pos.api.plugin.card.CardSearchResponse;
import ru.crystals.pos.api.plugin.card.CardSearchResponseStatus;
import ru.crystals.pos.api.ui.listener.ConfirmListener;
import ru.crystals.pos.api.ui.listener.DialogListener;
import ru.crystals.pos.api.ui.listener.InputListener;
import ru.crystals.pos.spi.plugin.card.CardSearchEventSource;
import ru.crystals.pos.spi.plugin.card.CardSearchFinishedCallback;
import ru.crystals.pos.spi.plugin.card.CardSearchFinishedRequest;
import ru.crystals.pos.spi.plugin.card.CardSearchRequest;
import ru.crystals.pos.spi.ui.UIForms;
import ru.crystals.pos.spi.ui.input.UIInputForms;
import ru.crystals.pos.spi.receipt.Card;
import ru.crystals.pos.spi.receipt.CardType;
import ru.crystals.pos.spi.receipt.LineItem;
import ru.crystals.pos.spi.receipt.Merchandise;
import ru.crystals.pos.spi.receipt.ProcessedPayment;
import ru.crystals.pos.spi.receipt.Receipt;
import ru.crystals.pos.spi.receipt.ReceiptType;
import ru.crystals.pos.spi.receipt.Shift;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Самопроверка плагина без внешних библиотек. Запуск: gradle selfTest (или gradle build).
 * Поддельные чеки/карты, настоящий HTTP-сервер на localhost.
 */
public class SelfTest {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        if (System.getProperty("deya.live.url") != null) { // проверка настоящего плагина против настоящего сервера (см. deya-loyalty/e2e/plugin_live.py)
            if (System.getProperty("deya.live.cardplugin") != null) {
                testLiveCardPlugin();
            } else if (System.getProperty("deya.live.redeem") != null) {
                testLiveRedeem();
            } else {
                testLive();
            }
            System.out.println("Проверок выполнено: " + checks + ", ошибок: " + failures.size());
            for (String f : failures) System.out.println("  ПРОВАЛ: " + f);
            System.exit(failures.isEmpty() ? 0 : 1);
        }
        testJson();
        testRequestBuilder();
        testLegacyKassaWithoutNewMethods();
        testRefund();
        testClientOutcomes();
        testPluginFlow();
        testBreaker();
        testJsonParse();
        testRedeem();
        testRedeemByCashier();
        testCardPlugin();

        System.out.println("Проверок выполнено: " + checks + ", ошибок: " + failures.size());
        for (String f : failures) {
            System.out.println("  ПРОВАЛ: " + f);
        }
        if (!failures.isEmpty()) {
            System.exit(1);
        }
        System.out.println("OK");
    }

    // ------------------------------------------------------------------ тесты

    static void testJson() {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("a", "кавычка \" слэш \\ перевод\nстроки");
        m.put("n", 5);
        m.put("b", true);
        m.put("z", null);
        m.put("l", Arrays.asList(1, "x"));
        m.put("d", new BigDecimal("10.50"));
        check(Json.toJson(m).equals("{\"a\":\"кавычка \\\" слэш \\\\ перевод\\nстроки\",\"n\":5,\"b\":true,\"z\":null,\"l\":[1,\"x\"],\"d\":\"10.50\"}"),
                "JSON: экранирование и типы: " + Json.toJson(m));
    }

    static void testRequestBuilder() {
        PluginSettings cfg = settings(new HashMap<String, String>());
        Receipt r = saleReceipt(card("2000000000017", CardType.INTERNAL), true);
        AccrualRequestBuilder.Request req = AccrualRequestBuilder.build(r, cfg);
        check(req != null, "запрос собран для чека с картой");
        check(req.idempotencyKey.equals("fd:9999078900001234:777"), "ключ по ФН и номеру ФД: " + req.idempotencyKey);
        check(req.json.contains("\"operation\":\"SALE\""), "операция SALE");
        check(req.json.contains("\"number\":\"2000000000017\""), "номер карты в запросе");
        check(req.json.contains("\"total\":\"1234.50\""), "сумма чека строкой с 2 знаками");
        check(req.json.contains("\"quantity\":\"1.500\""), "количество 1500 -> 1.500: " + req.json);
        check(req.json.contains("\"pointId\":\"hypermarket\""), "точка по умолчанию");
        check("****0017".equals(req.maskedCard), "маска карты для лога");

        // чек без карты
        check(AccrualRequestBuilder.build(saleReceipt(null, true), cfg) == null, "без карты запрос не создаётся");
        // купон не считается картой
        check(AccrualRequestBuilder.build(saleReceipt(card("COUPON1", CardType.COUPON), true), cfg) == null, "купон игнорируется");
        // фильтр по префиксу
        Map<String, String> withPrefix = new HashMap<>();
        withPrefix.put(PluginSettings.KEY_CARD_PREFIX, "2000, 2001");
        check(AccrualRequestBuilder.build(saleReceipt(card("2000000000017", CardType.INTERNAL), true), settings(withPrefix)) != null, "префикс подошёл");
        check(AccrualRequestBuilder.build(saleReceipt(card("4605000000017", CardType.INTERNAL), true), settings(withPrefix)) == null, "чужая карта отфильтрована");
        // изменённая точка
        Map<String, String> other = new HashMap<>();
        other.put(PluginSettings.KEY_POINT_ID, "hyper-1");
        check(AccrualRequestBuilder.build(r, settings(other)).json.contains("\"pointId\":\"hyper-1\""), "point.id из настроек");
    }

    static void testLegacyKassaWithoutNewMethods() {
        // Старая касса: методов getFiscalDocId/getShift и т.п. в API нет -> NoSuchMethodError
        Receipt r = saleReceipt(card("2000000000017", CardType.INTERNAL), false);
        AccrualRequestBuilder.Request req = AccrualRequestBuilder.build(r, settings(new HashMap<String, String>()));
        check(req != null, "старая касса: запрос всё равно собран");
        check(req.idempotencyKey.startsWith("rc:"), "старая касса: запасной ключ rc:...: " + req.idempotencyKey);
        check(req.idempotencyKey.endsWith(":5:42:1760000000"), "старая касса: ключ содержит смену, номер чека и время: " + req.idempotencyKey);
        check(!req.json.contains("fnNumber"), "старая касса: нет данных смены");
    }

    static void testRefund() {
        Receipt sale = saleReceipt(card("2000000000017", CardType.INTERNAL), true);
        Receipt refund = refundReceipt(sale, null);
        Map<String, String> none = new HashMap<>();
        AccrualRequestBuilder.Request req = AccrualRequestBuilder.build(refund, settings(none));
        check(req != null, "возврат по чеку продажи отправляется, даже если карту не прикладывали");
        check(req.json.contains("\"operation\":\"REFUND\"") && req.json.contains("\"originalReceipt\""), "возврат содержит исходный чек");
        check(req.json.contains("\"number\":\"2000000000017\""), "карта взята из чека продажи");
        Map<String, String> off = new HashMap<>();
        off.put(PluginSettings.KEY_SEND_REFUNDS, "false");
        check(AccrualRequestBuilder.build(refund, settings(off)) == null, "send.refunds=false отключает возвраты");
        check(AccrualRequestBuilder.build(refundReceipt(null, null), settings(none)) == null, "свободный возврат без карты и чека продажи пропускается");
    }

    static void testClientOutcomes() throws Exception {
        TestServer srv = new TestServer();
        try {
            Map<String, String> cfgMap = new HashMap<>();
            cfgMap.put(PluginSettings.KEY_SERVER_URL, srv.url());
            cfgMap.put(PluginSettings.KEY_API_KEY, "secret-key");
            cfgMap.put(PluginSettings.KEY_POINT_ID, "hyper-1");
            PluginSettings cfg = settings(cfgMap);
            BonusServerClient client = new BonusServerClient(new Logger() { });

            srv.status.set(200);
            check(client.send(cfg, "k1", "{\"x\":1}") == BonusServerClient.Outcome.DELIVERED, "200 -> DELIVERED");
            check("secret-key".equals(srv.lastHeaders.get("Authorization") == null ? null : srv.lastHeaders.get("Authorization").replace("Bearer ", "")), "ключ передан в Authorization");
            check("k1".equals(srv.lastHeaders.get("Idempotency-key")), "ключ идемпотентности в заголовке: " + srv.lastHeaders);
            check("hyper-1".equals(srv.lastHeaders.get("X-point-id")), "идентификатор точки в заголовке");
            check("{\"x\":1}".equals(srv.lastBody), "тело передано без искажений");
            srv.status.set(409);
            check(client.send(cfg, "k1", "{}") == BonusServerClient.Outcome.DELIVERED, "409 (дубль) -> DELIVERED");
            srv.status.set(422);
            check(client.send(cfg, "k1", "{}") == BonusServerClient.Outcome.REJECTED, "422 -> REJECTED");
            srv.status.set(404);
            check(client.send(cfg, "k1", "{}") == BonusServerClient.Outcome.REJECTED, "404 -> REJECTED");
            srv.status.set(500);
            check(client.send(cfg, "k1", "{}") == BonusServerClient.Outcome.RETRY_SERVER, "500 -> RETRY_SERVER");
            srv.status.set(401);
            check(client.send(cfg, "k1", "{}") == BonusServerClient.Outcome.RETRY_SERVER, "401 -> RETRY_SERVER (после исправления ключа дойдёт)");
        } finally {
            srv.stop();
        }
        Map<String, String> dead = new HashMap<>();
        dead.put(PluginSettings.KEY_SERVER_URL, "http://127.0.0.1:" + freePort() + "/x");
        dead.put(PluginSettings.KEY_CONNECTION_TIMEOUT, "300");
        check(new BonusServerClient(new Logger() { }).send(settings(dead), "k", "{}") == BonusServerClient.Outcome.RETRY_NETWORK, "сервер недоступен -> RETRY_NETWORK");
    }

    static void testPluginFlow() throws Exception {
        TestServer srv = new TestServer();
        try {
            Map<String, String> m = new HashMap<>();
            m.put(PluginSettings.KEY_SERVER_URL, srv.url());
            m.put(PluginSettings.KEY_CONNECTION_TIMEOUT, "300");
            m.put(PluginSettings.KEY_MAX_ATTEMPTS, "2");
            BonusAccrualPlugin plugin = plugin(m);
            Receipt r = saleReceipt(card("2000000000017", CardType.INTERNAL), true);

            check(plugin.doDiscount(r) != null && plugin.doDiscount(r).getDiscounts().isEmpty(), "doDiscount без списания: пустой результат (скидки считает Set10)");

            // 1. всё хорошо: ничего в очередь не ставим
            srv.status.set(200);
            check(plugin.eventReceiptFiscalized(r, null) == null, "успешная отправка: очередь не нужна");
            check(srv.requests.get() == 1, "на сервер ушёл ровно один запрос");

            // 2. чек без карты: на сервер ничего не уходит
            int before = srv.requests.get();
            check(plugin.eventReceiptFiscalized(saleReceipt(null, true), null) == null && srv.requests.get() == before, "без карты запросов нет");

            // 3. сервер отвечает 500 -> чек в очередь, потом доходит
            srv.status.set(500);
            LoyProviderFeedback queued = plugin.eventReceiptFiscalized(r, null);
            check(queued != null && queued.getPayload().contains("\"idempotencyKey\":\"fd:9999078900001234:777\""), "при ошибке сервера чек ставится в очередь");
            srv.status.set(200);
            check(plugin.onSendFeedback(queued) == null, "повтор из очереди доставлен -> null");
            check("fd:9999078900001234:777".equals(srv.lastHeaders.get("Idempotency-key")), "при повторе тот же ключ идемпотентности");

            // 4. лимит попыток при ошибках сервера
            srv.status.set(500);
            LoyProviderFeedback f = new LoyProviderFeedback();
            f.setPayload(queued.getPayload());
            plugin = plugin(m); // сброс предохранителя
            LoyProviderFeedback again = plugin.onSendFeedback(f);
            check(again == f && f.getAttemptsCount() == 1, "ошибка сервера: остаётся в очереди, счётчик попыток 1");
            check(plugin.onSendFeedback(f) == null, "лимит попыток (2) исчерпан -> удалено из очереди");

            // 5. окончательный отказ не повторяется
            srv.status.set(422);
            plugin = plugin(m);
            LoyProviderFeedback f2 = new LoyProviderFeedback();
            f2.setPayload(queued.getPayload());
            check(plugin.onSendFeedback(f2) == null, "422 из очереди: не повторяем");

            // 6. нет связи: в очередь, попытки не считаются
        } finally {
            srv.stop();
        }
        Map<String, String> dead = new HashMap<>();
        dead.put(PluginSettings.KEY_SERVER_URL, "http://127.0.0.1:" + freePort() + "/x");
        dead.put(PluginSettings.KEY_CONNECTION_TIMEOUT, "300");
        BonusAccrualPlugin p2 = plugin(dead);
        Receipt r = saleReceipt(card("2000000000017", CardType.INTERNAL), true);
        LoyProviderFeedback q = p2.eventReceiptFiscalized(r, null);
        check(q != null, "нет связи: чек в очереди кассы");
        LoyProviderFeedback back = p2.onSendFeedback(q);
        check(back == q && q.getAttemptsCount() == 0, "нет связи: попытки не считаются");

        // выключатель
        Map<String, String> off = new HashMap<>();
        off.put(PluginSettings.KEY_ENABLED, "false");
        check(plugin(off).eventReceiptFiscalized(r, null) == null, "enabled=false: ничего не отправляется");
        // сломанный чек не должен ломать кассу
        Receipt broken = fake(Receipt.class, map("getType", new IllegalStateException("boom")));
        check(plugin(dead).eventReceiptFiscalized(broken, null) == null, "сбой при разборе чека не пробрасывается наружу");
        check(BonusAccrualPlugin.extractKey("{\"schemaVersion\":1,\"idempotencyKey\":\"rc:a:1:2:3\",\"x\":1}").equals("rc:a:1:2:3"), "извлечение ключа из JSON");
    }

    /** Плагин (настоящий класс) отправляет чек продажи и возврат на живой сервер лояльности. */
    static void testLive() {
        Map<String, String> cfg = new HashMap<>();
        cfg.put(PluginSettings.KEY_SERVER_URL, System.getProperty("deya.live.url"));
        cfg.put(PluginSettings.KEY_API_KEY, System.getProperty("deya.live.key"));
        cfg.put(PluginSettings.KEY_POINT_ID, System.getProperty("deya.live.point", "hypermarket"));
        BonusAccrualPlugin pl = plugin(cfg);
        Receipt sale = saleReceipt(card(System.getProperty("deya.live.card"), CardType.INTERNAL), true);
        check(pl.eventReceiptFiscalized(sale, null) == null, "LIVE: продажа доставлена, очередь не нужна");
        check(pl.eventReceiptFiscalized(sale, null) == null, "LIVE: повторная отправка (дубль, ответ 409) тоже считается доставленной");
        check(pl.eventReceiptFiscalized(refundReceipt(sale, null), null) == null, "LIVE: возврат без карты доставлен (карта взята из чека продажи)");
        check(pl.eventReceiptFiscalized(saleReceipt(card("2000999999999", CardType.INTERNAL), true), null) == null, "LIVE: неизвестная карта (422) — отказ окончательный, очередь не нужна");
    }

    static void testJsonParse() {
        Object v = Json.parse(" {\"points\":50,\"discount\":\"50.00\",\"ok\":true,\"n\":null,\"lines\":[{\"number\":1,\"discount\":\"50.00\"}],\"s\":\"a\\\"b\\u0041\"} ");
        Map<?, ?> m = (Map<?, ?>) v;
        check(new BigDecimal("50").equals(m.get("points")), "JSON разбор: число");
        check(Boolean.TRUE.equals(m.get("ok")) && m.containsKey("n") && m.get("n") == null, "JSON разбор: true/null");
        check(((List<?>) m.get("lines")).size() == 1, "JSON разбор: массив объектов");
        check("a\"bA".equals(m.get("s")), "JSON разбор: экранирование: " + m.get("s"));
        boolean bad = false;
        try {
            Json.parse("{\"a\":1");
        } catch (IllegalArgumentException e) {
            bad = true;
        }
        check(bad, "JSON разбор: обрыв -> ошибка");
    }

    /** Списание баллов: подытог → скидка от сервера → фискализация с redemption → отмена расчёта. */
    static void testRedeem() throws Exception {
        TestServer srv = new TestServer();
        try {
            Map<String, String> m = new HashMap<>();
            m.put(PluginSettings.KEY_SERVER_URL, srv.url());
            m.put(PluginSettings.KEY_CONNECTION_TIMEOUT, "300");
            check(("http://127.0.0.1:" + srv.server.getAddress().getPort() + "/api/v1/pos/redeem").equals(settings(m).redeemBaseUrl()),
                    "адрес списания выводится из server.url: " + settings(m).redeemBaseUrl());
            Receipt r = saleReceipt(card("2000000000017", CardType.INTERNAL), true);

            // по умолчанию списание выключено: на подытоге запросов нет
            int before = srv.requests.get();
            check(plugin(m).doDiscount(r).getDiscounts().isEmpty() && srv.requests.get() == before, "redeem.enabled=false: подытог без запросов и скидок");

            m.put(PluginSettings.KEY_REDEEM_ENABLED, "true");
            BonusAccrualPlugin plugin = plugin(m);
            srv.body.set("{\"holdId\":\"h_1\",\"points\":50,\"discount\":\"50.00\",\"lines\":[{\"number\":1,\"discount\":\"50.00\"}]}");
            LoyaltyResult res = plugin.doDiscount(r);
            check(srv.lastPath.endsWith("/api/v1/pos/redeem/reserve"), "подытог: запрос резерва: " + srv.lastPath);
            check(srv.lastBody.contains("\"ref\":\"ref:9999078900001234:5:1760000000000\"") && srv.lastBody.contains("\"payBonusAllowed\":true"),
                    "резерв: ref чека и признаки позиций: " + srv.lastBody);
            check(res.getDiscounts().size() == 1, "скидка списанием применена");
            Discount d = res.getDiscounts().iterator().next();
            check(d.getPosNo() == 1 && new BigDecimal("50.00").equals(d.getValue()) && RedeemOnReceipt.DISCOUNT_ID.equals(d.getDiscountId()), "скидка на позицию 1 = 50.00");
            check("50".equals(res.getExtendedReceiptAttributesMap().get(RedeemOnReceipt.ATTR_POINTS)), "баллы списания сохранены в атрибутах чека");
            check(!res.getMessagesToCashier().isEmpty(), "кассир видит сообщение о списании");

            srv.body.set("{\"result\":\"ok\"}");
            check(plugin.eventReceiptFiscalized(r, res) == null, "фискализация со списанием доставлена");
            check(srv.lastBody.contains("\"redemption\":{\"ref\":\"ref:9999078900001234:5:1760000000000\",\"points\":50}"), "в начислении передано списание: " + srv.lastBody);
            check(srv.lastBody.contains("\"ownDiscount\":\"50.00\""), "скидка плагина отмечена в позиции");

            // касса не передала наш результат при фискализации: берём запомненное на подытоге
            srv.body.set("{\"points\":30,\"discount\":\"30.00\",\"lines\":[{\"number\":1,\"discount\":\"30.00\"}]}");
            plugin.doDiscount(r);
            srv.body.set("{}");
            plugin.eventReceiptFiscalized(r, null);
            check(srv.lastBody.contains("\"points\":30}"), "без LoyaltyResult: списание из памяти плагина");

            // отмена расчёта снимает резерв
            srv.body.set("{\"points\":10,\"discount\":\"10.00\",\"lines\":[{\"number\":1,\"discount\":\"10.00\"}]}");
            LoyaltyResult res2 = plugin.doDiscount(r);
            plugin.cancelDiscount(r, res2);
            check(srv.lastPath.endsWith("/api/v1/pos/redeem/cancel") && srv.lastBody.contains("ref:9999078900001234"), "cancelDiscount: резерв снят");

            // сервер отказал (клиент не включил списание) -> без скидки
            srv.body.set("{\"points\":0,\"discount\":\"0.00\",\"lines\":[],\"reason\":\"not_opted_in\"}");
            check(plugin.doDiscount(r).getDiscounts().isEmpty(), "0 баллов: чек без скидки");
            srv.status.set(500);
            check(plugin.doDiscount(r).getDiscounts().isEmpty(), "ошибка сервера: чек без скидки");
            srv.status.set(200);
            check(plugin.doDiscount(saleReceipt(null, true)).getDiscounts().isEmpty(), "без карты: без скидки");
        } finally {
            srv.stop();
        }
        Map<String, String> dead = new HashMap<>();
        dead.put(PluginSettings.KEY_SERVER_URL, "http://127.0.0.1:" + freePort() + "/api/v1/accruals");
        dead.put(PluginSettings.KEY_CONNECTION_TIMEOUT, "300");
        dead.put(PluginSettings.KEY_REDEEM_ENABLED, "true");
        long t0 = System.currentTimeMillis();
        check(plugin(dead).doDiscount(saleReceipt(card("2000000000017", CardType.INTERNAL), true)).getDiscounts().isEmpty(), "сервер недоступен: чек без скидки");
        check(System.currentTimeMillis() - t0 < 3000, "сервер недоступен: подытог не зависает");
    }

    /** Списание через настоящий сервер: подытог (резерв и скидка) → фискализация (подтверждение списания и начисление). */
    static void testLiveRedeem() {
        Map<String, String> cfg = new HashMap<>();
        cfg.put(PluginSettings.KEY_SERVER_URL, System.getProperty("deya.live.url"));
        cfg.put(PluginSettings.KEY_API_KEY, System.getProperty("deya.live.key"));
        cfg.put(PluginSettings.KEY_REDEEM_ENABLED, "true");
        BonusAccrualPlugin pl = plugin(cfg);
        Receipt sale = saleReceipt(card(System.getProperty("deya.live.card"), CardType.INTERNAL), true, 50, 900L);
        LoyaltyResult res = pl.doDiscount(sale);
        String expected = System.getProperty("deya.live.expectPoints");
        check(expected.equals(res.getExtendedReceiptAttributesMap().get(RedeemOnReceipt.ATTR_POINTS)), "LIVE: на подытоге сервер разрешил списать " + expected + ": " + res);
        check(res.getDiscounts().size() == 1, "LIVE: скидка списанием на позиции");
        check(pl.eventReceiptFiscalized(sale, res) == null, "LIVE: чек со списанием доставлен");
    }

    /** Кнопка «оплатить бонусами»: 1-й расчёт — потолок (writeOffsLimits), 2-й — сумма кассира становится скидкой BONUSES. */
    static void testRedeemByCashier() throws Exception {
        TestServer srv = new TestServer();
        try {
            Map<String, String> m = new HashMap<>();
            m.put(PluginSettings.KEY_SERVER_URL, srv.url());
            m.put(PluginSettings.KEY_REDEEM_ENABLED, "true");
            m.put(PluginSettings.KEY_REDEEM_MODE, "cashier");
            BonusAccrualPlugin plugin = plugin(m);
            srv.byPath.put("/pos/redeem/quote", "{\"maxPoints\":50,\"balance\":200}");
            srv.byPath.put("/pos/redeem/reserve", "{\"holdId\":\"h_9\",\"points\":30,\"discount\":\"30.00\",\"lines\":[{\"number\":1,\"discount\":\"30.00\"}]}");
            Receipt first = saleReceipt(bonusCard("2000000000017", null), true);
            LoyaltyResult r1 = plugin.doDiscount(first);
            check(srv.paths.get(srv.paths.size() - 1).endsWith("/pos/redeem/quote") && !srv.paths.toString().contains("/reserve"), "режим cashier: на 1-м расчёте только потолок, без резерва: " + srv.paths);
            check(r1.getDiscounts().isEmpty(), "1-й расчёт: скидки нет");
            check(r1.getWriteOffsLimits().containsKey("2000000000017") && new BigDecimal("50").equals(r1.getBonusWriteOffsLimits().get("2000000000017")),
                    "1-й расчёт: потолок 50 для карты: " + r1);
            Receipt second = saleReceipt(bonusCard("2000000000017", new BigDecimal("30")), true);
            LoyaltyResult r2 = plugin.doDiscount(second);
            check(srv.lastBody.contains("\"mode\":\"cashier\"") && srv.lastBody.contains("\"points\":30"), "2-й расчёт: резерв суммы кассира: " + srv.lastBody);
            check(r2.getDiscounts().size() == 1 && r2.getDiscounts().iterator().next().getDiscountType() == ru.crystals.pos.api.ext.loyal.dto.DiscountType.BONUSES,
                    "2-й расчёт: скидка типа BONUSES");
            check(new BigDecimal("30").equals(r2.getBonusesTakenIntoAccount().get("2000000000017")), "2-й расчёт: учтённые бонусы = сумме кассира");
        } finally {
            srv.stop();
        }
    }

    static Card bonusCard(String number, BigDecimal toChargeOff) {
        Map<String, Object> b = new HashMap<>();
        b.put("getBalance", new BigDecimal("200"));
        b.put("getSumToChargeOff", toChargeOff);
        Map<String, Object> m = new HashMap<>();
        m.put("getId", number);
        m.put("getCardNumber", number);
        m.put("getCardType", CardType.EXTERNAL);
        m.put("getBonusBalance", fake(ru.crystals.pos.spi.receipt.BonusBalance.class, b));
        return fake(Card.class, m);
    }

    /** Плагин карт: поиск, телефон, активация с формами кассы, инфо, списание/откат, разбор магнитной полосы. */
    static void testCardPlugin() throws Exception {
        check("2000123456789".equals(DeyaCardPlugin.trackNumber(";2000123456789=0000?")), "полоса: дорожка 2");
        check("2000123456789".equals(DeyaCardPlugin.trackNumber("%B2000123456789^IVANOV/I^?")), "полоса: дорожка 1");
        check("2000123456789".equals(DeyaCardPlugin.trackNumber("2000123456789")), "номер без служебных символов");
        TestServer srv = new TestServer();
        try {
            Map<String, String> m = new HashMap<>();
            m.put(PluginSettings.KEY_SERVER_URL, srv.url());
            m.put(PluginSettings.KEY_CARD_PREFIX, "999");
            String bound = "{\"known\":true,\"card\":\"999000000000001\",\"kind\":\"virtual\",\"state\":\"bound\",\"profileId\":\"1000007\",\"name\":\"Анна\",\"phone\":\"+7 920 ***-**-10\",\"balance\":120,\"available\":100}";
            srv.byPath.put("/pos/card/status", bound);

            // internal (по умолчанию): карту ищет Set10, плагин в поиск не вмешивается
            int before = srv.requests.get();
            check(cardPlugin(m, null).searchCard(searchReq("999000000000001", CardSearchEventSource.BARCODE)).getResponseStatus() == CardSearchResponseStatus.UNKNOWN_CARD
                    && srv.requests.get() == before, "internal: поиск карты отдаётся Set10, запросов нет");

            Map<String, String> ext = new HashMap<>(m);
            ext.put(PluginSettings.KEY_CARD_MODE, "external");
            CardSearchResponse found = cardPlugin(ext, null).searchCard(searchReq("999000000000001", CardSearchEventSource.BARCODE));
            check(found.getResponseStatus() == CardSearchResponseStatus.OK && new BigDecimal("100").equals(found.getCard().getBonusBalance().getBalance())
                    && "1000007".equals(found.getCard().getCardHolder().getId()), "external: карта наша, баланс (доступно) и ID профиля: " + found.getCard());
            check(cardPlugin(ext, null).searchCard(searchReq("4600000000001", CardSearchEventSource.BARCODE)).getResponseStatus() == CardSearchResponseStatus.UNKNOWN_CARD,
                    "external: чужая карта не наша");
            CardSearchResponse msr = cardPlugin(ext, null).searchCard(msrReq(";999000000000001=1?"));
            check(msr.getResponseStatus() == CardSearchResponseStatus.OK && srv.lastBody.contains("\"card\":\"999000000000001\""), "external: номер взят с магнитной полосы");

            // поиск по телефону (асинхронно)
            srv.byPath.put("/pos/card/by-phone", bound);
            final AtomicReference<CardSearchResponse> byPhone = new AtomicReference<>();
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            cardPlugin(m, null).searchCardAsync(searchReq("+79200000010", CardSearchEventSource.PHONE_NUMBER), res -> {
                byPhone.set(res);
                latch.countDown();
            });
            latch.await(5, java.util.concurrent.TimeUnit.SECONDS);
            check(byPhone.get() != null && byPhone.get().getResponseStatus() == CardSearchResponseStatus.OK
                    && "999000000000001".equals(byPhone.get().getCard().getCardNumber()), "поиск по телефону: карта найдена");

            // активация: касса нашла неактивированный пластик → диалог → телефон → код → сообщение → callback ровно один раз
            srv.byPath.put("/pos/card/status", "{\"known\":true,\"card\":\"999000000000008\",\"kind\":\"physical\",\"state\":\"guest\",\"balance\":50}");
            srv.byPath.put("/pos/activate/start", "{\"sent\":true,\"existingProfile\":false}");
            srv.byPath.put("/pos/activate/confirm", "{\"profileId\":\"1000009\",\"balance\":50}");
            List<String> shown = new CopyOnWriteArrayList<>();
            AtomicInteger callbacks = new AtomicInteger();
            DeyaCardPlugin cp = cardPlugin(m, scriptedUi(shown, "9200000012", "4321"));
            cp.cardSearchFinished(finishedReq(card("999000000000008", CardType.INTERNAL), callbacks));
            check(callbacks.get() == 1, "активация: касса продолжила работу (callback 1 раз): " + callbacks.get());
            check(srv.paths.toString().contains("/pos/activate/start") && srv.paths.toString().contains("/pos/activate/confirm"), "активация: запросы на сервер: " + srv.paths);
            check(srv.lastBody.contains("\"code\":\"4321\"") && srv.lastBody.contains("\"phone\":\"9200000012\""), "активация: телефон и код переданы");
            check(shown.size() == 4 && shown.get(3).contains("1000009"), "активация: диалог → телефон → код → «Карта активирована, профиль»: " + shown);

            // активированная карта — без диалога
            srv.byPath.put("/pos/card/status", bound);
            shown.clear();
            callbacks.set(0);
            cardPlugin(m, scriptedUi(shown, "x", "y")).cardSearchFinished(finishedReq(card("999000000000001", CardType.INTERNAL), callbacks));
            check(callbacks.get() == 1 && shown.isEmpty(), "активированная карта: без диалога");

            // сервер недоступен — касса не ждёт и не падает
            Map<String, String> dead = new HashMap<>(m);
            dead.put(PluginSettings.KEY_SERVER_URL, "http://127.0.0.1:" + freePort() + "/api/v1/accruals");
            dead.put(PluginSettings.KEY_CONNECTION_TIMEOUT, "300");
            callbacks.set(0);
            cardPlugin(dead, scriptedUi(shown, "x", "y")).cardSearchFinished(finishedReq(card("999000000000008", CardType.INTERNAL), callbacks));
            check(callbacks.get() == 1, "нет связи: активация не предлагается, касса продолжает");

            // инфо по карте
            CardInfo info = cardPlugin(m, null).getCardInfo(searchReq("999000000000001", CardSearchEventSource.NUMBER));
            check(info.getCardSearchStatus() == CardSearchResponseStatus.OK && "1000007".equals(info.getInfo().get("Профиль")) && "120".equals(info.getInfo().get("Баланс, баллов")),
                    "инфо по карте: профиль и баланс: " + info.getInfo());

            // списание кнопкой и откат
            srv.byPath.put("/pos/redeem/writeoff", "{\"txId\":\"h_5\",\"points\":30,\"balance\":70}");
            BonusWriteOffOperationResponse w = cardPlugin(m, null).writeOff(card("999000000000001", CardType.EXTERNAL), new BigDecimal("30"), saleReceipt(null, true));
            check(w.getResponseStatus() == BonusOperationStatus.OK && "h_5".equals(w.getTxId()) && srv.lastBody.contains("\"ref\":\"ref:"), "writeOff: списано, txId, ref чека");
            srv.byPath.put("/pos/redeem/rollback", "{\"status\":\"REVERSED\"}");
            check(cardPlugin(m, null).rollback("h_5").getResponseStatus() == BonusOperationStatus.OK, "rollback: откат списания");
            srv.status.set(409);
            check(cardPlugin(m, null).writeOff(card("999000000000001", CardType.EXTERNAL), new BigDecimal("30"), saleReceipt(null, true)).getResponseStatus() == BonusOperationStatus.ERROR,
                    "writeOff: отказ сервера → ERROR с сообщением кассиру");
        } finally {
            srv.stop();
        }
    }

    static DeyaCardPlugin cardPlugin(Map<String, String> values, UIForms ui) {
        DeyaCardPlugin p = new DeyaCardPlugin();
        p.log = new Logger() { };
        p.properties = properties(values);
        p.ui = ui;
        return p;
    }

    static CardSearchRequest searchReq(String s, CardSearchEventSource src) {
        Map<String, Object> m = new HashMap<>();
        m.put("getSearchString", s);
        m.put("getEventSource", src);
        m.put("getAdditionalData", Collections.emptyList());
        return fake(CardSearchRequest.class, m);
    }

    static CardSearchRequest msrReq(String track2) {
        Map<String, Object> m = new HashMap<>();
        m.put("getSearchString", track2);
        m.put("getEventSource", CardSearchEventSource.MAGNETIC_STRIPE);
        m.put("getAdditionalData", Arrays.asList(null, track2, null, null));
        return fake(CardSearchRequest.class, m);
    }

    static CardSearchFinishedRequest finishedReq(Card found, AtomicInteger callbacks) {
        Map<String, Object> m = new HashMap<>();
        m.put("getFoundCard", Optional.ofNullable(found));
        m.put("getCallback", (CardSearchFinishedCallback) res -> callbacks.incrementAndGet());
        return fake(CardSearchFinishedRequest.class, m);
    }

    /** Формы кассы, которые сразу «нажимают» первую кнопку и вводят заданные значения по очереди. */
    static UIForms scriptedUi(List<String> shown, String... inputs) {
        final AtomicInteger next = new AtomicInteger();
        UIInputForms input = fake(UIInputForms.class, null, (name, a) -> {
            if (name.equals("showInputNumberForm")) {
                shown.add("input:" + a[0]);
                ((InputListener) a[4]).eventInputComplete(inputs[next.getAndIncrement()]);
                return null;
            }
            return NO_VALUE;
        });
        return fake(UIForms.class, map("getInputForms", input), (name, a) -> {
            switch (name) {
                case "showDialogForm":
                    shown.add("dialog");
                    ((DialogListener) a[1]).eventButton1pressed();
                    return null;
                case "showMessageForm":
                    shown.add("message:" + a[0]);
                    ((ConfirmListener) a[1]).eventConfirmed();
                    return null;
                case "showErrorForm":
                    shown.add("error:" + a[0]);
                    ((ConfirmListener) a[1]).eventConfirmed();
                    return null;
                default:
                    return NO_VALUE;
            }
        });
    }

    /**
     * Плагин карт против настоящего сервера: активация пластика формами кассы (код читается из СМС-лога сервера),
     * затем «оплатить бонусами» кнопкой кассира: потолок → сумма кассира → writeOff → фискализация.
     */
    static void testLiveCardPlugin() throws Exception {
        Map<String, String> cfg = new HashMap<>();
        cfg.put(PluginSettings.KEY_SERVER_URL, System.getProperty("deya.live.url"));
        cfg.put(PluginSettings.KEY_API_KEY, System.getProperty("deya.live.key"));
        cfg.put(PluginSettings.KEY_REDEEM_ENABLED, "true");
        cfg.put(PluginSettings.KEY_REDEEM_MODE, "cashier");
        cfg.put(PluginSettings.KEY_CARD_MODE, "external");
        String plastic = System.getProperty("deya.live.plastic");
        final java.nio.file.Path smsLog = java.nio.file.Paths.get(System.getProperty("deya.live.smslog"));
        List<String> shown = new CopyOnWriteArrayList<>();
        UIInputForms input = fake(UIInputForms.class, null, (name, a) -> {
            if (!name.equals("showInputNumberForm")) {
                return NO_VALUE;
            }
            shown.add("input:" + a[0]);
            String value = "9200000077";
            if (String.valueOf(a[0]).contains("Код")) {
                try {
                    String logText = new String(java.nio.file.Files.readAllBytes(smsLog), StandardCharsets.UTF_8);
                    java.util.regex.Matcher mm = java.util.regex.Pattern.compile("Код (\\d{4}) для активации").matcher(logText);
                    value = null;
                    while (mm.find()) {
                        value = mm.group(1);
                    }
                } catch (IOException e) {
                    value = "0000";
                }
            }
            ((InputListener) a[4]).eventInputComplete(value);
            return null;
        });
        UIForms ui = fake(UIForms.class, map("getInputForms", input), (name, a) -> {
            if (name.equals("showDialogForm")) {
                shown.add("dialog");
                ((DialogListener) a[1]).eventButton1pressed();
                return null;
            }
            if (name.equals("showMessageForm") || name.equals("showErrorForm")) {
                shown.add(name + ":" + a[0]);
                ((ConfirmListener) a[1]).eventConfirmed();
                return null;
            }
            return NO_VALUE;
        });
        DeyaCardPlugin cp = cardPlugin(cfg, ui);
        AtomicInteger callbacks = new AtomicInteger();
        cp.cardSearchFinished(finishedReq(card(plastic, CardType.INTERNAL), callbacks));
        check(callbacks.get() == 1 && shown.toString().contains("Карта активирована"), "LIVE: пластик активирован на кассе формами: " + shown);

        CardSearchResponse found = cp.searchCard(searchReq(plastic, CardSearchEventSource.BARCODE));
        check(found.getResponseStatus() == CardSearchResponseStatus.OK && found.getCard().getBonusBalance() != null, "LIVE: external — карта с балансом: " + found.getCard());
        BigDecimal balance = found.getCard().getBonusBalance().getBalance();
        check(balance.intValue() == 100, "LIVE: на балансе гостевые баллы карты (100): " + balance);

        BonusAccrualPlugin lp = plugin(cfg);
        Card first = bonusCard(plastic, null);
        Receipt r1 = saleReceipt(first, true, 60, 960L);
        LoyaltyResult limits = lp.doDiscount(r1);
        check(new BigDecimal("7").equals(limits.getBonusWriteOffsLimits().get(plastic)), "LIVE: потолок 5% от 150 = 7: " + limits.getBonusWriteOffsLimits());
        Receipt r2 = saleReceipt(bonusCard(plastic, new BigDecimal("5")), true, 60, 960L);
        LoyaltyResult res = lp.doDiscount(r2);
        check(res.getDiscounts().size() == 1, "LIVE: скидка 5 баллов применена");
        BonusWriteOffOperationResponse w = cp.writeOff(bonusCard(plastic, new BigDecimal("5")), new BigDecimal("5"), r2);
        check(w.getResponseStatus() == BonusOperationStatus.OK, "LIVE: writeOff списал баллы: " + w);
        check(lp.eventReceiptFiscalized(r2, res) == null, "LIVE: чек со списанием кнопкой доставлен");
    }

    static void testBreaker() {
        final long[] now = {0};
        FailureBreaker b = new FailureBreaker(3, 1000, () -> now[0]);
        check(b.allow(), "предохранитель закрыт");
        b.failure();
        b.failure();
        check(b.allow(), "две ошибки: ещё пробуем");
        b.failure();
        check(!b.allow(), "три ошибки подряд: пауза");
        now[0] = 1500;
        check(b.allow(), "после паузы снова пробуем");
        b.success();
        b.failure();
        check(b.allow(), "успех сбрасывает счётчик");
    }

    // ------------------------------------------------------------------ фикстуры

    static BonusAccrualPlugin plugin(Map<String, String> values) {
        BonusAccrualPlugin p = new BonusAccrualPlugin();
        p.log = new Logger() { };
        p.properties = properties(values);
        return p;
    }

    static PluginSettings settings(Map<String, String> values) {
        return new PluginSettings(properties(values));
    }

    static IntegrationProperties properties(final Map<String, String> values) {
        final PropertiesReader reader = fake(PropertiesReader.class, null, (name, args) -> {
            String key = args.length > 0 ? String.valueOf(args[0]) : null;
            switch (name) {
                case "get":
                    return values.containsKey(key) ? values.get(key) : (args.length > 1 ? args[1] : null);
                case "getBoolean":
                    return values.containsKey(key) ? Boolean.valueOf(values.get(key)) : (args.length > 1 ? args[1] : Boolean.FALSE);
                case "getInt":
                    return values.containsKey(key) ? Integer.valueOf(values.get(key)) : (args.length > 1 ? args[1] : 0);
                default:
                    return NO_VALUE;
            }
        });
        return fake(IntegrationProperties.class, map("getServiceProperties", reader));
    }

    static Card card(String number, CardType type) {
        Map<String, Object> m = new HashMap<>();
        m.put("getCardNumber", number);
        m.put("getCardType", type);
        return fake(Card.class, m);
    }

    /** Чек продажи. withNewApi=false имитирует старую кассу, где новых методов нет. */
    static Receipt saleReceipt(Card card, boolean withNewApi) {
        return saleReceipt(card, withNewApi, 42, 777L);
    }

    static Receipt saleReceipt(Card card, boolean withNewApi, int number, long fiscalDocId) {
        Map<String, Object> m = new HashMap<>();
        m.put("getType", ReceiptType.SALE);
        m.put("getNumber", number);
        m.put("getShiftNo", 5);
        // время создания различается у разных чеков (как на кассе), поэтому различается и ref
        m.put("getDateCreate", new Date(1760000000000L + (fiscalDocId == 777L ? 0L : fiscalDocId * 1000L)));
        m.put("getSumWithDiscount", new BigDecimal("1234.5"));
        m.put("getCards", card == null ? Collections.<Card>emptyList() : Collections.singletonList(card));
        m.put("getLineItems", Collections.singletonList(lineItem()));
        if (withNewApi) {
            Map<String, Object> shift = new HashMap<>();
            shift.put("getFnNumber", "9999078900001234");
            shift.put("getFiscalFactoryNumber", "0012345678");
            m.put("getShift", fake(Shift.class, shift));
            m.put("getFiscalDocId", fiscalDocId);
            m.put("getFiscalSign", 123456789L);
            m.put("getFiscalizationTimestamp", new Date(1760000100000L));
            Map<String, Object> pay = new HashMap<>();
            pay.put("getPluginId", "cash");
            pay.put("getSum", new BigDecimal("1234.50"));
            m.put("getPayments", Collections.singletonList(fake(ProcessedPayment.class, pay)));
        } else {
            for (String n : new String[]{"getShift", "getFiscalDocId", "getFiscalSign", "getFiscalizationTimestamp", "getPayments", "getSaleReceipt"}) {
                m.put(n, new NoSuchMethodError(n));
            }
        }
        return fake(Receipt.class, m);
    }

    static Receipt refundReceipt(Receipt sale, Card card) {
        Map<String, Object> m = new HashMap<>();
        m.put("getType", ReceiptType.REFUND);
        m.put("getNumber", 43);
        m.put("getShiftNo", 5);
        m.put("getDateCreate", new Date(1760001000000L));
        m.put("getSumWithDiscount", new BigDecimal("100.00"));
        m.put("getCards", card == null ? Collections.<Card>emptyList() : Collections.singletonList(card));
        m.put("getLineItems", Collections.emptyList());
        m.put("getSaleReceipt", sale);
        return fake(Receipt.class, m);
    }

    static LineItem lineItem() {
        Map<String, Object> g = new HashMap<>();
        g.put("getName", "Молоко \"Дея\" 1л");
        g.put("getBarcode", "4600000000011");
        g.put("getGroupCode", "G1");
        Map<String, Object> l = new HashMap<>();
        l.put("getNumber", 1);
        l.put("getQuantity", 1500L);
        l.put("getOriginalPrice", new BigDecimal("100"));
        l.put("getSum", new BigDecimal("150.00"));
        l.put("getDiscountValue", new BigDecimal("0"));
        l.put("getMerchandise", fake(Merchandise.class, g));
        l.put("isAccrueBonusAllowed", Boolean.TRUE);
        l.put("isPayBonusAllowed", Boolean.TRUE);
        return fake(LineItem.class, l);
    }

    // ------------------------------------------------------------------ динамические заглушки интерфейсов

    static final Object NO_VALUE = new Object();

    interface Handler {
        Object handle(String name, Object[] args);
    }

    static <T> T fake(Class<T> type, Map<String, Object> values) {
        return fake(type, values, null);
    }

    @SuppressWarnings("unchecked")
    static <T> T fake(final Class<T> type, final Map<String, Object> values, final Handler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
            String name = method.getName();
            Object[] a = args == null ? new Object[0] : args;
            if (name.equals("toString")) {
                return type.getSimpleName();
            }
            if (name.equals("hashCode")) {
                return System.identityHashCode(proxy);
            }
            if (name.equals("equals")) {
                return proxy == a[0];
            }
            if (handler != null) {
                Object v = handler.handle(name, a);
                if (v != NO_VALUE) {
                    return v;
                }
            }
            if (values != null && values.containsKey(name)) {
                Object v = values.get(name);
                if (v instanceof Throwable) {
                    throw (Throwable) v;
                }
                return v;
            }
            Class<?> rt = method.getReturnType();
            if (rt == boolean.class) {
                return false;
            }
            if (rt == int.class) {
                return 0;
            }
            if (rt == long.class) {
                return 0L;
            }
            if (rt == float.class) {
                return 0f;
            }
            if (rt == double.class) {
                return 0d;
            }
            if (rt == Optional.class) {
                return Optional.empty();
            }
            if (rt == List.class || rt == Collection.class) {
                return Collections.emptyList();
            }
            if (rt == Map.class) {
                return Collections.emptyMap();
            }
            return null;
        });
    }

    static Map<String, Object> map(String k, Object v) {
        Map<String, Object> m = new HashMap<>();
        m.put(k, v);
        return m;
    }

    // ------------------------------------------------------------------ локальный HTTP-сервер

    static class TestServer {
        final HttpServer server;
        final AtomicInteger status = new AtomicInteger(200);
        final AtomicInteger requests = new AtomicInteger();
        volatile Map<String, String> lastHeaders = new HashMap<>();
        volatile String lastBody;
        volatile String lastPath = "";
        final AtomicReference<String> body = new AtomicReference<>("{\"result\":\"ok\"}");
        /** Ответы по окончанию пути (например "/pos/card/status"); иначе body. */
        final Map<String, String> byPath = new java.util.concurrent.ConcurrentHashMap<>();
        final List<String> paths = new CopyOnWriteArrayList<>();
        final List<String> bodies = new CopyOnWriteArrayList<>();

        TestServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::handle);
            server.start();
        }

        String url() {
            return "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1/accruals";
        }

        void stop() {
            server.stop(0);
        }

        private void handle(HttpExchange ex) throws IOException {
            requests.incrementAndGet();
            lastPath = ex.getRequestURI().getPath();
            paths.add(lastPath);
            Map<String, String> h = new HashMap<>();
            for (Map.Entry<String, List<String>> e : ex.getRequestHeaders().entrySet()) {
                h.put(e.getKey(), e.getValue().get(0));
            }
            lastHeaders = h;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = ex.getRequestBody()) {
                byte[] chunk = new byte[1024];
                int n;
                while ((n = in.read(chunk)) > 0) {
                    buf.write(chunk, 0, n);
                }
            }
            lastBody = new String(buf.toByteArray(), StandardCharsets.UTF_8);
            bodies.add(lastBody);
            String answer = body.get();
            for (Map.Entry<String, String> e : byPath.entrySet()) {
                if (lastPath.endsWith(e.getKey())) {
                    answer = e.getValue();
                }
            }
            byte[] resp = answer.getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(status.get(), resp.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(resp);
            }
        }
    }

    static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            failures.add(what);
        }
    }
}
