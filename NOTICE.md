# Notice

F5 is an opinionated fork of [T3 Code](https://github.com/pingdotgg/t3code) by Theo / [@pingdotgg](https://github.com/pingdotgg), originally published under the [MIT License](./LICENSE). All original upstream copyright and license notices are retained in this repository.

This fork continues to be distributed under the MIT License.

## Legacy identifiers retained for backwards compatibility

To keep existing installations, downloads, and integrations working, F5 deliberately keeps a set of legacy identifiers from the T3 Code lineage. Downstream auditors and integrators should be aware of the following:

| Kind | Identifier | Where it appears |
| --- | --- | --- |
| npm package | `t3` | Published CLI (`apps/server`) |
| Environment variables | `T3CODE_*` (e.g. `T3CODE_PORT`, `T3CODE_MODE`, `T3CODE_AUTH_TOKEN`, `T3CODE_STATE_DIR`) | Server/runtime configuration |
| Workspace package names | `@t3tools/*` (e.g. `@t3tools/monorepo`, `@t3tools/contracts`, `@t3tools/shared`) | `package.json` files across the monorepo |
| Desktop user-data dir (legacy) | `T3 Code (Alpha)` / `T3 Code (Dev)` | First-run migration only; new installs use the F5 name |

These identifiers are expected to remain stable for at least the first public F5 release. A future release may introduce `F5_*` / `@f5tools/*` aliases or replacements; when that happens, the legacy names above will continue to be honored for a deprecation window.

## Attributions

- Original project: <https://github.com/pingdotgg/t3code>
- Fork maintained at: <https://github.com/lopes-felipe/f5>
- Third-party runtime dependencies: see [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
