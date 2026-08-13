plugins { id("com.android.application") }

fun releaseValue(key: String) = providers.environmentVariable(key).orElse(providers.gradleProperty(key))
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val releaseKeys = listOf(
  "PLAYTIME_PACT_FCM_ENABLED",
  "PLAYTIME_PACT_FIREBASE_API_KEY",
  "PLAYTIME_PACT_FIREBASE_APPLICATION_ID",
  "PLAYTIME_PACT_FIREBASE_PROJECT_ID",
  "PLAYTIME_PACT_FIREBASE_SENDER_ID",
  "PLAYTIME_PACT_UPDATE_MANIFEST_URL",
  "PLAYTIME_PACT_UPDATE_PUBLIC_KEY_B64",
  "PLAYTIME_PACT_ANDROID_VERSION_CODE",
  "PLAYTIME_PACT_ANDROID_VERSION_NAME"
)
val signingKeys = listOf(
  "PLAYTIME_PACT_ANDROID_KEYSTORE",
  "PLAYTIME_PACT_ANDROID_KEY_ALIAS",
  "PLAYTIME_PACT_ANDROID_STORE_PASSWORD",
  "PLAYTIME_PACT_ANDROID_KEY_PASSWORD"
)
val configuredValues = (releaseKeys + signingKeys).associateWith(::releaseValue)
fun configured(key: String) = configuredValues.getValue(key).orNull?.trim().orEmpty()
fun missingReleaseKeys(): List<String> = releaseKeys.filter { key ->
  val value = configured(key)
  value.isEmpty() ||
      (key == "PLAYTIME_PACT_FCM_ENABLED" && !value.equals("true", ignoreCase = true)) ||
      (key == "PLAYTIME_PACT_ANDROID_VERSION_CODE" && (value.toIntOrNull() ?: 0) <= 0)
}
fun missingSigningKeys() = signingKeys.filter { configured(it).isEmpty() }

val configuredVersionCode = configured("PLAYTIME_PACT_ANDROID_VERSION_CODE").toIntOrNull()?.takeIf { it > 0 } ?: 1
val configuredVersionName = configured("PLAYTIME_PACT_ANDROID_VERSION_NAME").ifEmpty { "0.1.0" }
val signingConfigured = missingSigningKeys().isEmpty()

android {
  namespace = "com.playtimepact.parent"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.playtimepact.parent"
    minSdk = 28
    targetSdk = 36
    versionCode = configuredVersionCode
    versionName = configuredVersionName
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    testInstrumentationRunnerArguments["clearPackageData"] = "true"
    buildConfigField("String", "FIREBASE_API_KEY", quoted(configured("PLAYTIME_PACT_FIREBASE_API_KEY")))
    buildConfigField("String", "FIREBASE_APPLICATION_ID", quoted(configured("PLAYTIME_PACT_FIREBASE_APPLICATION_ID")))
    buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(configured("PLAYTIME_PACT_FIREBASE_PROJECT_ID")))
    buildConfigField("String", "FIREBASE_SENDER_ID", quoted(configured("PLAYTIME_PACT_FIREBASE_SENDER_ID")))
    buildConfigField("String", "UPDATE_MANIFEST_URL", quoted(configured("PLAYTIME_PACT_UPDATE_MANIFEST_URL")))
    buildConfigField("String", "UPDATE_PUBLIC_KEY_B64", quoted(configured("PLAYTIME_PACT_UPDATE_PUBLIC_KEY_B64")))
  }

  signingConfigs {
    if (signingConfigured) {
      create("release") {
        storeFile = file(configured("PLAYTIME_PACT_ANDROID_KEYSTORE"))
        keyAlias = configured("PLAYTIME_PACT_ANDROID_KEY_ALIAS")
        storePassword = configured("PLAYTIME_PACT_ANDROID_STORE_PASSWORD")
        keyPassword = configured("PLAYTIME_PACT_ANDROID_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    debug {
      buildConfigField("boolean", "FCM_ENABLED", configured("PLAYTIME_PACT_FCM_ENABLED").toBooleanStrictOrNull()?.toString() ?: "false")
    }
    release {
      buildConfigField("boolean", "FCM_ENABLED", "true")
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      if (signingConfigured) signingConfig = signingConfigs.getByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures { buildConfig = true }
}

gradle.taskGraph.whenReady {
  val lintReleaseRequested = hasTask(":app:lintRelease")
  val signedReleaseRequested = hasTask(":app:assembleRelease") || hasTask(":app:bundleRelease")
  if (lintReleaseRequested || signedReleaseRequested) {
    val missing = missingReleaseKeys()
    if (missing.isNotEmpty()) {
      val taskClass = if (signedReleaseRequested) "assembleRelease/bundleRelease" else "lintRelease"
      throw GradleException("Missing required release properties for $taskClass: ${missing.joinToString(", ")}")
    }
  }
  if (signedReleaseRequested) {
    val missing = missingSigningKeys()
    if (missing.isNotEmpty()) {
      throw GradleException("Missing required signing properties for assembleRelease/bundleRelease: ${missing.joinToString(", ")}")
    }
  }
}

dependencies {
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  implementation("androidx.activity:activity:1.9.3")
  implementation("androidx.fragment:fragment:1.8.5")
  implementation("androidx.biometric:biometric:1.1.0")
  implementation("com.google.firebase:firebase-messaging:24.1.1")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

dependencyLocking { lockAllConfigurations() }
