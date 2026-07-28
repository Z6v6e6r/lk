package com.cabinet.app;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FirebaseAvailability")
public class FirebaseAvailabilityPlugin extends Plugin {

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        Context context = getContext();

        if (context == null) {
            result.put("available", false);
            result.put("reason", "no_context");
            call.resolve(result);
            return;
        }

        try {
            int googleAppIdRes = context.getResources().getIdentifier(
                "google_app_id",
                "string",
                context.getPackageName()
            );
            int senderIdRes = context.getResources().getIdentifier(
                "gcm_defaultSenderId",
                "string",
                context.getPackageName()
            );

            String googleAppId = googleAppIdRes != 0
                ? context.getString(googleAppIdRes).trim()
                : "";
            String senderId = senderIdRes != 0
                ? context.getString(senderIdRes).trim()
                : "";

            boolean available = !googleAppId.isEmpty() && !senderId.isEmpty();
            result.put("available", available);
            result.put("reason", available ? "ok" : "missing_google_services");
            call.resolve(result);
        } catch (Exception error) {
            result.put("available", false);
            result.put("reason", "exception");
            result.put("message", error.getMessage());
            call.resolve(result);
        }
    }
}
