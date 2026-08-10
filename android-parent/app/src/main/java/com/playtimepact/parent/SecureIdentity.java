package com.playtimepact.parent;

import android.content.Context;
import android.os.Build;
import android.os.Looper;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Owns the non-exportable signing identity for this installation. */
public final class SecureIdentity {
  private static final String STORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "playtimepact.parent.signing.v2";
  private final Context appContext;
  private final FragmentActivity activity;

  public SecureIdentity(Context context) {
    appContext = context.getApplicationContext();
    activity = context instanceof FragmentActivity ? (FragmentActivity) context : null;
  }

  /** Creates the key on first use. The private key is never returned or exported. */
  public synchronized void ensureKey() throws SecureIdentityException {
    try {
      KeyStore store = KeyStore.getInstance(STORE);
      store.load(null);
      if (store.containsAlias(KEY_ALIAS)) return;
      KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE);
      KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
          .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setUserAuthenticationRequired(true);
      if (Build.VERSION.SDK_INT >= 30) {
        builder.setUserAuthenticationParameters(
            0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
      } else {
        builder.setUserAuthenticationValidityDurationSeconds(-1);
      }
      generator.initialize(builder.build());
      generator.generateKeyPair();
    } catch (Exception e) {
      throw new SecureIdentityException("Unable to create signing identity", e);
    }
  }

  public String publicJwk() throws SecureIdentityException {
    try {
      ECPublicKey key = (ECPublicKey) keyPair().getPublic();
      int bytes = 32;
      JSONObject jwk = new JSONObject();
      jwk.put("crv", "P-256");
      jwk.put("kty", "EC");
      jwk.put("x", base64Url(unsigned(key.getW().getAffineX().toByteArray(), bytes)));
      jwk.put("y", base64Url(unsigned(key.getW().getAffineY().toByteArray(), bytes)));
      return jwk.toString();
    } catch (Exception e) {
      throw new SecureIdentityException("Unable to read public identity", e);
    }
  }


  public Proof signProof(
      String method,
      String canonicalUrl,
      String canonicalBody,
      String actorId,
      long membershipEpoch,
      long serviceEpoch,
      String idempotencyKey,
      int clientVersionCode) throws SecureIdentityException {
    if (method == null || canonicalUrl == null || canonicalBody == null || actorId == null
        || idempotencyKey == null || membershipEpoch <= 0 || serviceEpoch <= 0 || clientVersionCode <= 0) {
      throw new IllegalArgumentException("Complete proof binding is required");
    }
    try {
      JSONObject jwk = new JSONObject(publicJwk());
      JSONObject header = new JSONObject();
      header.put("alg", "ES256");
      header.put("jwk", jwk);
      header.put("typ", "remote-approval+jws");

      String nonce = UUID.randomUUID().toString();
      JSONObject payload = proofClaims(method, canonicalUrl, canonicalBody, actorId, membershipEpoch, serviceEpoch, idempotencyKey, clientVersionCode, nonce, UUID.randomUUID().toString());

      String protectedPart = base64Url(header.toString().getBytes(StandardCharsets.UTF_8));
      String payloadPart = base64Url(payload.toString().getBytes(StandardCharsets.UTF_8));
      byte[] input = (protectedPart + "." + payloadPart).getBytes(StandardCharsets.US_ASCII);
      byte[] signature=authenticatedSign(input);
      return new Proof(protectedPart, payloadPart, base64Url(derToJose(signature, 32)));
    } catch (Exception e) {
      throw new SecureIdentityException("User authentication is required to sign this request", e);
    }
  }
  static JSONObject proofClaims(String method,String canonicalUrl,String canonicalBody,String actorId,long membershipEpoch,long serviceEpoch,String idempotencyKey,int clientVersionCode,String nonce,String jti) throws Exception {
    if(clientVersionCode<=0) throw new IllegalArgumentException("clientVersionCode is required");
    JSONObject payload=new JSONObject();
    payload.put("actorId",actorId);
    String digest=Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(canonicalBody.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
    payload.put("contentDigest","sha-256=:"+digest+":"); payload.put("htm",method.toUpperCase(java.util.Locale.US)); payload.put("htu",canonicalUrl); payload.put("iat",System.currentTimeMillis()/1000L); payload.put("idempotencyKey",idempotencyKey); payload.put("jti",jti); payload.put("membershipEpoch",membershipEpoch); payload.put("nonce",nonce); payload.put("serviceEpoch",serviceEpoch); payload.put("clientVersionCode",clientVersionCode); return payload;
  }

  private byte[] authenticatedSign(byte[] input) throws Exception {
    if(activity==null) throw new SecureIdentityException("A visible parent activity is required for user authentication");
    if(Looper.myLooper()==Looper.getMainLooper()) throw new SecureIdentityException("Signing must not block the main thread");
    Signature signature=Signature.getInstance("SHA256withECDSA");
    signature.initSign((PrivateKey) keyPair().getPrivate());
    signature.update(input);
    CountDownLatch completed=new CountDownLatch(1);
    AtomicReference<byte[]> result=new AtomicReference<>();
    AtomicReference<Throwable> failure=new AtomicReference<>();
    activity.runOnUiThread(() -> {
      BiometricPrompt prompt=new BiometricPrompt(activity,ContextCompat.getMainExecutor(appContext),new BiometricPrompt.AuthenticationCallback() {
        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticationResult) {
          try {
            BiometricPrompt.CryptoObject crypto=authenticationResult.getCryptoObject();
            if(crypto==null || crypto.getSignature()==null) throw new SecurityException("Authenticated signature is unavailable");
            result.set(crypto.getSignature().sign());
          } catch(Throwable error) {
            failure.set(error);
          } finally {
            completed.countDown();
          }
        }
        @Override public void onAuthenticationError(int errorCode, CharSequence message) {
          failure.set(new SecurityException(message.toString()));
          completed.countDown();
        }
      });
      BiometricPrompt.PromptInfo.Builder info=new BiometricPrompt.PromptInfo.Builder()
          .setTitle("부모 승인 확인")
          .setSubtitle("이 요청 한 건에 보안 키 서명을 허용하세요");
      if(Build.VERSION.SDK_INT>=30) {
        info.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
      } else {
        info.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        info.setNegativeButtonText("취소");
      }
      prompt.authenticate(info.build(),new BiometricPrompt.CryptoObject(signature));
    });
    if(!completed.await(90,TimeUnit.SECONDS)) throw new SecureIdentityException("User authentication timed out");
    if(failure.get()!=null) throw new SecureIdentityException("User authentication failed",failure.get());
    if(result.get()==null) throw new SecureIdentityException("Authenticated signature is unavailable");
    return result.get();
  }
  private KeyPair keyPair() throws Exception {
    ensureKey();
    KeyStore store = KeyStore.getInstance(STORE);
    store.load(null);
    return new KeyPair(store.getCertificate(KEY_ALIAS).getPublicKey(),
        (PrivateKey) store.getKey(KEY_ALIAS, null));
  }

