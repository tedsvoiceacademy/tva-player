package com.tedsvoiceacademy.player;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * What the page says to the phone about what it is playing.
 *
 * Three calls, and one event going the other way. The page already knows when
 * it starts, pauses and stops — those are the moments it tells the phone about,
 * and the phone answers by leaving the page running with the screen off and by
 * putting the song on the lock screen.
 */
@CapacitorPlugin(
    name = "Playback",
    permissions = {
        /* Android 13 and later ask before an app may show a notification, and
           the notification is not decoration here: it is the thing that makes
           the service a FOREGROUND one. Refused, the song still plays while the
           app is on screen and stops when it is not. */
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class Playback extends Plugin {

    @Override
    public void load() {
        PlaybackService.listener = (action) -> {
            JSObject event = new JSObject();
            event.put("action", action);
            notifyListeners("command", event);
        };
    }

    /** Playing, and what. Safe to call repeatedly — it updates rather than restarts.
     *
     * IT ASKS FOR NOTHING. This used to request the notification permission from
     * right here, which put Android's dialog on the screen in the middle of the
     * first song a person ever played — Ted's words: "There was a pop up to
     * allow something. i didn't read it but assumed it was microphone." A person
     * cannot answer a question they were not expecting in the middle of
     * something else, and an app should not ask one there. The page asks at
     * start-up instead, in its own words first: see askAboutNotifications. */
    @PluginMethod
    public void playing(PluginCall call) {
        send(call, true);
        call.resolve(new JSObject().put("canKeepPlaying", allowed()));
    }

    /** Ask Android for the notification permission, on purpose and at a moment
     *  of the page's choosing. Answered either way — the song plays regardless;
     *  what the permission buys is the song carrying on with the screen off. */
    @PluginMethod
    public void askAboutNotifications(PluginCall call) {
        if (allowed()) {
            call.resolve(new JSObject().put("canKeepPlaying", true));
            return;
        }
        requestPermissionForAlias("notifications", call, "afterNotificationPermission");
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        call.resolve(new JSObject().put("canKeepPlaying", allowed()));
    }

    private boolean allowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED;
    }

    @PluginMethod
    public void paused(PluginCall call) {
        send(call, false);
        call.resolve();
    }

    @PluginMethod
    public void stopped(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PlaybackService.class));
        call.resolve();
    }

    @PluginMethod
    public void canKeepPlaying(PluginCall call) {
        call.resolve(new JSObject().put("canKeepPlaying", allowed()));
    }

    private void send(PluginCall call, boolean playing) {
        Intent intent = new Intent(getContext(), PlaybackService.class);
        intent.putExtra("playing", playing);
        intent.putExtra("title", call.getString("title", "TVA Player"));
        intent.putExtra("positionMs", (long) (call.getDouble("positionSec", 0d) * 1000));
        intent.putExtra("durationMs", (long) (call.getDouble("durationSec", -0.001d) * 1000));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }
}
