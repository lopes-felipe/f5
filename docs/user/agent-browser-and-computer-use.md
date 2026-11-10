# Agent browser and computer use

Let Claude and Codex open, read and click through pages in F5's preview browser.
On macOS and Windows they can also request control of apps you approve.
Browser access and computer use are enabled by default, with background computer
execution. You can change these settings or take control back at any time.
Computer batches stop at the first failure or unconfirmed effect; completed steps must not be repeated.

![Settings → Browser & Computer with agent browser access and computer use toggles](../images/settings-browser.webp)

## How to

1. Open **Settings → Browser & Computer** and turn on **Agent browser access**.
2. Optionally, list the external sites the agent may visit under **Allowed external sites**.
3. Start a new Claude or Codex turn and ask the agent to check a page. F5 opens a **Preview** tab
   without taking focus.
4. Click **Take over** to pause the agent and drive the page yourself.

You can also set each option per project in **Project settings**.

## What the agent can do

Looking at the page never asks for permission: status, snapshots, screenshots and waiting for
text. Clicks, typing and navigation follow the thread's [runtime mode](../runtime-modes.md), and
one "allow for session" approval covers all of them. Screenshots the agent takes show up in the
chat as attachments.

Read-only workflow stages can look at pages but not save screenshots.

## External sites

Local pages (`localhost`, `127.0.0.1`) are always allowed. Anything else must be on your list,
one entry per line:

| Entry                   | Allows                                     |
| ----------------------- | ------------------------------------------ |
| `example.com`           | That host over HTTPS                       |
| `*.example.com`         | Its HTTPS subdomains                       |
| `http://intranet.local` | One host over plain HTTP                   |
| `*`                     | Any DNS host over HTTPS, after you confirm |

Blocked navigations fail the agent's action instead of opening your browser. Sign-in popups stay
with you.

## Computer use (preview)

On macOS 14 or later and Windows x64 build 19041 or newer, the agent can also see
and control apps you approve:

1. In **Settings → Browser & Computer**, check **Agent browser access** and **Computer use (preview)**.
   Both default to on; saved choices are preserved.
2. On macOS, grant **Screen Recording** and **Accessibility** to F5 in System Settings.
   On Windows, run F5 unelevated in an unlocked interactive session.
3. Start a new turn. When the agent asks for an app, approve it in F5's dialog.

Computer use is enabled by default, and background is the default execution mode.
Your input makes Full access foreground agents wait; other foreground agents pause.
Press **⌃⌘Esc** on macOS or
**Ctrl+Alt+Shift+F12** on Windows to stop every scope. While paused, the agent can't
take screenshots or inspect apps either.

Windows is an uncertified preview. Native workflow, lifecycle and capture
privacy checks passed on Windows 11. Full provider workflows, physical emergency
stop, display transitions, Windows 10 and installer checks remain pending; see the
[acceptance record](../computer-certification/windows-preview.md#rollout-record).
Elevated/protected system UI stays outside the agent's control.

Foreground uses the mouse and keyboard. Background uses accessibility inside approved
apps, and several agents can share an app while their writes run one at a time.
Interacting with a background app makes its agents wait until you leave and conflicting
activity stops. Other background apps can continue. Actions that need the foreground
request a takeover.
Windows app approvals apply to F5 computer tools; other agent code retains its
own Windows permissions.

## Your own Chrome (macOS)

Agents can also use the Chrome you already run, with your tabs and sign-ins, through each
provider's own browser extension. Each option shows per agent whether it's ready and, if not, why.
They become available on this Mac once F5 has certified the installed version. Until then the
toggles stay off and say what is missing.

**Claude in Chrome**

1. Install the Claude in Chrome extension and sign in to Claude with a claude.ai account. API-key
   sign-in isn't supported.
2. In **Settings → Browser & Computer**, turn on **Claude in Chrome**.
3. Start a new Claude session and approve the browser setup when F5 asks. Open Chrome before asking
   Claude to use it.

Claude Code creates its browser connection in seven browser folders (Chrome, Brave, Arc, Edge,
Chromium, Vivaldi and Opera). **Settings → Browser & Computer** lists each setup and can restore the
earlier files, even after F5 restarts. Running `claude --chrome` in a terminal takes the connection
back; reconnect in F5 afterwards. In Full access, Claude skips the extension's per-site permission
prompts. Claude in Chrome works in every F5 profile on macOS, isolated profiles included: they keep
your real home folder and only Claude's settings folder is separate. Replacing another profile's
setup always asks.

**Codex Chrome**

1. Install the ChatGPT app and set up its Chrome extension under **Settings → Computer use** in
   ChatGPT. If F5 says the helper is out of date, open the ChatGPT app once.
2. Give the Codex agent its own home folder (not `~/.codex`) and run the thread in **Full access**.
   Codex's browser runtime runs code F5 can't show you in an approval.
3. In **Settings → Browser & Computer**, turn on **Codex Chrome control**, then start a new session and allow
   Chrome for that session when asked.

F5 checks every browser action itself, holds the browser only while an action runs, and never
changes ChatGPT's files or registrations. Pausing or **⌃⌘Esc** stops the running action.

Codex's own Computer Use (the ChatGPT app's) isn't available yet. Codex uses F5's computer control
instead.

## Good to know

With an updated desktop, helper, and backend, interacting with an agent's background app makes
the agent wait until you leave that app and conflicting activity has stopped. Scrolling a
non-frontmost window counts too; typing in another app does not delay it. The agent uses
computer_wait_for_target and observes the app again before continuing. Waiting reserves no
control and never repeats an interrupted action automatically.

