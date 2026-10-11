package org.slf4j;

/**
 * Заглушка slf4j-api ТОЛЬКО для компиляции и самопроверки (в jar плагина не входит).
 * На кассе Set10 касса сама внедряет настоящий org.slf4j.Logger. Здесь объявлены лишь те
 * перегрузки, которые используются плагином и которые существуют в slf4j-api 1.7 с теми же сигнатурами.
 */
public interface Logger {
    default void trace(String msg) { }
    default void trace(String format, Object... arguments) { }
    default void trace(String msg, Throwable t) { }

    default void debug(String msg) { }
    default void debug(String format, Object... arguments) { }
    default void debug(String msg, Throwable t) { }

    default void info(String msg) { }
    default void info(String format, Object... arguments) { }
    default void info(String msg, Throwable t) { }

    default void warn(String msg) { }
    default void warn(String format, Object... arguments) { }
    default void warn(String msg, Throwable t) { }

    default void error(String msg) { }
    default void error(String format, Object... arguments) { }
    default void error(String msg, Throwable t) { }
}
