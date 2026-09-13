package site.rishit.snapnote;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

/**
 * The Snapnote icon. First time: asks to show notifications (and, on Android 14+, full-screen calls).
 * Then opens the website, handing it this phone's push token so the server can ring it.
 */
public class MainActivity extends Activity {
    private boolean wentToSettings = false;
    private boolean paused = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7);
            return;
        }
        proceed();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        proceed();
    }

    private void proceed() {
        // Android 14+: "full screen notifications" is a switch the person must allow once
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (!nm.canUseFullScreenIntent() && !getSharedPreferences(SnapApp.PREFS, MODE_PRIVATE).getBoolean("askedFullScreen", false)) {
                getSharedPreferences(SnapApp.PREFS, MODE_PRIVATE).edit().putBoolean("askedFullScreen", true).apply();
                try { wentToSettings = true; startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName()))); return; }
                catch (Exception ignored) { /* open the app anyway */ }
            }
        }
        open(this, null);
        finish();
    }

    @Override protected void onPause() { super.onPause(); paused = true; }

    @Override protected void onResume() {
        super.onResume();
        // came back from the full-screen settings page
        if (wentToSettings && paused && !isFinishing()) { wentToSettings = false; open(this, null); finish(); }
    }

    /** open the website (optionally straight into answering a call) */
    static void open(Context c, String answerCall) {
        Uri.Builder u = Uri.parse(BuildConfig.SITE + "/").buildUpon();
        String token = SnapApp.token(c);
        if (!token.isEmpty()) u.appendQueryParameter("fcm", token);
        if (answerCall != null) u.appendQueryParameter("answer", answerCall);
        Intent i = new Intent(Intent.ACTION_VIEW, u.build())
                .setClassName(c.getPackageName(), "com.google.androidbrowserhelper.trusted.LauncherActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        c.startActivity(i);
    }

    static void openAnswer(Context c, String call) { open(c, call); }
}
