package com.playtimepact.parent;

import android.content.Context;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;

import java.util.Objects;

/** Explicitly owns creation and identity validation of the default Firebase app. */
public final class FirebaseBootstrap {
  private FirebaseBootstrap() { }

  public static boolean ensureInitialized(Context context) {
    if (!BuildConfig.FCM_ENABLED) return false;
    Context applicationContext = context.getApplicationContext();
    Config expected = new Config(
        BuildConfig.FIREBASE_API_KEY,
        BuildConfig.FIREBASE_APPLICATION_ID,
        BuildConfig.FIREBASE_PROJECT_ID,
        BuildConfig.FIREBASE_SENDER_ID);
    return ensureInitialized(true, expected, new Runtime() {
      @Override public Config defaultAppConfig() {
        try {
          FirebaseOptions options = FirebaseApp.getInstance().getOptions();
          return new Config(options.getApiKey(), options.getApplicationId(), options.getProjectId(), options.getGcmSenderId());
        } catch (IllegalStateException missingDefaultApp) {
          return null;
        }
      }

      @Override public void initializeDefault(Config config) {
        FirebaseOptions options = new FirebaseOptions.Builder()
            .setApiKey(config.apiKey)
            .setApplicationId(config.applicationId)
            .setProjectId(config.projectId)
            .setGcmSenderId(config.senderId)
            .build();
        if (FirebaseApp.initializeApp(applicationContext, options) == null) {
          throw new IllegalStateException("Unable to initialize the default Firebase app");
        }
      }
    });
  }

  static synchronized boolean ensureInitialized(boolean enabled, Config expected, Runtime runtime) {
    if (!enabled) return false;
    expected.validate();
    Config current = runtime.defaultAppConfig();
    if (current == null) {
      runtime.initializeDefault(expected);
    } else if (!expected.equals(current)) {
      throw new IllegalStateException("Existing default Firebase app identity does not match BuildConfig");
    }
    return true;
  }

  interface Runtime {
    Config defaultAppConfig();
    void initializeDefault(Config config);
  }

  static final class Config {
    final String apiKey;
    final String applicationId;
    final String projectId;
    final String senderId;

    Config(String apiKey, String applicationId, String projectId, String senderId) {
      this.apiKey = normalized(apiKey);
      this.applicationId = normalized(applicationId);
      this.projectId = normalized(projectId);
      this.senderId = normalized(senderId);
    }

    void validate() {
      if (apiKey.isEmpty() || applicationId.isEmpty() || projectId.isEmpty() || senderId.isEmpty()) {
        throw new IllegalStateException("Firebase BuildConfig is incomplete");
      }
    }

    @Override public boolean equals(Object other) {
      if (this == other) return true;
      if (!(other instanceof Config)) return false;
      Config config = (Config) other;
      return apiKey.equals(config.apiKey)
          && applicationId.equals(config.applicationId)
          && projectId.equals(config.projectId)
          && senderId.equals(config.senderId);
    }

    @Override public int hashCode() {
      return Objects.hash(apiKey, applicationId, projectId, senderId);
    }

    private static String normalized(String value) {
      return value == null ? "" : value.trim();
    }
  }
}
