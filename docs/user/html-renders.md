# HTML renders

Agents can put a small HTML page in the conversation with `html_render`: a chart, a diagram, a
mockup or an interactive control. You do not need to name the tool. Ask in your own words:

- "Chart monthly signups from `data/signups.csv` and tell me what changed."
- "Compare the bundle sizes of these three builds."
- "Sketch the settings screen with the new toggle."
- "Make a collage of the screenshots in `docs/images`."

When an answer shows a trend or a comparison in data, agents prefer a chart unless you ask
for text only or for an exportable image. The page appears above the agent's reply, and the
reply does not repeat what the page shows.

## Viewing a page

A page sits directly on the thread, in your theme's colors and fonts. Changing the palette,
a custom theme, fonts or light/dark mode restyles pages already in the thread, without
reloading them, so anything you typed into a page stays.

- Hover a page (or focus it) and click **Open full screen** in its top corner. Full screen
  zooms from 50% to 200%; click the percentage to reset. Escape returns to the conversation.
  Full screen opens its own copy of the page; the inline page keeps its state.
- Click an image to open F5's image viewer, where you can copy or download it.
- Links open in your browser, or beside the thread for pull requests, like chat links. The
  app's keyboard shortcuts keep working inside a page.
- Scrolling over a page scrolls the conversation, and scrolling up while a reply streams
  stops following the end, as it does anywhere else in the thread. This holds for pages that
  scroll inside their frame too; use their scrollbar or keyboard, or open them full screen,
  where the wheel scrolls the page.

### Height

A page grows to fit its content, up to 20,000 pixels. A taller page scrolls inside its frame,
and full screen shows all of it (up to 100,000 pixels). A page that is still loading keeps the
height it last had, so the thread does not jump.

Some pages size themselves from their frame, for example with `100vh` or a script that reads
the window height. They would grow every time the frame grows. F5 stops such a page at its
previous height, lets it scroll inside, and shows **Automatic sizing paused**. The page
resumes fitting when its content or the window width changes its height. Click
**Retry sizing** to measure it again. A script that rebuilds the page from the frame height
every time keeps changing it, so that page grows to the 20,000-pixel limit instead.

## Limits

`html_render` accepts up to 512 KiB of HTML and a title up to 80 characters. Absolute local
image paths are inlined only from the thread's project, worktree or attachment folders; a
thread without a project uses only its own scratch folder. Images must be at most 10 MiB each,
and the prepared page must fit within 25 MiB. F5 rejects pages that use viewport height units
(`vh`, `svh`, `lvh`, `dvh`) in their styles. When a page is rejected, or an image path cannot
be read, the agent gets a message that names the problem and fixes the page.

Remote HTTPS images and scripts load only when **Load remote images in chat** is on in
Conversation settings; it is off by default because any remote request a page makes can carry
data out. `html_preview` screenshots never load remote content.

Pages use your configured font names, but fonts F5 itself bundles, such as Inter and
JetBrains Mono, are not available inside a page. A page falls back to that font when it is
installed on your computer, and otherwise to a system font.

Each page runs in a sandbox with an opaque origin. It cannot read the parent application,
its cookies or Node.js. The desktop app also stops a page from navigating its frame away,
for example with a script or a meta refresh, so a page cannot send its contents out that
way. When F5 is open in a regular browser, that navigation cannot be blocked. Pages share the
generated attachment budget with tool screenshots: 200 attachments and 64 MiB per thread.
Deleting the thread also reclaims its pages.

## Previews

Before publishing, agents check a page with `html_preview`. A connected F5 desktop renders it
offscreen with your palette and the requested light or dark mode, and returns a PNG, the page
height, console output, any image paths it could not read, and a note when the page is taller
than the inline limit. Previews use the bundled desktop browser and have a 15-second deadline.
Without a connected desktop, for example when F5 runs only in a browser, the preview reports
that it is unavailable and `html_render` still works.

F5 supplies these tools to ordinary Codex, Claude and Pi sessions, and to ACP agents that
advertise HTTP MCP support. OpenCode and Muse keep their existing tool configuration.
