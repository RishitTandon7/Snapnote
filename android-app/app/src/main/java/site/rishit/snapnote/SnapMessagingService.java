package site.rishit.snapnote;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Receives the "someone is calling" push from the server, even when Snapnote is closed. */
public class SnapMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        SnapApp.saveToken(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        String type = d.get("type");
        String call = d.get("call");
        if ("call".equals(type) && call != null) {
            String name = d.get("name");
            CallRinger.start(this, call, name == null || name.isEmpty() ? "Someone" : name);
        } else if ("cancel".equals(type)) {
            CallRinger.stop(this, call);
        }
    }
}
