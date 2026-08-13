import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  CANONICAL_FIELDS,
  canonicalManifestBytes,
  parseArguments,
  signAndroidUpdate,
} from '../scripts/sign-android-update.mjs'
import { verifyAndroidUpdate } from '../scripts/verify-android-update.mjs'

const EXPECTED_FIELDS = [
  'applicationId',
  'versionCode',
  'minimumSupportedVersionCode',
  'versionName',
  'apkSha256',
  'sizeBytes',
  'apkUrl',
  'releaseNotes',
  'signerLineageSha256',
  'issuedAtMillis',
  'expiresAtMillis',
]

const javaSource = readFileSync(new URL('../android-parent/app/src/main/java/com/playtimepact/parent/UpdateVerifier.java', import.meta.url), 'utf8')

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-update-'))
  const apkPath = join(directory, 'candidate.apk')
  const apkBytes = Buffer.from('disposable APK fixture\n', 'utf8')
  writeFileSync(apkPath, apkBytes)
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKeyPath = join(directory, 'update-private.pem')
  const publicKeyPath = join(directory, 'update-public.b64')
  const manifestPath = join(directory, 'manifest.json')
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
  return { directory, apkPath, apkBytes, privateKey, publicKey, privateKeyPath, publicKeyPath, manifestPath }
}

test('canonical bytes use the exact Android UpdateVerifier field order and Java signature encoding', () => {
  assert.deepEqual(CANONICAL_FIELDS, EXPECTED_FIELDS)
  const javaCanonical = javaSource.match(/String canonical=(.*?);\s*java\.security\.Signature/s)?.[1]
  assert.ok(javaCanonical, 'Java canonical expression was not found')
  const javaFields = [...javaCanonical.matchAll(/(?:^|\+)\s*(applicationId|version|minimum|name|sha|size|url|notes|lineage|issued|expires)(?=\+|$)/g)].map((match) => match[1])
  assert.deepEqual(javaFields, ['applicationId', 'version', 'minimum', 'name', 'sha', 'size', 'url', 'notes', 'lineage', 'issued', 'expires'])

  const manifest = {
    applicationId: 'com.playtimepact.parent', versionCode: 42, minimumSupportedVersionCode: 30,
    versionName: '4.2.0', apkSha256: 'a'.repeat(64), sizeBytes: 123,
    apkUrl: 'https://updates.example/parent.apk', releaseNotes: 'Line one\nLine two',
    signerLineageSha256: 'b'.repeat(64), issuedAtMillis: 1_800_000_000_000,
    expiresAtMillis: 1_800_086_400_000,
  }
  const expected = EXPECTED_FIELDS.map((field) => String(manifest[field])).join('\n')
  assert.deepEqual(canonicalManifestBytes(manifest), Buffer.from(expected, 'utf8'))

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const signature = cryptoSign('sha256', canonicalManifestBytes(manifest), { key: privateKey, dsaEncoding: 'der' })
  assert.equal(cryptoVerify('sha256', canonicalManifestBytes(manifest), publicKey, signature), true)
  assert.doesNotMatch(signature.toString('base64url'), /=/)
})

const NOW = 1_800_000_000_000
const LINEAGE = createHash('sha256').update('ordered APK signing certificate lineage\n').digest('hex')

async function signedFixture(overrides = {}) {
  const value = fixture()
  const options = {
    apkPath: value.apkPath,
    apkUrl: 'https://updates.example/parent-v42.apk',
    versionCode: 42,
    minimumSupportedVersionCode: 30,
    versionName: '4.2.0',
    signerLineageSha256: LINEAGE,
    issuedAtMillis: NOW - 1_000,
    expiresAtMillis: NOW + 60_000,
    releaseNotes: 'Safe release\nSecond line',
    outputPath: value.manifestPath,
    publicKeyOutputPath: value.publicKeyPath,
    signingKeyPath: value.privateKeyPath,
    nowMillis: NOW,
    ...overrides,
  }
  try {
    await signAndroidUpdate(options)
    return { ...value, options, manifest: JSON.parse(readFileSync(value.manifestPath, 'utf8')) }
  } catch (error) {
    rmSync(value.directory, { recursive: true, force: true })
    throw error
  }
}

