# Attachments and media

Use **Attach files**, paste, or drop files into the workspace or onto a sidebar thread. Local folders remain path references; archives are never extracted. HEIC files are retained as ordinary files. No HEIC conversion dependency is installed.

Uploads show progress, Cancel and Retry. Sending waits for completion. A failed transfer leaves the draft available. Draft storage retains upload references rather than base64 bytes; older image drafts are uploaded when used. Restoring a saved prompt into another thread creates an independent upload copy.

| Limit                     | Value                              |
| ------------------------- | ---------------------------------- |
| Attachments per turn      | 100                                |
| Image / all images        | 10 MiB / 80 MiB                    |
| File                      | 50 MiB                             |
| All attachments in a turn | 256 MiB                            |
| Simultaneous uploads      | 2 per client, 4 per server         |
| Staging quota             | 1 GiB per draft, 2 GiB per profile |

The server advertises and rechecks these limits. Antigravity additionally limits all attachments to 50 MiB per turn. Claude, Codex and OpenCode receive up to 20 inline images; Cursor and Grok receive up to 10. Additional images are retained as file paths, with a visible notice. OpenCode receives text and PDF file parts; other generic files are described with their saved paths. Permissions still govern whether the provider can read a path.

Pastes of at least 32 KiB UTF-8, or pastes exceeding the composer text limit, become numbered text attachments. On desktop, **Paste as text** (`mod+shift+v`, rebindable) bypasses folding while retaining input validation.

Incomplete uploads expire after one hour; finalized, unused uploads after 24 hours. Using a draft renews its referenced uploads for seven days. An expired draft keeps its file metadata and asks for reattachment. Delivered messages and queued turns own independent copies and have no upload TTL. Removing one copy never mutates another.

File links and chips open images, Markdown, HTML, PDF, video and audio. Markdown and HTML have source views. Images support Fit/Actual size; chat images open a zoomable gallery. Binary files can be downloaded, with Reveal available for workspace files on desktop. Large text previews are bounded at 1 MiB; downloading retains the full file.

HTML in the file viewer is sandboxed, with scripts, network requests, forms and child frames disabled. Passive resources are restricted to the document's directory. **Open in preview browser** explicitly runs HTML on a separate loopback origin in the desktop preview. Preview guests, popups and subframes never receive F5's backend token.

Only preview HTML you trust. An actively previewed page runs its own scripts and can read supported files (HTML, CSS, JS, JSON, images, fonts and media, but not dotfiles) in its folder and up to five levels below it. For a repository-root `index.html`, that includes `package.json` and source files. Its content security policy keeps scripts, `fetch`, images, frames and form posts on the preview origin, so it cannot upload those files to another host. CSP cannot stop a page from navigating itself or a popup to another URL, though, and such a navigation can carry data in the URL.

HTTPS images in chat are disabled by default. Enable **Load remote images in chat** in General settings to load them lazily without a referrer. Local media is restricted to registered projects, worktrees and this profile's attachments directory. Asset URLs expire after 30 minutes and are renewed while the viewer is open. An asset URL is a bearer capability: anyone who has it can read that one file (or an HTML document's passive siblings) until it expires, without signing in. On remote deployments, treat asset URLs from logs, screenshots or copied links like short-lived passwords.

This adds protocol version **10**, requiring stale tabs to reload, and migration **93** for upload reservations and claim leases. Upload ownership uses the existing attachment registry. Questions with attached answers remain part of Phase 8.
