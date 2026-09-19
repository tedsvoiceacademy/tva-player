package com.tedsvoiceacademy.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.session.MediaButtonReceiver;

/**
 * Keeping the song playing when the screen goes off.
 *
 * WHY ANYTHING IS NEEDED AT ALL. The player is a page, and Android is entitled
 * to freeze a page whose app is not on the screen — so pressing the power button
 * mid-practice stopped the song. A phone only leaves audio alone for an app it
 * can see is playing something, and "can see" means three specific things:
 *
 *   1. A FOREGROUND SERVICE, typed mediaPlayback. Without it the process is
 *      merely backgrounded and may be frozen or reclaimed at any moment.
 *   2. A WAKE LOCK on the CPU, so a long practice session survives the screen
 *      going off.
 *   3. A MEDIA SESSION. This is what puts the song on the lock screen, gives the
 *      pause button on the headphones something to talk to, and — later — is
 *      what Android Auto browses. Doing it now is not a detour.
 *
 * IT PLAYS NOTHING ITSELF. The sound is still made by the page, because that is
 * where the speed and key engine, the pan and the loops live. This service is
 * the standing the app needs for the phone to leave that page running, and the
 * controls that reach it from outside.
 *
 * AND IT DELIBERATELY DOES NOT TAKE AUDIO FOCUS. Do not add it back.
 *
 * This service used to request AUDIOFOCUS_GAIN every time the page said it was
 * playing. The web view ALREADY holds focus for the <audio> element it is
 * playing, so that made a second focus client inside one app, asking a fraction
 * of a second after the sound started — the time it takes the page to reach
 * Playback.playing and this service to start. One of the two has to lose. Either
 * the web view was told it lost and paused its own element, or this service's
 * listener fired and told the page to pause. There was no AUDIOFOCUS_GAIN
 * branch, so nothing ever undid it.
 *
 * Ted got a split second of sound and then silence, on every song, for ever:
 * "it only plays the first split second of the file and stops. Opened a
 * different song and it wouldn't play more than the split second right out of
 * the chute." It began the moment he granted the notification permission,
 * because until then Playback.playing returned before ever starting this
 * service — see the comment there.
 *
 * The web view's own media stack handles focus correctly for the element it
 * owns, a telephone call included. Nothing here needs focus: the foreground
 * type, the wake lock and the session do the work. focusRequests below exists
 * only so a check can prove none is taken.
 */
public class PlaybackService extends Service {

    public static final String ACTION_SHOW = "com.tedsvoiceacademy.player.SHOW";
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION = 1;

    /* Static so the plugin can reach the live session without binding. One
       service, one session, one page: there is never a second of any of them. */
    static MediaSessionCompat session;
    static Listener listener;

    public interface Listener {
        void onCommand(String action);
    }

    private PowerManager.WakeLock awake;

    /* Counted, not taken. A check reads this and requires it to stay at zero;
       putting the focus request back turns that check red on any phone. */
    static int focusRequests = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureSession();

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        /* The CPU, not the screen. A practice app that held the screen on would
           flatten the battery and is not what was asked for. */
        awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TVAPlayer:playing");
        awake.setReferenceCounted(false);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null
            && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL, "Playing", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while a song is playing, so the phone leaves it alone.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
    }

    /* The session is static, and onDestroy clears it. A stopService racing a
       startForegroundService therefore used to leave onStartCommand reading a
       null one. Built here rather than only in onCreate so either can ask. */
    private void ensureSession() {
        if (session != null) return;
        session = new MediaSessionCompat(this, "TVAPlayer");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { say("play"); }
            @Override public void onPause() { say("pause"); }
            @Override public void onStop() { say("stop"); }
            @Override public void onSkipToNext() { say("next"); }
            @Override public void onSkipToPrevious() { say("previous"); }
            @Override public void onSeekTo(long ms) { say("seek:" + ms); }
        });
        session.setActive(true);
    }

    private void say(String action) {
        if (listener != null) listener.onCommand(action);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureSession();                        // a stopService may have raced a start
        MediaButtonReceiver.handleIntent(session, intent);
        String title = intent != null ? intent.getStringExtra("title") : null;
        /* A NULL INTENT MEANS ANDROID RESTARTED THE SERVICE, not that a song is
           playing. START_STICKY hands one back after the process is reclaimed,
           and defaulting to true had the phone showing "Playing" and holding a
           wake lock with nothing playing at all. */
        boolean playing = intent != null && intent.getBooleanExtra("playing", true);

        /* startForeground has to be called promptly after the service starts, or
           Android kills the app with a ForegroundServiceDidNotStartInTimeException
           — so it happens here, on every start, before anything else. */
        startForeground(NOTIFICATION, notification(title, playing));

        /* WHAT THE LOCK SCREEN READS. The notification's own title is not what
           the lock screen and the car show — they read the session's metadata,
           and without it the song appears there as nothing at all. */
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE,
                title == null || title.isEmpty() ? "TVA Player" : title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "TVA Player")
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION,
                intent != null ? intent.getLongExtra("durationMs", -1) : -1)
            .build());

        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_STOP
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SEEK_TO)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                intent != null ? intent.getLongExtra("positionMs", 0) : 0,
                playing ? 1f : 0f)
            .build());

        if (playing) {
            if (!awake.isHeld()) awake.acquire(4 * 60 * 60 * 1000L);   // a long lesson, never for ever
        } else {
            if (awake.isHeld()) awake.release();
        }
        return START_STICKY;
    }

    private Notification notification(String title, boolean playing) {
        Intent open = new Intent(this, MainActivity.class);
        open.setAction(ACTION_SHOW);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(title == null || title.isEmpty() ? "TVA Player" : title)
            .setContentText(playing ? "Playing" : "Paused")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(tap)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(playing
                ? new NotificationCompat.Action(android.R.drawable.ic_media_pause, "Pause",
                    MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PAUSE))
                : new NotificationCompat.Action(android.R.drawable.ic_media_play, "Play",
                    MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PLAY)))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0))
            .build();
    }

    @Override
    public void onDestroy() {
        if (awake != null && awake.isHeld()) awake.release();
        if (session != null) { session.setActive(false); session.release(); session = null; }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
