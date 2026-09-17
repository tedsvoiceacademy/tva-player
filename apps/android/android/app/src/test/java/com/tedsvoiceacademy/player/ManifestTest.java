package com.tedsvoiceacademy.player;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import org.junit.Test;

/**
 * The manifest says what the app is allowed to ask Android for, and one missing
 * line there is why recording never worked on Ted's phone.
 *
 * WHAT HAPPENED. When the page asks for a microphone, Capacitor does not ask
 * Android for RECORD_AUDIO on its own — it asks for RECORD_AUDIO and
 * MODIFY_AUDIO_SETTINGS together, and hands the page the microphone only if
 * every one of them comes back granted. A permission the manifest does not
 * declare is refused on the spot, without a dialog and without a message. So
 * with MODIFY_AUDIO_SETTINGS left out, the app asked politely, Android said no
 * to a permission nobody had heard of, and the Record button did nothing at
 * all. It looked like a broken recorder.
 *
 * WHY THIS TEST EXISTS RATHER THAN ONLY THE EMULATOR ONE. The instrumented test
 * proves the whole path but takes an emulator and ten minutes. This reads a
 * file and takes no time, so the answer arrives with the rest of the build —
 * and it names the reason, which is the part that took a day to find.
 *
 * Gradle runs unit tests with the module folder as the working directory, so
 * the manifest is simply there to be read. No Android, nothing mocked.
 */
public class ManifestTest {

    private String manifest() throws IOException {
        Path path = Paths.get("src/main/AndroidManifest.xml");
        if (!Files.exists(path)) {
            /* Run from somewhere else — say so rather than passing by accident. */
            fail("Could not find src/main/AndroidManifest.xml from " + Paths.get("").toAbsolutePath());
        }
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    /* The full attribute, quote and all. A comment in the manifest explaining
       why WAKE_LOCK is there would otherwise satisfy a check for WAKE_LOCK, and
       a test that a comment can satisfy is not a test. */
    private static String declaration(String permission) {
        return "android:name=\"android.permission." + permission + "\"";
    }

    private void declares(String permission, String why) throws IOException {
        assertTrue(why, manifest().contains(declaration(permission)));
    }

    @Test
    public void bothMicrophonePermissionsAreDeclared() throws IOException {
        declares("RECORD_AUDIO",
            "The app cannot record without RECORD_AUDIO.");
        declares("MODIFY_AUDIO_SETTINGS",
            "MODIFY_AUDIO_SETTINGS is missing. Capacitor asks Android for it AND for "
            + "RECORD_AUDIO together when the page wants a microphone, and gives the page "
            + "nothing unless both come back granted. Undeclared means refused, so leaving "
            + "this out denies the microphone every time, silently. Both, or neither works.");
    }

    @Test
    public void playingOnWithTheScreenOffIsStillDeclared() throws IOException {
        /* The same shape of fault waiting to happen: a foreground service that
           is started without its permission declared is refused, and the song
           stops the moment the screen goes off. */
        declares("FOREGROUND_SERVICE",
            "A media foreground service cannot start without FOREGROUND_SERVICE.");
        declares("FOREGROUND_SERVICE_MEDIA_PLAYBACK",
            "Android 14 and later refuse a mediaPlayback foreground service unless "
            + "FOREGROUND_SERVICE_MEDIA_PLAYBACK is declared too.");
        declares("WAKE_LOCK",
            "Without WAKE_LOCK the processor sleeps and playback stops with the screen.");
    }

    @Test
    public void theServiceIsTypedForMediaPlayback() throws IOException {
        assertTrue(
            "PlaybackService must be declared with foregroundServiceType=\"mediaPlayback\", "
            + "or Android refuses to start it and playback dies with the screen.",
            manifest().contains("android:foregroundServiceType=\"mediaPlayback\""));
    }

    @Test
    public void theAppDoesNotAskForTheWholeOfSomebodysStorage() throws IOException {
        /* A player that reads one song through the picker has no business asking
           for every file on the phone, and asking would be the sort of thing a
           person notices and holds against the app. */
        String manifest = manifest();
        for (String greedy : new String[] {
            "READ_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE", "READ_MEDIA_AUDIO",
        }) {
            assertTrue(
                "The manifest asks for " + greedy + ". Songs are opened through Android's own "
                + "picker, which grants this app one file at a time and needs no such "
                + "permission.",
                !manifest.contains(declaration(greedy)));
        }
    }
}
