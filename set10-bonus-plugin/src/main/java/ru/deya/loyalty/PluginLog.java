package ru.deya.loyalty;

import org.slf4j.Logger;
import ru.crystals.pos.api.ext.loyal.dto.LoyaltyResult;
import ru.crystals.pos.spi.receipt.Card;
import ru.crystals.pos.spi.receipt.Receipt;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.function.Supplier;

/**
 * Журнал плагинов ДЕЯ: каждое сообщение уходит в лог кассы (внедрённый slf4j Logger) и дублируется в свой файл,
 * который удобно открыть и прислать: по умолчанию {@code <папка плагина>/deya-logs/deya-plugin.log}
 * (на кассе — {@code /storage/crystal-cash/plugins/deya-logs/deya-plugin.log}), либо путь из настройки {@code log.file}.
 * Ротация: 5 файлов по 5 МБ ({@code deya-plugin.log.1} … {@code .4}).
 * <p>
 * Режим трассировки ({@code log.trace=true}): каждый метод плагина пишет строку «вызван …» с кратким содержанием чека
 * и результатом — даже если делать было нечего. Номера карт маскируются.
 * <p>
 * Любая ошибка записи в файл молча игнорируется: журнал не должен мешать продаже.
 */
final class PluginLog {

    static final long MAX_BYTES = 5L * 1024 * 1024;
    static final int KEEP_FILES = 5;
    private static final Object FILE_LOCK = new Object();

    private final Logger log;
    private final Supplier<PluginSettings> settings;

    PluginLog(Logger log, Supplier<PluginSettings> settings) {
        this.log = log;
        this.settings = settings;
    }

    /** Для тестов и мест без настроек: только лог кассы. */
    static PluginLog of(Logger log) {
        return new PluginLog(log, null);
    }

    void info(String format, Object... args) {
        if (log != null) {
            log.info(format, args);
        }
        file("INFO ", format, args);
    }

    void warn(String format, Object... args) {
        if (log != null) {
            log.warn(format, args);
        }
        file("WARN ", format, args);
    }

    void error(String format, Object... args) {
        if (log != null) {
            log.error(format, args);
        }
        file("ERROR", format, args);
    }

    void error(String msg, Throwable t) {
        if (log != null) {
            log.error(msg, t);
        }
        file("ERROR", msg, new Object[]{t});
    }

    /** Строка трассировки: пишется только при {@code log.trace=true}. */
    void trace(String format, Object... args) {
        PluginSettings cfg = cfg();
        if (cfg == null || !cfg.logTrace()) {
            return;
        }
        if (log != null) {
            log.info("[trace] " + format, args);
        }
        file("TRACE", format, args);
    }

    // ------------------------------------------------------------------ файл

    private PluginSettings cfg() {
        try {
            return settings == null ? null : settings.get();
        } catch (Exception | LinkageError e) {
            return null;
        }
    }

