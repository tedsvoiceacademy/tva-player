package com.tedsvoiceacademy.player;

import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Recordings, written to the phone as they arrive.
 *
 * The same shape as the Windows app's recording.cjs, and for the same reason: an
 * hour of mono at 48 kHz is about 690 MB held in memory, so nothing is held.
 * Each chunk of samples crosses from the page and is appended to an open file.
 *
 * THE HEADER IS WRITTEN LAST, because a WAV header states its own length and the
 * length is not known until the recording stops. An app killed mid-lesson — and
 * Android kills apps — leaves a file whose header says zero, so repair() puts it
 * right from the file's own size on the next start. A lesson is never lost
 * because the phone decided to reclaim some memory.
 *
 * Takes go in the app's own external files directory. That is visible to the
 * person in Files, survives an update, needs no permission at all, and is the
 * only place a phone will let an app write freely. Getting one OUT goes through
 * Android's Save box, in Files.createDocument.
 */
@CapacitorPlugin(name = "Takes")
public class Takes extends Plugin {

    private static final int HEADER_BYTES = 44;
    private final Map<String, Open> running = new HashMap<>();

    private static class Open {
        RandomAccessFile file;
        File path;
        int sampleRate;
        int channels;
        long dataBytes;
    }

    private File folder() {
        /* getExternalFilesDir returns null when external storage is not mounted
           — rare on a modern phone and not impossible, and a null here is a
           crash the moment anybody presses record. */
        File base = getContext().getExternalFilesDir(null);
        File dir = new File(base != null ? base : getContext().getFilesDir(), "Takes");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    @PluginMethod
    public void folderPath(PluginCall call) {
        call.resolve(new JSObject().put("path", folder().getAbsolutePath()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSArray tracks = call.getArray("tracks", new JSArray());
        int sampleRate = call.getInt("sampleRate", 48000);
        String name = safeName(call.getString("name", "Lesson"));
        String stamp = new java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", java.util.Locale.US)
            .format(new java.util.Date());
        JSObject paths = new JSObject();
        try {
            for (int i = 0; i < tracks.length(); i++) {
                JSObject track = JSObject.fromJSONObject(tracks.getJSONObject(i));
                String key = track.getString("key", "mic1");
                String suffix = safeName(track.optString("suffix", ""));
                int channels = track.getInteger("channels", 1) == 2 ? 2 : 1;
                String fileName = name + (suffix.isEmpty() ? "" : " " + suffix) + " " + stamp + ".wav";
                Open open = new Open();
                open.path = new File(folder(), fileName);
                open.file = new RandomAccessFile(open.path, "rw");
                open.sampleRate = sampleRate;
                open.channels = channels;
                open.dataBytes = 0;
                open.file.setLength(0);
                open.file.write(header(sampleRate, channels, 0));
                running.put(key, open);
                paths.put(key, open.path.getAbsolutePath());
            }
        } catch (Exception err) {
            stopAll();
            call.reject("The recording could not be started. " + err.getMessage());
            return;
        }
        call.resolve(new JSObject().put("paths", paths));
    }

    @PluginMethod
    public void chunk(PluginCall call) {
        Open open = running.get(call.getString("key", ""));
        if (open == null) { call.resolve(); return; }
        try {
            byte[] bytes = Base64.decode(call.getString("base64", ""), Base64.NO_WRAP);
            open.file.seek(HEADER_BYTES + open.dataBytes);
            open.file.write(bytes);
            open.dataBytes += bytes.length;
        } catch (Exception ignored) { /* out of space; caught when it stops */ }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSArray takes = new JSArray();
        for (Open open : running.values()) {
            try {
                open.file.seek(0);
                open.file.write(header(open.sampleRate, open.channels, open.dataBytes));
                open.file.getFD().sync();
                open.file.close();
                JSObject take = new JSObject();
                take.put("path", open.path.getAbsolutePath());
                take.put("bytes", HEADER_BYTES + open.dataBytes);
                take.put("seconds", open.dataBytes / (double) (open.sampleRate * open.channels * 2));
                takes.put(take);
            } catch (Exception ignored) { /* nothing more can be done for it */ }
        }
        running.clear();
        call.resolve(new JSObject().put("takes", takes));
    }

    private void stopAll() {
        for (Open open : running.values()) {
            try { open.file.close(); } catch (Exception ignored) { }
        }
        running.clear();
    }

    @PluginMethod
    public void list(PluginCall call) {
        repair();
        File[] files = folder().listFiles((dir, name) -> name.toLowerCase().endsWith(".wav"));
        JSArray takes = new JSArray();
        if (files != null) {
            Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File file : files) {
                JSObject take = new JSObject();
                take.put("name", file.getName().replaceAll("(?i)\\.wav$", ""));
                take.put("path", file.getAbsolutePath());
                take.put("bytes", file.length());
                take.put("madeAt", new java.text.SimpleDateFormat(
                    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).format(new java.util.Date(file.lastModified())));
                takes.put(take);
            }
        }
        call.resolve(new JSObject().put("takes", takes));
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String path = call.getString("path", "");
        File file = new File(path);
        boolean mine = file.getParentFile() != null
            && file.getParentFile().getAbsolutePath().equals(folder().getAbsolutePath());
        call.resolve(new JSObject().put("removed", mine && file.delete()));
    }

    /** Part of a take, for the export code, which reads in slices. */
    @PluginMethod
    public void readRange(PluginCall call) {
        File file = new File(call.getString("path", ""));
        long start = call.getLong("start", 0L);
        int length = call.getInt("length", 65536);
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.seek(start);
            byte[] buffer = new byte[(int) Math.min(length, Math.max(0, raf.length() - start))];
            raf.readFully(buffer);
            call.resolve(new JSObject().put("base64",
                Base64.encodeToString(buffer, Base64.NO_WRAP)));
        } catch (Exception err) {
            call.reject("That take could not be read. " + err.getMessage());
        }
    }

    /* A take left behind by an app the phone killed. Its header says zero bytes,
       so no player will open it; the real length is the file's own size. */
    private void repair() {
        File[] files = folder().listFiles((dir, name) -> name.toLowerCase().endsWith(".wav"));
        if (files == null) return;
        for (File file : files) {
            if (file.length() <= HEADER_BYTES) continue;
            try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
                byte[] head = new byte[HEADER_BYTES];
                raf.readFully(head);
                if (head[0] != 'R' || head[1] != 'I' || head[2] != 'F' || head[3] != 'F') continue;
                long stated = readLe32(head, 40);
                int channels = (int) readLe16(head, 22);
                if (channels < 1) channels = 1;
                long real = file.length() - HEADER_BYTES;
                real -= real % (channels * 2L);
                if (stated == 0 || stated > real) {
                    writeLe32(head, 4, 36 + real);
                    writeLe32(head, 40, real);
                    raf.seek(0);
                    raf.write(head);
                }
            } catch (Exception ignored) { /* a file something else is writing */ }
        }
    }

