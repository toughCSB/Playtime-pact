package com.playtimepact.parent;

import android.content.pm.PackageInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.util.Base64;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;

/** Fail-closed signed-update retrieval and verification. Signing configuration is injected at build time. */
public final class UpdateVerifier {
  public static final long MAX_APK_BYTES = 200L * 1024L * 1024L;
  private static final String APPLICATION_ID = "com.playtimepact.parent";
  private static final int CONNECT_TIMEOUT_MS = 10_000, READ_TIMEOUT_MS = 30_000, MAX_MANIFEST_BYTES = 64 * 1024;

  public static final class VerifiedUpdate {
    public final long versionCode, minimumSupportedVersion, sizeBytes, issuedAtMillis, expiresAtMillis;
    public final String versionName, apkUrl, apkSha256, releaseNotes, signerLineageSha256;
    private VerifiedUpdate(long versionCode, long minimumSupportedVersion, String versionName, String apkUrl, String apkSha256, long sizeBytes, String releaseNotes, String signerLineageSha256, long issuedAtMillis, long expiresAtMillis) {
      this.versionCode=versionCode; this.minimumSupportedVersion=minimumSupportedVersion; this.versionName=versionName; this.apkUrl=apkUrl; this.apkSha256=apkSha256; this.sizeBytes=sizeBytes; this.releaseNotes=releaseNotes; this.signerLineageSha256=signerLineageSha256; this.issuedAtMillis=issuedAtMillis; this.expiresAtMillis=expiresAtMillis;
    }
  }

