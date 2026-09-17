package com.tedsvoiceacademy.player;

import static androidx.test.espresso.intent.Intents.intended;
import static androidx.test.espresso.intent.Intents.intending;
import static androidx.test.espresso.intent.matcher.IntentMatchers.hasAction;
import static androidx.test.espresso.intent.matcher.IntentMatchers.hasCategories;
import static androidx.test.espresso.intent.matcher.IntentMatchers.hasType;
import static org.hamcrest.Matchers.allOf;
import static org.hamcrest.Matchers.hasItem;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;
import androidx.test.espresso.intent.rule.IntentsRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * "I couldn't open a song in my phone app."
 *
 * A song reaches an &lt;audio&gt; element on Android through SongStream, which
 * intercepts a made-up https://localhost/_song/... address, reads the
 * content:// URI behind it and answers HTTP range requests out of it. There is
 * nothing like that on a desktop, so the whole mechanism shipped unchecked.
 *
 * ONLY THE PICKER'S SCREEN IS STOOD IN FOR. Everything after the chooser is the
 * code that ships: Files.songsPicked, the persistable grant, describe()'s name
 * and size query through a real ContentResolver, the address the bridge and
 * SongStream must agree on, shouldInterceptRequest, Ranges.plan and the slice it
 * hands back. What is replaced is the one part a headless build runner cannot
 * supply, which is a person tapping a file.
 *
 * AND THE FIXTURE IS HONEST ABOUT ITSELF. A file handed over by this app's own
 * FileProvider always knows its size and its stream always skips. A song in
 * OneDrive may do neither, and those are exactly the cases RangesTest puts
 * through Ranges.plan on a plain JVM. This proves the wiring; that proves the
 * decisions. Neither of them is Microsoft's provider, and nothing here pretends
 * otherwise.
 */
@RunWith(AndroidJUnit4.class)
public class SongFromThePickerTest {

    @Rule
    public IntentsRule intents = new IntentsRule();

