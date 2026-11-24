# First-run onboarding

The upstream welcome-wizard port extends F5's existing onboarding rather than
replacing it. Preserve display-profile selection and harness validation, and add
agent setup and explicit project/history import to that flow.

This product decision was confirmed on 2026-11-19. It applies to upstream topic
pr-5362. Keep F5's profile isolation and existing provider defaults; importing
history must not import credentials or silently enable additional agents.

Agent setup continues to use Providers settings and the existing harness
validation panel. The extension adds a navigation link and explicit discovery
and import controls, rather than a separate agent-setup wizard.

The upstream ledger and its policy files are maintained separately and must not
be edited in a code port.