    private static byte[] header(int sampleRate, int channels, long dataBytes) {
        byte[] h = new byte[HEADER_BYTES];
        int bytesPerFrame = channels * 2;
        put(h, 0, "RIFF");
        writeLe32(h, 4, 36 + dataBytes);
        put(h, 8, "WAVE");
        put(h, 12, "fmt ");
        writeLe32(h, 16, 16);
        writeLe16(h, 20, 1);
        writeLe16(h, 22, channels);
        writeLe32(h, 24, sampleRate);
        writeLe32(h, 28, (long) sampleRate * bytesPerFrame);
        writeLe16(h, 32, bytesPerFrame);
        writeLe16(h, 34, 16);
        put(h, 36, "data");
        writeLe32(h, 40, dataBytes);
        return h;
    }

    private static void put(byte[] at, int index, String text) {
        for (int i = 0; i < text.length(); i++) at[index + i] = (byte) text.charAt(i);
    }

    private static void writeLe32(byte[] at, int index, long value) {
        for (int i = 0; i < 4; i++) at[index + i] = (byte) ((value >> (8 * i)) & 0xff);
    }

    private static void writeLe16(byte[] at, int index, int value) {
        for (int i = 0; i < 2; i++) at[index + i] = (byte) ((value >> (8 * i)) & 0xff);
    }

    private static long readLe32(byte[] from, int index) {
        long value = 0;
        for (int i = 3; i >= 0; i--) value = (value << 8) | (from[index + i] & 0xffL);
        return value;
    }

    private static long readLe16(byte[] from, int index) {
        return ((from[index + 1] & 0xffL) << 8) | (from[index] & 0xffL);
    }

    private static String safeName(String name) {
        return name == null ? "" : name.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "").trim();
    }
}