    @Test
    public void aSongOpensFromTheChooserAndItsLengthIsKnown() throws Exception {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File song = new File(app.getCacheDir(), "Shenandoah.mp3");
        copyAsset("song.mp3", song);

        /* Legal with no manifest change: the app already declares this
           FileProvider, and its file_paths.xml already opens the cache folder.
           The instrumentation runs in the app's own process and UID, so it can
           mint and read its own provider's addresses. */
        Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", song);

        Intent chosen = new Intent().setData(uri);
        chosen.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intending(hasAction(Intent.ACTION_OPEN_DOCUMENT))
            .respondWith(new Instrumentation.ActivityResult(Activity.RESULT_OK, chosen));

        Page page = Page.open();
        page.eval("document.querySelector('.tabs .tab[data-tab=\"songs\"]').click()");
        page.eval("document.getElementById('open').click()");

        /* THE CHOOSER WAS ASKED FOR, AND FOR THE RIGHT THING. A pickSongs that
           quietly stopped naming an audio type, or stopped saying the file has
           to be openable, would show a person a chooser with nothing in it —
           which looks exactly like "I couldn't open a song". */
        intended(allOf(
            hasAction(Intent.ACTION_OPEN_DOCUMENT),
            hasType("audio/*"),
            hasCategories(hasItem(Intent.CATEGORY_OPENABLE))));

        page.waitUntil("a song opens from the chooser",
            "document.getElementById('now-name').textContent !== 'NO SONG OPEN'",
            30_000, "document.getElementById('now-name').textContent");

        /* THE SYMPTOM ITSELF rather than a proxy for it. A stream whose length is
           never answered leaves the duration at Infinity: the clock sticks on
           0:00, the wave has nothing to scale against and the song will not
           play. */
        page.waitUntil("and its length is read",
            "document.getElementById('t-total').textContent !== '0:00'",
            30_000, "document.getElementById('t-total').textContent");
        assertEquals("The song is eight seconds long and the clock should say so.",
            "0:08", page.eval("document.getElementById('t-total').textContent"));

        /* AND THE BYTES REALLY ARE THE FILE'S. A clock can be right for the wrong
           reason. This asks SongStream for a window out of the middle and holds
           it against the same window of the whole file — the status, the
           Content-Range and the hundred bytes. No audio device is involved, so
           this is the part that cannot be flaky. */
        /* THE TRUTH, READ OFF THE DISK. Comparing the served window against a
           second fetch of the whole file only ever proves the two agree — and
           if the whole-file fetch is itself wrong, the check reports a fault in
           the app that is really a fault in the check. The test copied this file
           into place, so it can simply read bytes 1000-1099 out of it and hand
           those over as the answer. */
        String truth = hexOf(song, 1000, 100);

        String served = page.await(
            "(async function () {"
            + "  const truth = '" + truth + "';"
            + "  const songs = JSON.parse(localStorage.getItem('tva.songs') || '[]');"
            + "  const song = songs[songs.length - 1];"
            + "  const all = new Uint8Array(await (await fetch(song.url)).arrayBuffer());"
            + "  const grab = async function (from, to) {"
            + "    const r = await fetch(song.url, { headers: { Range: 'bytes=' + from + '-' + to } });"
            + "    return { status: r.status, range: r.headers.get('Content-Range'),"
            + "             bytes: new Uint8Array(await r.arrayBuffer()) };"
            + "  };"
            /* SAYS WHERE THE BYTES CAME FROM, not merely that they differ. A
               window served from the wrong offset and a window of rubbish are
               different faults with different fixes, and one emulator run costs
               fifteen minutes — so the run has to come back with the answer
               rather than with the question again. */
            + "  const whereFrom = function (got) {"
            + "    if (!got.length) return 'it is empty';"
            + "    for (let at = 0; at + got.length <= all.length; at++) {"
            + "      let hit = true;"
            + "      for (let i = 0; i < got.length && hit; i++) hit = all[at + i] === got[i];"
            + "      if (hit) return 'the file\\u0027s bytes from offset ' + at;"
            + "    }"
            + "    return 'bytes that are nowhere in the file';"
            + "  };"
            + "  const hex = function (got) {"
            + "    return [...got.slice(0, 8)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join(' ');"
            + "  };"
            + "  const mid = await grab(1000, 1099);"
            /* THE SAME QUESTION FROM BYTE ZERO. If the head matches and the
               middle does not, seeking is broken. If neither matches, the
               whole-file baseline this compares against is what is wrong, and
               the fault is in this check rather than in the app. */
            + "  const head = await grab(0, 99);"
            + "  const matches = function (got, from) {"
            + "    if (got.length !== 100) return false;"
            + "    for (let i = 0; i < 100; i++) if (got[i] !== all[from + i]) return false;"
            + "    return true;"
            + "  };"
            + "  const asHex = function (got) {"
            + "    return [...got].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');"
            + "  };"
            + "  const trueToTheFile = asHex(mid.bytes) === truth;"
            + "  return { name: song.name, total: all.length, trueToTheFile: trueToTheFile,"
            + "           status: mid.status, range: mid.range,"
            + "           sliced: mid.bytes.length, same: matches(mid.bytes, 1000),"
            + "           midWas: whereFrom(mid.bytes), midHex: hex(mid.bytes),"
            + "           wantedHex: hex(all.slice(1000, 1008)),"
            + "           headOk: matches(head.bytes, 0), headStatus: head.status,"
            + "           headWas: whereFrom(head.bytes), fileHeadHex: hex(all) };"
            + "})()");

        assertTrue("SongStream did not answer a range request with a 206: " + served,
            served.contains("\"status\":206"));
        assertTrue("The Content-Range header was wrong or missing: " + served,
            served.contains("\"range\":\"bytes 1000-1099/"));
        /* THE ASSERTION THAT MATTERS, and the one that decides whether this is the
           app's fault at all: the hundred bytes the app served are the hundred
           bytes that are really at offset 1000 in the file on disk. */
        assertTrue(
            "The app served the wrong hundred bytes for 'Range: bytes=1000-1099'. This is the "
            + "fault that stops a song seeking — the wave is drawn, the clock runs, and the "
            + "sound comes from the wrong place. midWas says where the served window really "
            + "came from. " + served,
            served.contains("\"trueToTheFile\":true"));

        assertTrue(
            "The bytes served for a range were not the file's bytes. midWas says where the "
            + "served window really came from; if headOk is true and same is false, seeking is "
            + "broken, and if headOk is false as well then the whole-file baseline this compares "
            + "against is what is wrong and the fault is in this check. " + served,
            served.contains("\"same\":true"));
        /* describe() asks the provider for a display name. Without it a song is
           listed as the tail of a URI, which is unreadable and was one of the
           things that made the phone app feel broken. */
        assertTrue("The song was listed by its address rather than its name: " + served,
            served.contains("\"name\":\"Shenandoah.mp3\""));

        page.eval("document.getElementById('play').click()");
        page.waitUntil("and it plays",
            "document.getElementById('t-now').textContent !== '0:00'",
            20_000, "document.getElementById('t-now').textContent");
    }

    /** A window of the real file, as hex, for the page to compare against. */
    private static String hexOf(File file, int from, int count) throws Exception {
        byte[] window = new byte[count];
        try (RandomAccessFile open = new RandomAccessFile(file, "r")) {
            open.seek(from);
            open.readFully(window);
        }
        StringBuilder hex = new StringBuilder(count * 2);
        for (byte b : window) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /** The eight-second song lives in the test app's own assets, not in git. */
    private void copyAsset(String name, File target) throws Exception {
        try (InputStream in = InstrumentationRegistry.getInstrumentation()
                .getContext().getAssets().open(name);
             OutputStream out = new FileOutputStream(target)) {
            byte[] lump = new byte[64 * 1024];
            for (int read = in.read(lump); read > 0; read = in.read(lump)) out.write(lump, 0, read);
        }
    }
}
