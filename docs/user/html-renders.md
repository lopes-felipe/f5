# HTML renders

Ask a supported agent to use `html_render` to put a small HTML page in the conversation.
The page can include interactive JavaScript, diagrams and images. Its title and **Fullscreen**
action appear above it. Fullscreen offers zoom controls; Escape returns to the conversation.
Click an image to open F5's image viewer, where you can copy or download it. Links open in
your browser, and the app's configured keyboard shortcuts continue to work inside the page.

`html_render` accepts up to 512 KiB of HTML, a title up to 80 characters and a height from
120 to 2,000 pixels. Absolute local image paths are inlined only from the thread's project,
worktree or attachment folders; a thread without a project uses only its own scratch folder. Images must be at most 10 MiB each, and the prepared page
must fit within 25 MiB. Remote HTTPS images and scripts load only when **Load remote images
in chat** is on in Conversation settings; it is off by default because any remote request a
page makes can carry data out. `html_preview` screenshots never load remote content.

Each page runs in a sandbox with an opaque origin. It cannot read the parent application,
its cookies or Node.js. The desktop app also stops a page from navigating its frame away,
for example with a script or a meta refresh, so a page cannot send its contents out that
way. When F5 is open in a regular browser, that navigation cannot be blocked. Pages share the generated attachment budget with tool screenshots:
200 attachments and 64 MiB per thread. Deleting the thread also reclaims its pages.

Use `html_preview` when the agent needs a screenshot before publishing. A connected F5 desktop
renders it offscreen and returns a PNG, content height and console output. This uses the
bundled desktop browser and has a 15-second deadline. Without a connected desktop,
`html_render` still works.

F5 supplies these tools to ordinary Codex and Claude sessions, and to ACP agents that
advertise HTTP MCP support. OpenCode and Muse keep their existing tool configuration.
