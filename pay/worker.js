/**
 * Mixsos ödeme sunucusu (Cloudflare Worker) — iyzico Checkout Form.
 *
 * POST /pay/init      Uygulama sepeti gönderir. Fiyat menu.json'dan sunucuda hesaplanır,
 *                     iyzico ödeme formu başlatılır, paymentPageUrl döner.
 * POST /pay/callback  iyzico ödeme bitince buraya token gönderir. Sonuç iyzico'dan
 *                     yeniden sorgulanır ve kullanıcı uygulamaya (?pay=...) yönlendirilir.
 * GET  /health        Çalışıyor mu, hangi ortam (sandbox/canlı).
 *
 * Gizli değerler (Worker secret): IYZICO_API_KEY, IYZICO_SECRET_KEY
 * Ortam değişkeni: IYZICO_BASE_URL (varsayılan sandbox)
 * Kart bilgisi bu sunucuya hiç gelmez; kart iyzico'nun sayfasında girilir.
 */
import MENU from "./menu.json";

const SANDBOX = "https://sandbox-api.iyzipay.com";
const RETURN_ORIGINS = [/^https:\/\/localhost(\/|$)/, /^https:\/\/app\.mixsos\.com(\/|$)/, /^http:\/\/localhost(:\d+)?(\/|$)/, /^https:\/\/yunusaycicek\.github\.io(\/|$)/];
const CORS_ORIGINS = [/^https:\/\/localhost$/, /^https:\/\/app\.mixsos\.com$/, /^http:\/\/localhost(:\d+)?$/, /^https:\/\/yunusaycicek\.github\.io$/, /^https:\/\/cdn\.jsdelivr\.net$/];

