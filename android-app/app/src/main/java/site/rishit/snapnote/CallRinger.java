package site.rishit.snapnote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

/** Rings like a phone call until answered, declined, cancelled, or 45 seconds pass. */
final class CallRinger {
    static final String CHANNEL = "calls";
    static final int NOTIF_ID = 4242;
    private static final long MAX_MS = 45_000;

    private static MediaPlayer player;
    private static Vibrator vibrator;
    private static String activeCall;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static Runnable timeout;

    static String active() { return activeCall; }

    static void start(Context c, String callId, String name) {
        Context app = c.getApplicationContext();
        stopSound();
        activeCall = callId;
        ensureChannel(app);

        Intent full = new Intent(app, IncomingCallActivity.class)
                .putExtra("call", callId).putExtra("name", name)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent fullPi = PendingIntent.getActivity(app, 1, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent answer = PendingIntent.getBroadcast(app, 2, new Intent(app, CallActionReceiver.class).setAction("answer").putExtra("call", callId), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent decline = PendingIntent.getBroadcast(app, 3, new Intent(app, CallActionReceiver.class).setAction("decline").putExtra("call", callId), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(app, CHANNEL) : new Notification.Builder(app);
        b.setSmallIcon(R.drawable.ic_call)
                .setContentTitle(name + " is calling")
                .setContentText("Snapnote video call")
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setTimeoutAfter(MAX_MS)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(fullPi)
                .addAction(new Notification.Action.Builder(null, "Decline", decline).build())
                .addAction(new Notification.Action.Builder(null, "Answer", answer).build());
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_MAX);
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, b.build());

        // the ring itself (our own loop: a notification sound would play once)
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            player.setDataSource(app, uri);
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception e) { player = null; }
        try {
            vibrator = (Vibrator) app.getSystemService(Context.VIBRATOR_SERVICE);
            long[] pattern = {0, 800, 600};
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            else vibrator.vibrate(pattern, 0);
        } catch (Exception ignored) { }

        timeout = () -> stop(app, callId);
        handler.postDelayed(timeout, MAX_MS);
    }

    /** stop ringing and remove the notification (only if it is still THIS call) */
    static void stop(Context c, String callId) {
        if (callId != null && activeCall != null && !callId.equals(activeCall)) return;
        stopSound();
        activeCall = null;
        ((NotificationManager) c.getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE)).cancel(NOTIF_ID);
        Intent done = new Intent("site.rishit.snapnote.CALL_ENDED").setPackage(c.getPackageName());
        c.getApplicationContext().sendBroadcast(done);
    }

    private static void stopSound() {
        handler.removeCallbacksAndMessages(null);
        try { if (player != null) { player.stop(); player.release(); } } catch (Exception ignored) { }
        player = null;
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) { }
    }

    private static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Rings when a friend calls you on Snapnote");
        ch.setSound(null, null);          // the ringtone is played by CallRinger
        ch.enableVibration(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }
}
