package com.tedsvoiceacademy.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

import org.junit.Test;

/**
 * Which bytes actually go out, put through the awkward streams.
 *
 * Ranges says which bytes to promise; Slice hands them over, and a wrong answer
 * there is the difference between seeking to the chorus and hearing the verse.
 * The emulator check caught a range answer whose hundred bytes were not the
 * file's hundred bytes, and this is where that question gets settled in a second
 * rather than in a fifteen-minute build.
 *
 * THE FILE IS COUNTABLE ON PURPOSE. Every byte equals its own offset modulo 251
 * — a prime, so no offset inside any window this tests can collide — which means
 * a failure says WHERE the bytes came from instead of only that two arrays
 * differ.
 */
public class SliceTest {

    private static final int SIZE = 128_731;   // the size of the song the emulator check uses

    private static byte[] countableFile() {
        byte[] file = new byte[SIZE];
        for (int i = 0; i < SIZE; i++) file[i] = (byte) (i % 251);
        return file;
    }

    private static byte[] window(byte[] file, long start, long length) throws IOException {
        return drain(new Slice(new ByteArrayInputStream(file), start, length));
    }

    private static byte[] drain(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] lump = new byte[8192];
        for (int read = in.read(lump); read > 0; read = in.read(lump)) out.write(lump, 0, read);
        return out.toByteArray();
    }

    private static byte[] expected(byte[] file, int from, int count) {
        byte[] want = new byte[count];
        System.arraycopy(file, from, want, 0, count);
        return want;
    }

    /** Says where a window really came from, so a failure names the fault. */
    private static String whereItCameFrom(byte[] file, byte[] got) {
        if (got.length == 0) return "it is empty";
        outer:
        for (int at = 0; at + got.length <= file.length; at++) {
            for (int i = 0; i < got.length; i++) {
                if (file[at + i] != got[i]) continue outer;
            }
            return "those are the file's bytes from offset " + at;
        }
        return "those bytes are nowhere in the file at all";
    }

    @Test
    public void aWindowOutOfTheMiddleIsTheFilesOwnBytes() throws IOException {
        /* THE EXACT REQUEST THE EMULATOR CHECK MAKES: bytes 1000-1099. */
        byte[] file = countableFile();
        byte[] got = window(file, 1000, 100);
        assertEquals("a hundred bytes were asked for", 100, got.length);
        assertArrayEquals("the window is not bytes 1000-1099 — " + whereItCameFrom(file, got),
            expected(file, 1000, 100), got);
    }

    @Test
    public void aWindowFromAStreamThatSkipsShortIsStillRight() throws IOException {
        /* InputStream.skip may skip FEWER bytes than it was asked for and say
           nothing about it, which is why the skipping is a loop. Called once,
           this window would start 993 bytes early. */
        byte[] file = countableFile();
        byte[] got = drain(new Slice(new Awkward(file, 7, false), 1000, 100));
        assertArrayEquals("a stream that skips seven bytes at a time lands in the wrong place — "
            + whereItCameFrom(file, got), expected(file, 1000, 100), got);
    }

    @Test
    public void aWindowFromAStreamThatWillNotSkipAtAllIsStillRight() throws IOException {
        /* The OneDrive-shaped case: skip answers 0 for ever. Reading forward is
           the only way through, and without it the song plays from the top
           every time somebody seeks. */
        byte[] file = countableFile();
        byte[] got = drain(new Slice(new Awkward(file, 0, true), 4096, 256));
        assertArrayEquals("a stream that refuses to skip served the wrong bytes — "
            + whereItCameFrom(file, got), expected(file, 4096, 256), got);
    }

    @Test
    public void aWindowRunningToTheEndStopsAtTheEnd() throws IOException {
        byte[] file = countableFile();
        byte[] got = window(file, SIZE - 10, Long.MAX_VALUE);
        assertArrayEquals("the tail of the file is wrong — " + whereItCameFrom(file, got),
            expected(file, SIZE - 10, 10), got);
    }

    @Test
    public void aWindowAskingForMoreThanIsThereEndsWhenTheFileDoes() throws IOException {
        byte[] file = countableFile();
        byte[] got = window(file, SIZE - 5, 4096);
        assertEquals("only five bytes are left to give", 5, got.length);
        assertArrayEquals(expected(file, SIZE - 5, 5), got);
    }

    @Test
    public void readingOneByteAtATimeGivesTheSameWindow() throws IOException {
        /* A reader is allowed to ask for one byte at a time, and the two read
           methods keep their own count of what is left. */
        byte[] file = countableFile();
        Slice slice = new Slice(new ByteArrayInputStream(file), 2000, 50);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int b = slice.read(); b >= 0; b = slice.read()) out.write(b);
        assertArrayEquals("byte-at-a-time reading gave a different window — "
            + whereItCameFrom(file, out.toByteArray()), expected(file, 2000, 50), out.toByteArray());
    }

    @Test
    public void whatRangesPromisesIsWhatSliceHandsOver() throws IOException {
        /* THE JOIN, which neither test covered on its own — and the join is what
           SongStream actually does. Ranges says bytes 1000-1099 of 128731 and
           Content-Range says so out loud; Slice has to deliver exactly that. */
        byte[] file = countableFile();
        Ranges.Plan plan = Ranges.plan("bytes=1000-1099", SIZE);
        assertEquals(206, plan.status);
        assertEquals("bytes 1000-1099/" + SIZE, plan.contentRange);
        assertEquals(100, plan.contentLength);
        assertTrue("a window out of the middle has to be sliced", plan.slices());

        byte[] got = window(file, plan.start, plan.end >= 0 ? plan.end - plan.start + 1 : Long.MAX_VALUE);
        assertEquals("Content-Length promised " + plan.contentLength + " bytes",
            plan.contentLength, got.length);
        assertArrayEquals("the bytes served are not the bytes Content-Range promised — "
            + whereItCameFrom(file, got), expected(file, 1000, 100), got);
    }

    @Test
    public void aSeekToTheMiddleOfALongSongLandsWhereItWasAsked() throws IOException {
        /* What pressing halfway along the wave really asks for: everything from
           here to the end. */
        byte[] file = countableFile();
        Ranges.Plan plan = Ranges.plan("bytes=64000-", SIZE);
        byte[] got = window(file, plan.start, plan.end >= 0 ? plan.end - plan.start + 1 : Long.MAX_VALUE);
        assertEquals(SIZE - 64000, got.length);
        assertArrayEquals("seeking to the middle served the wrong bytes — "
            + whereItCameFrom(file, got), expected(file, 64000, SIZE - 64000), got);
    }

    /**
     * A stream that behaves the way a provider is allowed to behave.
     *
     * @param skipAtMost how many bytes skip will ever move, or 0 for never
     * @param refuseSkip true to have skip always answer 0, like a provider
     *                   streaming from somewhere that cannot seek
     */
    private static final class Awkward extends InputStream {
        private final byte[] data;
        private final int skipAtMost;
        private final boolean refuseSkip;
        private int at;

        Awkward(byte[] data, int skipAtMost, boolean refuseSkip) {
            this.data = data;
            this.skipAtMost = skipAtMost;
            this.refuseSkip = refuseSkip;
        }

        @Override
        public int read() {
            return at < data.length ? (data[at++] & 0xff) : -1;
        }

        @Override
        public int read(byte[] buffer, int off, int len) {
            if (at >= data.length) return -1;
            /* Short reads too, because a reader that assumes a full buffer is
               another way to get this wrong. */
            int count = Math.min(Math.min(len, 1024), data.length - at);
            System.arraycopy(data, at, buffer, off, count);
            at += count;
            return count;
        }

        @Override
        public long skip(long n) {
            if (refuseSkip || skipAtMost <= 0) return 0;
            long moved = Math.min(Math.min(n, skipAtMost), data.length - at);
            at += (int) moved;
            return moved;
        }
    }
}
