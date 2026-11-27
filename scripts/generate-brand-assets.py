"""Regenerate brand assets with Python 3, Pillow 11.3.0 and macOS iconutil."""
from pathlib import Path
import shutil
import subprocess
import tempfile
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# The icon is drawn from these tables, on a 128-unit grid: "F5" spelled by five
# rows of bars, one colour per row, on a rounded tile.
GRID = 128
TILE_RADIUS = 28
ROW_HEIGHT = 10
ROW_RADIUS = 3
# (y, [(x, width), ...]); the first bar of each row belongs to the F.
BARS = [
    (33, [(15, 45), (68, 45)]),
    (46, [(15, 19), (68, 19)]),
    (59, [(15, 40), (68, 45)]),
    (72, [(15, 19), (94, 19)]),
    (85, [(15, 19), (68, 45)]),
]
# A tile is a gradient from `top` to `bottom` (down the tile, or from the top left
# corner when `diagonal`), with an edge line of (colour, opacity, width).
GRAPHITE = {"top": "#222227", "bottom": "#0b0b0d", "edge": ("white", 0.1, 1.5)}
LINES_COLOURS = ["#4f9bff", "#6b8dff", "#8b7cff", "#bd72ea", "#f06acb"]
# The app icons people can choose, keyed by the ids in packages/contracts/src/appIcon.ts.
# `rows` colours the five rows from the top; `bloom` puts a copy of the rows, blurred by
# that many units at that opacity, behind them; `source` is hand-made artwork instead.
VARIANTS = {
    "lines": {"tile": GRAPHITE, "rows": LINES_COLOURS},
    "classic": {"source": "assets/icon-classic.png"},
    "mono": {"tile": GRAPHITE, "rows": ["#f2f3f5"] * 5},
    "cobalt": {"tile": GRAPHITE, "rows": ["#b3c8ff", "#8fadff", "#6b90ff", "#4d77f5", "#3a61e0"]},
    "sunrise": {"tile": GRAPHITE, "rows": ["#4f9bff", "#8b7cff", "#e06ad0", "#ff7a59", "#ffb340"]},
    "cool": {"tile": GRAPHITE, "rows": ["#34d3b8", "#38bdf8", "#4f8bff", "#7a6cff", "#b06cf0"]},
    "light": {
        "tile": {"top": "#ffffff", "bottom": "#e6e7ec", "edge": ("black", 0.14, 1)},
        "rows": ["#2f7bf0", "#5068f0", "#6d5cf0", "#a354d6", "#d94fb5"],
    },
    "blue": {
        "tile": {"top": "#6a95ff", "bottom": "#2a45cc", "diagonal": True, "edge": ("white", 0.22, 1.5)},
        "rows": ["#ffffff"] * 5,
    },
    "glow": {
        "tile": {**GRAPHITE, "top": "#070709", "bottom": "#070709"},
        "rows": LINES_COLOURS,
        "bloom": (5, 0.8),
    },
    "terminal": {
        "tile": {**GRAPHITE, "top": "#07090a", "bottom": "#07090a"},
        "rows": ["#a7f3c4", "#6ee7a0", "#34d27b", "#22b765", "#169a52"],
    },
}
DEFAULT_VARIANT = "lines"
# Development builds carry this badge, in 1024px canvas coordinates.
DEV_BADGE_BOX = (752, 752, 976, 976)
DEV_BADGE_FILL = "#ff9f0a"
ICNS_SIZES = [16, 32, 128, 256, 512]
WINDOWS_ICO_SIZES = [(n, n) for n in [16, 32, 48, 64, 128, 256]]


def resize(image, size):
    return image.resize((size, size), Image.Resampling.LANCZOS)


def rgb(colour):
    return tuple(int(colour[index : index + 2], 16) for index in (1, 3, 5))


def rows(name=DEFAULT_VARIANT):
    """A drawn variant's rows as (y, colour, bars)."""
    return [(y, colour, bars) for (y, bars), colour in zip(BARS, VARIANTS[name]["rows"])]


