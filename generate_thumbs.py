# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Generate 160×160 WebP thumbnails for preset textures (cover-crop, center)."""
import re
from pathlib import Path
from PIL import Image

THUMB = 160  # 2x the ~80 px swatch size so thumbnails stay sharp on HiDPI screens
SRC = Path(__file__).parent / "textures"
DST = SRC / "thumbs"
DST.mkdir(exist_ok=True)

# The preset list lives in js/presetTextures.js; take every texture file it references.
_presets_js = (Path(__file__).parent / "js" / "presetTextures.js").read_text(encoding="utf-8")
PRESETS = re.findall(r"url: 'textures/([^']+)'", _presets_js)

total = 0
for fname in PRESETS:
    img = Image.open(SRC / fname).convert("RGB")
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
