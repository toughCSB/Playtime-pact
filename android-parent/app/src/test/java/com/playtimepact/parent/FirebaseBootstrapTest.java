package com.playtimepact.parent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class FirebaseBootstrapTest {
  private static final FirebaseBootstrap.Config CONFIG = new FirebaseBootstrap.Config(
      "api-key", "1:123456:android:abcdef", "project-id", "123456");

  @Test public void configuredBootstrapInitializesOneDefaultAppWithExpectedIdentity() {
    FakeRuntime runtime = new FakeRuntime();

    assertTrue(FirebaseBootstrap.ensureInitialized(true, CONFIG, runtime));
    assertTrue(FirebaseBootstrap.ensureInitialized(true, CONFIG, runtime));

    assertEquals(1, runtime.initializeCalls);
    assertEquals(CONFIG, runtime.current);
  }

  @Test public void disabledBootstrapDoesNotInspectOrInitializeFirebase() {
    FakeRuntime runtime = new FakeRuntime();

    assertFalse(FirebaseBootstrap.ensureInitialized(false, CONFIG, runtime));

    assertEquals(0, runtime.lookupCalls);
    assertEquals(0, runtime.initializeCalls);
  }

  @Test public void configuredBootstrapRejectsMismatchedExistingDefaultApp() {
    FakeRuntime runtime = new FakeRuntime();
    runtime.current = new FirebaseBootstrap.Config(
        "other-api-key", "1:999:android:other", "other-project", "999");

    try {
      FirebaseBootstrap.ensureInitialized(true, CONFIG, runtime);
      throw new AssertionError("Expected mismatched Firebase identity rejection");
    } catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("identity"));
    }
    assertEquals(0, runtime.initializeCalls);
  }

  @Test public void debugBuildDisablesFcmByDefault() {
    assertFalse(BuildConfig.FCM_ENABLED);
  }

  private static final class FakeRuntime implements FirebaseBootstrap.Runtime {
    FirebaseBootstrap.Config current;
    int lookupCalls;
    int initializeCalls;

    @Override public FirebaseBootstrap.Config defaultAppConfig() {
      lookupCalls++;
      return current;
    }

    @Override public void initializeDefault(FirebaseBootstrap.Config config) {
      initializeCalls++;
      current = config;
    }
  }
}
