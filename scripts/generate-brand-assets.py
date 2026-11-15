"""Regenerate bitmap assets with Python 3, Pillow 11.3.0 and macOS iconutil."""
from pathlib import Path
import shutil
import subprocess
import tempfile
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent


def resize(image, size):
    return image.resize((size, size), Image.Resampling.LANCZOS)


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


def generate():
    production = resize(Image.open(ROOT / "assets/icon.png").convert("RGBA"), 1024)
    development = production.copy()
    ImageDraw.Draw(development).ellipse((700, 700, 944, 944), fill="#2388ff", outline="white", width=16)
    for mode, image, prefix, web in [
        ("prod", production, "black", "t3-black"),
        ("dev", development, "blueprint", "blueprint"),
    ]:
        directory = ROOT / "assets" / mode
        for platform in ["ios", "macos", "universal"]:
            platform_image(image, platform).save(directory / f"{prefix}-{platform}-1024.png")
        for size in [16, 32]:
            resize(image, size).save(directory / f"{web}-web-favicon-{size}x{size}.png")
        resize(image, 180).save(directory / f"{web}-web-apple-touch-180.png")
        image.save(directory / f"{web}-web-favicon.ico", sizes=[(n, n) for n in [16, 32, 48]])
        windows = "t3-black" if mode == "prod" else prefix
        image.save(directory / f"{windows}-windows.ico", sizes=[(n, n) for n in [16, 32, 48, 64, 128, 256]])
    public = ROOT / "apps/web/public"
    for source, target in [
        ("t3-black-web-favicon.ico", "favicon.ico"),
        ("t3-black-web-favicon-16x16.png", "favicon-16x16.png"),
        ("t3-black-web-favicon-32x32.png", "favicon-32x32.png"),
        ("t3-black-web-apple-touch-180.png", "apple-touch-icon.png"),
    ]:
        shutil.copyfile(ROOT / "assets/prod" / source, public / target)
    resize(production, 512).save(public / "icon.png")
    resources = ROOT / "apps/desktop/resources"
    resize(platform_image(development, "macos"), 512).save(resources / "icon.png")
    shutil.copyfile(ROOT / "assets/dev/blueprint-windows.ico", resources / "icon.ico")
    with tempfile.TemporaryDirectory(prefix="f5-icons-") as temporary:
        iconset = Path(temporary) / "icon.iconset"
        iconset.mkdir()
        for size in [16, 32, 128, 256, 512]:
            resize(platform_image(development, "macos"), size).save(iconset / f"icon_{size}x{size}.png")
            resize(platform_image(development, "macos"), size * 2).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "icon.icns")], check=True)


if __name__ == "__main__":
    generate()
