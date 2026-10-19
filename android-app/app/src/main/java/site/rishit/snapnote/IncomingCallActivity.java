package site.rishit.snapnote;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full-screen incoming call (shows over the lock screen and turns the screen on). */
public class IncomingCallActivity extends Activity {
    private String call;
    private final BroadcastReceiver ended = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { finishAndRemoveTask(); }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        if (Build.VERSION.SDK_INT >= 26) ((KeyguardManager) getSystemService(KEYGUARD_SERVICE)).requestDismissKeyguard(this, null);

        call = getIntent().getStringExtra("call");
        String name = getIntent().getStringExtra("name");
        if (name == null) name = "Someone";

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0E101C"));
        root.setPadding(dp(32), dp(96), dp(32), dp(72));

        TextView hint = text("Snapnote video call", 15, Color.parseColor("#9AA0BA"));
        TextView who = text(name, 34, Color.WHITE);
        who.setPadding(0, dp(12), 0, 0);
        TextView ring = text("is calling you…", 17, Color.parseColor("#C9CEE6"));
        ring.setPadding(0, dp(6), 0, 0);

        // a soft avatar circle with the first letter
        TextView avatar = text(name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase(), 56, Color.WHITE);
        GradientDrawable circle = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{Color.parseColor("#7C5CFF"), Color.parseColor("#FF7AC6")});
        circle.setShape(GradientDrawable.OVAL);
        avatar.setBackground(circle);
        avatar.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(dp(132), dp(132));
        ap.topMargin = dp(40);

        View spacer = new View(this);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(1, 0, 1f);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        TextView decline = roundButton("✕", Color.parseColor("#F4533F"));
        TextView answer = roundButton("📞", Color.parseColor("#34C759"));
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(dp(78), dp(78));
        bp.setMargins(dp(40), 0, dp(40), 0);
        buttons.addView(decline, bp);
        buttons.addView(answer, bp);

        TextView l1 = text("Decline", 13, Color.parseColor("#9AA0BA"));
        TextView l2 = text("Answer", 13, Color.parseColor("#9AA0BA"));
        LinearLayout labels = new LinearLayout(this);
        labels.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(78) + dp(80), LinearLayout.LayoutParams.WRAP_CONTENT);
        labels.addView(l1, lp);
        labels.addView(l2, lp);

        root.addView(hint);
        root.addView(who);
        root.addView(ring);
        root.addView(avatar, ap);
        root.addView(spacer, sp);
        root.addView(buttons);
        root.addView(labels);
        setContentView(root);

        decline.setOnClickListener(v -> { CallRinger.stop(this, call); finishAndRemoveTask(); });
        answer.setOnClickListener(v -> { CallRinger.stop(this, call); MainActivity.openAnswer(this, call); finishAndRemoveTask(); });

        IntentFilter f = new IntentFilter("site.rishit.snapnote.CALL_ENDED");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(ended, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(ended, f);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        try { unregisterReceiver(ended); } catch (Exception ignored) { }
    }

    @Override public void onBackPressed() { /* a call can't be dismissed by accident */ }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color); t.setGravity(Gravity.CENTER);
        return t;
    }

    private TextView roundButton(String label, int color) {
        TextView t = text(label, 28, Color.WHITE);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        t.setBackground(g);
        t.setClickable(true);
        return t;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
