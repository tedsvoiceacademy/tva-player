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
import androidx.test.rule.GrantPermissionRule;
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

    /* THE NOTIFICATION PERMISSION, GRANTED SO NO DIALOG APPEARS MID-TEST.
       The app asks for it a couple of seconds after it opens — deliberately, so a
       person is not asked in the middle of the first song they play. Android's
       dialog would then sit over whatever this test is doing. Granting it here
       takes the dialog out of the way; it is not what this test is about. */
    @Rule
    public GrantPermissionRule notifications =
        GrantPermissionRule.grant("android.permission.POST_NOTIFICATIONS");

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
        assertEquals("The clock should say how long the song really is. Its length is"
            + " set in one place — see Page.SONG_SECONDS.",
            Page.songLength(), page.eval("document.getElementById('t-total').textContent"));

        /* describe() asks the provider for a display name. Without it a song is
           listed as the tail of a URI, which is unreadable and was one of the
           things that made the phone app feel broken. */
        /* CASE-INSENSITIVELY, because the lit readout shows a song's name in
           capitals the way a real piece of hardware does. Comparing letter for
           letter failed a build on SHENANDOAH.MP3 — which is the right name,
           correctly read from the provider, in the right place. */
        String shown = page.eval("document.getElementById('now-name').textContent");
        assertTrue("The song is listed by its address rather than its name: " + shown,
            shown.toLowerCase(java.util.Locale.ROOT).contains("shenandoah"));

        page.eval("document.getElementById('play').click()");
        page.waitUntil("and it plays",
            "document.getElementById('t-now').textContent !== '0:00'",
            20_000, "document.getElementById('t-now').textContent");

        /* AND IT SEEKS, which is the thing that really broke.
         *
         * THIS REPLACED A BYTE-FOR-BYTE PROBE, and the reason is worth keeping.
         * That probe fetched the song's address twice from JavaScript — once
         * whole, once with a Range header — and compared the two. It kept
         * disagreeing, SliceTest then proved on a plain JVM that the code
         * choosing those bytes is correct in every awkward case, and adding one
         * method to that class changed the probe's failure from "wrong bytes" to
         * "Failed to fetch". A change that alters whether the request succeeds at
         * all is the web view's own interception layer talking, not the app:
         * shouldInterceptRequest hands a stream back for a request, and partial
         * content through it is not something a page's fetch can lean on.
         *
         * So the check asks the question the way the app does. A media element
         * given a new position asks for the song from a new offset, and if the
         * wrong bytes come back the sound comes from the wrong place — which is
         * what Ted would hear. Byte-exactness is proved where it can be proved
         * properly, in SliceTest and RangesTest on a JVM.
         */
        page.eval("window.__tvaSeek(6)");
        page.waitUntil("and it seeks, so the song can be played from the middle",
            "document.getElementById('t-now').textContent === '0:06'"
            + " || document.getElementById('t-now').textContent === '0:07'",
            20_000, "document.getElementById('t-now').textContent");

        /* AND KEEPS GOING FROM THERE. A seek that lands and then stops dead is
           the shape of a range answer the element cannot use — it would look
           like a song that plays once and refuses to be moved. */
        String after = page.eval(
            "(function () { return document.getElementById('t-now').textContent"
            + " + ', and the transport says ' + document.getElementById('play').getAttribute('aria-label'); })()");
        page.waitUntil("and carries on playing from where it was put",
            "document.getElementById('t-now').textContent !== '0:06'",
            20_000, "'the clock stopped at ' + document.getElementById('t-now').textContent"
            + " + ' (it read " + after.replace("'", " ") + " just after the seek)'");
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