    private void file(String level, String format, Object[] args) {
        PluginSettings cfg = cfg();
        if (cfg == null || !cfg.logFileEnabled()) {
            return;
        }
        try {
            File f = target(cfg);
            if (f == null) {
                return;
            }
            String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS").format(new Date()) + " " + level + " ["
                    + Thread.currentThread().getName() + "] " + format(format, args) + System.lineSeparator();
            byte[] bytes = line.getBytes(StandardCharsets.UTF_8);
            synchronized (FILE_LOCK) {
                File dir = f.getAbsoluteFile().getParentFile();
                if (dir != null && !dir.exists() && !dir.mkdirs()) {
                    return;
                }
                if (f.length() + bytes.length > MAX_BYTES) {
                    rotate(f);
                }
                try (OutputStream out = new FileOutputStream(f, true)) {
                    out.write(bytes);
                }
            }
        } catch (IOException | RuntimeException | LinkageError e) {
            // журнал не должен мешать кассе
        }
    }

    /** Файл журнала: из настройки log.file или рядом с jar плагина. */
    static File target(PluginSettings cfg) {
        String custom = cfg.logFile();
        if (custom != null) {
            return new File(custom);
        }
        try {
            File jar = new File(PluginLog.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            File base = jar.isFile() ? jar.getParentFile() : jar;
            return new File(new File(base, "deya-logs"), "deya-plugin.log");
        } catch (Exception | LinkageError e) {
            return new File(System.getProperty("java.io.tmpdir"), "deya-plugin.log");
        }
    }

    static void rotate(File f) {
        for (int i = KEEP_FILES - 1; i >= 1; i--) {
            File from = new File(f.getPath() + (i == 1 ? "" : "." + (i - 1)));
            File to = new File(f.getPath() + "." + i);
            if (from.exists()) {
                if (to.exists() && !to.delete()) {
                    return;
                }
                if (!from.renameTo(to)) {
                    return;
                }
            }
        }
    }

    /** Подстановка {} как в slf4j; не использованный последним аргументом Throwable дописывается стеком. */
    static String format(String format, Object[] args) {
        StringBuilder sb = new StringBuilder();
        int argi = 0;
        int i = 0;
        String fmt = format == null ? "" : format;
        while (i < fmt.length()) {
            int j = fmt.indexOf("{}", i);
            if (j < 0 || args == null || argi >= args.length) {
                sb.append(fmt, i, fmt.length());
                break;
            }
            sb.append(fmt, i, j).append(String.valueOf(args[argi++]));
            i = j + 2;
        }
        if (args != null && argi < args.length && args[args.length - 1] instanceof Throwable) {
            StringWriter sw = new StringWriter();
            ((Throwable) args[args.length - 1]).printStackTrace(new PrintWriter(sw));
            sb.append(System.lineSeparator()).append(sw.toString().trim());
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------ краткое содержание для трассировки

    /** Чек одной строкой: тип, номер, ref, сумма, позиции, карта (маска). */
    static String receipt(Receipt r) {
        if (r == null) {
            return "чек=null";
        }
        StringBuilder sb = new StringBuilder();
        sb.append(AccrualRequestBuilder.safe(r::getType)).append(" №").append(AccrualRequestBuilder.safe(r::getNumber));
        sb.append(" ref=").append(AccrualRequestBuilder.safe(() -> AccrualRequestBuilder.receiptRef(r)));
        sb.append(" сумма=").append(AccrualRequestBuilder.safe(r::getSumWithDiscount));
        java.util.List<?> lines = AccrualRequestBuilder.safe(r::getLineItems);
        sb.append(" позиций=").append(lines == null ? 0 : lines.size());
        java.util.Collection<Card> cards = AccrualRequestBuilder.safe(r::getCards);
        sb.append(" карты=").append(cards(cards));
        return sb.toString();
    }

    static String cards(java.util.Collection<Card> cards) {
        if (cards == null || cards.isEmpty()) {
            return "нет";
        }
        StringBuilder sb = new StringBuilder("[");
        for (Card c : cards) {
            if (c == null) {
                continue;
            }
            if (sb.length() > 1) {
                sb.append(", ");
            }
            sb.append(AccrualRequestBuilder.mask(AccrualRequestBuilder.safe(c::getCardNumber))).append(' ')
                    .append(AccrualRequestBuilder.safe(c::getCardType));
        }
        return sb.append(']').toString();
    }

    /** Результат расчёта нашего плагина одной строкой. */
    static String result(LoyaltyResult res) {
        if (res == null) {
            return "результат=null";
        }
        java.math.BigDecimal sum = java.math.BigDecimal.ZERO;
        int n = 0;
        for (ru.crystals.pos.api.ext.loyal.dto.Discount d : res.getDiscounts()) {
            if (d != null && d.getValue() != null) {
                sum = sum.add(d.getValue());
                n++;
            }
        }
        String pts = res.getExtendedReceiptAttributesMap().get(RedeemOnReceipt.ATTR_POINTS);
        return "скидок=" + n + (n > 0 ? " на " + sum.toPlainString() + " ₽" : "") + (pts != null ? ", баллов=" + pts : "")
                + (res.getBonusWriteOffsLimits().isEmpty() ? "" : ", потолок=" + res.getBonusWriteOffsLimits().values());
    }
}
