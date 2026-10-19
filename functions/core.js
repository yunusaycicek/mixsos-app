/**
 * Ödeme çekirdeği: fiyat hesabı, iyzico sepet kalemleri ve IYZWSv2 imzası.
 * Platformdan bağımsızdır; sunucu (index.js) ve testler bunu kullanır.
 */
const crypto = require("node:crypto");

const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) => r2(n).toFixed(2);

/** Sepeti menüye göre fiyatlar. İstemciden gelen fiyat kullanılmaz. */
function priceCart(input, menu) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new Error("Sepet boş");
  if (items.length > 50) throw new Error("Sepette çok fazla ürün var");
  const lines = [];
  for (const it of items) {
    const p = menu.products[it.pid];
    if (!p) throw new Error("Ürün bulunamadı");
    const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
    let unit = p.price;
    const sel = it.sel && typeof it.sel === "object" ? it.sel : {};
    for (const g of p.groups) {
      const picked = Array.isArray(sel[g.id]) ? [...new Set(sel[g.id].map(Number))] : [];
      if (g.req && !picked.length) throw new Error(`${p.name}: seçim zorunlu`);
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
    // Damga kartı hediyesi. Demo sürümünde damgalar cihazda tutulur; giriş sistemi
    // kurulduğunda damga sayısı sunucudan doğrulanacak.
    const d = lines.filter((l) => l.doner).map((l) => l.base);
    if (d.length) discount = Math.min(...d);
  }
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  return { lines, subtotal: r2(subtotal), discount, total: r2(Math.max(0, subtotal - discount)) };
}

/** İndirimi kalemlere orantılı dağıtır; iyzico kalem toplamının price'a eşit olmasını ister. */
function basketItems(lines, total) {
  const sub = lines.reduce((a, l) => a + l.total, 0);
  let acc = 0;
  return lines
    .map((l, i) => {
      const last = i === lines.length - 1;
      const price = last ? r2(total - acc) : r2((l.total / sub) * total);
      acc = r2(acc + price);
      return { id: `${l.id}-${i}`, name: String(l.name).slice(0, 100), category1: "Yemek", itemType: "PHYSICAL", price: money(price) };
    })
    .filter((b) => Number(b.price) > 0);
}

/** iyzico IYZWSv2 başlıkları: HMAC-SHA256(secret, randomKey + uriPath + body) */
function iyziHeaders(apiKey, secretKey, path, body, randomKey) {
  const rnd = randomKey || `${Date.now()}${crypto.randomInt(1e9)}`;
  const signature = crypto.createHmac("sha256", secretKey).update(rnd + path + body).digest("hex");
  const auth = Buffer.from(`apiKey:${apiKey}&randomKey:${rnd}&signature:${signature}`).toString("base64");
  return { "Content-Type": "application/json", Accept: "application/json", Authorization: `IYZWSv2 ${auth}`, "x-iyzi-rnd": rnd };
}

/** Basit hız sınırı (sunucu örneği başına): aynı anahtardan kısa sürede çok istek gelirse reddeder. */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return arr.length <= limit;
  };
}

module.exports = { priceCart, basketItems, iyziHeaders, rateLimiter, money, r2 };