const verifyOptions = (value, overrides = {}) => ({
  manifestPath: value.manifestPath,
  apkPath: value.apkPath,
  publicKeyPath: value.publicKeyPath,
  installedVersionCode: 41,
  signerLineageSha256: LINEAGE,
  nowMillis: NOW,
  ...overrides,
})

async function withFixture(body, overrides) {
  const value = await signedFixture(overrides)
  try { await body(value) } finally { rmSync(value.directory, { recursive: true, force: true }) }
}

test('valid locally signed manifest and actual APK pass pre-upload verification', async () => {
  await withFixture(async (value) => {
    const result = await verifyAndroidUpdate(verifyOptions(value))
    assert.deepEqual(result, {
      ok: true,
      applicationId: 'com.playtimepact.parent',
      versionCode: 42,
      apkSha256: createHash('sha256').update(value.apkBytes).digest('hex'),
    })
    assert.match(readFileSync(value.publicKeyPath, 'utf8').trim(), /^[A-Za-z0-9+/]+={0,2}$/)
    assert.doesNotMatch(readFileSync(value.manifestPath, 'utf8'), /PRIVATE KEY|BEGIN EC|BEGIN PRIVATE|"d"\s*:/)
  })
})

test('tampered APK and every signature-bound manifest field fail', async () => {
  await withFixture(async (value) => {
    writeFileSync(value.apkPath, Buffer.from('tampered APK fixture\n'))
    await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value)), /APK_(SIZE|SHA256)_MISMATCH/)
  })

  const replacements = {
    applicationId: 'com.example.attacker',
    versionCode: 43,
    minimumSupportedVersionCode: 31,
    versionName: '4.2.1',
    apkSha256: 'c'.repeat(64),
    sizeBytes: 999,
    apkUrl: 'https://evil.example/parent.apk',
    releaseNotes: 'tampered notes',
    signerLineageSha256: 'd'.repeat(64),
    issuedAtMillis: NOW - 2_000,
    expiresAtMillis: NOW + 70_000,
  }
  for (const [field, replacement] of Object.entries(replacements)) {
    await withFixture(async (value) => {
      writeFileSync(value.manifestPath, `${JSON.stringify({ ...value.manifest, [field]: replacement })}\n`)
      await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value)), /MISMATCH|INVALID|UPDATE_/)
    })
  }
})

test('wrong key, validity bounds, HTTP URL, downgrade, and wrong signer lineage all fail closed', async () => {
  await withFixture(async (value) => {
    const wrong = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    const wrongPath = join(value.directory, 'wrong-public.b64')
    writeFileSync(wrongPath, wrong.export({ type: 'spki', format: 'der' }).toString('base64'))
    await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value, { publicKeyPath: wrongPath })), /SIGNATURE_MISMATCH/)
    await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value, { nowMillis: value.manifest.expiresAtMillis })), /UPDATE_EXPIRED/)
    await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value, { nowMillis: value.manifest.issuedAtMillis - 1 })), /UPDATE_NOT_YET_VALID/)
    await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value, { installedVersionCode: 42 })), /UPDATE_DOWNGRADE_OR_NOT_NEWER/)
    await assert.rejects(() => verifyAndroidUpdate(verifyOptions(value, { signerLineageSha256: 'e'.repeat(64) })), /SIGNER_LINEAGE_MISMATCH/)
  })
  await assert.rejects(() => signedFixture({ apkUrl: 'http://updates.example/parent.apk' }), /INVALID_APK_URL/)
})

test('malformed input and stale output cannot be mistaken for a successful repeat', async () => {
  assert.throws(() => parseArguments(['--apk']), /MISSING_ARGUMENT_VALUE/)
  assert.throws(() => parseArguments(['--apk', 'one', '--apk', 'two']), /DUPLICATE_ARGUMENT/)
  await withFixture(async (value) => {
    await assert.rejects(() => signAndroidUpdate({ ...value.options, apkUrl: 'http://invalid.example/apk' }), /INVALID_APK_URL/)
    assert.equal(readFileOrNull(value.manifestPath), null)
    assert.equal(readFileOrNull(value.publicKeyPath), null)
  })
})

