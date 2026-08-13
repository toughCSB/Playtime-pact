package com.playtimepact.parent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.security.keystore.KeyInfo;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.lang.reflect.Method;
import java.util.Arrays;

@RunWith(AndroidJUnit4.class)
public final class ParentAppInstrumentedTest {
  @Test public void fcmWakeupIgnoresAdversarialPayloadAndCarriesNoAuthority() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    RemoteMessage message = new RemoteMessage.Builder("untrusted-sender")
        .addData("childName", "민감한 이름")
        .addData("approvedMinutes", "9999")
        .addData("launchGame", "true")
        .build();
    android.content.Intent wakeup = ApprovalMessagingService.opaqueWakeupIntent(context, message);
    assertEquals(ApprovalMessagingService.ACTION_SYNC_REQUIRED, wakeup.getAction());
    assertEquals(context.getPackageName(), wakeup.getPackage());
    assertTrue(wakeup.getExtras() == null || wakeup.getExtras().isEmpty());
  }
  @Test public void pairingUriIsStrictAndEncryptedAtRest() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    PairingStore store = new PairingStore(context);
    store.clear();
    String uri = new Uri.Builder()
        .scheme("playtimepact").authority("pair")
        .appendQueryParameter("baseUrl", "https://approval.example")
        .appendQueryParameter("householdId", "family-1")
        .appendQueryParameter("parentId", "parent-android")
        .appendQueryParameter("token", "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG")
        .appendQueryParameter("membershipEpoch", "3")
        .appendQueryParameter("serviceEpoch", "8")
        .build().toString();
    PairingStore.Pairing pairing = PairingStore.parsePairingUri(uri);
    store.save(pairing);
    PairingStore.Pairing restored = store.load();
    assertNotNull(restored);
    assertEquals("https://approval.example", restored.getBaseUrl());
    assertEquals("family-1", restored.getHouseholdId());
    assertEquals("parent-android", restored.getParentId());
    assertEquals("0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", restored.getToken());
    String rawPreferences = context.getSharedPreferences("playtimepact.pairing", Context.MODE_PRIVATE).getAll().toString();
    assertTrue(!rawPreferences.contains("0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"));
    store.save(restored.withPendingReset("reset-operation-1"));
    PairingStore.Pairing pending=store.load();
    assertEquals("reset-operation-1",pending.getPendingResetOperationKey());
    store.save(pending.withEpochs(4,8));
    PairingStore.Pairing reconciled=store.load();
    assertEquals(4,reconciled.getMembershipEpoch());
    assertTrue(reconciled.getPendingResetOperationKey()==null);
    store.clear();
  }
  @Test public void resetIntentPersistsSeparatelyFromDeleteIntent() throws Exception {
    Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
    PairingStore store=new PairingStore(context);
    PairingStore.Pairing pairing=new PairingStore.Pairing("https://approval.example","h","p","0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",1,1);
    store.save(pairing.withPendingReset("reset-key"));
    assertEquals("reset-key",store.load().getPendingResetOperationKey());
    assertTrue(store.load().getPendingDeleteOperationKey()==null);
    store.save(store.load().withPendingDelete("delete-key"));
    assertEquals("reset-key",store.load().getPendingResetOperationKey());
    assertEquals("delete-key",store.load().getPendingDeleteOperationKey());
    store.clear();
  }

  @Test public void rejectsNonHttpsAndUnexpectedPairingFields() throws Exception {
    String insecure = "playtimepact://pair?baseUrl=http%3A%2F%2Flocal&householdId=h&parentId=p&token=t&membershipEpoch=1&serviceEpoch=1";
    try { PairingStore.parsePairingUri(insecure); throw new AssertionError("Expected rejection"); }
    catch (PairingStore.PairingException expected) { assertTrue(expected.getMessage().contains("HTTPS")); }
    String extra = "playtimepact://pair?baseUrl=https%3A%2F%2Fexample.com&householdId=h&parentId=p&token=t&membershipEpoch=1&serviceEpoch=1&admin=true";
    try { PairingStore.parsePairingUri(extra); throw new AssertionError("Expected rejection"); }
    catch (PairingStore.PairingException expected) { assertTrue(expected.getMessage().contains("parameters")); }
  }

  @Test public void androidKeystoreIdentityPublishesOnlyPublicJwk() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    SecureIdentity identity = new SecureIdentity(context);
    identity.ensureKey();
    JSONObject jwk = new JSONObject(identity.publicJwk());
    assertEquals("EC", jwk.getString("kty"));
    assertEquals("P-256", jwk.getString("crv"));
    assertTrue(jwk.getString("x").length() > 40);
    assertTrue(jwk.getString("y").length() > 40);
    assertTrue(!jwk.has("d"));
    KeyStore keyStore=KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    PrivateKey privateKey=(PrivateKey)keyStore.getKey("playtimepact.parent.signing.v2",null);
    KeyInfo keyInfo=KeyFactory.getInstance(privateKey.getAlgorithm(),"AndroidKeyStore")
        .getKeySpec(privateKey,KeyInfo.class);
    assertTrue(keyInfo.isUserAuthenticationRequired());
    assertTrue(keyInfo.getUserAuthenticationValidityDurationSeconds()<=0);
  }

  @Test public void failsClosedForInvalidUpdateMetadataAndArtifact() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    File apk = new File(context.getCacheDir(), "candidate.apk");
    byte[] bytes = "verified-apk".getBytes(StandardCharsets.UTF_8);
    try (FileOutputStream output = new FileOutputStream(apk)) { output.write(bytes); }
    String digest = hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(256);
    KeyPair pair = generator.generateKeyPair(); long now=System.currentTimeMillis();
    JSONObject manifest = signedManifest(pair, 7, 6, "7.0", "https://updates.example/parent-v7.apk", digest, bytes.length, "Notes", hex(MessageDigest.getInstance("SHA-256").digest("lineage".getBytes(StandardCharsets.UTF_8))), now, now+60_000);
    String publicKey = Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP);
    UpdateVerifier.VerifiedUpdate update = UpdateVerifier.verifyManifest(manifest.toString(), publicKey, 6);
    UpdateVerifier.verifyApk(apk, update);
    assertEquals(7, update.versionCode);
    JSONObject wrongApplication = new JSONObject(manifest.toString()).put("applicationId", "com.example.other");
    expectReject(() -> UpdateVerifier.verifyManifest(wrongApplication.toString(), publicKey, 6));
    manifest.put("signature", "invalid");
    expectReject(() -> UpdateVerifier.verifyManifest(manifest.toString(), publicKey, 6));
    expectReject(() -> UpdateVerifier.verifyManifest(signedManifest(pair, 6, 6, "6", "https://updates.example/a.apk", digest, bytes.length, "n", update.signerLineageSha256, now, now+60_000).toString(), publicKey, 6));
    UpdateVerifier.VerifiedUpdate recovery = UpdateVerifier.verifyManifest(signedManifest(pair, 8, 7, "8", "https://updates.example/a.apk", digest, bytes.length, "n", update.signerLineageSha256, now, now+60_000).toString(), publicKey, 6);
    UpdateVerifier.persistMinimumSupportedVersion(context, recovery);
    assertEquals(7, UpdateVerifier.minimumSupportedVersion(context));
    assertTrue(UpdateVerifier.isPolicyKnown(context));
    UpdateVerifier.VerifiedUpdate lowerFloor = UpdateVerifier.verifyManifest(
        signedManifest(pair, 9, 6, "9", "https://updates.example/a.apk", digest, bytes.length, "n",
            update.signerLineageSha256, now, now + 60_000).toString(),
        publicKey, 6);
    UpdateVerifier.persistMinimumSupportedVersion(context, lowerFloor);
    assertEquals(7, UpdateVerifier.minimumSupportedVersion(context));
    expectReject(() -> UpdateVerifier.verifyManifest(signedManifest(pair, 8, 6, "8", "https://updates.example/a.apk", digest, UpdateVerifier.MAX_APK_BYTES+1, "n", update.signerLineageSha256, now, now+60_000).toString(), publicKey, 6));
    try (FileOutputStream output = new FileOutputStream(apk)) { output.write("tampered".getBytes(StandardCharsets.UTF_8)); }
    expectReject(() -> UpdateVerifier.verifyApk(apk, update));
    expectReject(() -> UpdateVerifier.verifySignerLineage(context.getPackageManager(), context.getPackageName(), apk, update));
  }
  @Test public void buildConfigurationMatchesFcmMode() throws Exception {
    assertTrue(!UpdateVerifier.isConfigured("", ""));
    assertTrue(UpdateVerifier.isConfigured("https://updates.example/manifest.json", "pinned-key"));
    expectReject(() -> UpdateVerifier.fetchManifest("", "", 1));
    assertEquals(
        !BuildConfig.UPDATE_MANIFEST_URL.isEmpty() && !BuildConfig.UPDATE_PUBLIC_KEY_B64.isEmpty(),
        UpdateVerifier.isConfigured(BuildConfig.UPDATE_MANIFEST_URL, BuildConfig.UPDATE_PUBLIC_KEY_B64));
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    if (BuildConfig.FCM_ENABLED) {
      assertTrue(!BuildConfig.FIREBASE_API_KEY.isEmpty());
      assertTrue(!BuildConfig.FIREBASE_APPLICATION_ID.isEmpty());
      assertTrue(!BuildConfig.FIREBASE_PROJECT_ID.isEmpty());
      assertTrue(!BuildConfig.FIREBASE_SENDER_ID.isEmpty());
      assertTrue(FirebaseBootstrap.ensureInitialized(context));
    } else {
      assertTrue(!FirebaseBootstrap.ensureInitialized(context));
    }
  }
  @Test public void signerRotationRequiresOrderedInstalledPrefix() {
    assertTrue(UpdateVerifier.isAllowedRotation(new String[]{"old"},new String[]{"old"}));
    assertTrue(UpdateVerifier.isAllowedRotation(new String[]{"old"},new String[]{"old","new"}));
    assertTrue(!UpdateVerifier.isAllowedRotation(new String[]{"old"},new String[]{"new","old"}));
    assertTrue(!UpdateVerifier.isAllowedRotation(new String[]{"old","new"},new String[]{"old"}));
    assertTrue(!UpdateVerifier.isAllowedRotation(new String[]{"old"},new String[]{"other"}));
  }
  @Test public void staleRerenderDoesNotReanchorAuthoritativeExpiryClock() throws Exception {
    Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
    new PairingStore(context).clear();
    try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        try {
          java.lang.reflect.Field anchor=MainActivity.class.getDeclaredField("serverNowAtElapsedMs"); anchor.setAccessible(true);
          anchor.setLong(activity, 777L);
          ApprovalRepository.State stale=new ApprovalRepository.State(ApprovalRepository.Status.STALE,java.util.Collections.<ApprovalRepository.Request>emptyList(),java.util.Collections.<ApprovalRepository.Device>emptyList(),java.util.Collections.<ApprovalRepository.Allowance>emptyList(),0,0,999999L,"","",null);
          Method render=MainActivity.class.getDeclaredMethod("renderState",ApprovalRepository.State.class); render.setAccessible(true); render.invoke(activity,stale);
          assertEquals(777L,anchor.getLong(activity));
        } catch(Exception error) { throw new AssertionError(error); }
      });
    }
  }
  @Test public void encryptedFcmTokenClearIsRetrySafe() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    ApprovalMessagingService.clearToken(context);
    assertTrue(ApprovalMessagingService.loadToken(context) == null);
    ApprovalMessagingService.clearToken(context);
    assertTrue(ApprovalMessagingService.loadToken(context) == null);
  }
  @Test public void allowanceReceiptKeepsGameIdentityAndServerTime() {
    ApprovalRepository.Allowance allowance = new ApprovalRepository.Allowance("pc-1", "game-1", "2026-08-05", "Asia/Seoul", 3600, 600, 120, 8, 123456L);
    assertEquals("game-1", allowance.getGameId());
    assertEquals(8, allowance.getVersion());
    assertEquals(123456L, allowance.getServerNowMs());
  }
  @Test public void parsesFrozenParentStateAllowanceEnvelope() throws Exception {
    JSONObject allowance = new JSONObject().put("pcId","pc-1").put("gameId","game-1").put("ianaTimeZone","Asia/Seoul").put("ianaDay","2026-08-05").put("allowanceVersion",9).put("totalSeconds",3600).put("committedSeconds",600).put("reservedSeconds",120).put("serverNowMs",1234L);
    JSONObject request = new JSONObject().put("householdId","h").put("requestId","r").put("childName","Child").put("pcId","pc-1").put("gameId","game-1").put("status","pending").put("personalDecision",JSONObject.NULL).put("todayUsedMinutes",0).put("todayLimitMinutes",60).put("allowanceVersion",9).put("processId","p").put("processStartedAt",1L).put("membershipEpoch",2L).put("serviceEpoch",3L).put("requestedAt",1000L).put("expiresAt",2000L);
    JSONObject device = new JSONObject().put("id","parent-1").put("name","Parent").put("platform","Android").put("status","active").put("registeredAt",900L);
    JSONObject state = new JSONObject().put("serverNowMs",1234L).put("requests",new org.json.JSONArray().put(request)).put("devices",new org.json.JSONArray().put(device)).put("allowances",new org.json.JSONArray().put(allowance));
    Method parser=RemoteApi.class.getDeclaredMethod("parseState", JSONObject.class); parser.setAccessible(true);
    ApprovalRepository.ServerState parsed=(ApprovalRepository.ServerState)parser.invoke(null,state);
    assertEquals(1, parsed.getRequests().size());
    assertEquals("r", parsed.getRequests().get(0).getId());
    assertEquals(1234L, parsed.getServerTimeMillis());
    assertEquals("game-1", parsed.getAllowances().get(0).getGameId());
    assertEquals(9, parsed.getAllowances().get(0).getVersion());
  }
  @Test public void rejectsParentStateMissingAuthoritativeDtoField() throws Exception {
    JSONObject invalid=new JSONObject().put("serverNowMs",1L).put("requests",new org.json.JSONArray()).put("devices",new org.json.JSONArray()).put("allowances",new org.json.JSONArray().put(new JSONObject().put("pcId","pc").put("gameId","g")));
    Method parser=RemoteApi.class.getDeclaredMethod("parseState", JSONObject.class); parser.setAccessible(true);
    try { parser.invoke(null,invalid); throw new AssertionError("Expected DTO rejection"); } catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof org.json.JSONException); }
  }
  @Test public void clientVersionCodeIsARequiredSignatureBoundProofClaim() throws Exception {
    JSONObject claims=SecureIdentity.proofClaims("POST","https://approval.example/v1/approve","{}", "parent",1,1,"operation",BuildConfig.VERSION_CODE,"nonce","jti");
    assertEquals(BuildConfig.VERSION_CODE,claims.getInt("clientVersionCode"));
    assertTrue(claims.has("contentDigest"));
  }
  @Test public void expiredOrRefreshingPolicyFailsClosed() {
    Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
    context.getSharedPreferences("playtimepact.signed-update",Context.MODE_PRIVATE).edit().putBoolean("policy_known",true).putLong("policy_issued_at_ms",1).putLong("policy_expires_at_ms",1).commit();
    assertTrue(!UpdateVerifier.isPolicyKnown(context));
    UpdateVerifier.beginForegroundPolicyRefresh(context);
    assertTrue(UpdateVerifier.isForegroundPolicyRefreshPending(context));
    UpdateVerifier.endForegroundPolicyRefresh(context);
    assertTrue(!UpdateVerifier.isForegroundPolicyRefreshPending(context));
  }
  @Test public void installerPendingExplicitConfirmationIsLaunched() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Intent confirmation = new Intent(context, MainActivity.class);
    Intent callback = new Intent(context, UpdateInstallReceiver.class).setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS)
        .putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION)
        .putExtra(Intent.EXTRA_INTENT, confirmation);
    new UpdateInstallReceiver().onReceive(context, callback);
  }
  @Test public void installerPendingWithoutExplicitConfirmationFailsClosed() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Intent callback = new Intent(context, UpdateInstallReceiver.class).setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS)
        .putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION)
        .putExtra(Intent.EXTRA_INTENT, new Intent("untrusted"));
    new UpdateInstallReceiver().onReceive(context, callback);
  }
  @Test public void installerStatusReceiverAcceptsExplicitFailureCallback() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Intent callback = new Intent(context, UpdateInstallReceiver.class).setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS)
        .putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, android.content.pm.PackageInstaller.STATUS_FAILURE)
        .putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE, "declined");
    new UpdateInstallReceiver().onReceive(context, callback);
  }

  @Test public void unpairedActivityExposesAccessiblePairingActions() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    new PairingStore(context).clear();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        View root = activity.findViewById(android.R.id.content);
        assertTrue(hasText(root, "부모 기기 연결"));
        assertTrue(hasText(root, "QR 코드 스캔"));
        assertTrue(hasDescription(root, "PC의 연결 QR 코드 스캔"));
        assertTrue(hasText(root, "업데이트 확인 사용할 수 없음"));
      });
    }
  }

  @Test public void rendersDashboardAndRequestDetailFromAuthoritativeStateContract() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    new PairingStore(context).clear();
    ApprovalRepository.Request request = new ApprovalRepository.Request(
        "request-1", "민준", "Roblox", "아이 PC", "pending", null,
        System.currentTimeMillis(), System.currentTimeMillis() + 300_000, 42, 60);
    ApprovalRepository.Device device = new ApprovalRepository.Device(
        "parent-android", "엄마의 Android", "Android", "active", System.currentTimeMillis());
    ApprovalRepository.Allowance allowance = new ApprovalRepository.Allowance(
        "pc-1", "roblox", "2026-08-05", "Asia/Seoul", 3_600, 2_520, 0, 9, System.currentTimeMillis());
    ApprovalRepository.State state = new ApprovalRepository.State(
        ApprovalRepository.Status.ONLINE, Arrays.asList(request), Arrays.asList(device), Arrays.asList(allowance),
        42, System.currentTimeMillis(), System.currentTimeMillis(), "2026-08-05", "Asia/Seoul", null);

    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        try {
          Method render = MainActivity.class.getDeclaredMethod("renderState", ApprovalRepository.State.class);
          render.setAccessible(true);
          render.invoke(activity, state);
          java.lang.reflect.Field anchor = MainActivity.class.getDeclaredField("serverNowAtElapsedMs");
          anchor.setAccessible(true);
          anchor.setLong(activity, System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime());
        } catch (Exception error) { throw new AssertionError(error); }
        View root = activity.findViewById(android.R.id.content);
        assertTrue(hasText(root, "민준의 플레이 요청"));
        assertTrue(hasText(root, "오늘 PC·게임별 허용 시간"));
      });
      InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      saveScreenshot(context, "g003-dashboard.png");

      scenario.onActivity(activity -> {
        try {
          Method detail = MainActivity.class.getDeclaredMethod("showRequest", ApprovalRepository.Request.class);
          detail.setAccessible(true);
          detail.invoke(activity, request);
        } catch (Exception error) { throw new AssertionError(error); }
        View root = activity.findViewById(android.R.id.content);
        assertTrue(hasText(root, "Roblox 플레이 승인"));
        assertTrue(hasText(root, "기본 20분 승인"));
        assertTrue(hasText(root, "나만 거절"));
      });
      InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      saveScreenshot(context, "g003-request-detail.png");
      ApprovalRepository.Request rejected = new ApprovalRepository.Request(
          "request-2","민준","Roblox","아이 PC","approved","reject",
          System.currentTimeMillis(),System.currentTimeMillis()+300_000,42,60);
      scenario.onActivity(activity -> {
        try {
          Method detail=MainActivity.class.getDeclaredMethod("showRequest",ApprovalRepository.Request.class);
          detail.setAccessible(true);
          detail.invoke(activity,rejected);
        } catch(Exception error) { throw new AssertionError(error); }
        View root=activity.findViewById(android.R.id.content);
        assertTrue(hasText(root,"이 요청은 더 이상 변경할 수 없습니다."));
        assertTrue(hasText(root,"이 부모 기기는 거절했지만 다른 동등한 부모 기기가 먼저 승인했습니다."));
        assertTrue(!hasText(root,"기본 20분 승인"));
      });
    }
  }

  private static void saveScreenshot(Context context, String name) {
    try {
      ParcelFileDescriptor descriptor = InstrumentationRegistry.getInstrumentation()
          .getUiAutomation().executeShellCommand("screencap -p /sdcard/Download/" + name);
      try (FileInputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
        byte[] buffer = new byte[256];
        while (input.read(buffer) != -1) { }
      } finally {
        descriptor.close();
      }
    } catch (Exception error) {
      throw new AssertionError(error);
    }
  }
  private static boolean hasText(View view, String expected) {
    if (view instanceof TextView && expected.contentEquals(((TextView) view).getText())) return true;
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) if (hasText(((ViewGroup) view).getChildAt(i), expected)) return true;
    return false;
  }

  private static boolean hasDescription(View view, String expected) {
    if (view.getContentDescription() != null && expected.contentEquals(view.getContentDescription())) return true;
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) if (hasDescription(((ViewGroup) view).getChildAt(i), expected)) return true;
    return false;
  }
  private interface ThrowingOperation { void run() throws Exception; }
  private static void expectReject(ThrowingOperation operation) throws Exception {
    try { operation.run(); throw new AssertionError("Expected rejection"); } catch (Exception expected) { }
  }
  private static JSONObject signedManifest(KeyPair pair, long version, long minimum, String name, String url, String digest, long size, String notes, String lineage, long issued, long expires) throws Exception {
    String canonical="com.playtimepact.parent\n"+version+"\n"+minimum+"\n"+name+"\n"+digest+"\n"+size+"\n"+url+"\n"+notes+"\n"+lineage+"\n"+issued+"\n"+expires;
    Signature signer=Signature.getInstance("SHA256withECDSA"); signer.initSign(pair.getPrivate()); signer.update(canonical.getBytes(StandardCharsets.UTF_8));
    return new JSONObject().put("applicationId","com.playtimepact.parent").put("versionCode",version).put("minimumSupportedVersionCode",minimum).put("versionName",name).put("apkUrl",url).put("apkSha256",digest).put("sizeBytes",size).put("releaseNotes",notes).put("signerLineageSha256",lineage).put("issuedAtMillis",issued).put("expiresAtMillis",expires).put("signature",Base64.encodeToString(signer.sign(),Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING));
  }
  private static String hex(byte[] bytes) {
    StringBuilder output=new StringBuilder(); for(byte value:bytes) output.append(String.format(java.util.Locale.ROOT,"%02x",value&0xff)); return output.toString();
  }
}
