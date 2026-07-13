# Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Generate 80×80 WebP thumbnails for preset textures (cover-crop, center)."""
from pathlib import Path
from PIL import Image

THUMB = 80
SRC = Path(__file__).parent / "textures"
DST = SRC / "thumbs"
DST.mkdir(exist_ok=True)

PRESETS = [
    "basket.png", "brick.png", "bubble.png", "carbonFiber.jpg",
    "crystal.png", "dots.png", "grid.png", "gripSurface.jpg",
    "hexagon.jpg", "hexagons.jpg", "isogrid.png", "knitting.png",
    "knurling.jpg", "leather2.png", "noise.jpg", "stripes.png",
    "stripes_02.png", "voronoi.jpg", "weave.png", "weave_02.jpg",
    "weave_03.jpg", "wood.jpg", "woodgrain_02.jpg", "woodgrain_03.jpg",
]

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
