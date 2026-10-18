package site.rishit.snapnote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The Answer / Decline buttons on the call notification. */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String call = i.getStringExtra("call");
        CallRinger.stop(c, call);
        if ("answer".equals(i.getAction())) MainActivity.openAnswer(c, call);
    }
}