def draw_source(size, name=DEFAULT_VARIANT):
    """Draw a variant at `size` pixels, supersampled 2x for antialiased edges."""
    variant = VARIANTS[name]
    if "source" in variant:
        return resize(Image.open(ROOT / variant["source"]).convert("RGBA"), size)
    canvas = size * 2
    scale = canvas / GRID
    tile_spec = variant["tile"]
    edge_colour, edge_opacity, edge_width = tile_spec["edge"]

    def box(x, y, width, height):
        # Pillow's boxes include their far edge.
        left, top = round(x * scale), round(y * scale)
        return (left, top, round((x + width) * scale) - 1, round((y + height) * scale) - 1)

    def rounded_mask(inset, radius):
        mask = Image.new("L", (canvas, canvas))
        side = GRID - 2 * inset
        ImageDraw.Draw(mask).rounded_rectangle(box(inset, inset, side, side), radius=round(radius * scale), fill=255)
        return mask

    def ramp_channel(top, bottom):
        return ramp.point(lambda value: round(top + (bottom - top) * value / 255))

    def draw_rows(image):
        draw = ImageDraw.Draw(image)
        for y, colour, bars in rows(name):
            for x, width in bars:
                draw.rounded_rectangle(box(x, y, width, ROW_HEIGHT), radius=round(ROW_RADIUS * scale), fill=colour)

    ramp = Image.linear_gradient("L")
    if tile_spec.get("diagonal"):
        ramp = ImageChops.add(ramp, ramp.transpose(Image.Transpose.TRANSPOSE), scale=2)
    ramp = ramp.resize((canvas, canvas), Image.Resampling.BILINEAR)
    tile = Image.merge("RGB", [ramp_channel(*ends) for ends in zip(rgb(tile_spec["top"]), rgb(tile_spec["bottom"]))])
    outer = rounded_mask(0, TILE_RADIUS)
    ring = ImageChops.subtract(outer, rounded_mask(edge_width, TILE_RADIUS - edge_width))
    tile.paste(edge_colour, mask=ring.point(lambda value: round(value * edge_opacity)))
    if "bloom" in variant:
        # Blur colour and coverage separately, so the glow keeps its colour as it fades.
        radius, opacity = variant["bloom"]
        blur = ImageFilter.GaussianBlur(radius * scale)
        colour = Image.new("RGB", (canvas, canvas))
        draw_rows(colour)
        coverage = colour.convert("L").point(lambda value: 255 if value else 0)
        coverage = coverage.filter(blur).point(lambda value: round(value * opacity))
        colour = colour.filter(blur).point(lambda value: round(value * opacity))
        tile = ImageChops.add(Image.composite(Image.new("RGB", (canvas, canvas)), tile, coverage), colour)
    draw_rows(tile)
    tile.putalpha(outer)
    return resize(tile, size)


