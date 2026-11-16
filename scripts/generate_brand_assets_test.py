"""Platform geometry and development distinction checks; requires the recipe's Pillow."""
import importlib.util
from pathlib import Path
import unittest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("brand_assets", ROOT / "scripts/generate-brand-assets.py")
RECIPE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECIPE)


class BrandGeometryTests(unittest.TestCase):
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
            blue_pixels = sum(
                a > 200 and b > 180 and b > r + 80
                for r, g, b, a in mac.getdata()
            )
            self.assertGreater(blue_pixels, 1000) if mode == "dev" else self.assertEqual(blue_pixels, 0)


if __name__ == "__main__":
    unittest.main()
