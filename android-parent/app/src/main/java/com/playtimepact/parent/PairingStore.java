package com.playtimepact.parent;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypted, local-only storage for the currently paired household. */
public final class PairingStore {
  private static final String PREFS = "playtimepact.pairing";
  private static final String VALUE = "encrypted_pairing";
  private static final String KEY_ALIAS = "playtimepact.parent.pairing.v1";
  private static final String MIGRATION_REQUIRED = "signing_key_migration_required";
  private static final int CURRENT_SIGNING_KEY_VERSION = 2;
  private final SharedPreferences preferences;

  public PairingStore(Context context) {
    preferences = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** Parses only the canonical one-time pairing URI. */
  public static Pairing parsePairingUri(String rawUri) throws PairingException {
    try {
      Uri uri = Uri.parse(rawUri);
      if (!"playtimepact".equals(uri.getScheme()) || !"pair".equals(uri.getAuthority())
          || uri.getPath() != null && !uri.getPath().isEmpty() || uri.getFragment() != null
          || uri.getUserInfo() != null || uri.getPort() != -1) throw new PairingException("Invalid pairing URI");
      Set<String> expected = new HashSet<>(Arrays.asList("baseUrl", "householdId", "parentId", "token", "membershipEpoch", "serviceEpoch"));
      Set<String> names = uri.getQueryParameterNames();
      if (!names.equals(expected)) throw new PairingException("Invalid pairing URI parameters");
      for (String name : expected) if (uri.getQueryParameters(name).size() != 1) throw new PairingException("Duplicate pairing URI parameter");
      String baseUrl = uri.getQueryParameter("baseUrl");
      String householdId = required(uri, "householdId");
      String parentId = required(uri, "parentId");
      String token = required(uri, "token");
      long membershipEpoch = positiveLong(required(uri, "membershipEpoch"), "membershipEpoch");
      long serviceEpoch = positiveLong(required(uri, "serviceEpoch"), "serviceEpoch");
      Uri base = Uri.parse(baseUrl);
      if (!"https".equals(base.getScheme()) || base.getHost() == null || base.getUserInfo() != null
          || base.getFragment() != null || base.getQuery() != null) throw new PairingException("Pairing server must use HTTPS");
      if (token.length() < 43 || token.length() > 128 || !token.matches("[A-Za-z0-9_-]+")) {
        throw new PairingException("Pairing token must be a high-entropy base64url secret");
      }
      String normalizedBase = base.toString();
      if (normalizedBase.endsWith("/")) normalizedBase = normalizedBase.substring(0, normalizedBase.length() - 1);
      return new Pairing(normalizedBase, householdId, parentId, token, membershipEpoch, serviceEpoch);
    } catch (PairingException e) {
      throw e;
    } catch (Exception e) {
      throw new PairingException("Invalid pairing URI", e);
    }
  }

  public synchronized void save(Pairing pairing) throws PairingException {
    if (pairing == null) throw new IllegalArgumentException("pairing is required");
    try {
      JSONObject json = new JSONObject();
      json.put("baseUrl", pairing.baseUrl); json.put("householdId", pairing.householdId);
      json.put("parentId", pairing.parentId); json.put("token", pairing.token);
      json.put("membershipEpoch", pairing.membershipEpoch); json.put("serviceEpoch", pairing.serviceEpoch);
      json.put("signingKeyVersion", pairing.signingKeyVersion);
      if (pairing.pendingResetOperationKey != null) json.put("pendingResetOperationKey", pairing.pendingResetOperationKey);
      if (pairing.pendingDeleteOperationKey != null) json.put("pendingDeleteOperationKey", pairing.pendingDeleteOperationKey);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key());
      byte[] iv = cipher.getIV();
      byte[] encrypted = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
      byte[] blob = new byte[iv.length + encrypted.length];
      System.arraycopy(iv, 0, blob, 0, iv.length); System.arraycopy(encrypted, 0, blob, iv.length, encrypted.length);
      if (!preferences.edit().putString(VALUE, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()) throw new PairingException("Unable to save pairing");
    } catch (PairingException e) { throw e;
    } catch (Exception e) { throw new PairingException("Unable to save pairing", e); }
  }

  /** Returns null only when no pairing exists. Corrupt encrypted data is cleared and rejected. */
  public synchronized Pairing load() throws PairingException {
    String encoded = preferences.getString(VALUE, null);
    if (encoded == null) return null;
    try {
      byte[] blob = Base64.decode(encoded, Base64.NO_WRAP);
      if (blob.length <= 12 + 16) throw new PairingException("Corrupt pairing data");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, blob, 0, 12));
      JSONObject json = new JSONObject(new String(cipher.doFinal(blob, 12, blob.length - 12), StandardCharsets.UTF_8));
      return new Pairing(
          json.getString("baseUrl"), json.getString("householdId"), json.getString("parentId"),
          json.getString("token"), json.getLong("membershipEpoch"), json.getLong("serviceEpoch"),
          json.optString("pendingResetOperationKey", null),json.optString("pendingDeleteOperationKey",null),json.optInt("signingKeyVersion",1));
    } catch (Exception e) {
      clear();
      if (e instanceof PairingException) throw (PairingException) e;
      throw new PairingException("Unable to decrypt pairing", e);
    }
  }

  public synchronized boolean isPaired() {
    if(!preferences.contains(VALUE)) return false;
    try {
      Pairing pairing=load();
      if(pairing==null) return false;
      if(pairing.signingKeyVersion!=CURRENT_SIGNING_KEY_VERSION) {
        clear();
        preferences.edit().putBoolean(MIGRATION_REQUIRED,true).commit();
        return false;
      }
      return true;
    } catch(PairingException error) {
      return false;
    }
  }
  public synchronized void clear() { preferences.edit().remove(VALUE).apply(); }
  public synchronized boolean consumeMigrationRequired() {
    boolean required=preferences.getBoolean(MIGRATION_REQUIRED,false);
    if(required) preferences.edit().remove(MIGRATION_REQUIRED).apply();
    return required;
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    if (!store.containsAlias(KEY_ALIAS)) {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256).build());
      generator.generateKey();
    }
    return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
  }

  private static String required(Uri uri, String name) throws PairingException {
    String value = uri.getQueryParameter(name);
    if (value == null || value.trim().isEmpty() || value.length() > 4096) throw new PairingException("Missing pairing " + name);
    return value;
  }

  private static long positiveLong(String value, String name) throws PairingException {
    try {
      long parsed = Long.parseLong(value);
      if (parsed <= 0) throw new NumberFormatException();
      return parsed;
    } catch (NumberFormatException error) {
      throw new PairingException("Invalid pairing " + name, error);
    }
  }

  public static final class Pairing {
    private final String baseUrl, householdId, parentId, token, pendingResetOperationKey, pendingDeleteOperationKey;
    private final long membershipEpoch, serviceEpoch;
    private final int signingKeyVersion;
    public Pairing(String baseUrl, String householdId, String parentId, String token, long membershipEpoch, long serviceEpoch) {
      this(baseUrl, householdId, parentId, token, membershipEpoch, serviceEpoch, null, null, CURRENT_SIGNING_KEY_VERSION);
    }
    private Pairing(String baseUrl, String householdId, String parentId, String token, long membershipEpoch, long serviceEpoch, String pendingResetOperationKey, String pendingDeleteOperationKey, int signingKeyVersion) {
      this.baseUrl = baseUrl; this.householdId = householdId; this.parentId = parentId; this.token = token;
      this.membershipEpoch = membershipEpoch; this.serviceEpoch = serviceEpoch;
      this.pendingResetOperationKey = pendingResetOperationKey; this.pendingDeleteOperationKey=pendingDeleteOperationKey;
      this.signingKeyVersion=signingKeyVersion;
    }
    public Pairing withPendingReset(String operationKey) {
      return new Pairing(baseUrl, householdId, parentId, token, membershipEpoch, serviceEpoch, operationKey, pendingDeleteOperationKey, signingKeyVersion);
    }
    public Pairing withPendingDelete(String operationKey) {
      return new Pairing(baseUrl, householdId, parentId, token, membershipEpoch, serviceEpoch, pendingResetOperationKey, operationKey, signingKeyVersion);
    }
    public Pairing withEpochs(long nextMembershipEpoch, long nextServiceEpoch) {
      return new Pairing(baseUrl, householdId, parentId, "", nextMembershipEpoch, nextServiceEpoch, null, null, signingKeyVersion);
    }
    public String getBaseUrl() { return baseUrl; }
    public String getHouseholdId() { return householdId; }
    public String getParentId() { return parentId; }
    public String getToken() { return token; }
    public long getMembershipEpoch() { return membershipEpoch; }
    public long getServiceEpoch() { return serviceEpoch; }
    public String getPendingResetOperationKey() { return pendingResetOperationKey; }
    public String getPendingDeleteOperationKey() { return pendingDeleteOperationKey; }
  }
  public static final class PairingException extends Exception {
    PairingException(String message) { super(message); }
    PairingException(String message, Throwable cause) { super(message, cause); }
  }
}
