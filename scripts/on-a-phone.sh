#!/usr/bin/env bash
#
# THE APP, DRIVEN ON A RUNNING EMULATOR.
#
# Called from the `phone` job in .github/workflows/ci.yml, from inside
# reactivecircus/android-emulator-runner, so a phone is already booted and `adb`
# is already talking to it. It lives in a file rather than inside the YAML
# because it is a real script with real reasoning in it, and reasoning buried in
# a YAML string is reasoning nobody reads.
#
# It does three things: give the web view a microphone, run the checks, and then
# put the original faults back and require every check to go red.
set -euo pipefail

APP=com.tedsvoiceacademy.player
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE/apps/android/android"

# ---------------------------------------------------------------------------
# A MICROPHONE THAT IS NOT A MICROPHONE
#
# A build runner has no sound card, so Chromium is told to supply a fake capture
# device instead. Two details, both of which cost a round to learn if they are
# missed:
#
#   * The leading "_" is not decoration. A web view ignores the first token as
#     argv[0], so without it the first real flag is silently eaten.
#   * The flags are read when the web view starts, so the app must not already
#     be running when they are written.
#
# --use-fake-ui-for-media-stream IS DELIBERATELY ABSENT. That switch puts a fake
# permission proxy in place of the one that calls the app's own WebChromeClient
# — so Capacitor's permission code would never run, MODIFY_AUDIO_SETTINGS would
# never be asked for, and the very fault the recording check exists for would
# become invisible while the check stayed green forever. The control run at the
# bottom is what proves nobody has quietly added it back.
# ---------------------------------------------------------------------------
adb shell "echo '_ --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required' > /data/local/tmp/webview-command-line"
adb shell chmod 644 /data/local/tmp/webview-command-line
echo "web view flags: $(adb shell cat /data/local/tmp/webview-command-line)"

# :app: AND NOT THE WHOLE PROJECT. Unqualified, Gradle builds the androidTest
# variant of every module, and the Cordova plugins module — which holds no tests
# at all — fails on duplicate Kotlin standard library classes before anything is
# installed. The tests are in :app, so :app is what is asked for.
./gradlew --no-daemon :app:installDebug :app:installDebugAndroidTest
adb shell am force-stop "$APP"

echo
echo "=== the app, on a phone ==="
./gradlew --no-daemon :app:connectedDebugAndroidTest

# ---------------------------------------------------------------------------
# AND PROVE THOSE CHECKS CAN FAIL.
#
# A harness that cannot fail is not evidence. Each of the three faults Ted
# actually hit is put back, and the check that is supposed to catch it is
# required to go red. The emulator is already up, which is the expensive part,
# so this costs a rebuild and three runs.
# ---------------------------------------------------------------------------
echo
echo "=== putting the faults back ==="

# 0. THE APP TAKING AUDIO FOCUS AWAY FROM ITS OWN WEB VIEW.
#
#    This is the fault that gave Ted a split second of sound and then silence on
#    every song: the service asked for AUDIOFOCUS_GAIN a moment after playback
#    started, and the web view already held focus for the element it was playing.
#    Whichever of the two lost, the song stopped, and there was no
#    AUDIOFOCUS_GAIN branch to undo it.
#
#    IT IS PUT BACK IN FULL rather than as a flag, so the check is being asked
#    the same question Ted's phone asked. The check counts focus requests as well
#    as watching the song, which is what makes it bite on a build runner's
#    emulator and not only on a handset that happens to reproduce the hand-off.
python3 - <<'PUTITBACK'
p = 'app/src/main/java/com/tedsvoiceacademy/player/PlaybackService.java'
s = open(p, encoding='utf-8').read()
s = s.replace("        if (playing) {\n            if (!awake.isHeld())",
              "        if (playing) {\n            takeFocus();\n            if (!awake.isHeld())")
s = s.replace("    @Override\n    public void onDestroy() {", '''    private android.media.AudioFocusRequest focus;

    private void takeFocus() {
        focusRequests++;
        android.media.AudioManager audio =
            (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (focus == null) {
            focus = new android.media.AudioFocusRequest.Builder(
                    android.media.AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
                .setOnAudioFocusChangeListener((change) -> {
                    if (change == android.media.AudioManager.AUDIOFOCUS_LOSS
                        || change == android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) say("pause");
                })
                .build();
        }
        audio.requestAudioFocus(focus);
    }

    @Override
    public void onDestroy() {''', 1)
open(p, 'w', encoding='utf-8').write(s)
PUTITBACK

# 1. The microphone permission Capacitor asks for alongside RECORD_AUDIO.
sed -i '/uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/d' \
  app/src/main/AndroidManifest.xml

# 2. Refusing every request for the song's bytes.
#
#    THIS WAS A WEAKER MUTATION UNTIL A BUILD SAID SO. It used to serve the song
#    without ever stating its length, on the reasoning that a media element then
#    reports the duration as Infinity and the clock sticks on 0:00 -- which is
#    true of a long song from a slow provider. The check went green anyway,
#    because an eight-second file downloads in a moment and the element works the
#    length out for itself once it has the lot. A control that does not bite is
#    worth nothing, so this refuses the bytes outright: the song cannot open, and
#    a check that claims a song opened has to notice.
#
#    What this control proves is that the check really drives the app's own
#    song-serving path. Whether the RIGHT bytes come back is proved properly
#    elsewhere -- SliceTest and RangesTest, twenty-two cases on a plain JVM, with
#    their own controls.
sed -i 's|    public static Plan plan(String rangeHeader, long total) {|    public static Plan plan(String rangeHeader, long total) {\n        if (true) return new Plan(416, 0, -1, "bytes */" + total, -1);|' \
  app/src/main/java/com/tedsvoiceacademy/player/Ranges.java

# 3. The phone layout, removed — the same mutation phone-harness.mjs uses for
#    its own control.
echo '/* control: the phone layout removed */' > app/src/main/assets/public/ui/phone.css

bad=0
expect_red () {
  local what="$1" test_class="$2"
  if ./gradlew --no-daemon :app:connectedDebugAndroidTest \
       -Pandroid.testInstrumentationRunnerArguments.class="com.tedsvoiceacademy.player.$test_class" \
       > /dev/null 2>&1; then
    echo "FAIL  $what still passed with its fault put back — it is measuring nothing"
    bad=1
  else
    echo "ok    $what went red, as it must"
  fi
}

expect_red "keeping a song playing"         KeepsPlayingTest
expect_red "recording"                      RecordingTest
expect_red "opening a song from a content:// URI" SongFromThePickerTest
expect_red "the layout at Android's larger text"  BigTextTest

git checkout -- app/src/main/AndroidManifest.xml \
  app/src/main/java/com/tedsvoiceacademy/player/Ranges.java \
  app/src/main/java/com/tedsvoiceacademy/player/PlaybackService.java
# phone.css is not in git here — it is built into the assets folder — so it is
# put back the way it was made.
(cd "$HERE" && node scripts/build-android.mjs > /dev/null && cd apps/android && npx cap sync android > /dev/null)

[ "$bad" = "0" ]
echo
echo "the checks measured something, and the app passed them."
