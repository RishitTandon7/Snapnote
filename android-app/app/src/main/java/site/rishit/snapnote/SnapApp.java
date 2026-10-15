package site.rishit.snapnote;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

/** Starts Firebase (push) from the identifiers in firebase.properties, and keeps this phone's push token handy. */
public class SnapApp extends Application {
    static final String PREFS = "snapnote";

    @Override
    public void onCreate() {
        super.onCreate();
        if (!firebaseConfigured()) return;
        try {
            if (FirebaseApp.getApps(this).isEmpty()) {
                FirebaseApp.initializeApp(this, new FirebaseOptions.Builder()
                        .setApiKey(BuildConfig.FB_API_KEY)
                        .setApplicationId(BuildConfig.FB_APP_ID)
                        .setProjectId(BuildConfig.FB_PROJECT_ID)
                        .setGcmSenderId(BuildConfig.FB_SENDER_ID)
                        .build());
            }
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t -> saveToken(this, t));
        } catch (Exception ignored) { /* push just stays off */ }
    }

    static boolean firebaseConfigured() {
        return !BuildConfig.FB_API_KEY.isEmpty() && !BuildConfig.FB_APP_ID.isEmpty()
                && !BuildConfig.FB_PROJECT_ID.isEmpty() && !BuildConfig.FB_SENDER_ID.isEmpty();
    }

    static void saveToken(Context c, String token) {
        SharedPreferences p = c.getSharedPreferences(PREFS, MODE_PRIVATE);
        p.edit().putString("token", token).apply();
    }

    static String token(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE).getString("token", "");
    }
}
