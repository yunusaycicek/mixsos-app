/**
 * Mixsos ödeme sunucusu — Firebase Cloud Functions (2. nesil), iyzico Checkout Form.
 *
 * Adres: https://europe-west1-<proje>.cloudfunctions.net/api
 *   POST /pay/init      Sepet gelir; fiyat sunucuda menüden hesaplanır, iyzico ödeme sayfası başlatılır.
 *   POST /pay/callback  iyzico ödeme sonrası token gönderir; sonuç iyzico'dan yeniden sorgulanır,
 *                       kullanıcı uygulamaya ?pay=success|fail ile döner.
 *   GET  /health        Durum.
 *
 * Güvenlik:
 *  - Kart bilgisi buraya gelmez; iyzico sayfasında girilir.
 *  - Fiyat istemciden alınmaz; menu.json (uygulamadaki menüden üretilir) kullanılır.
 *  - Ödeme sonucu callback'te iyzico'dan doğrulanır.
 *  - API anahtarları Secret Manager'da durur.
 *  - Saldırı/fatura koruması: en fazla 3 sunucu örneği, IP başına dakikada 10 ödeme başlatma,
 *    yalnızca izinli dönüş adresleri ve CORS kaynakları.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const MENU = require("./menu.json");
const { priceCart, basketItems, iyziHeaders, rateLimiter, money, r2, orderMessage } = require("./core");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const IYZICO_API_KEY = defineSecret("IYZICO_API_KEY");
const IYZICO_SECRET_KEY = defineSecret("IYZICO_SECRET_KEY");
// Kalıcı test ortamı (apitest): her zaman iyzico sandbox'a bağlanır.
const IYZICO_SANDBOX_API_KEY = defineSecret("IYZICO_SANDBOX_API_KEY");
const IYZICO_SANDBOX_SECRET_KEY = defineSecret("IYZICO_SANDBOX_SECRET_KEY");
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
// Şube → Telegram sohbet kimliği. functions/.env: TELEGRAM_CHATS={"kadikoy":"-100...","kocaeli":"-100..."}
const CHATS = (() => { try { return JSON.parse(process.env.TELEGRAM_CHATS || "{}"); } catch { return {}; } })();
const BRANCHES = { kadikoy: "Kadıköy Şubesi", kocaeli: "Körfez Şubesi" };
const SANDBOX = (process.env.IYZICO_BASE_URL || "https://sandbox-api.iyzipay.com").includes("sandbox");
const REGION = "europe-west1";
const BASE_URL = process.env.IYZICO_BASE_URL || "https://sandbox-api.iyzipay.com";

const RETURN_OK = [/^capacitor:\/\/localhost(\/|$)/, /^https:\/\/localhost(\/|$)/, /^https:\/\/app\.mixsos\.com(\/|$)/, /^http:\/\/localhost(:\d+)?(\/|$)/, /^https:\/\/yunusaycicek\.github\.io(\/|$)/];
const CORS_OK = [/^capacitor:\/\/localhost$/, /^https:\/\/localhost$/, /^https:\/\/app\.mixsos\.com$/, /^http:\/\/localhost(:\d+)?$/, /^https:\/\/yunusaycicek\.github\.io$/];
const limitInit = rateLimiter(10, 60_000);
const limitCallback = rateLimiter(30, 60_000);

function cors(req, res) {
  const o = req.get("Origin") || "";
  if (CORS_OK.some((r) => r.test(o))) {
    res.set("Access-Control-Allow-Origin", o);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
}

function selfUrl(env) {
  return `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/${env.name}`;
}

async function iyzi(env, path, payload) {
  const body = JSON.stringify(payload);
  const headers = iyziHeaders(env.key(), env.secret(), path, body);
  const r = await fetch(env.base + path, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
  return r.json();
}

/** Ödeme sonucunu gösterip uygulamaya döner. Doğrudan yönlendirme yerine küçük bir sayfa: bazı Android
 *  WebView'ları dış siteden uygulama adresine (https://localhost) 303 yönlendirmesinde takılabiliyor. */
