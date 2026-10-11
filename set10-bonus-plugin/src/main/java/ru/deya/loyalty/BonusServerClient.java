package ru.deya.loyalty;

import org.slf4j.Logger;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * HTTP-клиент к самописному серверу лояльности. Только стандартная Java (HttpURLConnection),
 * короткие таймауты (требование Set10: плагин не должен надолго блокировать кассу).
 */
class BonusServerClient {

    /** Итог попытки отправки. */
    enum Outcome {
        /** Сервер принял (2xx) или сообщил, что такой чек уже есть (409): повторять не нужно. */
        DELIVERED,
        /** Сервер отказал окончательно (400, 404, 410, 422): повтор не поможет, отправку прекращаем. */
        REJECTED,
        /** Нет связи с сервером (сеть, таймаут): повторим позже, попытку не считаем. */
        RETRY_NETWORK,
        /** Сервер ответил ошибкой, которая может пройти (5xx, 401, 403, 429...): повторим позже. */
        RETRY_SERVER
    }

    private static final int MAX_LOGGED_BODY = 512;

    private final Logger log;

    BonusServerClient(Logger log) {
        this.log = log;
    }

    Outcome send(PluginSettings cfg, String idempotencyKey, String json) {
        String url = cfg.serverUrl();
        if (url == null) {
            log.warn("Не задан адрес сервера (server.url), чек {} не отправлен", idempotencyKey);
            return Outcome.RETRY_SERVER;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(cfg.connectionTimeoutMs());
            conn.setReadTimeout(cfg.readTimeoutMs());
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Idempotency-Key", idempotencyKey);
            conn.setRequestProperty("X-Point-Id", cfg.pointId());
            conn.setRequestProperty("User-Agent", "deya-set10-bonus-plugin");
            String apiKey = cfg.apiKey();
            if (apiKey != null) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body);
            }
            int status = conn.getResponseCode();
            String answer = readSmall(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
            return classify(status, idempotencyKey, answer);
        } catch (IOException e) {
            log.warn("Нет связи с сервером лояльности ({}): {}", idempotencyKey, e.toString());
            return Outcome.RETRY_NETWORK;
        } catch (RuntimeException e) {
            // например, некорректный URL в настройках
            log.error("Ошибка отправки на сервер лояльности (" + idempotencyKey + "): проверьте настройки", e);
            return Outcome.RETRY_SERVER;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    static Outcome classify(int status, String key, String answer, Logger log) {
        if (status >= 200 && status < 300) {
            return Outcome.DELIVERED;
        }
        if (status == 409) {
            // Идемпотентность: такой чек уже обработан, баллы второй раз не начислены
            return Outcome.DELIVERED;
        }
        if (status == 400 || status == 404 || status == 410 || status == 422) {
            log.warn("Сервер отклонил чек {}: HTTP {} {}", key, status, answer);
            return Outcome.REJECTED;
        }
        log.warn("Сервер лояльности вернул ошибку для чека {}: HTTP {} {}", key, status, answer);
        return Outcome.RETRY_SERVER;
    }

    private Outcome classify(int status, String key, String answer) {
        return classify(status, key, answer, log);
    }

    private static String readSmall(InputStream in) {
        if (in == null) {
            return "";
        }
        try (InputStream is = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[256];
            int n;
            while ((n = is.read(chunk)) > 0 && buf.size() < MAX_LOGGED_BODY) {
                buf.write(chunk, 0, n);
            }
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }
}
