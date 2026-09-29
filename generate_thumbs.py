# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Generate 160×160 WebP thumbnails for preset textures (cover-crop, center).

Usage: python generate_thumbs.py [texture file ...]   (no arguments = every preset)"""
import re
import sys
from pathlib import Path
from PIL import Image

THUMB = 160  # 2x the ~80 px swatch size so thumbnails stay sharp on HiDPI screens
SRC = Path(__file__).parent / "textures"
DST = SRC / "thumbs"
DST.mkdir(exist_ok=True)

# Fine grains read as grey noise when a whole tile is squeezed into 160 px, so these thumbnails
# show only the central fraction of the tile.
ZOOM = {
    "brushed.png": 0.5, "concrete.png": 0.5, "fineLeather.png": 0.5, "fineStipple.png": 0.5,
    "haircell.png": 0.5, "hammered.png": 0.5, "sandMatte.png": 0.5, "sparkErosion.png": 0.5,
}

# The preset list lives in js/presetTextures.js; take every texture file it references.
_presets_js = (Path(__file__).parent / "js" / "presetTextures.js").read_text(encoding="utf-8")
PRESETS = re.findall(r"url: 'textures/([^']+)'", _presets_js)
if sys.argv[1:]:
    unknown = set(sys.argv[1:]) - set(PRESETS)
    if unknown:
        sys.exit(f"Not a preset texture: {', '.join(sorted(unknown))}")
    PRESETS = [f for f in PRESETS if f in sys.argv[1:]]

total = 0
for fname in PRESETS:
    img = Image.open(SRC / fname).convert("RGB")
    if fname in ZOOM:
        cw, ch = round(img.width * ZOOM[fname]), round(img.height * ZOOM[fname])
        l, t = (img.width - cw) // 2, (img.height - ch) // 2
        img = img.crop((l, t, l + cw, t + ch))
    # Cover-scale: scale so shortest side = THUMB, then center-crop
    scale = max(THUMB / img.width, THUMB / img.height)
    w, h = round(img.width * scale), round(img.height * scale)
    img = img.resize((w, h), Image.LANCZOS)
    left = (w - THUMB) // 2
    top = (h - THUMB) // 2
    img = img.crop((left, top, left + THUMB, top + THUMB))
    out = DST / (Path(fname).stem + ".webp")
    img.save(out, "WEBP", quality=80)
    size = out.stat().st_size
    total += size
    print(f"  {out.name:30s} {size:>6,} bytes")

print(f"\nTotal: {total:,} bytes ({total/1024:.1f} KB) for {len(PRESETS)} thumbnails")
