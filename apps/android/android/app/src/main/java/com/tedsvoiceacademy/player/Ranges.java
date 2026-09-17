package com.tedsvoiceacademy.player;

/**
 * Deciding what to answer a media element with, and nothing else.
 *
 * NO ANDROID IN THIS FILE ON PURPOSE. Serving a song out of the phone's storage
 * is the one part of the app that no check could reach — there is no document
 * picker on a build runner and no OneDrive to read from — and it is exactly the
 * part that failed the first time Ted tried it. Everything about it that is
 * really a decision rather than a file handle lives here, where it runs on a
 * plain JVM and `gradlew test` can put twenty awkward cases through it.
 *
 * What a media element actually does, in order:
 *
 *   1. Asks for the whole file. It needs a length back, or it reports the song's
 *      duration as Infinity — the clock sticks at 0:00 and the waveform has
 *      nothing to scale itself against.
 *   2. Asks for "bytes=0-" to start streaming.
 *   3. Asks for "bytes=<somewhere>-" every time the person seeks.
 *
 * AND A LENGTH IS NOT ALWAYS AVAILABLE. A file in OneDrive is not on the phone;
 * the provider may not say how big it is until it has been fetched. The rule
 * below is the important one: when the length is unknown, answer 200 and send
 * the file from the beginning. A 206 without a valid Content-Range is a reply
 * the browser cannot use, and answering one is how a song that was perfectly
 * readable refuses to open at all.
 */
public final class Ranges {

    private Ranges() { }

    public static final class Plan {
        /** 200, 206 or 416. */
        public final int status;
        /** First byte to send. */
        public final long start;
        /** Last byte to send, or -1 for "to the end of the stream". */
        public final long end;
        /** The Content-Range header, or null when this is not a partial answer. */
        public final String contentRange;
        /** The Content-Length header, or -1 when the length is not known. */
        public final long contentLength;

        Plan(int status, long start, long end, String contentRange, long contentLength) {
            this.status = status;
            this.start = start;
            this.end = end;
            this.contentRange = contentRange;
            this.contentLength = contentLength;
        }

        public boolean partial() { return status == 206; }
        /** True when the bytes have to be sliced rather than passed straight through. */
        public boolean slices() { return start > 0 || end >= 0; }
    }

    /**
     * @param rangeHeader the request's Range header, or null
     * @param total       the file's length in bytes, or -1 if it is not known
     */
    public static Plan plan(String rangeHeader, long total) {
        String header = rangeHeader == null ? "" : rangeHeader.trim();

        /* THE LENGTH DECIDES EVERYTHING. Without it no partial answer can be
           made, because Content-Range must state where the bytes sit, and an
           answer the browser cannot use is worse than a whole file. */
        if (total < 0) {
            return new Plan(200, 0, -1, null, -1);
        }
        if (total == 0) {
            return new Plan(200, 0, -1, null, 0);
        }
        if (!header.toLowerCase().startsWith("bytes=")) {
            return new Plan(200, 0, total - 1, null, total);
        }

        String spec = header.substring(6).trim();
        /* One range only. "bytes=0-99,200-299" is legal and no media element
           sends it; answering the whole file is the correct fallback. */
        if (spec.contains(",")) return new Plan(200, 0, total - 1, null, total);

        int dash = spec.indexOf('-');
        if (dash < 0) return new Plan(200, 0, total - 1, null, total);

        String fromText = spec.substring(0, dash).trim();
        String toText = spec.substring(dash + 1).trim();

        long start;
        long end;
        try {
            if (fromText.isEmpty()) {
                /* "bytes=-500" means the LAST 500 bytes, not the first 500.
                   Read the other way round it serves the head of the file while
                   claiming to be the tail, and a seek to the end plays the
                   beginning. */
                if (toText.isEmpty()) return new Plan(200, 0, total - 1, null, total);
                long wanted = Long.parseLong(toText);
                if (wanted <= 0) return new Plan(416, 0, -1, "bytes */" + total, -1);
                start = Math.max(0, total - wanted);
                end = total - 1;
            } else {
                start = Long.parseLong(fromText);
                end = toText.isEmpty() ? total - 1 : Long.parseLong(toText);
            }
        } catch (NumberFormatException notANumber) {
            return new Plan(200, 0, total - 1, null, total);
        }

        if (start < 0) return new Plan(416, 0, -1, "bytes */" + total, -1);
        if (start >= total) return new Plan(416, 0, -1, "bytes */" + total, -1);
        if (end >= total) end = total - 1;
        if (end < start) return new Plan(416, 0, -1, "bytes */" + total, -1);

        return new Plan(206, start, end,
            "bytes " + start + "-" + end + "/" + total, end - start + 1);
    }

    /** The type to serve a file as, from its name. */
    public static String mimeForName(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".m4a") || lower.endsWith(".aac")) return "audio/mp4";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga") || lower.endsWith(".opus")) return "audio/ogg";
        if (lower.endsWith(".aiff") || lower.endsWith(".aif")) return "audio/aiff";
        if (lower.endsWith(".wma")) return "audio/x-ms-wma";
        return "audio/mpeg";
    }
}