function readFileOrNull(path) {
  try { return readFileSync(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

test('Node signature verifies with the Java SHA256withECDSA contract driver', async (context) => {
  const javac = process.env.JAVAC ?? 'javac'
  const java = process.env.JAVA ?? 'java'
  const probe = spawnSync(javac, ['-version'], { encoding: 'utf8', timeout: 5_000 })
  if (probe.error?.code === 'ENOENT') {
    context.skip('javac is not available; set JAVAC and JAVA to run compatibility coverage')
    return
  }
  assert.equal(probe.status, 0, probe.stderr)
  await withFixture(async (value) => {
    const canonicalPath = join(value.directory, 'canonical.bin')
    writeFileSync(canonicalPath, canonicalManifestBytes(value.manifest))
    const source = fileURLToPath(new URL('./drivers/AndroidUpdateContractDriver.java', import.meta.url))
    const compilation = spawnSync(javac, ['-d', value.directory, source], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(compilation.status, 0, compilation.stderr)
    const accepted = spawnSync(java, ['-cp', value.directory, 'AndroidUpdateContractDriver', value.publicKeyPath, canonicalPath, value.manifest.signature], { encoding: 'utf8', timeout: 5_000 })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /^PASS Java SHA256withECDSA contract accepted signature/)
    writeFileSync(canonicalPath, Buffer.concat([canonicalManifestBytes(value.manifest), Buffer.from('tamper')]))
    const rejected = spawnSync(java, ['-cp', value.directory, 'AndroidUpdateContractDriver', value.publicKeyPath, canonicalPath, value.manifest.signature], { encoding: 'utf8', timeout: 5_000 })
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /^FAIL Java SHA256withECDSA contract rejected signature/)
  })
})

const ANDROID_STUB_SOURCES = {
  'android/util/Base64.java': `package android.util;
public final class Base64 {
  public static final int DEFAULT = 0, NO_PADDING = 1, NO_WRAP = 2, URL_SAFE = 8;
  private Base64() { }
  public static byte[] decode(String value, int flags) {
    String trimmed = value.trim();
    java.util.Base64.Decoder decoder = (flags & URL_SAFE) != 0 ? java.util.Base64.getUrlDecoder() : java.util.Base64.getMimeDecoder();
    return decoder.decode(trimmed);
  }
}
`,
  'android/os/Build.java': `package android.os;
public final class Build { public static final class VERSION { public static final int SDK_INT = 34; } }
`,
  'android/content/Context.java': `package android.content;
public abstract class Context {
  public static final int MODE_PRIVATE = 0;
  public abstract Context getApplicationContext();
  public abstract SharedPreferences getSharedPreferences(String name, int mode);
  public abstract android.content.pm.PackageManager getPackageManager();
  public abstract String getPackageName();
}
`,
  'android/content/SharedPreferences.java': `package android.content;
public interface SharedPreferences {
  Editor edit();
  boolean getBoolean(String key, boolean fallback);
  long getLong(String key, long fallback);
  interface Editor {
    Editor putBoolean(String key, boolean value);
    Editor putLong(String key, long value);
    boolean commit();
  }
}
`,
  'android/content/pm/PackageManager.java': `package android.content.pm;
public abstract class PackageManager {
  public static final int GET_SIGNING_CERTIFICATES = 0x08000000;
  public abstract PackageInfo getPackageArchiveInfo(String path, int flags);
  public abstract PackageInfo getPackageInfo(String packageName, int flags) throws Exception;
}
`,
  'android/content/pm/PackageInfo.java': `package android.content.pm;
public class PackageInfo { public String packageName; public SigningInfo signingInfo; }
`,
  'android/content/pm/SigningInfo.java': `package android.content.pm;
public class SigningInfo {
  public boolean hasPastSigningCertificates() { return false; }
  public Signature[] getSigningCertificateHistory() { return null; }
  public Signature[] getApkContentsSigners() { return null; }
}
`,
  'android/content/pm/Signature.java': `package android.content.pm;
public class Signature { private final byte[] value; public Signature(byte[] value) { this.value = value; } public byte[] toByteArray() { return value; } }
`,
  'org/json/JSONException.java': `package org.json;
public class JSONException extends RuntimeException { public JSONException(String message) { super(message); } }
`,
  // Mirrors the org.json accessor contract UpdateVerifier relies on: ordered keys, strict typed getters, JSONException on absence.
  'org/json/JSONObject.java': `package org.json;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;
public class JSONObject {
  private final Map<String, Object> values = new LinkedHashMap<>();
  public JSONObject(String source) {
    Object parsed = MiniJson.parse(source);
    if (!(parsed instanceof Map)) throw new JSONException("Value is not a JSON object");
    @SuppressWarnings("unchecked") Map<String, Object> map = (Map<String, Object>) parsed;
    values.putAll(map);
  }
  public int length() { return values.size(); }
  public boolean has(String key) { return values.containsKey(key); }
  public Iterator<String> keys() { return values.keySet().iterator(); }
  public long getLong(String key) {
    Object value = require(key);
    if (value instanceof Number) return ((Number) value).longValue();
    if (value instanceof String) { try { return Long.parseLong(((String) value).trim()); } catch (NumberFormatException error) { throw new JSONException("Not a long: " + key); } }
    throw new JSONException("Not a long: " + key);
  }
  public String getString(String key) {
    Object value = require(key);
    if (value instanceof String) return (String) value;
    if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
    throw new JSONException("Not a string: " + key);
  }
  private Object require(String key) {
    Object value = values.get(key);
    if (value == null) throw new JSONException("No value for " + key);
    return value;
  }
}
`,
  'org/json/MiniJson.java': `package org.json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
/** Disposable strict JSON reader backing the org.json stub used by the UpdateVerifier driver. */
final class MiniJson {
  private final String source;
  private int index;
  private MiniJson(String source) { this.source = source; }
  static Object parse(String source) {
    MiniJson reader = new MiniJson(source);
    Object value = reader.readValue();
    reader.skipWhitespace();
    if (reader.index != source.length()) throw new JSONException("Trailing JSON content");
    return value;
  }
  private Object readValue() {
    skipWhitespace();
    char c = peek();
    if (c == '{') return readObject();
    if (c == '[') return readArray();
    if (c == '"') return readString();
    if (c == 't') { expect("true"); return Boolean.TRUE; }
    if (c == 'f') { expect("false"); return Boolean.FALSE; }
    if (c == 'n') { expect("null"); return null; }
    return readNumber();
  }
  private Map<String, Object> readObject() {
    Map<String, Object> result = new LinkedHashMap<>();
    index++;
    skipWhitespace();
    if (peek() == '}') { index++; return result; }
    while (true) {
      skipWhitespace();
      String key = readString();
      skipWhitespace();
      if (peek() != ':') throw new JSONException("Expected ':'");
      index++;
      result.put(key, readValue());
      skipWhitespace();
      char next = peek();
      index++;
      if (next == '}') return result;
      if (next != ',') throw new JSONException("Expected ',' or '}'");
    }
  }
  private List<Object> readArray() {
    List<Object> result = new ArrayList<>();
    index++;
    skipWhitespace();
    if (peek() == ']') { index++; return result; }
    while (true) {
      result.add(readValue());
      skipWhitespace();
      char next = peek();
      index++;
      if (next == ']') return result;
      if (next != ',') throw new JSONException("Expected ',' or ']'");
    }
  }
  private String readString() {
    if (peek() != '"') throw new JSONException("Expected string");
    index++;
    StringBuilder out = new StringBuilder();
    while (true) {
      char c = next();
      if (c == '"') return out.toString();
      if (c != '\\\\') { out.append(c); continue; }
      char escape = next();
      switch (escape) {
        case '"': out.append('"'); break;
        case '\\\\': out.append('\\\\'); break;
        case '/': out.append('/'); break;
        case 'b': out.append('\\b'); break;
        case 'f': out.append('\\f'); break;
        case 'n': out.append('\\n'); break;
        case 'r': out.append('\\r'); break;
        case 't': out.append('\\t'); break;
        case 'u': out.append((char) Integer.parseInt(source.substring(index, index + 4), 16)); index += 4; break;
        default: throw new JSONException("Invalid escape");
      }
    }
  }
  private Object readNumber() {
    int start = index;
    while (index < source.length() && "+-.eE0123456789".indexOf(source.charAt(index)) >= 0) index++;
    String literal = source.substring(start, index);
    if (literal.isEmpty()) throw new JSONException("Expected value");
    if (literal.indexOf('.') < 0 && literal.indexOf('e') < 0 && literal.indexOf('E') < 0) return Long.valueOf(literal);
    return Double.valueOf(literal);
  }
  private void expect(String literal) {
    if (!source.startsWith(literal, index)) throw new JSONException("Expected " + literal);
    index += literal.length();
  }
  private void skipWhitespace() { while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++; }
  private char peek() { if (index >= source.length()) throw new JSONException("Unexpected end of JSON"); return source.charAt(index); }
  private char next() { char c = peek(); index++; return c; }
}
`,
}

const VERIFIER_DRIVER_SOURCE = `import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import com.playtimepact.parent.UpdateVerifier;

/** Disposable driver that runs the real production UpdateVerifier.verifyManifest against a manifest file. */
public final class AndroidUpdateVerifierDriver {
  public static void main(String[] args) throws Exception {
    if (args.length != 3) { System.err.println("Usage: AndroidUpdateVerifierDriver <manifest.json> <public-key.b64> <installed-version-code>"); System.exit(2); }
    String manifest = Files.readString(Path.of(args[0]), StandardCharsets.UTF_8);
    String publicKey = Files.readString(Path.of(args[1]), StandardCharsets.US_ASCII).trim();
    try {
      UpdateVerifier.VerifiedUpdate update = UpdateVerifier.verifyManifest(manifest, publicKey, Long.parseLong(args[2]));
      System.out.println("ACCEPT versionCode=" + update.versionCode + " issuedAtMillis=" + update.issuedAtMillis);
    } catch (Exception error) {
      System.out.println("REJECT " + error.getClass().getName() + ": " + error.getMessage());
      System.exit(1);
    }
  }
}
`

const verifierSourcePath = fileURLToPath(new URL('../android-parent/app/src/main/java/com/playtimepact/parent/UpdateVerifier.java', import.meta.url))

function compileVerifier(javac, directory) {
  const sourceRoot = join(directory, 'java')
  const classesRoot = join(directory, 'classes')
  mkdirSync(classesRoot, { recursive: true })
  const sources = []
  for (const [relative, contents] of Object.entries(ANDROID_STUB_SOURCES)) {
    const path = join(sourceRoot, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    sources.push(path)
  }
  const driverPath = join(sourceRoot, 'AndroidUpdateVerifierDriver.java')
  writeFileSync(driverPath, VERIFIER_DRIVER_SOURCE)
  sources.push(driverPath, verifierSourcePath)
  const compilation = spawnSync(javac, ['-nowarn', '-d', classesRoot, ...sources], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(compilation.status, 0, compilation.stderr)
  return classesRoot
}

function signManifest(privateKey, manifest) {
  return { ...manifest, signature: cryptoSign('sha256', canonicalManifestBytes(manifest), { key: privateKey, dsaEncoding: 'der' }).toString('base64url') }
}

test('production Android UpdateVerifier rejects unknown manifest fields and future-issued manifests', async (context) => {
  const javac = process.env.JAVAC ?? 'javac'
  const java = process.env.JAVA ?? 'java'
  const probe = spawnSync(javac, ['-version'], { encoding: 'utf8', timeout: 10_000 })
  if (probe.error?.code === 'ENOENT') {
    context.skip('javac is not available; set JAVAC and JAVA to run Android verifier coverage')
    return
  }
  assert.equal(probe.status, 0, probe.stderr)

  const value = fixture()
  try {
    const classesRoot = compileVerifier(javac, value.directory)
    // Bounds are anchored to the real clock the production verifier reads, so every case is decided by the
    // manifest contents rather than by test timing: "valid" stays valid and "future" stays future for a decade.
    const now = Date.now()
    const base = {
      applicationId: 'com.playtimepact.parent',
      versionCode: 42,
      minimumSupportedVersionCode: 30,
      versionName: '4.2.0',
      apkSha256: createHash('sha256').update(value.apkBytes).digest('hex'),
      sizeBytes: value.apkBytes.length,
      apkUrl: 'https://updates.example/parent-v42.apk',
      releaseNotes: 'Safe release\nSecond line',
      signerLineageSha256: LINEAGE,
      issuedAtMillis: now - 60_000,
      expiresAtMillis: now + 10 * 365 * 24 * 60 * 60 * 1000,
    }
    const run = (manifest) => {
      writeFileSync(value.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const result = spawnSync(java, ['-cp', classesRoot, 'AndroidUpdateVerifierDriver', value.manifestPath, value.publicKeyPath, '41'], { encoding: 'utf8', timeout: 30_000 })
      assert.notEqual(result.status, 2, result.stderr)
      assert.equal(result.stderr, '', result.stderr)
      return { status: result.status, stdout: result.stdout.trim() }
    }

    const accepted = run(signManifest(value.privateKey, base))
    assert.equal(accepted.status, 0, accepted.stdout)
    assert.equal(accepted.stdout, `ACCEPT versionCode=42 issuedAtMillis=${base.issuedAtMillis}`)

    const unknownField = run(signManifest(value.privateKey, { ...base, unexpectedField: 'attacker-controlled' }))
    assert.equal(unknownField.status, 1, unknownField.stdout)
    assert.match(unknownField.stdout, /^REJECT java\.lang\.SecurityException: /)

    const missingField = signManifest(value.privateKey, base)
    delete missingField.releaseNotes
    const missing = run(missingField)
    assert.equal(missing.status, 1, missing.stdout)
    assert.match(missing.stdout, /^REJECT /)

    const futureIssued = { ...base, issuedAtMillis: now + 5 * 365 * 24 * 60 * 60 * 1000, expiresAtMillis: now + 15 * 365 * 24 * 60 * 60 * 1000 }
    const future = run(signManifest(value.privateKey, futureIssued))
    assert.equal(future.status, 1, future.stdout)
    assert.match(future.stdout, /^REJECT java\.lang\.SecurityException: /)

    // Existing rejections must keep failing closed through the same path.
    const tampered = signManifest(value.privateKey, base)
    tampered.versionCode = 43
    const tamperedResult = run(tampered)
    assert.equal(tamperedResult.status, 1, tamperedResult.stdout)
    assert.match(tamperedResult.stdout, /^REJECT java\.lang\.SecurityException: Update manifest signature is invalid/)

    const expired = run(signManifest(value.privateKey, { ...base, issuedAtMillis: now - 120_000, expiresAtMillis: now - 60_000 }))
    assert.equal(expired.status, 1, expired.stdout)
    assert.match(expired.stdout, /^REJECT java\.lang\.SecurityException: Update metadata is invalid/)
  } finally {
    rmSync(value.directory, { recursive: true, force: true })
  }
})

test('CLI emits PASS only after complete verification and never prints private material', async () => {
  await withFixture(async (value) => {
    const verification = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/verify-android-update.mjs', import.meta.url)),
      '--manifest', value.manifestPath, '--apk', value.apkPath, '--public-key', value.publicKeyPath,
      '--installed-version-code', '41', '--signer-lineage-sha256', LINEAGE, '--now-millis', String(NOW),
    ], { encoding: 'utf8', timeout: 5_000 })
    assert.equal(verification.status, 0, verification.stderr)
    assert.match(verification.stdout, /^PASS Android update verified before upload\/install:/)
    assert.doesNotMatch(verification.stdout + verification.stderr, /PRIVATE KEY|BEGIN PRIVATE/)

    writeFileSync(value.apkPath, 'tampered')
    const rejected = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/verify-android-update.mjs', import.meta.url)),
      '--manifest', value.manifestPath, '--apk', value.apkPath, '--public-key', value.publicKeyPath,
      '--installed-version-code', '41', '--signer-lineage-sha256', LINEAGE, '--now-millis', String(NOW),
    ], { encoding: 'utf8', timeout: 5_000 })
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /^FAIL /)
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /PASS Android update verified/)
  })
})
