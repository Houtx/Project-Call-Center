import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

fun String.asBuildConfigString(): String =
    "\"${replace("\\", "\\\\").replace("\"", "\\\"")}\""

val configuredApiUrl = providers.gradleProperty("CALL_CENTER_API_URL")
    .orElse(providers.environmentVariable("CALL_CENTER_API_URL"))
    .orNull
val updateManifestUrl = providers.gradleProperty("CALL_CENTER_UPDATE_MANIFEST_URL")
    .orElse(providers.environmentVariable("CALL_CENTER_UPDATE_MANIFEST_URL"))
    .orNull
    ?.trim()
    .orEmpty()
val updateReleasesBaseUrl = providers.gradleProperty("CALL_CENTER_UPDATE_RELEASES_BASE_URL")
    .orElse(providers.environmentVariable("CALL_CENTER_UPDATE_RELEASES_BASE_URL"))
    .orNull
    ?.trim()
    .orEmpty()
val telemetryUrl = providers.gradleProperty("CALL_CENTER_TELEMETRY_URL")
    .orElse(providers.environmentVariable("CALL_CENTER_TELEMETRY_URL"))
    .orNull
    ?.trim()
    .orEmpty()
val debugAgentUsername = providers.gradleProperty("CALL_CENTER_DEBUG_AGENT_USERNAME")
    .orElse(providers.environmentVariable("CALL_CENTER_DEBUG_AGENT_USERNAME"))
    .orNull
    ?.trim()
    .orEmpty()
val debugAgentPassword = providers.gradleProperty("CALL_CENTER_DEBUG_AGENT_PASSWORD")
    .orElse(providers.environmentVariable("CALL_CENTER_DEBUG_AGENT_PASSWORD"))
    .orNull
    ?.trim()
    .orEmpty()
val releaseRequested = gradle.startParameter.taskNames.any {
    it.contains("assembleRelease", ignoreCase = true) ||
        it.contains("bundleRelease", ignoreCase = true)
}
configuredApiUrl?.let {
    require((it.startsWith("https://") || !releaseRequested && it.startsWith("http://")) && it.endsWith("/")) {
        "CALL_CENTER_API_URL must end with / and release builds must use HTTPS"
    }
}
if (updateManifestUrl.isNotBlank()) {
    require(updateManifestUrl.startsWith("https://")) {
        "CALL_CENTER_UPDATE_MANIFEST_URL must use HTTPS"
    }
}
if (updateReleasesBaseUrl.isNotBlank()) {
    require(updateReleasesBaseUrl.startsWith("https://") && updateReleasesBaseUrl.endsWith("/")) {
        "CALL_CENTER_UPDATE_RELEASES_BASE_URL must use HTTPS and end with /"
    }
}
if (telemetryUrl.isNotBlank()) {
    val parsedTelemetryUrl = runCatching { URI(telemetryUrl) }.getOrNull()
    require(
        parsedTelemetryUrl != null &&
            parsedTelemetryUrl.scheme.equals("https", ignoreCase = true) &&
            !parsedTelemetryUrl.host.isNullOrBlank() &&
            (parsedTelemetryUrl.port == -1 || parsedTelemetryUrl.port in 1..65_535) &&
            parsedTelemetryUrl.userInfo == null &&
            parsedTelemetryUrl.fragment == null
    ) {
        "CALL_CENTER_TELEMETRY_URL must be an HTTPS URL without credentials or a fragment"
    }
}
if (releaseRequested && (updateManifestUrl.isBlank() || updateReleasesBaseUrl.isBlank())) {
    throw GradleException(
        "Release builds require CALL_CENTER_UPDATE_MANIFEST_URL and CALL_CENTER_UPDATE_RELEASES_BASE_URL",
    )
}

val releaseSigningValues = mapOf(
    "storeFile" to providers.gradleProperty("CALL_CENTER_KEYSTORE_FILE")
        .orElse(providers.environmentVariable("CALL_CENTER_KEYSTORE_FILE")).orNull,
    "storePassword" to providers.gradleProperty("CALL_CENTER_KEYSTORE_PASSWORD")
        .orElse(providers.environmentVariable("CALL_CENTER_KEYSTORE_PASSWORD")).orNull,
    "keyAlias" to providers.gradleProperty("CALL_CENTER_KEY_ALIAS")
        .orElse(providers.environmentVariable("CALL_CENTER_KEY_ALIAS")).orNull,
    "keyPassword" to providers.gradleProperty("CALL_CENTER_KEY_PASSWORD")
        .orElse(providers.environmentVariable("CALL_CENTER_KEY_PASSWORD")).orNull,
)
if (releaseRequested && releaseSigningValues.values.any { it.isNullOrBlank() }) {
    throw GradleException("All CALL_CENTER_KEYSTORE_* and CALL_CENTER_KEY_* values must be set for a release build")
}

android {
    namespace = "com.company.callcenter"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.company.callcenter"
        minSdk = 31
        targetSdk = 35
        versionCode = 14
        versionName = "0.6.8"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField(
            "String",
            "DEFAULT_API_URL",
            configuredApiUrl.orEmpty().asBuildConfigString(),
        )
        buildConfigField("String", "UPDATE_MANIFEST_URL", updateManifestUrl.asBuildConfigString())
        buildConfigField("String", "UPDATE_RELEASES_BASE_URL", updateReleasesBaseUrl.asBuildConfigString())
        buildConfigField("String", "TELEMETRY_URL", telemetryUrl.asBuildConfigString())
        buildConfigField("String", "DEBUG_AGENT_USERNAME", "".asBuildConfigString())
        buildConfigField("String", "DEBUG_AGENT_PASSWORD", "".asBuildConfigString())
    }

    signingConfigs {
        create("release") {
            releaseSigningValues["storeFile"]?.let { storeFile = file(it) }
            storePassword = releaseSigningValues["storePassword"]
            keyAlias = releaseSigningValues["keyAlias"]
            keyPassword = releaseSigningValues["keyPassword"]
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField(
                "String",
                "DEFAULT_API_URL",
                (configuredApiUrl ?: "http://10.0.2.2:8800/api/v1/").asBuildConfigString(),
            )
            buildConfigField("String", "DEBUG_AGENT_USERNAME", debugAgentUsername.asBuildConfigString())
            buildConfigField("String", "DEBUG_AGENT_PASSWORD", debugAgentPassword.asBuildConfigString())
        }
        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    sourceSets.getByName("androidTest").assets.srcDir("$projectDir/schemas")
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("net.sourceforge.jexcelapi:jxl:2.6.12") {
        exclude(group = "log4j", module = "log4j")
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.room:room-testing:2.6.1")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
