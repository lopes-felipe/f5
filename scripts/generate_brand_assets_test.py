"""Artwork, platform geometry, development distinction and drift checks; requires the recipe's Pillow."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("brand_assets", ROOT / "scripts/generate-brand-assets.py")
RECIPE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECIPE)

# Committed bitmaps are compared as decoded pixels, with room for a filter
# weight that rounds differently on another platform.
CHANNEL_TOLERANCE = 2


def frames(path):
    """The decoded images in a PNG, or in every entry of an ICO."""
    image = Image.open(path)
    if path.suffix != ".ico":
        return [image.convert("RGBA")]
    return [image.ico.getimage(size).convert("RGBA") for size in sorted(image.info["sizes"])]


class BrandGeometryTests(unittest.TestCase):
    def assertSamePixels(self, actual, expected, label):
        self.assertEqual(actual.size, expected.size, label)
        drift = max(high for _, high in ImageChops.difference(actual, expected).getextrema())
        self.assertLessEqual(drift, CHANNEL_TOLERANCE, label)

    def test_platform_canvas_treatment(self):
        solid = Image.new("RGBA", (1024, 1024), "white")
        mac = RECIPE.platform_image(solid, "macos")
        ios = RECIPE.platform_image(solid, "ios")
        universal = RECIPE.platform_image(solid, "universal")
        self.assertEqual(mac.size, (1024, 1024))
        self.assertEqual(mac.getpixel((50, 512))[3], 0)
        self.assertEqual(mac.getpixel((100, 512))[3], 255)
        self.assertEqual(mac.getpixel((923, 512))[3], 255)
        self.assertLess(mac.getpixel((950, 512))[3], 30)
        self.assertEqual(ios.getpixel((0, 0))[3], 0)
        self.assertEqual(ios.getpixel((512, 0))[3], 255)
        self.assertEqual(universal.getpixel((0, 0))[3], 255)

    def test_generated_assets_keep_padding_and_badge(self):
        for mode, prefix in [("prod", "black"), ("dev", "blueprint")]:
            mac = Image.open(ROOT / f"assets/{mode}/{prefix}-macos-1024.png").convert("RGBA")
            universal = Image.open(ROOT / f"assets/{mode}/{prefix}-universal-1024.png").convert("RGBA")
            self.assertEqual(mac.size, (1024, 1024))
            self.assertEqual(mac.getpixel((50, 512))[3], 0)
            self.assertGreater(universal.getpixel((50, 512))[3], 200)
            amber_pixels = sum(
                a > 200 and r > 220 and 120 < g < 200 and b < 80
                for r, g, b, a in mac.getdata()
            )
            self.assertGreater(amber_pixels, 1000) if mode == "dev" else self.assertEqual(amber_pixels, 0)

    def test_generated_artwork_matches_the_recipe(self):
        universal = Image.open(ROOT / "assets/prod/black-universal-1024.png").convert("RGBA")
        self.assertBarColours(universal, RECIPE.DEFAULT_VARIANT)
        scale = 1024 / RECIPE.GRID
        first, second = RECIPE.BARS[0][0], RECIPE.BARS[1][0]
        gap = (round(20 * scale), round((first + RECIPE.ROW_HEIGHT + second) / 2 * scale))
        self.assertLess(max(universal.getpixel(gap)[:3]), 0x30)

    def test_each_choice_is_drawn_from_its_table_row(self):
        for name, variant in RECIPE.VARIANTS.items():
            tile = Image.open(ROOT / f"assets/prod/app-icons/{name}/linux.png").convert("RGBA")
            self.assertEqual(tile.size, (512, 512), name)
            if "source" in variant:
                source = Image.open(ROOT / variant["source"]).convert("RGBA")
                self.assertSamePixels(tile, RECIPE.resize(RECIPE.resize(source, 1024), 512), name)
            else:
                self.assertBarColours(tile, name)
        self.assertIn(RECIPE.DEFAULT_VARIANT, RECIPE.VARIANTS)

    def assertBarColours(self, image, name):
        scale = image.width / RECIPE.GRID
        for y, colour, bars in RECIPE.rows(name):
            for x, width in bars:
                centre = (round((x + width / 2) * scale), round((y + RECIPE.ROW_HEIGHT / 2) * scale))
                for actual, expected in zip(image.getpixel(centre), RECIPE.rgb(colour)):
                    self.assertLessEqual(abs(actual - expected), 6, name)

    def test_committed_assets_match_a_fresh_run(self):
        with tempfile.TemporaryDirectory(prefix="f5-brand-drift-") as temporary:
            fresh = Path(temporary)
            RECIPE.generate(fresh, icns=False)
            generated = sorted(path.relative_to(fresh) for path in fresh.rglob("*") if path.is_file())
            # 30 files for the built-in icon, then 2 web and 2 x 3 desktop files per choice.
            self.assertEqual(len(generated), 30 + 8 * len(RECIPE.VARIANTS))
            for folder in ["apps/web/public/app-icons", "assets/prod/app-icons", "apps/desktop/resources/app-icons"]:
                committed = sorted(path.relative_to(ROOT) for path in (ROOT / folder).rglob("*") if path.is_file())
                self.assertEqual(committed, [path for path in generated if path.is_relative_to(folder)], folder)
            for relative in generated:
                label = str(relative)
                self.assertTrue((ROOT / relative).is_file(), label)
                if relative.suffix == ".svg":
                    self.assertEqual((ROOT / relative).read_text("utf-8"), (fresh / relative).read_text("utf-8"), label)
                    continue
                committed, expected = frames(ROOT / relative), frames(fresh / relative)
                self.assertEqual(len(committed), len(expected), label)
                for actual, wanted in zip(committed, expected):
                    self.assertSamePixels(actual, wanted, label)
            # iconutil only exists on macOS, so the ICNS is checked through the entries Pillow can decode.
            face = Image.open(fresh / "assets/dev/blueprint-macos-1024.png").convert("RGBA")
            icns = ROOT / "apps/desktop/resources/icon.icns"
            entries = sorted(Image.open(icns).info["sizes"])
            self.assertEqual({width * scale for width, _, scale in entries}, {32, 64, 128, 256, 512, 1024})
            for width, height, scale in entries:
                entry = Image.open(icns)
                entry.size = (width, height)
                entry.load(scale)
                wanted = RECIPE.resize(face, width * scale)
                self.assertSamePixels(entry.convert("RGBA"), wanted, f"icon.icns {width}@{scale}x")


if __name__ == "__main__":
    unittest.main()
