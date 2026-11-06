"""Telegram getUpdates çıktısından botun bulunduğu sohbetleri (ad ve kimlik) listeler."""
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get("ok"):
    print("::warning::Telegram hatası: %s" % d.get("description")); sys.exit()
res = d.get("result", [])
print("Telegram güncelleme sayısı:", len(res))
seen = set()
for u in res:
    for k, v in u.items():
        c = v.get("chat") if isinstance(v, dict) else None
        if c and c["id"] not in seen:
            seen.add(c["id"])
            print("::notice::Telegram sohbeti: %s (%s) → %s" % (c.get("title") or c.get("first_name"), c.get("type"), c["id"]))