  private UpdateVerifier() { }
  public static boolean isConfigured(String manifestUrl, String pinnedPublicKey) { return isHttps(manifestUrl) && pinnedPublicKey != null && !pinnedPublicKey.trim().isEmpty(); }
  public static VerifiedUpdate fetchManifest(String manifestUrl, String pinnedPublicKey, long installedVersion) throws Exception {
    if (!isConfigured(manifestUrl, pinnedPublicKey)) throw new SecurityException("Signed updates are not configured for this build");
    return verifyManifest(new String(fetch(manifestUrl, MAX_MANIFEST_BYTES), StandardCharsets.UTF_8), pinnedPublicKey, installedVersion);
  }
  public static VerifiedUpdate fetchPolicy(String manifestUrl, String pinnedPublicKey) throws Exception {
    if (!isConfigured(manifestUrl, pinnedPublicKey)) throw new SecurityException("Signed updates are not configured for this build");
    return verifyManifest(new String(fetch(manifestUrl, MAX_MANIFEST_BYTES), StandardCharsets.UTF_8), pinnedPublicKey, -1);
  }
  public static VerifiedUpdate verifyManifest(String manifestJson, String pinnedPublicKeyBase64, long installedVersion) throws Exception {
    if (pinnedPublicKeyBase64 == null || pinnedPublicKeyBase64.trim().isEmpty()) throw new SecurityException("Update signing key is not configured");
    JSONObject input = new JSONObject(manifestJson);
    long version=input.getLong("versionCode"), minimum=input.getLong("minimumSupportedVersionCode"), size=input.getLong("sizeBytes"), issued=input.getLong("issuedAtMillis"), expires=input.getLong("expiresAtMillis");
    String applicationId=input.getString("applicationId"), name=input.getString("versionName"), url=input.getString("apkUrl"), sha=normalizeDigest(input.getString("apkSha256")), notes=input.getString("releaseNotes"), lineage=normalizeDigest(input.getString("signerLineageSha256")), signature=input.getString("signature");
    if (version <= installedVersion) throw new SecurityException("Update is not newer");
    if (minimum > version || minimum < 0) throw new SecurityException("Update metadata has an invalid supported version floor");
    if (!APPLICATION_ID.equals(applicationId) || size <= 0 || size > MAX_APK_BYTES || issued < 0 || expires <= issued || expires <= System.currentTimeMillis() || name.trim().isEmpty() || notes.length() > 16_384 || !isHttps(url)) throw new SecurityException("Update metadata is invalid");
    PublicKey key=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(pinnedPublicKeyBase64, Base64.DEFAULT)));
    String canonical=applicationId+"\n"+version+"\n"+minimum+"\n"+name+"\n"+sha+"\n"+size+"\n"+url+"\n"+notes+"\n"+lineage+"\n"+issued+"\n"+expires;
    java.security.Signature verifier=java.security.Signature.getInstance("SHA256withECDSA"); verifier.initVerify(key); verifier.update(canonical.getBytes(StandardCharsets.UTF_8));
    if (!verifier.verify(Base64.decode(signature, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING))) throw new SecurityException("Update manifest signature is invalid");
    return new VerifiedUpdate(version,minimum,name,url,sha,size,notes,lineage,issued,expires);
  }
  public static void persistMinimumSupportedVersion(Context context, VerifiedUpdate update) {
    SharedPreferences preferences = context.getApplicationContext().getSharedPreferences("playtimepact.signed-update", Context.MODE_PRIVATE);
    long current = preferences.getLong("minimum_supported_version_code", 0);
    long next = Math.max(current, update.minimumSupportedVersion);
    if (!preferences.edit().putLong("minimum_supported_version_code", next).putLong("policy_issued_at_ms", update.issuedAtMillis).putLong("policy_expires_at_ms", update.expiresAtMillis).putBoolean("policy_known", true).commit()) throw new IllegalStateException("Unable to persist signed update policy");
  }
  public static boolean isPolicyKnown(Context context) {
    SharedPreferences preferences=context.getApplicationContext().getSharedPreferences("playtimepact.signed-update", Context.MODE_PRIVATE);
    return preferences.getBoolean("policy_known", false) && preferences.getLong("policy_issued_at_ms", 0) >= 0 && preferences.getLong("policy_expires_at_ms", 0) > System.currentTimeMillis();
  }
  public static void beginForegroundPolicyRefresh(Context context) {
    context.getApplicationContext().getSharedPreferences("playtimepact.signed-update", Context.MODE_PRIVATE).edit().putBoolean("policy_refresh_pending", true).commit();
  }
  public static void endForegroundPolicyRefresh(Context context) {
    context.getApplicationContext().getSharedPreferences("playtimepact.signed-update", Context.MODE_PRIVATE).edit().putBoolean("policy_refresh_pending", false).commit();
  }
  public static boolean isForegroundPolicyRefreshPending(Context context) {
    return context.getApplicationContext().getSharedPreferences("playtimepact.signed-update", Context.MODE_PRIVATE).getBoolean("policy_refresh_pending", false);
  }
  public static long minimumSupportedVersion(Context context) {
    return context.getApplicationContext().getSharedPreferences("playtimepact.signed-update", Context.MODE_PRIVATE).getLong("minimum_supported_version_code", 0);
  }
  public static File downloadApk(VerifiedUpdate update, File destination) throws Exception {
    if (destination == null) throw new SecurityException("APK destination is required");
    if (destination.exists() && !destination.delete()) throw new SecurityException("Unable to replace APK download");
    HttpsURLConnection connection=null;
    try {
      connection=openHttps(update.apkUrl);
      long length=connection.getContentLengthLong();
      if(length>update.sizeBytes) throw new SecurityException("Update download exceeds signed size bound");
      long copied=0;
      try(BufferedInputStream input=new BufferedInputStream(connection.getInputStream()); FileOutputStream output=new FileOutputStream(destination)) {
        byte[] buffer=new byte[32*1024]; int count;
        while((count=input.read(buffer))!=-1) { copied+=count; if(copied>update.sizeBytes) throw new SecurityException("Update download exceeds signed size bound"); output.write(buffer,0,count); }
        output.getFD().sync();
      }
      if(copied!=update.sizeBytes) throw new SecurityException("APK size does not match signed manifest");
      return destination;
    } catch(Exception error) { if(destination.exists()) destination.delete(); throw error; }
    finally { if(connection!=null)connection.disconnect(); }
  }
  public static void verifyApk(File apk, VerifiedUpdate update) throws Exception {
    if (apk == null || !apk.isFile() || apk.length() != update.sizeBytes || apk.length() > MAX_APK_BYTES) throw new SecurityException("APK size is invalid");
    MessageDigest digest=MessageDigest.getInstance("SHA-256");
    try (FileInputStream input=new FileInputStream(apk)) { byte[] buffer=new byte[32*1024]; int count; while((count=input.read(buffer))!=-1) digest.update(buffer,0,count); }
    if (!MessageDigest.isEqual(hex(digest.digest()).getBytes(StandardCharsets.US_ASCII), update.apkSha256.getBytes(StandardCharsets.US_ASCII))) throw new SecurityException("APK digest does not match signed manifest");
  }
  public static void verifySignerLineage(PackageManager manager, String packageName, File apk, VerifiedUpdate update) throws Exception {
    PackageInfo candidateInfo=manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
    if (candidateInfo == null || !packageName.equals(candidateInfo.packageName)) throw new SecurityException("APK package identity does not match installed application");
    String[] candidate=lineage(signatures(candidateInfo)), installed=lineage(signatures(manager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)));
    if (!MessageDigest.isEqual(lineageDigest(candidate).getBytes(StandardCharsets.US_ASCII), update.signerLineageSha256.getBytes(StandardCharsets.US_ASCII)) || !isAllowedRotation(installed,candidate)) throw new SecurityException("APK signer lineage does not match installed application");
  }
  static boolean isAllowedRotation(String[] installed, String[] candidate) {
    if(installed.length==0 || candidate.length<installed.length) return false;
    for(int i=0;i<installed.length;i++) if(!MessageDigest.isEqual(installed[i].getBytes(StandardCharsets.US_ASCII),candidate[i].getBytes(StandardCharsets.US_ASCII))) return false;
    return true;
  }
  private static Signature[] signatures(PackageInfo info) throws SecurityException {
    if (info == null || info.signingInfo == null) throw new SecurityException("APK signing lineage is unavailable");
    Signature[] result=info.signingInfo.hasPastSigningCertificates() ? info.signingInfo.getSigningCertificateHistory() : info.signingInfo.getApkContentsSigners();
    if (result == null || result.length == 0) throw new SecurityException("APK signing lineage is unavailable"); return result;
  }
  private static String[] lineage(Signature[] signatures) throws Exception { String[] values=new String[signatures.length]; for(int i=0;i<signatures.length;i++) values[i]=hex(MessageDigest.getInstance("SHA-256").digest(signatures[i].toByteArray())); return values; }
  private static String lineageDigest(String[] values) throws Exception { MessageDigest digest=MessageDigest.getInstance("SHA-256"); for(String value:values) { digest.update(value.getBytes(StandardCharsets.US_ASCII)); digest.update((byte)'\n'); } return hex(digest.digest()); }
  private static byte[] fetch(String value, long maximum) throws Exception { HttpsURLConnection connection=null; try { connection=openHttps(value); long length=connection.getContentLengthLong(); if(length>maximum) throw new SecurityException("Update download exceeds signed size bound"); try(BufferedInputStream input=new BufferedInputStream(connection.getInputStream()); ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] buffer=new byte[32*1024];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>maximum)throw new SecurityException("Update download exceeds signed size bound");output.write(buffer,0,count);}return output.toByteArray();} } finally { if(connection!=null)connection.disconnect(); } }
  private static HttpsURLConnection openHttps(String value) throws Exception { if(!isHttps(value)) throw new SecurityException("Update URL must use HTTPS"); HttpsURLConnection connection=(HttpsURLConnection)new URL(value).openConnection(); connection.setConnectTimeout(CONNECT_TIMEOUT_MS); connection.setReadTimeout(READ_TIMEOUT_MS); connection.setUseCaches(false); connection.setInstanceFollowRedirects(false); connection.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive"); int status=connection.getResponseCode(); if(status<200||status>=300) { connection.disconnect(); throw new SecurityException("Update download was rejected"); } return connection; }
  private static boolean isHttps(String value) { try { URI uri=URI.create(value); return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost()!=null && uri.getUserInfo()==null && uri.getFragment()==null; } catch(Exception error) { return false; } }
  private static String hex(byte[] value) { StringBuilder out=new StringBuilder(value.length*2); for(byte b:value)out.append(String.format(Locale.ROOT,"%02x",b&255)); return out.toString(); }
  private static String normalizeDigest(String value) { String normalized=value.toLowerCase(Locale.ROOT); if(!normalized.matches("[0-9a-f]{64}"))throw new SecurityException("Invalid SHA-256 digest"); return normalized; }
}