const enc = new TextEncoder();
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const r2 = (n) => Math.round(n * 100) / 100;

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** iyzico IYZWSv2 imzası: HMAC-SHA256(secret, randomKey + uriPath + body) */
export async function iyziHeaders(apiKey, secretKey, path, body, randomKey) {
  const rnd = randomKey || `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
  const signature = await hmacHex(secretKey, rnd + path + body);
  const auth = btoa(`apiKey:${apiKey}&randomKey:${rnd}&signature:${signature}`);
  return { "Content-Type": "application/json", Accept: "application/json", Authorization: `IYZWSv2 ${auth}`, "x-iyzi-rnd": rnd };
}

async function iyzi(env, path, payload) {
  const body = JSON.stringify(payload);
  const headers = await iyziHeaders(env.IYZICO_API_KEY, env.IYZICO_SECRET_KEY, path, body);
  const res = await fetch((env.IYZICO_BASE_URL || SANDBOX) + path, { method: "POST", headers, body });
  return res.json();
}

/** Sepeti menüye göre fiyatlar. İstemciden gelen fiyat kullanılmaz. */
export function priceCart(input, menu = MENU) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new Error("Sepet boş");
  const lines = [];
  for (const it of items.slice(0, 50)) {
    const p = menu.products[it.pid];
    if (!p) throw new Error("Ürün bulunamadı");
    const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
    let unit = p.price;
    const sel = it.sel || {};
    for (const g of p.groups) {
      const picked = Array.isArray(sel[g.id]) ? [...new Set(sel[g.id].map(Number))] : [];
      if (g.req && !picked.length) throw new Error(`${p.name}: ${g.id} seçimi zorunlu`);
      if (picked.length > g.max) throw new Error(`${p.name}: fazla seçim`);
      for (const i of picked) {
        if (!g.opts[i]) throw new Error("Geçersiz seçenek");
        unit += g.opts[i][1];
      }
    }
    lines.push({ id: it.pid, name: p.name, total: unit * qty, doner: p.doner, base: p.price });
  }
  const poset = Math.max(0, Math.min(20, parseInt(input.poset, 10) || 0));
  if (poset) lines.push({ id: "poset", name: "Poşet", total: poset * menu.poset });
  const productsTotal = lines.filter((l) => l.id !== "poset").reduce((a, l) => a + l.total, 0);
  let discount = 0;
  const c = input.coupon && menu.coupons[input.coupon];
  if (c) discount = r2((productsTotal * c.pct) / 100);
  if (input.coupon === "free") {
    // Damga kartı hediyesi: demo sürümünde damgalar cihazda tutulur, sunucu en ucuz döner ürününü düşer.
    const d = lines.filter((l) => l.doner).map((l) => l.base);
    if (d.length) discount = Math.min(...d);
  }
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  const total = r2(Math.max(0, subtotal - discount));
  return { lines, subtotal: r2(subtotal), discount, total };
}

/** İndirimi kalemlere orantılı dağıtır; iyzico kalem toplamının price'a eşit olmasını ister. */
export function basketItems(lines, total) {
  const sub = lines.reduce((a, l) => a + l.total, 0);
  let acc = 0;
  return lines
    .map((l, i) => {
      const last = i === lines.length - 1;
      const price = last ? r2(total - acc) : r2((l.total / sub) * total);
      acc = r2(acc + price);
      return { id: `${l.id}-${i}`, name: l.name.slice(0, 100), category1: "Yemek", itemType: "PHYSICAL", price: money(price) };
    })
    .filter((b) => Number(b.price) > 0);
}

function corsHeaders(req) {
  const o = req.headers.get("Origin") || "";
  return CORS_ORIGINS.some((r) => r.test(o))
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : {};
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) } });

function backTo(ret, params) {
  const u = new URL(ret);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  return Response.redirect(u.toString(), 303);
}

async function init(req, env) {
  const input = await req.json().catch(() => ({}));
  const ret = String(input.ret || "");
  if (!RETURN_ORIGINS.some((r) => r.test(ret))) return json(req, { error: "Geçersiz dönüş adresi" }, 400);

  let priced;
  try {
    if (input.kind === "topup") {
      const amt = Number(input.amount);
      if (!(amt >= 50 && amt <= 5000)) throw new Error("Yükleme tutarı 50–5000 TL olmalı");
      priced = { lines: [{ id: "topup", name: "Mixsos Cüzdan bakiye yükleme", total: amt }], total: r2(amt), discount: 0 };
    } else priced = priceCart(input);
  } catch (e) {
    return json(req, { error: e.message }, 400);
  }
  if (priced.total <= 0) return json(req, { error: "Tutar sıfır olamaz" }, 400);

  const conv = crypto.randomUUID();
  const b = input.buyer || {};
  const full = String(b.name || "Mixsos Üyesi").trim().split(/\s+/);
  const name = full[0].slice(0, 50);
  const surname = (full.slice(1).join(" ") || "Müşteri").slice(0, 50);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  const addr = { contactName: `${name} ${surname}`, city: "Istanbul", country: "Turkey", address: String(input.address || "Mixsos şubesinden teslim").slice(0, 200) };
  const callbackUrl = new URL("/pay/callback", req.url);
  callbackUrl.searchParams.set("ret", ret);
  callbackUrl.searchParams.set("kind", input.kind === "topup" ? "topup" : "order");

  const payload = {
    locale: "tr",
    conversationId: conv,
    price: money(priced.total),
    paidPrice: money(priced.total),
    currency: "TRY",
    basketId: conv,
    paymentGroup: "PRODUCT",
    callbackUrl: callbackUrl.toString(),
    enabledInstallments: [1],
    buyer: {
      id: phone || conv,
      name, surname,
      gsmNumber: phone ? `+90${phone}` : "+905000000000",
      email: "musteri@mixsos.com",
      identityNumber: "11111111111",
      registrationAddress: addr.address,
      ip: req.headers.get("CF-Connecting-IP") || "85.34.78.112",
      city: addr.city, country: addr.country,
    },
    shippingAddress: addr,
    billingAddress: addr,
    basketItems: basketItems(priced.lines, priced.total),
  };
  const r = await iyzi(env, "/payment/iyzipos/checkoutform/initialize/auth/ecom", payload);
  if (r.status !== "success") return json(req, { error: r.errorMessage || "Ödeme başlatılamadı", code: r.errorCode }, 502);
  return json(req, { paymentPageUrl: r.paymentPageUrl, token: r.token, conversationId: conv, total: priced.total });
}

async function callback(req, env) {
  const url = new URL(req.url);
  const ret = url.searchParams.get("ret") || "";
  if (!RETURN_ORIGINS.some((r) => r.test(ret))) return new Response("Geçersiz dönüş adresi", { status: 400 });
  let token = url.searchParams.get("token");
  if (!token && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    token = form && form.get("token");
  }
  if (!token) return backTo(ret, { pay: "fail", msg: "Ödeme bilgisi alınamadı" });
  const r = await iyzi(env, "/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "tr", token });
  if (r.status === "success" && r.paymentStatus === "SUCCESS") {
    return backTo(ret, { pay: "success", kind: url.searchParams.get("kind"), pid: r.paymentId, amount: r.paidPrice, conv: r.conversationId });
  }
  return backTo(ret, { pay: "fail", msg: r.errorMessage || "Ödeme tamamlanamadı" });
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (pathname === "/health") return json(req, { ok: true, mode: (env.IYZICO_BASE_URL || SANDBOX).includes("sandbox") ? "sandbox" : "live", keys: !!(env.IYZICO_API_KEY && env.IYZICO_SECRET_KEY) });
    if (!env.IYZICO_API_KEY || !env.IYZICO_SECRET_KEY) return json(req, { error: "Ödeme anahtarları tanımlı değil" }, 503);
    if (pathname === "/pay/init" && req.method === "POST") return init(req, env);
    if (pathname === "/pay/callback") return callback(req, env);
    return json(req, { error: "Bulunamadı" }, 404);
  },
};
