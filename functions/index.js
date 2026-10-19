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
const { priceCart, basketItems, iyziHeaders, rateLimiter, money, r2 } = require("./core");

const IYZICO_API_KEY = defineSecret("IYZICO_API_KEY");
const IYZICO_SECRET_KEY = defineSecret("IYZICO_SECRET_KEY");
const REGION = "europe-west1";
const BASE_URL = process.env.IYZICO_BASE_URL || "https://sandbox-api.iyzipay.com";

const RETURN_OK = [/^https:\/\/localhost(\/|$)/, /^https:\/\/app\.mixsos\.com(\/|$)/, /^http:\/\/localhost(:\d+)?(\/|$)/, /^https:\/\/yunusaycicek\.github\.io(\/|$)/];
const CORS_OK = [/^https:\/\/localhost$/, /^https:\/\/app\.mixsos\.com$/, /^http:\/\/localhost(:\d+)?$/, /^https:\/\/yunusaycicek\.github\.io$/];
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

function selfUrl() {
  return `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/api`;
}

async function iyzi(path, payload) {
  const body = JSON.stringify(payload);
  const headers = iyziHeaders(IYZICO_API_KEY.value(), IYZICO_SECRET_KEY.value(), path, body);
  const r = await fetch(BASE_URL + path, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
  return r.json();
}

function backTo(res, ret, params) {
  const u = new URL(ret);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  res.redirect(303, u.toString());
}

async function init(req, res, ip) {
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

  const conv = require("node:crypto").randomUUID();
  const b = input.buyer && typeof input.buyer === "object" ? input.buyer : {};
  const parts = String(b.name || "Mixsos Üyesi").trim().split(/\s+/);
  const name = parts[0].slice(0, 50);
  const surname = (parts.slice(1).join(" ") || "Müşteri").slice(0, 50);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  const addr = { contactName: `${name} ${surname}`, city: "Istanbul", country: "Turkey", address: String(input.address || "Mixsos şubesinden teslim").slice(0, 200) };
  const cb = new URL(selfUrl() + "/pay/callback");
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
  const r = await iyzi("/payment/iyzipos/checkoutform/initialize/auth/ecom", payload);
  if (r.status !== "success") {
    logger.warn("iyzico init hata", { code: r.errorCode, msg: r.errorMessage });
    return res.status(502).json({ error: r.errorMessage || "Ödeme başlatılamadı" });
  }
  logger.info("ödeme başlatıldı", { conv, total: priced.total, kind: input.kind || "order" });
  return res.json({ paymentPageUrl: r.paymentPageUrl, conversationId: conv, total: priced.total });
}

async function callback(req, res, ip) {
  const ret = String(req.query.ret || "");
  if (!RETURN_OK.some((r) => r.test(ret))) return res.status(400).send("Geçersiz dönüş adresi");
  if (!limitCallback(ip)) return backTo(res, ret, { pay: "fail", msg: "Çok fazla deneme" });
  const token = (req.body && req.body.token) || req.query.token;
  if (!token) return backTo(res, ret, { pay: "fail", msg: "Ödeme bilgisi alınamadı" });
  const r = await iyzi("/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "tr", token: String(token) });
  if (r.status === "success" && r.paymentStatus === "SUCCESS") {
    logger.info("ödeme başarılı", { paymentId: r.paymentId, paidPrice: r.paidPrice, conv: r.conversationId });
    return backTo(res, ret, { pay: "success", kind: req.query.kind, pid: r.paymentId, amount: r.paidPrice, conv: r.conversationId });
  }
  logger.warn("ödeme başarısız", { code: r.errorCode, msg: r.errorMessage, status: r.paymentStatus });
  return backTo(res, ret, { pay: "fail", msg: r.errorMessage || "Ödeme tamamlanamadı" });
}

exports.api = onRequest(
  { region: REGION, secrets: [IYZICO_API_KEY, IYZICO_SECRET_KEY], maxInstances: 3, concurrency: 40, memory: "256MiB", timeoutSeconds: 30, invoker: "public" },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    const ip = String(req.get("x-forwarded-for") || req.ip || "0.0.0.0").split(",")[0].trim();
    try {
      if (req.path === "/health") return res.json({ ok: true, mode: BASE_URL.includes("sandbox") ? "sandbox" : "live" });
      if (req.path === "/pay/init" && req.method === "POST") return await init(req, res, ip);
      if (req.path === "/pay/callback") return await callback(req, res, ip);
      return res.status(404).json({ error: "Bulunamadı" });
    } catch (e) {
      logger.error("sunucu hatası", e);
      return res.status(500).json({ error: "Sunucu hatası. Tekrar dene." });
    }
  }
);
