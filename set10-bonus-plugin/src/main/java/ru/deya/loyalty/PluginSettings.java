package ru.deya.loyalty;

import ru.crystals.pos.spi.IntegrationProperties;
import ru.crystals.pos.spi.PropertiesReader;

import java.util.ArrayList;
import java.util.List;

/**
 * Настройки плагина. Задаются в Set10: «Интеграция → Внешние процессинги» (поля описаны в metainf.xml).
 * Читаются при каждом обращении, поэтому изменения настроек применяются без перезапуска кассы.
 */
class PluginSettings {

    static final String KEY_ENABLED = "enabled";
    static final String KEY_SERVER_URL = "server.url";
    static final String KEY_API_KEY = "api.key";
    static final String KEY_POINT_ID = "point.id";
    static final String KEY_CARD_PREFIX = "card.prefix";
    static final String KEY_CONNECTION_TIMEOUT = "connection.timeout";
    static final String KEY_READ_TIMEOUT = "read.timeout";
    static final String KEY_SEND_REFUNDS = "send.refunds";
    static final String KEY_MAX_ATTEMPTS = "max.attempts";
    static final String KEY_REDEEM_ENABLED = "redeem.enabled";
    static final String KEY_REDEEM_URL = "redeem.url";
    static final String KEY_REDEEM_TIMEOUT = "redeem.timeout";
    static final String KEY_REDEEM_DISCOUNT_TYPE = "redeem.discount.type";
    static final String KEY_LOG_PAYLOAD = "log.payload";

    private final IntegrationProperties properties;

    PluginSettings(IntegrationProperties properties) {
        this.properties = properties;
    }

    private PropertiesReader reader() {
        return properties.getServiceProperties();
    }

    private String str(String key) {
        String v = reader().get(key);
        if (v == null) {
            return null;
        }
        v = v.trim();
        return v.isEmpty() ? null : v;
    }

    /** Аварийный выключатель: если false, плагин ничего не отправляет. */
    boolean isEnabled() {
        return reader().getBoolean(KEY_ENABLED, true);
    }

    /** Полный адрес, на который отправляется POST с данными чека. */
    String serverUrl() {
        return str(KEY_SERVER_URL);
    }

    String apiKey() {
        return str(KEY_API_KEY);
    }

    /** Идентификатор точки (гипермаркета) на сервере лояльности. */
    String pointId() {
        String v = str(KEY_POINT_ID);
        return v == null ? "hypermarket" : v;
    }

    /**
     * Префиксы номеров карт приложения (через запятую). Если не заданы, подходит любая карта,
     * кроме купонов и подарочных. Нужны, чтобы не отправлять на сервер чужие карты (если на кассе
     * бывают и другие карты лояльности).
     */
    List<String> cardPrefixes() {
        List<String> res = new ArrayList<>();
        String raw = str(KEY_CARD_PREFIX);
        if (raw != null) {
            for (String p : raw.split(",")) {
                p = p.trim();
                if (!p.isEmpty()) {
                    res.add(p);
                }
            }
        }
        return res;
    }

    int connectionTimeoutMs() {
        return clamp(reader().getInt(KEY_CONNECTION_TIMEOUT, 1500), 200, 30000);
    }

    int readTimeoutMs() {
        return clamp(reader().getInt(KEY_READ_TIMEOUT, 3000), 200, 60000);
    }

    boolean sendRefunds() {
        return reader().getBoolean(KEY_SEND_REFUNDS, true);
    }

    /** Сколько раз повторять отправку, если сервер отвечает ошибкой (сетевые сбои в счёт не идут). */
    int maxAttempts() {
        return clamp(reader().getInt(KEY_MAX_ATTEMPTS, 200), 1, 100000);
    }

    /**
     * Списание баллов в чеке гипермаркета (скидкой на подытоге). По умолчанию выключено: сначала проверяем начисление.
     * Лимит (% чека), исключения («цена 3») и согласие клиента решает сервер; плагин только применяет присланную скидку.
     */
    boolean redeemEnabled() {
        return reader().getBoolean(KEY_REDEEM_ENABLED, false);
    }

    /**
     * Базовый адрес списания: по умолчанию выводится из server.url (…/api/v1/accruals → …/api/v1/pos/redeem),
     * запросы идут на {base}/reserve и {base}/cancel.
     */
    String redeemBaseUrl() {
        String v = str(KEY_REDEEM_URL);
        if (v != null) {
            return v.endsWith("/") ? v.substring(0, v.length() - 1) : v;
        }
        String s = serverUrl();
        if (s == null) {
            return null;
        }
        int q = s.indexOf('?');
        if (q >= 0) {
            s = s.substring(0, q);
        }
        return s.endsWith("/accruals") ? s.substring(0, s.length() - "/accruals".length()) + "/pos/redeem" : null;
    }

    /** Таймаут ответа сервера на подытоге (кассир ждёт): короче, чем для фоновой отправки чеков. */
    int redeemTimeoutMs() {
        return clamp(reader().getInt(KEY_REDEEM_TIMEOUT, 1500), 200, 10000);
    }

    /** Тип скидки списания: SUM (обычная скидка, по умолчанию) или BONUSES (скидка бонусами, касса с API 0.0.60+). */
    boolean redeemAsBonusesDiscount() {
        String v = str(KEY_REDEEM_DISCOUNT_TYPE);
        return v != null && v.equalsIgnoreCase("BONUSES");
    }

    /** Писать в лог кассы JSON запроса (для этапа тестирования; номер карты в нём не маскируется). */
    boolean logPayload() {
        return reader().getBoolean(KEY_LOG_PAYLOAD, false);
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }
}
