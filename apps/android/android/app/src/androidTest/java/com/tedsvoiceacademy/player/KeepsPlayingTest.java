package com.tedsvoiceacademy.player;

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
import androidx.test.rule.GrantPermissionRule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

import static androidx.test.espresso.intent.Intents.intending;
import static androidx.test.espresso.intent.matcher.IntentMatchers.hasAction;

/**
 * "It only plays the first split second of the file and stops."
 *
 * THE FAULT THIS EXISTS FOR. The app used to request AUDIOFOCUS_GAIN from
 * PlaybackService every time the page said it was playing. The web view ALREADY
 * holds audio focus for the &lt;audio&gt; element it is playing, so that made a
 * second focus client inside one app, asking a fraction of a second after the
 * sound started — the time it takes the page to reach Playback.playing and the
 * service to start. One of the two has to lose: either the web view was told it
 * lost and paused its own element, or the service's listener fired and told the
 * page to pause. There was no AUDIOFOCUS_GAIN branch, so nothing ever undid it.
 *
 * AND IT ONLY STARTED WHEN A PERMISSION WAS GRANTED. Until then, Playback.playing
 * returned before ever starting the service, so no focus was ever taken and the
 * song played normally. Ted granted the notification permission mid-song — "There
 * was a pop up to allow something. i didn't read it" — and from that moment every
 * song stopped after a split second, for ever.
 *
 * So this test GRANTS THAT PERMISSION FIRST. Without it the service path never
 * runs and the test would prove nothing at all while looking green.
 *
 * TWO THINGS ARE MEASURED, because a song that stops has two causes that look
 * identical from outside:
 *
 *   1. That it is still playing six seconds later — what a person would notice.
 *   2. That no command arrived FROM THE PHONE. If the song stops and a "pause"
 *      arrived, the phone told it to; if it stops with none, the sound went away
 *      on its own. The failure says which, which is the difference between an
 *      afternoon and a week.
 *
 * And that the service takes no audio focus at all, which is a fact about the
 * app rather than about this phone — so it goes red wherever it is run, on a
 * build runner's emulator as readily as on Ted's handset.
 */
@RunWith(AndroidJUnit4.class)
public class KeepsPlayingTest {

    @Rule
    public IntentsRule intents = new IntentsRule();

    /* The permission whose granting is what broke it. Android 13 and later ask
       before an app may show a notification; below that it is granted already and
       this rule is harmless. */
    @Rule
    public GrantPermissionRule notifications =
        GrantPermissionRule.grant("android.permission.POST_NOTIFICATIONS");

    @Test
    public void aSongKeepsPlayingRatherThanStoppingAfterASplitSecond() throws Exception {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File song = new File(app.getCacheDir(), "Keeps Playing.mp3");
        copyAsset("song.mp3", song);
        Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", song);

        Intent chosen = new Intent().setData(uri);
        chosen.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intending(hasAction(Intent.ACTION_OPEN_DOCUMENT))
            .respondWith(new Instrumentation.ActivityResult(Activity.RESULT_OK, chosen));

        PlaybackService.focusRequests = 0;

        Page page = Page.open();
        page.eval("document.querySelector('.tabs .tab[data-tab=\"songs\"]').click()");
        page.eval("document.getElementById('open').click()");
        page.waitUntil("a song opens", "document.getElementById('now-name').textContent !== 'NO SONG OPEN'",
            30_000, "document.getElementById('now-name').textContent");
        page.waitUntil("and its length is read", "document.getElementById('t-total').textContent !== '0:00'",
            30_000, "document.getElementById('t-total').textContent");

        page.eval("window.__tvaNativeCommands.length = 0");
        page.eval("document.getElementById('play').click()");
        page.waitUntil("it starts playing", "window.__tvaPlayerState().playing",
            20_000, "JSON.stringify(window.__tvaPlayerState())");

        /* SIX SECONDS. The fault showed itself within one, and the song is eight
           seconds long, so this is long enough to catch it and short enough to
           leave the song running when it is over. */
        Page.sleep(6_000);

        String commands = page.eval("JSON.stringify(window.__tvaNativeCommands.map(c => c.action))");
        String state = page.eval("JSON.stringify(window.__tvaPlayerState())");

        assertTrue("The phone told the song to stop: " + commands + ". The player was " + state,
            !commands.contains("pause") && !commands.contains("stop"));
        assertTrue("The song stopped on its own within six seconds, with nothing from the phone. "
            + "The player was " + state,
            "true".equals(page.eval("window.__tvaPlayerState().playing")));
        assertTrue("The clock never moved past a second, so only the first moment of the song "
            + "was ever played. The player was " + state,
            Double.parseDouble(page.eval("String(window.__tvaPlayerState().elTime)")) > 1.0);

        /* AND THE APP TOOK NO AUDIO FOCUS. The service has no business taking it
           — the web view holds it for the element it is playing — and this is
           what makes the check bite on any phone rather than only on one that
           happens to reproduce the hand-off. */
        assertEquals("PlaybackService asked for audio focus, which is what took the sound away.",
            0, PlaybackService.focusRequests);
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
