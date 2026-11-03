"""Capacitor Android projesini Google Play için hazırlar.

- compileSdk / targetSdk 36 (Play'in yeni uygulamalar için istediği seviye), uyumlu AGP ve Gradle
- versionName / versionCode
- release imzası: ci/upload.p12 (şifre ORG_GRADLE_PROJECT_mixsosKeyPass ortam değişkeninden)
- Android 15+ kenardan kenara ekran: içerik durum çubuğu ve gezinme çubuğunun altında kalmasın

Kullanım: python3 ci/play_gradle.py <android klasörü> <versionName> <versionCode> <keystore yolu>
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
version_name, version_code, keystore = sys.argv[2], int(sys.argv[3]), sys.argv[4]
AGP, GRADLE, SDK = "8.10.1", "8.11.1", 36


def edit(rel, fn):
    p = root / rel
    s = p.read_text()
    n = fn(s)
    if n == s:
        print(f"uyarı: {rel} değişmedi")
    p.write_text(n)


edit("variables.gradle", lambda s: re.sub(r"(compileSdkVersion|targetSdkVersion)\s*=\s*\d+", lambda m: f"{m.group(1)} = {SDK}", s))
# Play otomatik koruma en az API 24 istiyor
edit("variables.gradle", lambda s: re.sub(r"minSdkVersion\s*=\s*\d+", "minSdkVersion = 24", s))
edit("build.gradle", lambda s: re.sub(r"com\.android\.tools\.build:gradle:[\d.]+", f"com.android.tools.build:gradle:{AGP}", s))
edit("gradle/wrapper/gradle-wrapper.properties", lambda s: re.sub(r"gradle-[\d.]+-(all|bin)\.zip", f"gradle-{GRADLE}-all.zip", s))


def app_gradle(s):
    s = re.sub(r"versionCode\s+\d+", f"versionCode {version_code}", s)
    s = re.sub(r'versionName\s+"[^"]*"', f'versionName "{version_name}"', s)
    signing = f"""    signingConfigs {{
        release {{
            storeFile file("{keystore}")
            storeType "pkcs12"
            storePassword project.findProperty("mixsosKeyPass") ?: ""
            keyAlias "upload"
            keyPassword project.findProperty("mixsosKeyPass") ?: ""
        }}
    }}
    buildTypes {{"""
    s = s.replace("    buildTypes {", signing, 1)
    s = re.sub(r"(release\s*\{\s*\n)(\s*minifyEnabled)", r"\1            signingConfig signingConfigs.release\n\2", s, count=1)
    return s


edit("app/build.gradle", app_gradle)

gp = root / "gradle.properties"
gp.write_text(gp.read_text() + "\nandroid.suppressUnsupportedCompileSdk=36\n")

# MainActivity: sistem çubuklarının yüksekliği kadar boşluk bırak, arka plan siyah, ikonlar açık renk.
main = next(root.glob("app/src/main/java/**/MainActivity.java"))
pkg = re.search(r"package\s+([\w.]+);", main.read_text()).group(1)
main.write_text(f"""package {pkg};

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {{
    @Override
    protected void onCreate(Bundle savedInstanceState) {{
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setBackgroundColor(Color.BLACK);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {{
            Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(b.left, b.top, b.right, Math.max(b.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        }});
    }}
}}
""")
print("Play ayarları uygulandı:", version_name, version_code, "SDK", SDK, "AGP", AGP)