def logo_svg():
    """The default drawing as an SVG, for places that take a vector logo."""
    tile = VARIANTS[DEFAULT_VARIANT]["tile"]
    edge_colour, edge_opacity, edge_width = tile["edge"]
    inset = edge_width / 2
    side = GRID - 2 * inset
    lines = [
        f'<svg width="{GRID}" height="{GRID}" viewBox="0 0 {GRID} {GRID}" fill="none" xmlns="http://www.w3.org/2000/svg">',
        "<!-- Generated by scripts/generate-brand-assets.py; edit the recipe, not this file. -->",
        "<defs>",
        '<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">',
        f'<stop stop-color="{tile["top"]}"/>',
        f'<stop offset="1" stop-color="{tile["bottom"]}"/>',
        "</linearGradient>",
        "</defs>",
        f'<rect width="{GRID}" height="{GRID}" rx="{TILE_RADIUS}" fill="url(#tile)"/>',
        f'<rect x="{inset}" y="{inset}" width="{side}" height="{side}" rx="{TILE_RADIUS - inset}"'
        f' stroke="{edge_colour}" stroke-opacity="{edge_opacity}" stroke-width="{edge_width}"/>',
    ]
    for y, colour, bars in rows():
        lines.append(f'<g fill="{colour}">')
        for x, width in bars:
            lines.append(f'<rect x="{x}" y="{y}" width="{width}" height="{ROW_HEIGHT}" rx="{ROW_RADIUS}"/>')
        lines.append("</g>")
    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def platform_image(image, platform):
    if platform == "universal":
        return image.copy()
    face = image.copy()
    mask = Image.new("L", (1024, 1024))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 1023, 1023), radius=224, fill=255)
    face.putalpha(ImageChops.multiply(face.getchannel("A"), mask))
    if platform == "ios":
        return face
    # The established macOS face occupies ~80% of the canvas, with a soft
    # shadow inside the remaining transparent margin.
    face = resize(face, 824)
    alpha = Image.new("L", (1024, 1024))
    alpha.paste(face.getchannel("A"), (100, 108))
    shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(16)).point(lambda value: value // 3))
    shadow.alpha_composite(face, (100, 100))
    return shadow


def badged(image):
    """A 1024px icon with the development badge."""
    development = image.copy()
    ImageDraw.Draw(development).ellipse(DEV_BADGE_BOX, fill=DEV_BADGE_FILL, outline="white", width=16)
    return development


def write_choice(root, name, production):
    """The files the app switches between when someone picks `name` as their app icon."""
    web = root / "apps/web/public/app-icons"
    web.mkdir(parents=True, exist_ok=True)
    resize(production, 256).save(web / f"{name}.png")
    resize(production, 32).save(web / f"{name}-32.png")
    for directory, image in [
        (root / "assets/prod/app-icons" / name, production),
        (root / "apps/desktop/resources/app-icons" / name, badged(production)),
    ]:
        directory.mkdir(parents=True, exist_ok=True)
        resize(platform_image(image, "macos"), 512).save(directory / "macos.png")
        resize(image, 512).save(directory / "linux.png")
        image.save(directory / "windows.ico", sizes=WINDOWS_ICO_SIZES)


def generate(root=ROOT, icns=True):
    """Write every asset under `root`; `icns=False` skips the one that needs macOS iconutil."""
    for directory in ["assets/prod", "assets/dev", "apps/web/public", "apps/marketing/public"]:
        (root / directory).mkdir(parents=True, exist_ok=True)
    (root / "apps/desktop/resources").mkdir(parents=True, exist_ok=True)
    source = draw_source(4096)
    source.save(root / "assets/icon.png", optimize=True)
    (root / "assets/prod/logo.svg").write_text(logo_svg(), encoding="utf-8")
    production = resize(source, 1024)
    development = badged(production)
    for mode, image, prefix, web in [
        ("prod", production, "black", "t3-black"),
        ("dev", development, "blueprint", "blueprint"),
    ]:
        directory = root / "assets" / mode
        for platform in ["ios", "macos", "universal"]:
            platform_image(image, platform).save(directory / f"{prefix}-{platform}-1024.png")
        for size in [16, 32]:
            resize(image, size).save(directory / f"{web}-web-favicon-{size}x{size}.png")
        resize(image, 180).save(directory / f"{web}-web-apple-touch-180.png")
        image.save(directory / f"{web}-web-favicon.ico", sizes=[(n, n) for n in [16, 32, 48]])
        windows = "t3-black" if mode == "prod" else prefix
        image.save(directory / f"{windows}-windows.ico", sizes=WINDOWS_ICO_SIZES)
    for public, icon_size in [(root / "apps/web/public", 512), (root / "apps/marketing/public", 1024)]:
        for source_name, target in [
            ("t3-black-web-favicon.ico", "favicon.ico"),
            ("t3-black-web-favicon-16x16.png", "favicon-16x16.png"),
            ("t3-black-web-favicon-32x32.png", "favicon-32x32.png"),
            ("t3-black-web-apple-touch-180.png", "apple-touch-icon.png"),
        ]:
            shutil.copyfile(root / "assets/prod" / source_name, public / target)
        resize(production, icon_size).save(public / "icon.png")
    for name in VARIANTS:
        write_choice(root, name, production if name == DEFAULT_VARIANT else draw_source(1024, name))
    resources = root / "apps/desktop/resources"
    resize(platform_image(development, "macos"), 512).save(resources / "icon.png")
    shutil.copyfile(root / "assets/dev/blueprint-windows.ico", resources / "icon.ico")
    if not icns:
        return
    with tempfile.TemporaryDirectory(prefix="f5-icons-") as temporary:
        iconset = Path(temporary) / "icon.iconset"
        iconset.mkdir()
        for size in ICNS_SIZES:
            resize(platform_image(development, "macos"), size).save(iconset / f"icon_{size}x{size}.png")
            resize(platform_image(development, "macos"), size * 2).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "icon.icns")], check=True)


if __name__ == "__main__":
    generate()
