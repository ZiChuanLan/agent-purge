"""Optional asset maintenance: python scripts/make-icon.py (requires Pillow).

The ICO is checked in; normal Node/Bun builds do not require Python or Pillow.
Coordinates and colors match the existing A mark in web/ui.html, not a host logo.
"""
from pathlib import Path
from PIL import Image, ImageDraw

scale = 32
image = Image.new("RGBA", (32 * scale, 32 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 32 * scale - 1, 32 * scale - 1),
                       radius=7 * scale, fill="#2459cf")
draw.line([(8 * scale, 23 * scale), (16 * scale, 8 * scale),
           (24 * scale, 23 * scale)], fill="white", width=round(2.5 * scale))
draw.line([(11 * scale, 18 * scale), (21 * scale, 18 * scale)],
          fill="white", width=round(2.5 * scale))
target = Path(__file__).resolve().parent.parent / "web/assets/agent-purge.ico"
image.resize((256, 256), Image.Resampling.LANCZOS).save(
    target, sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
print(target)