function backTo(res, ret, params) {
  const u = new URL(ret);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const ok = params.pay === "success";
  const href = JSON.stringify(u.toString()).replace(/</g, "\\u003c");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  res.set("Cache-Control", "no-store").status(200).send(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MIXSOS</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#000;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
.i{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:40px;background:${ok ? "#1f9d55" : "#C8102E"}}
a{display:block;background:#C8102E;color:#fff;text-decoration:none;padding:14px 28px;border-radius:26px;font-weight:600}</style></head>
<body><div class="i">${ok ? "✓" : "!"}</div><h2 style="margin:0">${ok ? "Ödeme alındı" : "Ödeme tamamlanamadı"}</h2>
<p style="margin:0;opacity:.8">${ok ? "Siparişin şubeye iletildi. Uygulamaya dönülüyor…" : esc(params.msg || "")}</p>
<a id="b" href="#">Uygulamaya dön</a>
<script>var h=${href};document.getElementById("b").href=h;setTimeout(function(){location.replace(h)},600);</script></body></html>`);
}

async function init(env, req, res, ip) {
  if (!limitInit(ip)) return res.status(429).json({ error: "Çok fazla deneme. Bir dakika sonra tekrar dene." });
  const input = req.body && typeof req.body === "object" ? req.body : {};
  const ret = String(input.ret || "");
  if (!RETURN_OK.some((r) => r.test(ret))) return res.status(400).json({ error: "Geçersiz dönüş adresi" });

  let priced;
  try {
    if (input.kind === "topup") {
      const amt = Number(input.amount);
      if (!(amt >= 50 && amt <= 5000)) throw new Error("Yükleme tutarı 50–5000 TL olmalı");
      priced = { lines: [{ id: "topup", name: "Mixsos Cüzdan bakiye yükleme", total: amt }], total: r2(amt) };
    } else priced = priceCart(input, MENU);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (priced.total <= 0) return res.status(400).json({ error: "Tutar sıfır olamaz" });
  const branch = String(input.branch || "");
  // Yalnızca Telegram grubu tanımlı şubeler online sipariş alır (aksi halde ödeme alınır ama şube görmez).
  if (input.kind !== "topup" && (!BRANCHES[branch] || !CHATS[branch]))
    return res.status(400).json({ error: "Bu şube henüz online sipariş almıyor. Lütfen şubeyi arayın." });

  const conv = require("node:crypto").randomUUID();
  const b = input.buyer && typeof input.buyer === "object" ? input.buyer : {};
  const parts = String(b.name || "Mixsos Üyesi").trim().split(/\s+/);
  const name = parts[0].slice(0, 50);
  const surname = (parts.slice(1).join(" ") || "Müşteri").slice(0, 50);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  const addr = { contactName: `${name} ${surname}`, city: "Istanbul", country: "Turkey", address: String(input.address || "Mixsos şubesinden teslim").slice(0, 200) };
  const cb = new URL(selfUrl(env) + "/pay/callback");
  cb.searchParams.set("ret", ret);
  cb.searchParams.set("kind", input.kind === "topup" ? "topup" : "order");

  const payload = {
    locale: "tr",
    conversationId: conv,
    price: money(priced.total),
    paidPrice: money(priced.total),
    currency: "TRY",
    basketId: conv,
    paymentGroup: "PRODUCT",
    callbackUrl: cb.toString(),
    enabledInstallments: [1],
    buyer: {
      id: phone || conv, name, surname,
      gsmNumber: phone ? `+90${phone}` : "+905000000000",
      email: "musteri@mixsos.com",
      identityNumber: "11111111111",
      registrationAddress: addr.address,
      ip, city: addr.city, country: addr.country,
    },
    shippingAddress: addr,
    billingAddress: addr,
    basketItems: basketItems(priced.lines, priced.total),
  };
  const r = await iyzi(env, "/payment/iyzipos/checkoutform/initialize/auth/ecom", payload);
  if (r.status !== "success") {
    logger.warn("iyzico init hata", { code: r.errorCode, msg: r.errorMessage });
    return res.status(502).json({ error: r.errorMessage || "Ödeme başlatılamadı" });
  }
  if (input.kind !== "topup") {
    await db.collection("orders").doc(conv).set({
      status: "pending", test: env.test, code: conv.slice(0, 6).toUpperCase(),
      branch, branchName: BRANCHES[branch],
      lines: priced.lines.map((l) => ({ name: l.name, qty: l.qty, opts: l.opts || [], total: r2(l.total) })),
      discount: priced.discount || 0, total: priced.total,
      buyerName: `${name} ${surname}`.trim(), buyerPhone: phone,
      mode: input.mode === "adres" ? "adres" : "gelal", dine: !!input.dine,
      address: addr.address, note: String(input.note || "").slice(0, 200),
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  logger.info("ödeme başlatıldı", { conv, total: priced.total, kind: input.kind || "order" });
  return res.json({ paymentPageUrl: r.paymentPageUrl, conversationId: conv, total: priced.total });
}

async function callback(env, req, res, ip) {
  const ret = String(req.query.ret || "");
  if (!RETURN_OK.some((r) => r.test(ret))) return res.status(400).send("Geçersiz dönüş adresi");
  if (!limitCallback(ip)) return backTo(res, ret, { pay: "fail", msg: "Çok fazla deneme" });
  const token = (req.body && req.body.token) || req.query.token;
  if (!token) return backTo(res, ret, { pay: "fail", msg: "Ödeme bilgisi alınamadı" });
  const r = await iyzi(env, "/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "tr", token: String(token) });
  if (r.status === "success" && r.paymentStatus === "SUCCESS") {
    logger.info("ödeme başarılı", { paymentId: r.paymentId, paidPrice: r.paidPrice, conv: r.conversationId });
    if (req.query.kind !== "topup") await notifyBranch(r.basketId || r.conversationId, r.paymentId).catch((e) => logger.error("bildirim hatası", e));
    return backTo(res, ret, { pay: "success", kind: req.query.kind, pid: r.paymentId, amount: r.paidPrice, conv: r.conversationId });
  }
  logger.warn("ödeme başarısız", { code: r.errorCode, msg: r.errorMessage, status: r.paymentStatus });
  if (r.basketId) await db.collection("orders").doc(String(r.basketId)).update({ status: "failed" }).catch(() => {});
  return backTo(res, ret, { pay: "fail", msg: r.errorMessage || "Ödeme tamamlanamadı" });
}

/** Ödenen siparişi bir kez "paid" yapar ve şubenin Telegram grubuna gönderir. */
async function notifyBranch(conv, paymentId) {
  if (!conv) return;
  const ref = db.collection("orders").doc(String(conv));
  const order = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.get("status") !== "pending") return null;
    t.update(ref, { status: "paid", paymentId: String(paymentId || ""), paidAt: FieldValue.serverTimestamp() });
    return s.data();
  });
  if (!order) return;
  const token = TELEGRAM_BOT_TOKEN.value();
  const chat = CHATS[order.branch] || CHATS.default;
  if (!token || token === "none" || !chat) return logger.warn("Telegram ayarlı değil", { branch: order.branch });
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ chat_id: chat, parse_mode: "HTML", text: orderMessage(order, money) }),
  });
  if (!r.ok) throw new Error("Telegram " + r.status + " " + (await r.text()).slice(0, 200));
  await ref.update({ notified: true });
}

function handler(env) {
  return async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    const ip = String(req.get("x-forwarded-for") || req.ip || "0.0.0.0").split(",")[0].trim();
    try {
      if (req.path === "/health") return res.json({ ok: true, mode: env.test ? "sandbox" : "live" });
      if (req.path === "/pay/init" && req.method === "POST") return await init(env, req, res, ip);
      if (req.path === "/pay/callback") return await callback(env, req, res, ip);
      if (req.path === "/pay/status" && req.method === "GET") {
        // Uygulama, ödeme dönüşü kaçarsa siparişi bu kimlikle sorgular (kimlik tahmin edilemez bir UUID).
        const conv = String(req.query.conv || "");
        if (!/^[0-9a-f-]{36}$/.test(conv)) return res.status(400).json({ error: "Geçersiz" });
        const d = await db.collection("orders").doc(conv).get();
        if (!d.exists) return res.json({ status: "unknown" });
        return res.json({ status: d.get("status"), total: d.get("total"), paymentId: d.get("paymentId") || null, code: d.get("code") });
      }
      return res.status(404).json({ error: "Bulunamadı" });
    } catch (e) {
      logger.error("sunucu hatası", e);
      return res.status(500).json({ error: "Sunucu hatası. Tekrar dene." });
    }
  };
}

const OPTS = { region: REGION, maxInstances: 3, concurrency: 40, memory: "256MiB", timeoutSeconds: 30, invoker: "private" };

// Müşteri sunucusu: functions/.env IYZICO_BASE_URL'e göre sandbox ya da canlı.
exports.api = onRequest(
  { ...OPTS, secrets: [IYZICO_API_KEY, IYZICO_SECRET_KEY, TELEGRAM_BOT_TOKEN] },
  handler({ name: "api", base: BASE_URL, test: SANDBOX, key: () => IYZICO_API_KEY.value(), secret: () => IYZICO_SECRET_KEY.value() })
);

// Test sunucusu: her zaman sandbox. Uygulama, test numarasıyla (5000000000) giriş yapan kullanıcıyı buraya yönlendirir.
exports.apitest = onRequest(
  { ...OPTS, maxInstances: 1, secrets: [IYZICO_SANDBOX_API_KEY, IYZICO_SANDBOX_SECRET_KEY, TELEGRAM_BOT_TOKEN] },
  handler({ name: "apitest", base: "https://sandbox-api.iyzipay.com", test: true, key: () => IYZICO_SANDBOX_API_KEY.value(), secret: () => IYZICO_SANDBOX_SECRET_KEY.value() })
);
