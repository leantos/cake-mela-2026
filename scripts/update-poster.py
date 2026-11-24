#!/usr/bin/env python3
"""Replace the poster: python3 scripts/update-poster.py /path/to/new-poster.png

Writes public/poster.jpg and public/poster.webp (1080 px wide, optimised),
and updates the width/height in public/site-config.js and public/index.html
so the page doesn't jump while the image loads. Needs Pillow.
"""
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
TARGET_W = 1080


def main(src):
    im = Image.open(src)
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    if im.width > TARGET_W:
        h = round(im.height * TARGET_W / im.width)
        im = im.resize((TARGET_W, h), Image.LANCZOS)
    w, h = im.size
    im.save(PUBLIC / "poster.jpg", "JPEG", quality=82, optimize=True, progressive=True)
    im.save(PUBLIC / "poster.webp", "WEBP", quality=80, method=6)

    cfg = PUBLIC / "site-config.js"
    s = cfg.read_text()
    s = re.sub(r"width: \d+,", f"width: {w},", s, count=1)
    s = re.sub(r"height: \d+\n", f"height: {h}\n", s, count=1)
    cfg.write_text(s)

    idx = PUBLIC / "index.html"
    s = idx.read_text()
    s = re.sub(r'(src="poster\.jpg"[\s\S]*?width=")\d+("\s*height=")\d+(")', rf"\g<1>{w}\g<2>{h}\g<3>", s, count=1)
    idx.write_text(s)

    for name in ("poster.jpg", "poster.webp"):
        print(f"{name}: {w}x{h}, {(PUBLIC / name).stat().st_size // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
