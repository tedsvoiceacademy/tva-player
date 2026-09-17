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
        String served = page.await(
            "(async function () {"
            + "  const songs = JSON.parse(localStorage.getItem('tva.songs') || '[]');"
            + "  const song = songs[songs.length - 1];"
            + "  const all = new Uint8Array(await (await fetch(song.url)).arrayBuffer());"
            + "  const r = await fetch(song.url, { headers: { Range: 'bytes=1000-1099' } });"
            + "  const got = new Uint8Array(await r.arrayBuffer());"
            + "  let same = got.length === 100;"
            + "  for (let i = 0; i < got.length && same; i++) same = got[i] === all[1000 + i];"
            + "  return { name: song.name, status: r.status, range: r.headers.get('Content-Range'),"
            + "           total: all.length, sliced: got.length, same: same };"
            + "})()");

        assertTrue("SongStream did not answer a range request with a 206: " + served,
            served.contains("\"status\":206"));
        assertTrue("The Content-Range header was wrong or missing: " + served,
            served.contains("\"range\":\"bytes 1000-1099/"));
        assertTrue("The bytes served for a range were not the file's bytes: " + served,
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
