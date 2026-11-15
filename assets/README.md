# Icon assets

The preserved source is assets/icon.png. On macOS, regenerate with Python 3,
Pillow 11.3.0, and Apple's iconutil:

    python3 -m venv /tmp/f5-brand-tools
    /tmp/f5-brand-tools/bin/pip install Pillow==11.3.0
    /tmp/f5-brand-tools/bin/python scripts/generate-brand-assets.py
    /tmp/f5-brand-tools/bin/python scripts/generate_brand_assets_test.py

The recipe uses RGBA and Lanczos resizing, preserving the source canvas and alpha.
Production remains unbadged. Development adds a blue circular indicator with a
white outline. All platform sources use a 1024px canvas. Universal assets retain
the source alpha; iOS assets apply a 224px rounded-corner mask. macOS assets keep
an 824px face at (100, 100), with a soft shadow offset 8px downward inside the
transparent margin, preserving the prior ~80% face-to-canvas ratio. Production
packaging derives ICNS entries from this padded macOS source.
Windows ICOs contain 16, 32, 48, 64, 128 and 256px entries. Web favicons contain
16, 32 and 48px entries, alongside 16/32px PNGs, a 180px touch icon and a 512px
sidebar image. Desktop development resources contain 512px PNG, ICO and ICNS.

scripts/lib/brand-assets.ts selects production assets for publishing and
development assets for local builds. The marketing site has separate assets.
