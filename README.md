# Vigil

Vigil is the [Guildbook](https://guildbook.io) desktop companion for WoW: Forever. It sits on a second monitor, tails `WoWCombatLog*.txt`, shows the current fight live (score, GCD use, idle time, uptimes, rotation callouts) and uploads each finished fight to your guild's Guildbook site.

It only reads the combat log file on disk. It never sends input to the game, reads its memory or looks at the screen.

Download it from [guildbook.io/vigil](https://guildbook.io/vigil) or from [Releases](https://github.com/Guildbook/vigil/releases).

## Install

| Platform | File |
|---|---|
| macOS (Apple Silicon and Intel) | `Vigil-x.y.z-mac-universal.dmg` |
| Windows 10/11 (x64) | `Vigil-x.y.z-win-x64.exe` |
| Linux (x64) | `Vigil-x.y.z-linux-x86_64.AppImage` |

### Unsigned builds

Until code signing is set up, builds are unsigned, so the operating system warns on first launch:

- **macOS:** open the dmg and drag Vigil to Applications. The first time, right-click (or Control-click) Vigil in Applications and choose **Open**, then **Open** again. If macOS still refuses, go to System Settings, Privacy & Security, and click **Open Anyway**.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
- **Linux:** `chmod +x Vigil-*.AppImage`, then run it.

Unsigned macOS builds can't update themselves (macOS only installs updates signed by the same Developer ID); they tell you when a new version exists and link to the download page. Windows and AppImage builds update themselves.

### Setup

1. In the game, turn on **Advanced Combat Logging** once, in System > Network.
2. Type `/combatlog` in chat to start logging (the bundled Vigil addon can turn it on at every login with `/vigil log on`).
3. On your guild's Guildbook site, open **Vigil**, then **Connect Vigil companion**, create a pairing code and enter it in the app's settings (or click **Open in the companion**).

## Development

Requires Node 22 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm dev           # build, watch and launch (pairs through http://localhost:3000, a local Guildbook site)
pnpm typecheck
pnpm lint
pnpm test          # tailer, engine, paths, uploader, trusted-origin and house-style tests
```

Without the game, try it with a synthetic log written in real time:

```bash
pnpm demo:log /tmp/vigil-demo/Logs                  # terminal 1
VIGIL_LOGS_DIR=/tmp/vigil-demo/Logs pnpm dev         # terminal 2
```

Development-only variables: `VIGIL_SITE_URL` (the site to pair with, default `http://localhost:3000`), `VIGIL_LOGS_DIR` (Logs folder), `VIGIL_USER_DATA` (settings folder), `VIGIL_PAIR_CODE` (pair on launch), `VIGIL_CAPTURE_DIR` (save window PNGs every `VIGIL_CAPTURE_EVERY_MS`). Packaged builds ignore them.

### Layout

```text
src/core/        log tailer, live engine, uploader, WoW paths, addon install, trusted origins
src/main/        Electron main process, preload, settings store, auto-update
src/renderer/    the window (HTML, CSS, TypeScript)
shared/lib/      combat log parser and Vigil analysis, vendored from the Guildbook site
resources/addon/ the Vigil in-game addon, installed by the app
build/           icons and macOS entitlements
test/            Vitest tests; test/support/ builds synthetic combat logs
```

### Shared code

`shared/lib/` is a copy of the Guildbook site's `src/lib/combatlog/`, `src/lib/vigil/` (analysis, live session, rotations, report schema) and `src/lib/game.ts`. Imports use `@/lib/...`, which esbuild, Vitest and `tsc` resolve to `shared/`, so files can be copied between the repositories unchanged. The report schema (`shared/lib/vigil/report.ts`) is the upload contract with the site's `/api/vigil/companion/reports`, so change both together.

### Trusted servers

Every API call goes to one home server, baked in at build time (`VIGIL_HOME_URL`, default `https://guildbook.io`; `scripts/build.mjs` refuses anything but a public https origin). Pairing codes are global, so the home server knows which guild a code belongs to and answers with that guild's site (its subdomain, or a verified custom domain). Links open only for the home domain and its subdomains, the paired guild's own site and `github.com/Guildbook/` (`src/core/origins.ts`, tested). Development runs are the only builds that accept local hosts. The window's CSP allows only its own files and no network access; the main process does all networking. The device token is stored with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows).

## Packaging

`electron-builder.config.cjs` builds a universal macOS dmg and zip, a Windows NSIS installer (x64) and a Linux AppImage (x64), with app id `io.guildbook.vigil`. Output goes to `release/` (gitignored).

```bash
pnpm dist          # the current OS, unsigned unless signing variables are set
pnpm dist:mac      # universal dmg + zip (ad-hoc signed without a Developer ID)
pnpm dist:dir      # unpacked app only, for a quick look
```

Signing and notarization switch on when their variables are set and are skipped otherwise (`scripts/signing.cjs`). Signed macOS builds use the hardened runtime with `build/entitlements.mac.plist`.

**Auto-update.** `electron-updater` checks this repository's latest GitHub Release 15 seconds after launch and every six hours.

## Releasing

1. Bump `version` in `package.json` (for example to `0.2.0`) and commit.
2. Tag and push: `git tag -a v0.2.0 -m "What changed, in Markdown"` then `git push origin v0.2.0`. The tag message becomes the release notes; the tag must match the package version.
3. `.github/workflows/release.yml` creates a draft release, builds on macOS, Windows and Linux, uploads the installers and `latest*.yml` (the update feeds), and adds a marker to the notes saying which builds are signed.
4. Check the draft, edit the notes if you like (keep the `vigil-signing` comment, which the download page reads), and publish it as the latest release. [guildbook.io/vigil](https://guildbook.io/vigil) picks it up within the hour, and installed apps on their next check.

`.github/workflows/ci.yml` typechecks, lints, tests and bundles on pushes to `main` and pull requests.

### Signing secrets

Repository secrets (Settings, Secrets and variables, Actions). All optional; without them the builds are unsigned.

| Platform | Secrets |
|---|---|
| macOS signing | `MAC_CSC_LINK` (base64 of the Developer ID Application `.p12`), `MAC_CSC_KEY_PASSWORD` |
| macOS notarization (API key, preferred) | `APPLE_API_KEY_P8` (contents of the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| macOS notarization (Apple ID) | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows, Azure Trusted Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, `AZURE_TRUSTED_SIGNING_PUBLISHER` |
| Windows, certificate | `WIN_CSC_LINK` (base64 of the `.pfx`), `WIN_CSC_KEY_PASSWORD` |

A Mac build only counts as signed when it is also notarized; otherwise Gatekeeper still stops it on first launch.

## License

Vigil is licensed under the [GNU Affero General Public License v3.0](LICENSE). The bundled Cinzel and Inter fonts are under the SIL Open Font License.

World of Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. Vigil is not affiliated with or endorsed by Blizzard.
