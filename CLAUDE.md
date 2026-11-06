# MIXSOS mobil uygulaması

Mixsos (tavuk döner, dürüm, burger zinciri) için sipariş uygulaması. Yanıtları Türkçe ver.
Uygulamada "Powered by Lokus Studio" yazısı kalmalı.

## Yapı
- `www/index.html` — uygulamanın tamamı (tek dosya, vanilla JS). Durum `localStorage` `mixsos.v2`.
  Menü (`P`, `DRINK`, `SOS`), şubeler (`BR`), şirket bilgisi (`COMPANY`), yasal metinler (`V.doc`).
  `ordersOpen()`: ödeme sunucusu canlı (PAY_MODE live) ve şube `online:true` ise sipariş açık; sandbox'ta yalnızca
  5000000000 test numarasına açık. Para yükleme (`TOPUP_OPEN`) kapalı.
- `shell/index.html` — Capacitor kabuğu; içeriği jsDelivr CDN'den (gh-pages) çeker. `www`'ye yapılan
  değişiklik main'e push edilince uygulamaya mağaza güncellemesi olmadan gelir.
- `functions/` — iyzico ödeme sunucusu (Firebase Cloud Functions v2 `api`, europe-west1, proje mixsos--web-site).
  Siparişler Firestore `orders`'a yazılır, ödeme sonrası şubenin Telegram grubuna gider (@mixsos_siparis_bot).
  `functions/.env`: IYZICO_BASE_URL (sandbox/live), TELEGRAM_CHATS. Secrets: IYZICO_API_KEY, IYZICO_SECRET_KEY,
  TELEGRAM_BOT_TOKEN. GitHub→GCP girişi anahtarsız (Workload Identity, github-deploy SA).
- `store/` — App Store metinleri/ekran görüntüleri (`metadata`, `screenshots`), Google Play görselleri (`play`).
- `ci/` — ikon/açılış (`brand.py`, `brand_ios.py`), Play Gradle ayarları (`play_gradle.py`), Android yükleme anahtarı (`upload.p12`).

## Yayın akışları (GitHub Actions)
- `build.yml` — her push: gh-pages'e yayın (app.mixsos.com). Commit mesajında `[apk]` → test APK.
- `ios.yml` — `[ios]` → App Store Connect'e build; `[ios] [meta]` → yalnızca ekran görüntüsü/metin.
  Bundle `com.restajet.mixsosdoner`, Team 65QNGMU6MN. App Store'da 2.0.0 yayında.
- `play.yml` — `[play]` ya da elle → imzalı `Mixsos.aab` (sürüm `play` release'inde).
  Paket `com.mixsos.app`, targetSdk 36, minSdk 24. Play Console'da dahili test yayında; ilk AAB elle yüklendi.

## Kurallar
- Secret'lar (API anahtarı, .p8, şifre) asla sohbete yazılmaz; kullanıcı GitHub secrets'a kendisi girer.
- Online sipariş yalnızca `online:true` şubelerde (şu an Körfez) ve sunucuda TELEGRAM_CHATS içinde grubu olan şubede açılır.
- Demo giriş: herhangi 5xx numara + kod 123456. iyzico sandbox test kartı 5528 7900 0000 0008, 12/30, 123, 3D 283126.