When another agent holds conflicting control, F5 waits fairly for up to twenty seconds.
A takeover reserves its place before asking for consent, so a busy computer does not
produce an approval dialog early. Foreground and takeover control remain exclusive:
there is one cursor and keyboard focus in a desktop session.

A Claude in Chrome session doesn't block other agents just by being open. Other threads and
profiles can take foreground control, or control Chrome in the background, whenever none of
its Chrome calls is running. Its next Chrome call then waits until that control ends. While
a thread waits, its banner and card name who it is waiting for: another profile by name, a
thread in this profile by title, and whether that agent is using Chrome or controlling the
computer. **Stop that agent** pauses only that agent, even in another profile. Resume it
from its own thread. An idle Chrome session in another profile also gives Chrome up when
a thread here needs it, the same way one in this profile does.

Agents sharing an app must inspect again after another agent changes it. If another
agent changed focus, the next agent presses the intended field before typing or sending
keys, or sets that field's value directly. This prevents typing into the other agent's
selected field. A background screenshot still never authorizes coordinate input.

Background key presses use a named app; background scrolling uses an element from a
fresh inspection. Both require app-specific native support verified by real rehearsals.
**No apps are enabled for background key presses or element scrolling yet on macOS or
Windows.** Until an app passes those checks, it needs foreground approval for these
operations. The delivery APIs and rehearsal runner are available for certification;
see [background cooperation acceptance](../computer-certification/background-cooperation.md).
Desktop shortcuts, coordinate scrolling, clicks, moves and drags still require foreground
control, and protected system shortcuts remain blocked.

In Full access threads, moving the mouse or typing during foreground control also makes the
agent wait. The overlay says **Waiting while you use the computer**, then counts down through
a three-second idle period; movement keeps you in control. Held keys or mouse buttons block
continuation. Other foreground threads still pause and require Resume. After repeated
contention the idle delay grows, up to fifteen seconds. Foreground ownership is released after
sixty seconds without continuation.

**Pause**, **Stop**, the stop shortcut, helper or monitor failures, and uncertain action
outcomes always latch. **Resume** always asks for native confirmation. Older helpers retain
their existing pause behavior.

> [!WARNING]
> Computer use is an uncertified preview. Claude's own built-in computer
> control is not available.

- Turning off **Agent browser access** stops automation on the next tool call, even for agents
  already running.
- A checked-in `f5.json` can never turn on external sites, Claude in Chrome, Codex Chrome or
  computer use.
- In the native dialog, **Don't ask again for this project** saves app access or session
  approval within the current F5 profile. App permission does not approve session actions,
  additional typing rights, or foreground takeover. Only native dialogs create these choices;
  the saved policy is signed by desktop main using a keychain-protected key. Live permission
  receipts are recreated when F5 restarts.
- Full access background sessions can opt into **Don't ask again in Full access threads** for
  the current profile. It covers session approval across projects, only in Full access threads.
  Foreground takeover has a separate per-app, per-project Full access checkbox.
- Review or revoke these choices in **Settings → Browser & Computer → Don't ask again**.
  Revoking removes current authority immediately and pauses affected work. Removed projects
  appear under **Unlinked projects**; recreating a project with a different ID inherits nothing.
  If saving fails, F5 grants the current run and shows **Until F5 closes**. If revocation cannot
  be saved, access remains removed for this run and F5 reports that restarting could restore it.
- **Screenshot password masking** defaults to **Fast — best effort**. It searches browser
  accessibility for password fields and masks those it finds. Password fields Chrome omits from
  accessibility search may appear in screenshots sent to your model.
- Choose **Conservative — inspect the full tree** to use the full accessibility walk. Large pages
  can hit audit limits and have their entire web area grayed out. The setting applies to every
  project in the current profile and takes effect without restarting F5.
- Both modes mask regions that cannot be audited and preserve app approvals, hidden-app filtering
  and secure-input restrictions. A completed audit means the accessibility calls finished; it does
  not prove every visually present password field was exposed.
- Selectable masking requires an updated computer helper. Older helpers and other platforms keep
  their existing behavior; captures without mode metadata are labeled **Legacy / unknown**.
- You'll be asked to confirm before closing a tab an agent opened.

<details>
<summary>Details and limits</summary>

| Topic            | Detail                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview hosts    | At most 2 headless previews pinned of 4 instances; a pin is released when you close it or after 10 minutes without agent activity                                                                                                                                             |
| Action queue     | Per thread, first in first out, up to 32 queued actions; **Take over** stops the running action at its next checkpoint and fails the queued ones                                                                                                                              |
| Snapshot size    | Images up to 2,560 px and 8 MiB; structured data trimmed to 256 KiB; whole response up to 16 MiB                                                                                                                                                                              |
| Diagnostics      | Last 50 console messages, navigations, failed loads and the tab's action timeline                                                                                                                                                                                             |
| Chat screenshots | PNG, JPEG or WebP, 8 MiB each; one per tool call and 200 per thread                                                                                                                                                                                                           |
| Allowlist rules  | IP literals never match wildcards. Ports, paths, credentials and other schemes are rejected                                                                                                                                                                                   |
| Page scripts     | The agent can run JavaScript only on local pages                                                                                                                                                                                                                              |
| Approvals        | Remembered policy is signed by desktop main with a keychain key and scoped to an F5 profile and project. Execution receipts are fresh for each main lifetime; editing `computer-access.json` cannot create approval. Revoke in Settings removes current authority immediately |
| Sandbox          | Agent processes on macOS can't reach Apple Events, synthesized input, screen capture or accessibility directly. All GUI control goes through F5's approval flow                                                                                                               |

</details>

## Related

- [Preview browser](preview-browser.md)
- [Runtime modes](../runtime-modes.md)
- [Agent browser technical reference](../agent-browser.md) (contributors)
