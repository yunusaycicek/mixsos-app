// Uygulamadaki menüyü (www/index.html içindeki DRINK, SOS ve P tanımları) okuyup
// ödeme sunucusunun fiyat hesabında kullanacağı pay/menu.json dosyasını üretir.
// Böylece fiyatın tek kaynağı uygulamadaki menüdür; sunucu istemciden gelen fiyata güvenmez.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../www/index.html", import.meta.url), "utf8");
const a = html.indexOf("const DRINK=");
const b = html.indexOf("const PICKS=");
if (a < 0 || b < 0) throw new Error("Menü tanımları bulunamadı");
const ctx = {};
vm.runInNewContext(html.slice(a, b).replace(/\bconst /g, "var "), ctx);
const posetMatch = html.match(/const POSET_PRICE=(\d+(?:\.\d+)?)/);
const menu = {
  poset: posetMatch ? Number(posetMatch[1]) : 1,
  coupons: { elit: { pct: 10 } },
  products: Object.fromEntries(
    ctx.P.map((p) => [p.id, {
      name: p.name,
      price: p.price,
      doner: !!p.doner,
      groups: p.g.map((g) => ({ id: g.id, req: !!g.req, max: g.max, opts: g.opts })),
    }])
  ),
};
writeFileSync(new URL("../functions/menu.json", import.meta.url), JSON.stringify(menu));
console.log(`menu.json: ${Object.keys(menu.products).length} ürün`);
