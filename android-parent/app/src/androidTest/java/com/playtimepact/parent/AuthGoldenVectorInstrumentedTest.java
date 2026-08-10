package com.playtimepact.parent;

import static org.junit.Assert.assertTrue;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.KeySpec;

@RunWith(AndroidJUnit4.class)
public final class AuthGoldenVectorInstrumentedTest {
  private static final String ALIAS = "playtime-pact-vector-test";
  private static final String X = "RD5y0WyFcRC0y6UpuVjP5BhpaJeydOWFaWKOj8gRGWM";
  private static final String Y = "IiMy7SxjNbsvY_agm_Lweo_jTeducGFpS5SWvxOjd4A";
  private static final String PROTECTED = "eyJhbGciOiJFUzI1NiIsImp3ayI6eyJrdHkiOiJFQyIsIngiOiJSRDV5MFd5RmNSQzB5NlVwdVZqUDVCaHBhSmV5ZE9XRmFXS09qOGdSR1dNIiwieSI6IklpTXk3U3hqTmJzdllfYWdtX0x3ZW9falRlZHVjR0ZwUzVTV3Z4T2pkNEEiLCJjcnYiOiJQLTI1NiJ9LCJ0eXAiOiJyZW1vdGUtYXBwcm92YWwrandzIn0";
  private static final String PAYLOAD = "eyJhY3RvcklkIjoicGFyZW50LXZlY3RvciIsImNvbnRlbnREaWdlc3QiOiJzaGEtMjU2PTp5Z28zdGFuSFZ5TE84MUdST1ZNcEhHQ05XT3dKK3puQjZLaVJnUVNDbVl3PToiLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9hcHByb3ZhbC5leGFtcGxlL3YxL3JlcXVlc3RzL3IxL3Jlc3BvbmQiLCJpYXQiOjQwMDAsImlkZW1wb3RlbmN5S2V5IjoiaWRlbXBvdGVuY3ktdmVjdG9yLTAwMDEiLCJqdGkiOiJqdGktdmVjdG9yLTAwMDEiLCJtZW1iZXJzaGlwRXBvY2giOjMsIm5vbmNlIjoibm9uY2UtdmVjdG9yLTAwMDEiLCJzZXJ2aWNlRXBvY2giOjh9";
  private static final String SIGNATURE = "oMW_tE4_aBvjKzbMjnx68FrJpm1Y4l3gvJtjV81YTrJwUF3DcC4jQVtpP1lzLpApEeAWRc6KRBukgGftspxNNA";

  @Test
  public void verifiesNodeVectorAndSignsWithAndroidKeystore() throws Exception {
    byte[] signingInput = (PROTECTED + "." + PAYLOAD).getBytes(StandardCharsets.US_ASCII);
    AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
    parameters.init(new ECGenParameterSpec("secp256r1"));
    ECParameterSpec curve = parameters.getParameterSpec(ECParameterSpec.class);
    ECPoint point = new ECPoint(unsigned(X), unsigned(Y));
    KeySpec keySpec = new ECPublicKeySpec(point, curve);
    ECPublicKey vectorKey = (ECPublicKey) java.security.KeyFactory.getInstance("EC").generatePublic(keySpec);
    Signature verifier = Signature.getInstance("SHA256withECDSA");
    verifier.initVerify(vectorKey);
    verifier.update(signingInput);
    assertTrue(verifier.verify(rawEs256ToDer(decode(SIGNATURE))));

    KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    keyStore.deleteEntry(ALIAS);
    KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
    generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
        .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .build());
    KeyPair keyPair = generator.generateKeyPair();
    Signature signer = Signature.getInstance("SHA256withECDSA");
    signer.initSign(keyPair.getPrivate());
    signer.update(signingInput);
    byte[] androidSignature = signer.sign();
    Signature androidVerifier = Signature.getInstance("SHA256withECDSA");
    androidVerifier.initVerify(keyPair.getPublic());
    androidVerifier.update(signingInput);
    assertTrue(androidVerifier.verify(androidSignature));
    keyStore.deleteEntry(ALIAS);
  }

  private static BigInteger unsigned(String value) {
    return new BigInteger(1, decode(value));
  }

  private static byte[] decode(String value) {
    return Base64.decode(value, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
  }

  private static byte[] rawEs256ToDer(byte[] raw) throws Exception {
    if (raw.length != 64) throw new IllegalArgumentException("ES256 signature must be 64 bytes");
    byte[] r = derInteger(raw, 0);
    byte[] s = derInteger(raw, 32);
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    output.write(0x30);
    output.write(r.length + s.length);
    output.write(r);
    output.write(s);
    return output.toByteArray();
  }

  private static byte[] derInteger(byte[] raw, int offset) throws Exception {
    int first = offset;
    while (first < offset + 31 && raw[first] == 0) first++;
    boolean needsLeadingZero = (raw[first] & 0x80) != 0;
    int length = offset + 32 - first;
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    output.write(0x02);
    output.write(length + (needsLeadingZero ? 1 : 0));
    if (needsLeadingZero) output.write(0);
    output.write(raw, first, length);
    return output.toByteArray();
  }
}
