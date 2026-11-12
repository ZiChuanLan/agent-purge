"""Optional asset maintenance: python scripts/make-icon.py (requires Pillow).

The ICO and PNG are checked in; normal Node/Bun builds do not require Python or Pillow.
Coordinates and colors match the unboxed geometric mark in web/assets/logo.svg.
"""
from pathlib import Path
from PIL import Image, ImageDraw

scale = 16
size = 32 * scale
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Crisp white rounded squircle base for desktop taskbars and macOS Dock
pad = 1 * scale
draw.rounded_rectangle(
    (pad, pad, size - pad - 1, size - pad - 1),
    radius=7 * scale,
    fill="#FFFFFF",
    outline="#E2E8F0",
    width=max(1, round(0.75 * scale)),
)

def pts(coords):
    # Map 32x32 SVG coordinates inside a padded inner box (margin 3.5 -> scale 0.78)
    offset = 3.5 * scale
    k = 0.78 * scale
    return [(offset + x * k, offset + y * k) for x, y in coords]

# Shell chevron (#0F172A)
draw.polygon(pts([(13.5, 6.5), (4.0, 16.0), (13.5, 25.5), (18.3, 20.7), (13.6, 16.0), (18.3, 11.3)]), fill="#0F172A")
# Injected core diamond (#2563EB)
draw.polygon(pts([(20.5, 10.8), (25.7, 16.0), (20.5, 21.2), (15.3, 16.0)]), fill="#2563EB")
# Peeled outer shard (#94A3B8)
draw.polygon(pts([(21.8, 5.2), (28.4, 11.8), (26.1, 14.1), (19.5, 7.5)]), fill="#94A3B8")

assets = Path(__file__).resolve().parent.parent / "web/assets"
ico_target = assets / "agent-purge.ico"
png_target = assets / "agent-purge.png"

image.resize((512, 512), Image.Resampling.LANCZOS).save(png_target)
image.resize((256, 256), Image.Resampling.LANCZOS).save(
    ico_target, sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)]
)
print(ico_target)
print(png_target)
