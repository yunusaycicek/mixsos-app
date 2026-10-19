"""Mixsos iOS uygulama ikonu (1024x1024, şeffaflıksız) ve açılış görsellerini Xcode projesine yazar.

Kullanım: python3 ci/brand_ios.py <ios/App/App/Assets.xcassets> <beyaz logo png>
"""
import glob
import os
import sys

from PIL import Image

assets, logo_path = sys.argv[1], sys.argv[2]
RED, BLACK = (200, 16, 46), (0, 0, 0)
logo = Image.open(logo_path).convert("RGBA")
logo = logo.crop(logo.getbbox())


def canvas(size, color, ratio):
    c = Image.new("RGBA", size, color + (255,))
    w = int(size[0] * ratio)
    h = int(logo.height * w / logo.width)
    c.alpha_composite(logo.resize((w, h), Image.LANCZOS), ((size[0] - w) // 2, (size[1] - h) // 2))
    return c.convert("RGB")  # App Store ikonunda alfa kanalı olmamalı


icon_dir = os.path.join(assets, "AppIcon.appiconset")
icons = glob.glob(os.path.join(icon_dir, "*.png"))
if not icons:
    raise SystemExit("AppIcon bulunamadı: " + icon_dir)
for p in icons:
    s = Image.open(p).size
    canvas(s, RED, 0.72).save(p)

for p in glob.glob(os.path.join(assets, "Splash.imageset", "*.png")):
    s = Image.open(p).size
    canvas(s, BLACK, 0.28).save(p)
print("iOS ikon ve açılış görselleri yazıldı:", len(icons), "ikon")
