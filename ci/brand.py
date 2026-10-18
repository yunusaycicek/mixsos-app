"""Mixsos uygulama ikonu ve açılış görselini Android kaynaklarına yazar.

Kullanım: python3 ci/brand.py <android res klasörü> <beyaz logo png>
"""
import glob
import os
import sys

from PIL import Image, ImageDraw

RED = (200, 16, 46, 255)
BLACK = (0, 0, 0, 255)
res, logo_path = sys.argv[1], sys.argv[2]
logo = Image.open(logo_path).convert("RGBA")
logo = logo.crop(logo.getbbox())


def place(canvas, width_ratio):
    w = int(canvas.width * width_ratio)
    h = int(logo.height * w / logo.width)
    lg = logo.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(lg, ((canvas.width - w) // 2, (canvas.height - h) // 2))
    return canvas


def legacy(size, round_):
    big = size * 4
    c = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    if round_:
        d.ellipse((0, 0, big - 1, big - 1), fill=255)
    else:
        d.rounded_rectangle((0, 0, big - 1, big - 1), radius=big // 5, fill=255)
    bg = Image.new("RGBA", (big, big), RED)
    c.paste(bg, (0, 0), m)
    place(c, 0.72 if not round_ else 0.66)
    return c.resize((size, size), Image.LANCZOS)


dens = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, k in dens.items():
    d = os.path.join(res, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)
    legacy(int(48 * k), False).save(os.path.join(d, "ic_launcher.png"))
    legacy(int(48 * k), True).save(os.path.join(d, "ic_launcher_round.png"))
    fg = Image.new("RGBA", (int(108 * k), int(108 * k)), (0, 0, 0, 0))
    place(fg, 0.58).save(os.path.join(d, "ic_launcher_foreground.png"))

vals = os.path.join(res, "values")
os.makedirs(vals, exist_ok=True)
with open(os.path.join(vals, "ic_launcher_background.xml"), "w") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            '    <color name="ic_launcher_background">#C8102E</color>\n</resources>\n')

for sp in glob.glob(os.path.join(res, "drawable*", "splash.png")):
    w, h = Image.open(sp).size
    c = Image.new("RGBA", (w, h), BLACK)
    place(c, 0.5 if w < h else 0.3).convert("RGB").save(sp)
print("ikon ve açılış görseli yazıldı")
