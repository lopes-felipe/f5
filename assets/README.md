# Icon assets

The icon is drawn by scripts/generate-brand-assets.py from the geometry table at
the top of that file: "F5" spelled by five rows of bars, one colour per row, on a
graphite tile. Every file below is generated, including assets/icon.png and
assets/prod/logo.svg, so change the recipe rather than the files. On macOS,
regenerate with Python 3, Pillow 11.3.0, and Apple's iconutil:

    python3 -m venv /tmp/f5-brand-tools
    /tmp/f5-brand-tools/bin/pip install Pillow==11.3.0
    /tmp/f5-brand-tools/bin/python scripts/generate-brand-assets.py
    /tmp/f5-brand-tools/bin/python scripts/generate_brand_assets_test.py

The test regenerates everything into a temporary directory and compares it with
the committed files, pixel by pixel. CI runs it in the static job, so a recipe
change that is committed without its regenerated files fails there.

The recipe draws a 4096px RGBA source at twice that size and resizes with Lanczos,
keeping the tile's rounded corners transparent. assets/prod/logo.svg is the same
drawing as a vector.
Production remains unbadged. Development adds an amber circular indicator with a
white outline. All platform sources use a 1024px canvas. Universal assets retain
the source alpha; iOS assets apply a 224px rounded-corner mask. macOS assets keep
an 824px face at (100, 100), with a soft shadow offset 8px downward inside the
transparent margin, preserving the prior ~80% face-to-canvas ratio. Production
packaging derives ICNS entries from this padded macOS source.
Windows ICOs contain 16, 32, 48, 64, 128 and 256px entries. Web favicons contain
16, 32 and 48px entries, alongside 16/32px PNGs, a 180px touch icon and a 512px
sidebar image. Desktop development resources contain 512px PNG, ICO and ICNS.

scripts/lib/brand-assets.ts selects production assets for publishing and
development assets for local builds. The marketing site's favicons and 1024px
icon in apps/marketing/public are copies of the production web assets, written by
the same recipe.
