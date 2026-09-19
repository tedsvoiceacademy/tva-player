package com.tedsvoiceacademy.player;

import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.os.ParcelFileDescriptor;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.GrantPermissionRule;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import org.junit.AfterClass;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * "The app opens but I can't scroll down to get to the place to add a song."
 *
 * Android's own Font size and Display size settings change the effective text
 * size inside a web view, and plenty of people turn them up. The layout was
 * built and checked at one size with one text size, and at anything larger the
 * panel under the case was twelve pixels tall on a small screen — the Loop panel
 * was reachable and nothing past it.
 *
 * scripts/phone-harness.mjs approximates this by setting a CSS font size in
 * desktop Chromium, which is the right shape and the wrong thing. This is the
 * setting itself, on a real web view.
 *
 * ONE MEASUREMENT, SHARED. window.__tvaReach lives in the renderer beside the
 * app's other hooks and both checks call it, so the browser check and this one
 * cannot drift into disagreeing about what "reachable" means.
 */
@RunWith(AndroidJUnit4.class)
public class BigTextTest {

    /* THE NOTIFICATION PERMISSION, GRANTED SO NO DIALOG APPEARS MID-TEST.
       The app asks for it a couple of seconds after it opens — deliberately, so a
       person is not asked in the middle of the first song they play. Android's
       dialog would then sit over whatever this test is doing. Granting it here
       takes the dialog out of the way; it is not what this test is about. */
    @Rule
    public GrantPermissionRule notifications =
        GrantPermissionRule.grant("android.permission.POST_NOTIFICATIONS");

    /**
     * Sets Android's own text size and opens the app fresh at it.
     *
     * The activity has to be built again for this to take: a web view takes its
     * text zoom from the configuration it was created in, and MainActivity does
     * not list fontScale among the changes it handles itself.
     *
     * AND NOT WITH `am force-stop`, which is the obvious way to do it and the
     * reason the first build of this job died. An instrumented test runs inside
     * the process of the app it is testing, so force-stopping that package kills
     * the test runner too — the run reported "Process crashed" and two of the
     * three tests never ran. Page.finishAndWait closes the window and leaves the
     * process alone.
     */
    private static Page reopenAtTextScale(String scale) {
        shell("settings put system font_scale " + scale);
        Page.finishAndWait();
        return Page.open();
    }

    @Test
    public void everyTabCanBeScrolledToItsEndAtAndroidsLargerText() {
        /* TWO PASSES, and the first one exists only to be compared against. A
           font scale that silently failed to apply would leave every assertion
           below passing while measuring nothing at all, which is the most
           expensive kind of green there is. */
        double plain = size(reopenAtTextScale("1.0").eval("document.documentElement.scrollHeight"));

        Page page = reopenAtTextScale("1.30");
        double big = size(page.eval("document.documentElement.scrollHeight"));
        assertTrue(
            "Android's font scale never reached the web view — the page is " + big
            + " pixels tall at 1.3x where it was " + plain + " at 1.0x. Nothing below this "
            + "line would have been measuring anything.",
            big > plain * 1.05);

        List<String> tabs = new ArrayList<>();
        String names = page.eval(
            "[...document.querySelectorAll('.tabs .tab')].map(function (t) { return t.dataset.tab; }).join(',')");
        for (String name : names.split(",")) {
            if (!name.trim().isEmpty()) tabs.add(name.trim());
        }

        String worst = null;
        int checked = 0;
        for (String tab : tabs) {
            page.eval("(function () { const t = document.querySelector('.tabs .tab[data-tab=\"" + tab + "\"]');"
                + " if (t) { t.scrollIntoView(); t.click(); } })()");
            Page.sleep(250);
            String reach = page.eval("JSON.stringify(window.__tvaReach('" + tab + "'))");
            if (reach.isEmpty() || "null".equals(reach)) continue;
            checked++;
            boolean fits = Page.valueOf(reach, "lastBottom") <= Page.valueOf(reach, "floor") + 1;
            boolean sideways = reach.contains("\"sideways\":true");
            boolean barOnScreen = reach.contains("\"tabOnScreen\":true");
            if ((!fits || sideways || !barOnScreen) && worst == null) worst = tab + ": " + reach;
        }

        /* COUNTED AS WELL AS MEASURED. A probe that found no tabs would otherwise
           pass on an empty set, which is worse than having no check. */
        assertTrue("Only " + checked + " tabs could be opened to measure at all, out of "
            + tabs.size() + " named in the bar.", checked >= 5);
        assertNull(
            "A tab cannot be scrolled to its end at Android's larger text size — this is the "
            + "fault Ted hit. lastBottom is where the last thing in the panel ends and floor is "
            + "the top of the tab bar, so lastBottom past floor means it is behind the bar. "
            + worst,
            worst);
    }

    /** Put the phone back, whatever happened, so the next test starts level. */
    @AfterClass
    public static void putThePhoneBack() {
        shell("settings put system font_scale 1.0");
    }

    private static double size(String text) {
        try {
            return Double.parseDouble(text.trim());
        } catch (RuntimeException notANumber) {
            return -1;
        }
    }

    /**
     * A shell command, drained.
     *
     * The stream HAS to be read: an undrained pipe leaves the command half-run
     * and the setting half-applied, which is a very quiet way for this whole
     * test to become meaningless.
     */
    private static void shell(String command) {
        UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        try (ParcelFileDescriptor pipe = automation.executeShellCommand(command);
             InputStream in = new FileInputStream(pipe.getFileDescriptor())) {
            byte[] lump = new byte[4096];
            while (in.read(lump) > 0) { /* drained, not wanted */ }
        } catch (Exception failed) {
            throw new AssertionError("could not run: " + command, failed);
        }
        /* A font scale change tears the activity down and builds it again, which
           takes a moment to settle. */
        Page.sleep(1200);
    }
}
