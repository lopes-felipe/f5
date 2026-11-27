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

## Icon choices

Settings > Appearance offers ten icons. Each is a row of the VARIANTS table in the
recipe: a tile, five row colours and an optional bloom, drawn on the same bar
geometry. "lines" is the default and is the icon described above. "classic" is the
exception: it is resized from assets/icon-classic.png, the previous hand-made
artwork and the only input that is not drawn.

For every id the recipe writes:

- apps/web/public/app-icons/<id>.png (256px) and <id>-32.png, for the sidebar and
  the browser tab;
- assets/prod/app-icons/<id>/macos.png (512px padded face), linux.png (512px full
  tile) and windows.ico, which packaging copies into the app for its platform;
- the same three files with the development badge under
  apps/desktop/resources/app-icons/<id>/.

On macOS the Dock draws a pinned icon itself while F5 is quit, so the app also ships a
Dock tile plug-in (apps/desktop/native/dock-tile, built by scripts/build-dock-tile.ts)
that carries a copy of every macos.png except the default's. The app writes the chosen
id to its preferences and the plug-in shows the matching image.

To add or change a choice, edit VARIANTS, add the id to APP_ICON_IDS in
packages/contracts/src/appIcon.ts and its label in apps/web/src/appIcon.ts, then
regenerate. scripts/brand-assets.test.ts fails when the two lists disagree.

scripts/lib/brand-assets.ts selects production assets for publishing and
development assets for local builds. The marketing site's favicons and 1024px
icon in apps/marketing/public are copies of the production web assets, written by
the same recipe.
