- Searching for "Gemini" or "Google" in Add provider and the model picker finds Antigravity, and
  the separate Gemini "coming soon" entry is gone.
- Antigravity lists Orchestrator first, uses a light Gemini model for titles and commit messages,
  and reads `skills.json` and plugin skills.
- Each Antigravity instance now reads your `~/.gemini/AGENTS.md` and `GEMINI.md`, as Antigravity
  does outside F5. Files and links of your own in the instance profile are kept.
- Changing Antigravity's sign-in method, key or Google account starts fresh native sessions on the
  next message instead of resuming the previous account's session.
