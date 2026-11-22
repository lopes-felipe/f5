# Antigravity Gemini live gates

Release 1 of the Gemini integration (account and auth, thinking levels, modes and plan, context
meter, discoverability) is built and tested against the mock agent's Antigravity profile
(`F5_ACP_ANTIGRAVITY_PROFILE=1` in `apps/server/scripts/acp-mock-agent.ts`) and the
upstream-derived initialize fixture. No live `agy` capture has been recorded yet.

**Merge order.** The plan makes R0 gate every dependent change. Land the R1 to R5 workstreams only
after the captures below are committed and each row's decision is applied. Until then, the
features are written to fail closed when the live shape differs:

- Native Auto, Plan and the thinking control are used only when the session advertises them.
- Auto-accept edits asks for anything it cannot recognise as an in-workspace edit.
- A key launches nothing until a Connect succeeds.
- Discovery restores the original model after any switch.

## R0 captures (to be run by a maintainer)

Captures run against a real `agy` and spend quota with `--scripted`. Status polling never runs them.

```bash
# Shape only: no prompt is sent.
bun apps/server/scripts/acp-capability-probe.ts --antigravity-session \
  --state-dir <f5 state dir> --instance-id <instance> --account-tier <tier> \
  --out apps/server/src/provider/acp/fixtures/antigravity/<name>.fixture.json

# Behaviour, in a throwaway git repo. Key runs read F5_PROBE_GEMINI_API_KEY.
F5_PROBE_GEMINI_API_KEY=... bun apps/server/scripts/acp-capability-probe.ts \
  --antigravity-session --state-dir <dir> --instance-id <instance> \
  --auth-method gemini-api-key --scripted --out <fixture.json>
```

Record one run on a personal Google account eligible for Neon and Orchestrator, and one on a
disposable API key. Commit only the projected fixture.

| Check                                                        | Fixture field                             | Decision it drives                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycling `setModel` changes the account default on disk       | `checks.defaultModelPersistsAfterCycling` | Paired with the next row                                                                                                                                    |
| The restored default holds in a new process                  | `checks.defaultRestoredInFreshProcess`    | If `false`, set `DISCOVERY_CYCLES_MODELS = false` in `AntigravityDriver.ts`; thread sessions then populate levels                                           |
| `GEMINI_API_KEY` visible to shell commands                   | `checks.apiKeyVisibleToShell`             | Keeps or removes the key-exposure warning in the settings field and docs                                                                                    |
| `GEMINI_API_KEY` visible to stdio MCP children               | `checks.apiKeyVisibleToMcpChildren`       | Same warning; also an input to F3                                                                                                                           |
| Catalog identical under client identity `f5`                 | `checks.catalogIdenticalUnderF5`          | The runtime sends `{ name: "f5", version: "1" }`, as before this change; any change waits on this                                                           |
| Project hooks and plugins executed                           | `checks.executedProjectHooks`             | `null` until recorded by hand: add a project hook and plugin to the throwaway repo and note which ran. A one-time per-project notice if they run unprompted |
| `session/set_mode` rejected                                  | `checks.rejectedModes`                    | Steps for a rejected mode are skipped, so permissions are never labelled with an unconfirmed mode                                                           |
| Permission requests per mode (`default`, `auto`, `plan`)     | `permissions`                             | Confirms the approval table and the Auto-accept edits shape (tool names, target fields)                                                                     |
| `usage_update` frames and prompt-response totals             | `usage`                                   | Confirms the context meter shape, including frames before `session/new` returns                                                                             |
| Cold resume returns config options and keeps the saved model | `resume`                                  | Confirms resume never replaces the saved model                                                                                                              |
| Background command after the prompt; stop then resend        | `backgroundWake`, `stopResend`            | Inputs to F2                                                                                                                                                |

## Follow-ons

F1 (runtime resolution), F2 (background wakes and native commands), F3 (F5 MCP servers),
F4 (attachments), F5 (Gemini Enterprise and Agent Platform), F6 (lifecycle recovery) and F7 are
not implemented. Each ships only after its own recorded live check is added to this page.
