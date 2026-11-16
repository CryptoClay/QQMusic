import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "ru.qqmusic.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "ru.qqmusic.app"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("qqmVersionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("qqmVersionName").orElse("0.1.0").get()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    // Signing is opt-in. Never sign a release with the debug identity.
    val signingFile = rootProject.file("keystore.properties")
    if (signingFile.exists()) {
        val keys = Properties().apply { signingFile.inputStream().use { load(it) } }
        signingConfigs.create("release") {
            storeFile = rootProject.file(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }
    buildTypes {
        release { isMinifyEnabled = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") }
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-debug" }
    }
    buildFeatures { compose = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.11.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.media3:media3-exoplayer:1.9.4")
    implementation("androidx.media3:media3-session:1.9.4")
    implementation("androidx.media3:media3-datasource-okhttp:1.9.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}
