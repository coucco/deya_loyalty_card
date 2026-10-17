package ru.deya.loyalty;

import org.slf4j.Logger;
import ru.crystals.pos.api.card.BonusBalanceEntity;
import ru.crystals.pos.api.card.CardCategoryEntity;
import ru.crystals.pos.api.card.CardEntity;
import ru.crystals.pos.api.card.CardHolderEntity;
import ru.crystals.pos.api.plugin.CardPlugin;
import ru.crystals.pos.api.plugin.card.BonusOperationResponse;
import ru.crystals.pos.api.plugin.card.BonusOperationStatus;
import ru.crystals.pos.api.plugin.card.BonusWriteOffOperationResponse;
import ru.crystals.pos.api.plugin.card.CardInfo;
import ru.crystals.pos.api.plugin.card.CardSearchFinishedResponse;
import ru.crystals.pos.api.plugin.card.CardSearchResponse;
import ru.crystals.pos.api.plugin.card.CardSearchResponseStatus;
import ru.crystals.pos.api.ui.listener.ConfirmListener;
import ru.crystals.pos.api.ui.listener.DialogListener;
import ru.crystals.pos.api.ui.listener.InputListener;
import ru.crystals.pos.spi.IntegrationProperties;
import ru.crystals.pos.spi.annotation.Inject;
import ru.crystals.pos.spi.annotation.POSPlugin;
import ru.crystals.pos.spi.plugin.card.CardInfoRequest;
import ru.crystals.pos.spi.plugin.card.CardSearchCallback;
import ru.crystals.pos.spi.plugin.card.CardSearchEventSource;
import ru.crystals.pos.spi.plugin.card.CardSearchFinishedRequest;
import ru.crystals.pos.spi.plugin.card.CardSearchRequest;
import ru.crystals.pos.spi.receipt.Card;
import ru.crystals.pos.spi.receipt.CardStatus;
import ru.crystals.pos.spi.receipt.CardType;
import ru.crystals.pos.spi.receipt.Receipt;
import ru.crystals.pos.spi.ui.DialogFormParameters;
import ru.crystals.pos.spi.ui.UIForms;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Плагин карт «ДЕЯ» (в том же jar и с теми же настройками, что и плагин лояльности).
 * <ul>
 * <li><b>Активация пластика на кассе</b> ({@link #cardSearchFinished}): касса нашла карту (свою или нашу) → если это
 * неактивированный пластик ДЕЯ, кассиру предлагается ввести телефон покупателя, сервер шлёт СМС с кодом, кассир вводит код →
 * карта привязана к профилю. Работает в любом режиме, «цену 3» не затрагивает.</li>
 * <li><b>Поиск по телефону</b> ({@link #searchCardAsync}, источник PHONE_NUMBER).</li>
 * <li><b>Инфо по карте</b> ({@link #getCardInfo}): профиль, баланс.</li>
 * <li><b>Режим external</b> (card.mode): плагин признаёт карты ДЕЯ своими и отдаёт кассе баланс → кнопка «оплатить бонусами»,
 * списание {@link #writeOff}, откат {@link #rollback}. Будет ли при этом работать «цена 3» по типу карты Set10 — проверяется
 * на тестовой кассе (TEST_PLAN, этап 2b); если нет — остаёмся в internal и списываем автоматически (redeem.mode=auto).</li>
 * </ul>
 * Любая ошибка или недоступность сервера не мешает продаже: карта работает как обычная карта Set10, без баланса и активации.
 */
@POSPlugin(id = DeyaCardPlugin.PLUGIN_ID)
public class DeyaCardPlugin implements CardPlugin {

    /** Должен совпадать с id элемента CardPlugin в metainf.xml. */
    static final String PLUGIN_ID = "ext.deya.card";

    @Inject
    Logger log;

    @Inject
    IntegrationProperties properties;

    @Inject
    UIForms ui;

    private volatile ServerApi api;

    // ------------------------------------------------------------------ поиск карты

    @Override
    public CardSearchResponse searchCard(CardSearchRequest request) {
        try {
            PluginSettings cfg = settings();
            if (!cfg.isEnabled() || !cfg.cardExternal() || request == null) {
                return new CardSearchResponse(CardSearchResponseStatus.UNKNOWN_CARD); // карту ищет Set10
            }
            String number = numberFrom(request);
            if (number == null || !ours(cfg, number)) {
                return new CardSearchResponse(CardSearchResponseStatus.UNKNOWN_CARD);
            }
            ServerApi.Answer st;
            try {
                st = api().post(cfg, "/pos/card/status", map("card", number), cfg.redeemTimeoutMs());
            } catch (IOException e) {
                // без сервера карта всё равно должна работать: «цена 3» и отложенное начисление
                log.warn("Поиск карты {}: нет связи с сервером ({}), карта без баланса", mask(number), e.toString());
                CardSearchResponse r = new CardSearchResponse(CardSearchResponseStatus.OK, entity(cfg, number, null, request.getEventSource()));
                r.addCashierMessage("Баллы ДЕЯ: баланс сейчас недоступен (нет связи)");
                return r;
            }
            if (!st.ok() || !"true".equals(st.str("known"))) {
                return new CardSearchResponse(CardSearchResponseStatus.UNKNOWN_CARD);
            }
            CardEntity card = entity(cfg, number, st, request.getEventSource());
            CardSearchResponse r = new CardSearchResponse(CardSearchResponseStatus.OK, card);
            String state = st.str("state");
            if ("blocked".equals(state) || "closed".equals(state)) {
                card.setCardStatus(CardStatus.BLOCKED);
                r.addCashierMessage("Карта ДЕЯ заблокирована. Клиент может обратиться в поддержку");
            }
            return r;
        } catch (Exception | LinkageError e) {
            log.error("Ошибка плагина карт при поиске карты", e);
            return new CardSearchResponse(CardSearchResponseStatus.UNKNOWN_CARD);
        }
    }

    /** Поиск по телефону — в отдельном потоке (касса ждёт callback). Остальные источники — как {@link #searchCard}. */
    @Override
    public void searchCardAsync(CardSearchRequest request, CardSearchCallback callback) {
        if (request == null || request.getEventSource() != CardSearchEventSource.PHONE_NUMBER) {
            callback.onCardSearchCompleted(searchCard(request));
            return;
        }
        background(() -> {
            CardSearchResponse res;
            try {
                PluginSettings cfg = settings();
                if (!cfg.isEnabled() || !cfg.cardPhoneSearch()) {
                    res = new CardSearchResponse(CardSearchResponseStatus.UNKNOWN_CARD);
                } else {
                    ServerApi.Answer a = api().post(cfg, "/pos/card/by-phone", map("phone", request.getSearchString()), cfg.redeemTimeoutMs());
                    if (a.ok() && a.str("card") != null) {
                        res = new CardSearchResponse(CardSearchResponseStatus.OK, entity(cfg, a.str("card"), a, CardSearchEventSource.PHONE_NUMBER));
                    } else {
                        res = new CardSearchResponse(a.status == 404 ? CardSearchResponseStatus.CARD_NOT_FOUND : CardSearchResponseStatus.ERROR);
                        res.addCashierMessage(a.message());
                    }
                }
            } catch (IOException e) {
                res = new CardSearchResponse(CardSearchResponseStatus.OFFLINE);
            } catch (Exception | LinkageError e) {
                log.error("Ошибка поиска карты по телефону", e);
                res = new CardSearchResponse(CardSearchResponseStatus.ERROR);
            }
            callback.onCardSearchCompleted(res);
        });
    }

    // ------------------------------------------------------------------ активация пластика на кассе

    @Override
    public void cardSearchFinished(CardSearchFinishedRequest request) {
        final AtomicBoolean done = new AtomicBoolean(false);
        final Runnable finish = () -> {
            if (done.compareAndSet(false, true)) {
                request.getCallback().onCardSearchFinishedCompleted(new CardSearchFinishedResponse());
            }
        };
        try {
            PluginSettings cfg = settings();
            Card found = request.getFoundCard().orElse(null);
            if (!cfg.isEnabled() || !cfg.cardActivation() || found == null || found.getCardNumber() == null
                    || !ours(cfg, found.getCardNumber()) || ui == null) {
                finish.run();
                return;
            }
            final String number = found.getCardNumber();
            ServerApi.Answer st = api().post(cfg, "/pos/card/status", map("card", number), cfg.redeemTimeoutMs());
            String state = st.ok() ? st.str("state") : null;
            if (!"physical".equals(st.str("kind")) || !("free".equals(state) || "guest".equals(state))) {
                finish.run();
                return;
            }
            DialogFormParameters p = new DialogFormParameters(
                    "Пластиковая карта ДЕЯ не активирована" + ("guest".equals(state) ? " (на ней " + st.num("balance") + " б.)" : "")
                            + ". Активировать по номеру телефона покупателя? Покупателю придёт СМС с кодом.",
                    "Активировать", "Позже");
            ui.showDialogForm(p, new DialogListener() {
                @Override
                public void eventButton1pressed() {
                    askPhone(cfg, number, finish);
                }

                @Override
                public void eventButton2pressed() {
                    finish.run();
                }

                @Override
                public void eventCanceled() {
                    finish.run();
                }
            });
        } catch (Exception | LinkageError e) {
            log.warn("Активация карты не предложена: {}", e.toString());
            finish.run();
        }
    }

    private void askPhone(PluginSettings cfg, String number, Runnable finish) {
        ui.getInputForms().showInputNumberForm("Активация карты ДЕЯ", "Телефон покупателя (10 цифр после +7)", "9XXXXXXXXX", 11, new InputListener() {
            @Override
            public void eventInputComplete(String phone) {
                try {
                    Map<String, Object> body = map("card", number);
                    body.put("phone", phone);
                    ServerApi.Answer a = api().post(cfg, "/pos/activate/start", body, cfg.redeemTimeoutMs() * 4);
                    if (!a.ok()) {
                        error(a.message(), finish);
                        return;
                    }
                    String note = a.str("replaces") != null ? " Прежняя карта " + a.str("replaces") + " будет заблокирована." : "";
                    askCode(cfg, number, phone, note, finish);
                } catch (Exception | LinkageError e) {
                    error("Нет связи с сервером ДЕЯ, активируйте карту позже", finish);
                }
            }

            @Override
            public void eventCanceled() {
                finish.run();
            }
        });
    }

    private void askCode(PluginSettings cfg, String number, String phone, String note, Runnable finish) {
        ui.getInputForms().showInputNumberForm("Код из СМС", "Покупатель получил СМС с кодом." + note, "0000", 4, new InputListener() {
            @Override
            public void eventInputComplete(String code) {
                try {
                    Map<String, Object> body = map("card", number);
                    body.put("phone", phone);
                    body.put("code", code);
                    ServerApi.Answer a = api().post(cfg, "/pos/activate/confirm", body, cfg.redeemTimeoutMs() * 2);
                    if (!a.ok()) {
                        error(a.message(), finish);
                        return;
                    }
                    log.info("Карта {} активирована, профиль {}", mask(number), a.str("profileId"));
                    ui.showMessageForm("Карта активирована. Профиль " + a.str("profileId") + ", баллов: " + a.num("balance"), new ConfirmListener() {
                        @Override
                        public void eventConfirmed() {
                            finish.run();
                        }
                    });
                } catch (Exception | LinkageError e) {
                    error("Нет связи с сервером ДЕЯ, активируйте карту позже", finish);
                }
            }

            @Override
            public void eventCanceled() {
                finish.run();
            }
        });
    }

    private void error(String text, Runnable finish) {
        try {
            ui.showErrorForm(text, new ConfirmListener() {
                @Override
                public void eventConfirmed() {
                    finish.run();
                }
            });
        } catch (Exception | LinkageError e) {
            finish.run();
        }
    }

    // ------------------------------------------------------------------ инфо по карте

    @Override
    public CardInfo getCardInfo(CardInfoRequest request) {
        try {
            PluginSettings cfg = settings();
            Card card = AccrualRequestBuilder.safe(request::getCard);
            String number = card != null ? card.getCardNumber() : numberFrom(request.getCardSearchRequest());
            if (number == null || !ours(cfg, number)) {
                return new CardInfo(CardSearchResponseStatus.UNKNOWN_CARD, null);
            }
            ServerApi.Answer st = api().post(cfg, "/pos/card/status", map("card", number), cfg.redeemTimeoutMs());
            if (!st.ok() || !"true".equals(st.str("known"))) {
                return new CardInfo(CardSearchResponseStatus.CARD_NOT_FOUND, null);
            }
            Map<String, String> info = new LinkedHashMap<>();
            info.put("Карта", number + ("physical".equals(st.str("kind")) ? " (пластик)" : " (приложение)"));
            info.put("Статус", stateText(st.str("state")));
            if (st.str("profileId") != null) {
                info.put("Профиль", st.str("profileId"));
                info.put("Баланс, баллов", String.valueOf(st.num("balance")));
                info.put("Доступно, баллов", String.valueOf(st.num("available")));
            }
            if (st.str("phone") != null) {
                info.put("Телефон", st.str("phone"));
            }
            CardInfo ci = new CardInfo(CardSearchResponseStatus.OK, info);
            ci.setTitle("Карта ДЕЯ");
            return ci;
        } catch (IOException e) {
            return new CardInfo(CardSearchResponseStatus.OFFLINE, null);
        } catch (Exception | LinkageError e) {
            log.error("Ошибка получения информации по карте", e);
            return new CardInfo(CardSearchResponseStatus.ERROR, null);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public CardInfo getCardInfo(CardSearchRequest request) {
        try {
            return getCardInfo(new CardInfoRequest() {
                @Override
                public Card getCard() {
                    return null;
                }

                @Override
                public CardSearchRequest getCardSearchRequest() {
                    return request;
                }
            });
        } catch (Exception | LinkageError e) {
            return new CardInfo(CardSearchResponseStatus.ERROR, null);
        }
    }

    // ------------------------------------------------------------------ оплата бонусами (режим external)

    /** Кассир подтвердил «оплатить бонусами»: списываем зарезервированное на подытоге. */
    @Override
    public BonusWriteOffOperationResponse writeOff(Card bonusCard, BigDecimal bonusesToWriteOff, Receipt receipt) {
        try {
            PluginSettings cfg = settings();
            Map<String, Object> body = map("ref", AccrualRequestBuilder.receiptRef(receipt));
            body.put("points", bonusesToWriteOff == null ? null : bonusesToWriteOff.intValue());
            body.put("card", bonusCard == null ? null : bonusCard.getCardNumber());
            ServerApi.Answer a = api().post(cfg, "/pos/redeem/writeoff", body, cfg.redeemTimeoutMs() * 2);
            if (a.ok()) {
                log.info("Списано {} баллов по карте {}, транзакция {}", a.num("points"), mask(bonusCard.getCardNumber()), a.str("txId"));
                return new BonusWriteOffOperationResponse(BonusOperationStatus.OK, a.str("txId"), null);
            }
            return new BonusWriteOffOperationResponse(BonusOperationStatus.ERROR, null, a.message());
        } catch (IOException e) {
            return new BonusWriteOffOperationResponse(BonusOperationStatus.TRY_AGAIN, null, "Нет связи с сервером ДЕЯ, повторите");
        } catch (Exception | LinkageError e) {
            log.error("Ошибка списания баллов", e);
            return new BonusWriteOffOperationResponse(BonusOperationStatus.ERROR, null, "Ошибка списания баллов ДЕЯ");
        }
    }

    @Override
    public BonusOperationResponse rollback(String txId) {
        try {
            ServerApi.Answer a = api().post(settings(), "/pos/redeem/rollback", map("txId", txId), settings().redeemTimeoutMs() * 2);
            return new BonusOperationResponse(a.ok() ? BonusOperationStatus.OK : BonusOperationStatus.ERROR, txId);
        } catch (IOException e) {
            return new BonusOperationResponse(BonusOperationStatus.TRY_AGAIN, txId);
        } catch (Exception | LinkageError e) {
            log.error("Ошибка отката списания", e);
            return new BonusOperationResponse(BonusOperationStatus.ERROR, txId);
        }
    }

    // ------------------------------------------------------------------ вспомогательное

    /** Карта для кассы: номер, держатель (ID профиля), баланс баллов, категория (если задана для акций Set10). */
    private CardEntity entity(PluginSettings cfg, String number, ServerApi.Answer st, CardSearchEventSource source) {
        CardEntity e = new CardEntity(number, cfg.cardExternal() ? CardType.EXTERNAL : CardType.INTERNAL, PLUGIN_ID);
        e.setId(number);
        e.setInputType(source);
        if (st != null && st.str("profileId") != null) {
            CardHolderEntity h = new CardHolderEntity(st.str("profileId"), st.str("name"), null, null);
            h.setPhone(st.str("phone"));
            e.setCardHolder(h);
            BonusBalanceEntity b = new BonusBalanceEntity(BigDecimal.valueOf(st.num("available")));
            b.setBonusProcessingDisplayName("Баллы ДЕЯ");
            e.setBonusBalance(b);
        }
        Long category = cfg.cardCategoryGuid();
        if (category != null) {
            e.setCategory(new CardCategoryEntity(category));
        }
        return e;
    }

    /** Номер карты из запроса; для магнитной полосы — с дорожки 2 (;номер=…?) или 1 (%Bномер^…). */
    static String numberFrom(CardSearchRequest r) {
        if (r == null) {
            return null;
        }
        if (r.getEventSource() == CardSearchEventSource.MAGNETIC_STRIPE) {
            List<String> tracks = r.getAdditionalData();
            String t2 = tracks != null && tracks.size() > 1 ? tracks.get(1) : null;
            String t1 = tracks != null && !tracks.isEmpty() ? tracks.get(0) : null;
            String n = trackNumber(t2 != null ? t2 : t1);
            if (n != null) {
                return n;
            }
        }
        String s = r.getSearchString();
        return s == null ? null : trackNumber(s.trim());
    }

    static String trackNumber(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim();
        if (s.startsWith("%B") || s.startsWith("%")) {
            s = s.substring(s.startsWith("%B") ? 2 : 1);
            int caret = s.indexOf('^');
            return caret > 0 ? s.substring(0, caret) : null;
        }
        if (s.startsWith(";")) {
            s = s.substring(1);
        }
        int stop = s.length();
        for (char c : new char[]{'=', '?'}) {
            int i = s.indexOf(c);
            if (i >= 0 && i < stop) {
                stop = i;
            }
        }
        s = s.substring(0, stop);
        return s.isEmpty() ? null : s;
    }

    private static boolean ours(PluginSettings cfg, String number) {
        List<String> prefixes = cfg.cardPrefixes();
        if (prefixes.isEmpty()) {
            return true;
        }
        for (String p : prefixes) {
            if (number.startsWith(p)) {
                return true;
            }
        }
        return false;
    }

    private static String stateText(String state) {
        if ("bound".equals(state)) {
            return "активирована";
        }
        if ("guest".equals(state)) {
            return "не активирована, баллы копятся на карте";
        }
        if ("free".equals(state)) {
            return "не активирована";
        }
        return "заблокирована";
    }

    private static Map<String, Object> map(String k, Object v) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(k, v);
        return m;
    }

    private static String mask(String n) {
        return AccrualRequestBuilder.mask(n);
    }

    private void background(Runnable r) {
        Thread t = new Thread(r, "deya-card-plugin");
        t.setDaemon(true);
        t.start();
    }

    private PluginSettings settings() {
        return new PluginSettings(properties);
    }

    private ServerApi api() {
        ServerApi a = api;
        if (a == null) {
            a = new ServerApi(new BonusServerClient(log));
            api = a;
        }
        return a;
    }
}
