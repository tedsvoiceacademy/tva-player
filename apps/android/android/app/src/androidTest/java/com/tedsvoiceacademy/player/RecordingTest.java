package com.tedsvoiceacademy.player;

import static org.junit.Assert.assertTrue;

import android.Manifest;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.GrantPermissionRule;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * "I just tried to record on the app and I can't do that yet either."
 *
 * WHY THIS COULD NOT BE CAUGHT BEFORE. Recording never worked on the phone and
 * every check was green, because every check was Chromium on a desktop, where a
 * microphone is handed over without Android's permission system being involved
 * at all. The fault was one missing line in the manifest: Capacitor's
 * BridgeWebChromeClient.onPermissionRequest asks Android for RECORD_AUDIO *and*
 * MODIFY_AUDIO_SETTINGS together and hands the page a microphone only if every
 * one of them comes back granted — and a permission that is not declared is
 * refused before anybody is asked. So the app asked politely, Android said no
 * to a permission nobody had heard of, and the red button lit up over nothing.
 */
@RunWith(AndroidJUnit4.class)
public class RecordingTest {

    /* RECORD_AUDIO AND NOTHING ELSE, on purpose, and this is the crux of the
       whole test.
       MODIFY_AUDIO_SETTINGS is a NORMAL permission: it cannot be granted at
       runtime at all, and `pm grant` refuses it. It is granted when the app is
       installed if — and only if — the manifest declares it. So granting
       RECORD_AUDIO here removes the one thing an emulator genuinely cannot do,
       which is tap Allow, and leaves the fault entirely in place. Take the
       MODIFY_AUDIO_SETTINGS line out of the manifest and Capacitor still asks
       for it, Android still refuses it, and this test still goes red. That is
       the negative control, and the build runs it.
       What it costs, said plainly: this does not prove that a person tapping
       Allow ends up with a working microphone. Nothing here taps anything. */
    @Rule
    public GrantPermissionRule mic = GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO);

    @Test
    public void aTakeHoldsTheSoundThatWasSung() {
        Page page = Page.open();

        /* IS THERE A MICROPHONE TO OPEN AT ALL? If the web view never read its
           command-line file there is no fake capture device, getUserMedia fails,
           and this test would report the app broken when the harness is the
           thing that is broken. Told apart here, before anything is blamed on
           the app. */
        String inputs = page.await(
            "navigator.mediaDevices.enumerateDevices()"
            + ".then(function (d) { return d.filter(function (x) { return x.kind === 'audioinput'; }).length; })");
        assertTrue(
            "The emulator was never given a fake microphone, so this is the harness and not "
            + "the app. Check that /data/local/tmp/webview-command-line was written with its "
            + "leading underscore, that the app was force-stopped afterwards, and that the "
            + "system image is google_apis (a userdebug build) rather than google_apis_playstore. "
            + "Got: " + inputs,
            Page.valueOf(inputs, "value") >= 1);

        page.eval("document.querySelector('.tabs .tab[data-tab=\"loop\"]').click()");
        page.eval("document.getElementById('rec-new').click()");
        page.waitUntil("the microphone opens and a take starts",
            "document.getElementById('lamp-rec').classList.contains('lit')",
            45_000, "JSON.stringify(window.__tvaMicState())");

        Page.sleep(3_500);
        page.eval("document.getElementById('rec-new').click()");
        page.waitUntil("and the take closes",
            "!document.getElementById('lamp-rec').classList.contains('lit')",
            30_000, "JSON.stringify(window.__tvaMicState())");

        /* A SECOND WITNESS that the permission really was granted rather than
           worked around: a browser leaves device labels empty until a page has
           actually been handed a microphone once. */
        String labelled = page.await(
            "navigator.mediaDevices.enumerateDevices().then(function (d) {"
            + " return d.some(function (x) { return x.kind === 'audioinput' && x.label.length > 0; }); })");
        assertTrue("The page was never really handed a microphone: " + labelled,
            labelled.contains("\"value\":true"));

        String take = page.await(
            "(async function () {"
            + "  const list = await window.tva.listRecordings();"
            + "  if (!list.length) return { seconds: 0, peak: 0, loud: 0, takes: 0 };"
            + "  const bytes = await (await fetch(list[list.length - 1].url)).arrayBuffer();"
            /* The sample rate is in the WAV header this app wrote, and an
               OfflineAudioContext has to be built at a rate before it will
               decode anything. */
            + "  const rate = new DataView(bytes).getUint32(24, true);"
            + "  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate });"
            + "  const buf = await ctx.decodeAudioData(bytes);"
            + "  const d = buf.getChannelData(0);"
            + "  let peak = 0, loud = 0;"
            + "  for (let i = 0; i < d.length; i++) {"
            + "    const a = Math.abs(d[i]); if (a > peak) peak = a; if (a > 0.01) loud++;"
            + "  }"
            + "  return { seconds: buf.duration, peak: peak, loud: loud / d.length, takes: list.length };"
            + "})()");

        assertTrue("No take was written at all: " + take, Page.valueOf(take, "takes") >= 1);
        /* NOT SILENCE, and not one stray click either. Chromium's fake capture
           device beeps rather than holding a steady tone, so the peak is what
           proves sound arrived and the loud fraction is what proves the file is
           not otherwise dead. */
        assertTrue("The take holds no sound — something between the microphone and the file "
            + "is broken: " + take, Page.valueOf(take, "peak") > 0.05);
        assertTrue("The take is almost entirely silence: " + take,
            Page.valueOf(take, "loud") > 0.01);
        assertTrue("The take is far shorter than the time it spent recording: " + take,
            Page.valueOf(take, "seconds") > 2.0);
    }
}
