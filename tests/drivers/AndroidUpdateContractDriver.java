import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

/** Standalone JVM mirror of UpdateVerifier's public-key, UTF-8, and SHA256withECDSA contract. */
public final class AndroidUpdateContractDriver {
  public static void main(String[] args) throws Exception {
    if (args.length != 3) {
      System.err.println("Usage: AndroidUpdateContractDriver <public-key.b64> <canonical-bytes> <signature-base64url>");
      System.exit(2);
    }
    String publicKeyBase64 = Files.readString(Path.of(args[0]), StandardCharsets.US_ASCII).trim();
    PublicKey key = KeyFactory.getInstance("EC").generatePublic(
        new X509EncodedKeySpec(Base64.getDecoder().decode(publicKeyBase64)));
    byte[] canonical = Files.readAllBytes(Path.of(args[1]));
    Signature verifier = Signature.getInstance("SHA256withECDSA");
    verifier.initVerify(key);
    verifier.update(canonical);
    if (!verifier.verify(Base64.getUrlDecoder().decode(args[2]))) {
      System.err.println("FAIL Java SHA256withECDSA contract rejected signature");
      System.exit(1);
    }
    System.out.println("PASS Java SHA256withECDSA contract accepted signature");
  }
}
