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

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }
}
