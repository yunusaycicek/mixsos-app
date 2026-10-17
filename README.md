# Mixsos Uygulaması

- `www/` — uygulamanın kendisi (ekranlar, menü, sepet). Burada yapılan her değişiklik `main`'e gönderilince
  GitHub Pages'e çıkar ve telefondaki uygulamaya bir sonraki açılışta gelir.
- `.github/workflows/build.yml` — siteyi yayınlar; commit mesajında `[apk]` geçerse APK de üretir.
- APK indirme linki: depo sayfası → **Releases → latest → Mixsos.apk**
- `ci/debug.keystore` yalnızca test APK'ları içindir (her sürüm aynı imzayla çıkar, üstüne kurulabilir).
  Google Play'e çıkarken ayrı ve gizli bir yayın anahtarı oluşturulacak.

Ödeme anahtarları (iyzico) bu depoya asla konmaz; yalnızca sunucuda (Firebase Secret Manager) durur.