  private static byte[] unsigned(byte[] value, int length) {
    byte[] output = new byte[length];
    int source = Math.max(0, value.length - length);
    int count = Math.min(value.length, length);
    System.arraycopy(value, source, output, length - count, count);
    return output;
  }

  /** Converts ASN.1 DER ECDSA output into the fixed 64-byte JWS ES256 representation. */
  static byte[] derToJose(byte[] der, int coordinateLength) throws SecureIdentityException {
    try {
      int offset = 0;
      if (der[offset++] != 0x30) throw new IllegalArgumentException("Not a DER sequence");
      int sequenceLength = derLength(der, offset);
      offset += lengthBytes(der[offset]);
      if (sequenceLength != der.length - offset) throw new IllegalArgumentException("Invalid DER length");
      if (der[offset++] != 0x02) throw new IllegalArgumentException("Missing r");
      int rLength = derLength(der, offset); offset += lengthBytes(der[offset]);
      byte[] r = new byte[rLength]; System.arraycopy(der, offset, r, 0, rLength); offset += rLength;
      if (der[offset++] != 0x02) throw new IllegalArgumentException("Missing s");
      int sLength = derLength(der, offset); offset += lengthBytes(der[offset]);
      if (offset + sLength != der.length) throw new IllegalArgumentException("Invalid s");
      byte[] s = new byte[sLength]; System.arraycopy(der, offset, s, 0, sLength);
      byte[] raw = new byte[coordinateLength * 2];
      System.arraycopy(unsigned(r, coordinateLength), 0, raw, 0, coordinateLength);
      System.arraycopy(unsigned(s, coordinateLength), 0, raw, coordinateLength, coordinateLength);
      return raw;
    } catch (RuntimeException e) {
      throw new SecureIdentityException("Invalid ECDSA signature", e);
    }
  }

  private static int derLength(byte[] value, int offset) {
    int first = value[offset] & 0xff;
    if ((first & 0x80) == 0) return first;
    int count = first & 0x7f;
    if (count == 0 || count > 2 || offset + count >= value.length) throw new IllegalArgumentException("Invalid DER length");
    int result = 0;
    for (int i = 1; i <= count; i++) result = (result << 8) | (value[offset + i] & 0xff);
    return result;
  }

  private static int lengthBytes(byte first) { return ((first & 0x80) == 0) ? 1 : 1 + (first & 0x7f); }
  private static String base64Url(byte[] value) { return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP); }

  public static final class Proof {
    private final String protectedPart, payloadPart, signature;
    private Proof(String protectedPart, String payloadPart, String signature) { this.protectedPart = protectedPart; this.payloadPart = payloadPart; this.signature = signature; }
    public String compactDetached() { return protectedPart + ".." + signature; }
    public String compact() { return protectedPart + "." + payloadPart + "." + signature; }
    public String flattenedJson() { return "{\"payload\":\"" + payloadPart + "\",\"protected\":\"" + protectedPart + "\",\"signature\":\"" + signature + "\"}"; }
  }

  public static final class SecureIdentityException extends Exception {
    SecureIdentityException(String message) { super(message); }
    SecureIdentityException(String message, Throwable cause) { super(message, cause); }
  }
}
