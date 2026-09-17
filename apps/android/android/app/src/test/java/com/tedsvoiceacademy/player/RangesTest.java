package com.tedsvoiceacademy.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The song-serving decisions, put through the awkward cases.
 *
 * THIS IS THE ONLY PART OF THE ANDROID SIDE A BUILD RUNNER CAN CHECK, and it is
 * the part that went wrong: Ted picked a song out of OneDrive and it would not
 * load. Everything here runs on a plain JVM, so it runs on every build.
 */
public class RangesTest {

    private static final long SONG = 5_000_000L;

    @Test
    public void wholeFileWhenNothingIsAsked() {
        Ranges.Plan plan = Ranges.plan(null, SONG);
        assertEquals(200, plan.status);
        assertEquals(SONG, plan.contentLength);
        assertNull(plan.contentRange);
    }

    @Test
    public void aLengthIsAlwaysGivenWhenItIsKnown() {
        /* Without it a media element reports the song's duration as Infinity:
           the clock sticks at 0:00 and the waveform has nothing to scale to. */
        assertEquals(SONG, Ranges.plan(null, SONG).contentLength);
        assertEquals(SONG, Ranges.plan("bytes=0-", SONG).contentLength);
    }

    @Test
    public void openEndedRangeRunsToTheEnd() {
        Ranges.Plan plan = Ranges.plan("bytes=0-", SONG);
        assertEquals(206, plan.status);
        assertEquals(0, plan.start);
        assertEquals(SONG - 1, plan.end);
        assertEquals("bytes 0-4999999/5000000", plan.contentRange);
    }

    @Test
    public void seekingAsksFromTheMiddle() {
        Ranges.Plan plan = Ranges.plan("bytes=2500000-", SONG);
        assertEquals(206, plan.status);
        assertEquals(2_500_000L, plan.start);
        assertEquals(SONG - 1, plan.end);
        assertEquals(2_500_000L, plan.contentLength);
        assertTrue(plan.slices());
    }

    @Test
    public void aClosedRangeIsHonouredExactly() {
        Ranges.Plan plan = Ranges.plan("bytes=100-199", SONG);
        assertEquals(100, plan.start);
        assertEquals(199, plan.end);
        assertEquals(100, plan.contentLength);
    }

    @Test
    public void anEndPastTheFileIsBroughtBack() {
        Ranges.Plan plan = Ranges.plan("bytes=4999990-9999999", SONG);
        assertEquals(206, plan.status);
        assertEquals(SONG - 1, plan.end);
        assertEquals(10, plan.contentLength);
    }

    @Test
    public void theLastBytesMeanTheLastBytes() {
        /* "bytes=-500" is the TAIL of the file. Read the other way round it
           serves the head while claiming to be the tail, so a seek to the end
           plays the beginning. */
        Ranges.Plan plan = Ranges.plan("bytes=-500", SONG);
        assertEquals(206, plan.status);
        assertEquals(SONG - 500, plan.start);
        assertEquals(SONG - 1, plan.end);
        assertEquals(500, plan.contentLength);
    }

    @Test
    public void askingPastTheEndIsRefusedProperly() {
        Ranges.Plan plan = Ranges.plan("bytes=5000000-", SONG);
        assertEquals(416, plan.status);
        assertEquals("bytes */5000000", plan.contentRange);
    }

    @Test
    public void anUnknownLengthNeverAnswersPartial() {
        /* THE ONE THAT MATTERS. A file in OneDrive is not on the phone, and the
           provider may not say how big it is. A 206 without a valid
           Content-Range is a reply the browser cannot use — which is how a song
           that reads perfectly well refuses to open at all. */
        for (String header : new String[] { null, "bytes=0-", "bytes=2500000-", "bytes=-500", "bytes=0-99" }) {
            Ranges.Plan plan = Ranges.plan(header, -1);
            assertEquals("header " + header, 200, plan.status);
            assertNull("header " + header, plan.contentRange);
            assertEquals("header " + header, 0, plan.start);
            assertEquals("header " + header + " must stream from the start", false, plan.slices());
        }
    }

    @Test
    public void nonsenseIsAnsweredWithTheWholeFile() {
        for (String header : new String[] { "bytes=", "bytes=abc-def", "seconds=1-2", "bytes=x", "" }) {
            Ranges.Plan plan = Ranges.plan(header, SONG);
            assertEquals("header " + header, 200, plan.status);
            assertEquals("header " + header, SONG, plan.contentLength);
        }
    }

    @Test
    public void severalRangesAtOnceFallBackToTheWholeFile() {
        assertEquals(200, Ranges.plan("bytes=0-99,200-299", SONG).status);
    }

    @Test
    public void anEmptyFileIsNotAnError() {
        Ranges.Plan plan = Ranges.plan("bytes=0-", 0);
        assertEquals(200, plan.status);
        assertEquals(0, plan.contentLength);
    }

    @Test
    public void aFileBiggerThanTwoGigabytesStillWorks() {
        /* Capacitor's own range handling counts in int and overflows here. A
           forty-five minute lesson is not this big, but a WAV of a rehearsal
           can be, and silently serving the wrong bytes is the worst outcome. */
        long huge = 3L * 1024 * 1024 * 1024;
        Ranges.Plan plan = Ranges.plan("bytes=2147483648-", huge);
        assertEquals(206, plan.status);
        assertEquals(2147483648L, plan.start);
        assertEquals(huge - 1, plan.end);
    }

    @Test
    public void theTypeFollowsTheName() {
        assertEquals("audio/mpeg", Ranges.mimeForName("Shenandoah.mp3"));
        assertEquals("audio/mp4", Ranges.mimeForName("Danny Boy.M4A"));
        assertEquals("audio/wav", Ranges.mimeForName("take.wav"));
        assertEquals("audio/flac", Ranges.mimeForName("x.flac"));
    }
}
