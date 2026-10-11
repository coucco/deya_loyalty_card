package ru.deya.loyalty;

import java.util.function.LongSupplier;

/**
 * Простой «предохранитель»: если сервер несколько раз подряд недоступен, на короткое время перестаём
 * пытаться отправлять сразу (чтобы кассир не ждал таймаутов при каждом чеке). Неотправленное
 * остаётся в очереди кассы и уйдёт позже.
 */
class FailureBreaker {

    private final int threshold;
    private final long openMs;
    private final LongSupplier clock;

    private int consecutiveFailures;
    private long openUntil;

    FailureBreaker(int threshold, long openMs, LongSupplier clock) {
        this.threshold = threshold;
        this.openMs = openMs;
        this.clock = clock;
    }

    synchronized boolean allow() {
        return clock.getAsLong() >= openUntil;
    }

    synchronized void success() {
        consecutiveFailures = 0;
        openUntil = 0;
    }

    synchronized void failure() {
        consecutiveFailures++;
        if (consecutiveFailures >= threshold) {
            openUntil = clock.getAsLong() + openMs;
        }
    }
}
