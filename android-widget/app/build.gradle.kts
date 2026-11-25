import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// local.properties is gitignored and stays on the computer that builds: the SDK path, and optionally
// the address a build starts with. An environment variable wins over it.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) {
        file.inputStream().use { load(it) }
    }
}

fun setting(env: String, prop: String): String =
    System.getenv(env)?.trim()?.takeIf { it.isNotEmpty() } ?: localProps.getProperty(prop, "").trim()

fun escapeBuildConfig(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// The computer's address a fresh install offers in its setup screen. Never a pairing code or key:
// the widget pairs on the phone and keeps its own key there. A build for everyone
// (VIBEFORGE_WIDGET_PUBLIC=1, scripts/publish-android-widget.sh) offers none: no one's tailnet name in it.
val defaultUrl = if (System.getenv("VIBEFORGE_WIDGET_PUBLIC") == "1") "" else setting("VIBEFORGE_WIDGET_URL", "vibeforge.defaultUrl")

// The release key: a properties file (storeFile, storePassword, keyAlias, keyPassword, and storeType
// if it isn't told by the file's extension) named by VIBEFORGE_WIDGET_SIGNING, else
// ~/.local/share/vibeforge-signing/widget-signing.properties when that is there. It stays on the
// computer that builds, never in the repository. Without it the build is signed with the SDK's
// debug key, which only that computer has. Updates install over an installed widget only when they
// are signed with the same key as it.
val signingFile: File? = run {
    val named = System.getenv("VIBEFORGE_WIDGET_SIGNING")?.trim().orEmpty()
    val file = if (named.isNotEmpty()) File(named) else File(System.getProperty("user.home"), ".local/share/vibeforge-signing/widget-signing.properties")
    if (named.isNotEmpty() && !file.isFile) throw GradleException("VIBEFORGE_WIDGET_SIGNING names $file, which isn't there.")
    file.takeIf { it.isFile }
}
val signingProps = Properties().apply { signingFile?.inputStream()?.use { load(it) } }
fun signing(name: String): String = signingProps.getProperty(name, "").trim()
val releaseStore: File? = signingFile?.let { from ->
    val named = signing("storeFile")
    if (named.isEmpty()) throw GradleException("$from names no storeFile.")
    val store = File(named).let { if (it.isAbsolute) it else File(from.parentFile, named) }
    if (!store.isFile) throw GradleException("The keystore $from names isn't there.")
    store
}
if (releaseStore != null && (signing("storePassword").isEmpty() || signing("keyAlias").isEmpty())) {
    throw GradleException("$signingFile needs storePassword and keyAlias.")
}
println(
    if (releaseStore != null) "VibeForge widget: signing with the release key from $signingFile"
    else "VibeForge widget: no release key found, signing with this computer's debug key"
)

android {
    namespace = "net.vibeforge.widget"
    compileSdk = 35

    defaultConfig {
        applicationId = "net.vibeforge.widget"
        minSdk = 28
        targetSdk = 35
        versionCode = 9
        versionName = "2.2.1"

        buildConfigField("String", "DEFAULT_URL", escapeBuildConfig(defaultUrl))
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (releaseStore != null) {
            create("release") {
                storeFile = releaseStore
                storePassword = signing("storePassword")
                keyAlias = signing("keyAlias")
                keyPassword = signing("keyPassword").ifEmpty { signing("storePassword") }
                val type = signing("storeType").ifEmpty {
                    if (releaseStore.extension.lowercase() in listOf("p12", "pfx")) "pkcs12" else ""
                }
                if (type.isNotEmpty()) storeType = type
            }
        }
    }

    buildTypes {
        release {
            // R8 drops what is never called (most of the Kotlin library and ZXing): the APK stays small.
            // Nothing is renamed; see proguard-rules.pro.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseStore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Otherwise pure Android framework (RemoteViews + HttpURLConnection + org.json + Android Keystore) keeps the APK tiny and fast.
    // The one library: ZXing's QR reader with its camera view (Apache-2.0), for Scan in the setup screen.
    // It decodes on the phone itself, with no Google Play Services, so a de-Googled phone pairs the same way.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
}
