package com.tedsvoiceacademy.player;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * One window of a stream: skip to the start, stop after the length.
 *
 * NO ANDROID IN THIS FILE ON PURPOSE, for exactly the reason Ranges has none.
 * Ranges decides WHICH bytes to promise; this decides which bytes actually go
 * out, and the second half is where a wrong answer is audible — a song that
 * seeks to the chorus and plays the verse, or one that will not open at all.
 * It lived inside SongStream until the emulator check caught a range answer
 * whose bytes were not the file's, and being unreachable from a plain JVM was
 * the reason that could not be settled without a fifteen-minute build.
 *
 * THE SKIPPING IS THE WHOLE JOB. InputStream.skip is allowed to skip fewer
 * bytes than it was asked for, and allowed to skip none at all, without saying
 * anything is wrong — so it has to be called in a loop, and a stream that will
 * never skip has to be read forward instead. A provider that hands a song over
 * from OneDrive or Drive is exactly the sort that does the awkward thing.
 */
final class Slice extends FilterInputStream {

    private long left;

    /**
     * @param in     the whole stream, positioned at its beginning
     * @param start  the first byte wanted
     * @param length how many bytes to hand over, or Long.MAX_VALUE for the rest
     */
    Slice(InputStream in, long start, long length) throws IOException {
        super(in);
        long skipped = 0;
        while (skipped < start) {
            long n = in.skip(start - skipped);
            if (n <= 0) {
                /* A stream that will not skip. Reading forward is slower but it
                   is the difference between a song that seeks and a song that
                   refuses to. */
                if (in.read() < 0) break;
                skipped++;
            } else {
                skipped += n;
            }
        }
        this.left = length;
    }

    @Override
    public int read() throws IOException {
        if (left <= 0) return -1;
        int b = super.read();
        if (b >= 0) left--;
        return b;
    }

    @Override
    public int read(byte[] buffer, int at, int length) throws IOException {
        if (left <= 0) return -1;
        int read = super.read(buffer, at, (int) Math.min(length, left));
        if (read > 0) left -= read;
        return read;
    }

    /* available() is inherited from FilterInputStream and would report the
       WHOLE rest of the stream rather than what is left of this window. A
       reader that trusts it reads past the end of the window. */
    @Override
    public int available() throws IOException {
        return (int) Math.min(super.available(), Math.max(0, left));
    }
}
