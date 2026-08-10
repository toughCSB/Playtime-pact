val updateManifestUrl = providers.gradleProperty("UPDATE_MANIFEST_URL").orElse("").get()
  .replace("\\", "\\\\").replace("\"", "\\\"")
val updateManifestPublicKey = providers.gradleProperty("UPDATE_MANIFEST_PUBLIC_KEY").orElse("").get()
  .replace("\\", "\\\\").replace("\"", "\\\"")

plugins { id("com.android.application") }

android {
  namespace = "com.playtimepact.parent"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.playtimepact.parent"
    minSdk = 28
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    testInstrumentationRunnerArguments["clearPackageData"] = "true"
    buildConfigField("String", "UPDATE_MANIFEST_URL", "\"$updateManifestUrl\"")
    buildConfigField("String", "UPDATE_MANIFEST_PUBLIC_KEY", "\"$updateManifestPublicKey\"")
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    buildConfig = true
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


dependencyLocking {
  lockAllConfigurations()
}
