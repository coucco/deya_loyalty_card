package ru.deya.loyalty;

import java.io.IOException;
import java.util.Map;

/**
 * Синхронные запросы плагинов к серверу лояльности с JSON-ответом (карта, активация, списание).
 * Отправка чеков идёт отдельно через {@link BonusServerClient#send} с очередью кассы.
 */
final class ServerApi {

    /** Ответ: HTTP-код и разобранное тело (Map) или null. */
    static final class Answer {
        final int status;
        final Map<String, Object> body;

        Answer(int status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300 && body != null;
        }

        String str(String key) {
            Object v = body == null ? null : body.get(key);
            return v == null ? null : String.valueOf(v);
        }

        int num(String key) {
            Object v = body == null ? null : body.get(key);
            return v instanceof Number ? ((Number) v).intValue() : 0;
        }

        /** Текст ошибки сервера для кассира. */
        String message() {
            String m = str("message");
            return m != null ? m : "Сервер лояльности ответил " + status;
        }
    }

    private final BonusServerClient client;

    ServerApi(BonusServerClient client) {
        this.client = client;
    }

    /**
     * POST {apiBase}{path}. Нет связи — IOException (вызывающий решает, как жить без сервера).
     */
    @SuppressWarnings("unchecked")
    Answer post(PluginSettings cfg, String path, Map<String, Object> body, int timeoutMs) throws IOException {
        String base = cfg.apiBase();
        if (base == null) {
            throw new IOException("не задан server.url (…/api/v1/accruals)");
        }
        BonusServerClient.Response r = client.post(cfg, base + path, null, Json.toJson(body), timeoutMs, 64 * 1024);
        Object parsed = null;
        try {
            parsed = r.body == null || r.body.isEmpty() ? null : Json.parse(r.body);
        } catch (IllegalArgumentException e) {
            parsed = null;
        }
        return new Answer(r.status, parsed instanceof Map ? (Map<String, Object>) parsed : null);
    }
}
