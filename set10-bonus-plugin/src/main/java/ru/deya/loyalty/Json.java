package ru.deya.loyalty;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Минимальный сериализатор JSON без внешних библиотек (на кассе нельзя рассчитывать на набор библиотек,
 * кроме белого списка Set10). Понимает: null, String, Boolean, Number, Map&lt;String,?&gt;, Collection.
 * Деньги передаются строками заранее, чтобы не потерять точность.
 * {@link #parse(String)} читает ответы сервера: объекты → Map, массивы → List, числа → BigDecimal.
 */
final class Json {

    private Json() {
    }

    static String toJson(Object value) {
        StringBuilder sb = new StringBuilder(512);
        write(sb, value);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            quote(sb, (String) v);
        } else if (v instanceof Boolean || v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
            sb.append(v.toString());
        } else if (v instanceof Number) {
            // Прочие числа (BigDecimal, Double) пишем как строку: так не потеряется точность
            quote(sb, v.toString());
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                quote(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Collection) {
            sb.append('[');
            boolean first = true;
            for (Object o : (Collection<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                write(sb, o);
            }
            sb.append(']');
        } else {
            quote(sb, v.toString());
        }
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20 || c == ' ' || c == ' ') {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ------------------------------------------------------------------ разбор

    static Object parse(String text) {
        Parser p = new Parser(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != text.length()) {
            throw new IllegalArgumentException("JSON: лишние символы на позиции " + p.i);
        }
        return v;
    }

    private static final class Parser {
        private final String s;
        private int i;

        Parser(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        char next() {
            if (i >= s.length()) {
                throw new IllegalArgumentException("JSON: неожиданный конец");
            }
            return s.charAt(i++);
        }

        void expect(String word) {
            if (!s.startsWith(word, i)) {
                throw new IllegalArgumentException("JSON: ожидалось " + word + " на позиции " + i);
            }
            i += word.length();
        }

        Object value() {
            ws();
            if (i >= s.length()) {
                throw new IllegalArgumentException("JSON: неожиданный конец");
            }
            char c = s.charAt(i);
            switch (c) {
                case '{': {
                    i++;
                    Map<String, Object> m = new LinkedHashMap<>();
                    ws();
                    if (s.startsWith("}", i)) {
                        i++;
                        return m;
                    }
                    while (true) {
                        ws();
                        if (next() != '"') {
                            throw new IllegalArgumentException("JSON: ожидался ключ на позиции " + (i - 1));
                        }
                        String k = string();
                        ws();
                        expect(":");
                        m.put(k, value());
                        ws();
                        char d = next();
                        if (d == '}') {
                            return m;
                        }
                        if (d != ',') {
                            throw new IllegalArgumentException("JSON: ожидалась запятая на позиции " + (i - 1));
                        }
                    }
                }
                case '[': {
                    i++;
                    List<Object> l = new ArrayList<>();
                    ws();
                    if (s.startsWith("]", i)) {
                        i++;
                        return l;
                    }
                    while (true) {
                        l.add(value());
                        ws();
                        char d = next();
                        if (d == ']') {
                            return l;
                        }
                        if (d != ',') {
                            throw new IllegalArgumentException("JSON: ожидалась запятая на позиции " + (i - 1));
                        }
                    }
                }
                case '"':
                    i++;
                    return string();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default: {
                    int start = i;
                    while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                        i++;
                    }
                    if (start == i) {
                        throw new IllegalArgumentException("JSON: неожиданный символ на позиции " + i);
                    }
                    return new BigDecimal(s.substring(start, i));
                }
            }
        }

        String string() {
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') {
                    return sb.toString();
                }
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char e = next();
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u':
                        if (i + 4 > s.length()) {
                            throw new IllegalArgumentException("JSON: неполная \\u-последовательность");
                        }
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: sb.append(e);
                }
            }
        }
    }
}
