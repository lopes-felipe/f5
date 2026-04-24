# Security Policy

## Reporting a vulnerability

If you believe you have found a security issue in F5 (including the desktop app, server, or any published package), please **report it privately**. Do **not** open a public GitHub issue.

Preferred channels (in order):

1. **GitHub Security Advisories** — open a private advisory at <https://github.com/lopes-felipe/f5/security/advisories/new>. This keeps the report inside GitHub and lets maintainers coordinate a fix.
2. **Email** — if GitHub is not an option, email the maintainer listed in the repository's GitHub profile. Please mention "F5 security" in the subject line.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (minimal repro preferred).
- The version, commit SHA, or release tag you tested against.
- Any suggested fix or mitigation, if you have one.

## Scope

In scope:

- The F5 desktop app (`apps/desktop`).
- The F5 server / CLI (`apps/server`, published as `t3` on npm).
- The F5 web app (`apps/web`) when served by the F5 server.
- The shared packages (`packages/contracts`, `packages/shared`).

Out of scope:

- Upstream dependencies (please report those to the respective project; if you believe an upstream CVE affects F5 in a non-obvious way, we want to know).
- Misconfiguration when deliberately exposing the server to the public internet without the documented `--auth-token` (see [REMOTE.md](./REMOTE.md)).
- Issues that require an attacker already running code as the same OS user as F5.

## Response expectations

F5 is an early-stage project maintained on a best-effort basis. We will:

- Acknowledge reports as soon as we can, typically within a few business days.
- Keep the reporter informed as we triage and fix.
- Credit reporters in the release notes when a fix ships (unless asked otherwise).

We do not currently offer a bug bounty or guarantee a fixed SLA.
