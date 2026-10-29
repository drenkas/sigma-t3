# Sigma T3 fork boundaries and local packaging

Sigma T3 is `drenkas/sigma-t3`, based on `pingdotgg/t3code`. Keep upstream history and internal `@t3tools/*`/MCP names. Repository groups, task coordination, and Graph extend T3 rather than replacing its execution state. The original Sigma repository remains a comparison source; importing its history is separate work.

## Identity and data

The macOS application is **Sigma T3**, bundle ID `com.drenkas.sigma-t3`. Production and development URL schemes are `sigma-t3` and `sigma-t3-dev`; official T3 links are not accepted as fork callbacks. Backend data defaults to `~/.sigma-t3`, or explicit `SIGMA_T3_HOME` / `--base-dir`. Official `T3CODE_HOME` is ignored. Electron profiles are `sigma-t3` and `sigma-t3-dev`, without automatic legacy profile or credential imports. Worktree development keeps its own gitignored `.t3`; use an explicit isolated home when testing.

T3 Connect uses upstream's hosted deployment. Its public identifiers come from the repository-root `.env` (see [T3 Connect setup](connect-setup.md#public-application-configuration)) and are embedded at build time. Direct provider login retains its existing validation and uses the fork's callback scheme.

## Fork schema and upstream merges

Fork tables migrate through `apps/server/src/persistence/SigmaMigrations.ts`, recorded in `sigma_sql_migrations`. Never add fork migrations to upstream's `Migrations.ts`: the migrator skips every id up to the highest recorded one, so a fork id there makes upstream's next migration refuse to start. Fork fields inside upstream schemas (the optional `role` on subagents and delegated tasks) are the places most likely to conflict when upstream changes the same shape; resolve them by keeping both.

## Build an isolated macOS arm64 preview

For daily use, `pnpm run sigma:preview-install [version]` runs the steps below in a separate `../sigma-t3-build` worktree from `origin/main`, copies this checkout's `.env` and `.env.local` into it, builds the ZIP, verifies the signature, and replaces `/Applications/Sigma T3.app` (the previous bundle goes to the Trash). It refuses to run while Sigma T3 is open. The default version is `<base>-preview.<UTC yyyyMMddHHmm>.g<short commit>`, shown in Settings → About, so the running build names the commit it came from.

From a clean owned checkout with locked dependencies:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec node scripts/update-release-package-versions.ts 0.1.0-preview.1
SIGMA_T3_HOME="$PWD/.scratch/package-home" SIGMA_T3_TELEMETRY_ENABLED=false T3CODE_DESKTOP_SIGNED=false corepack pnpm exec node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version 0.1.0-preview.1
```

The `pnpm exec node` invocation keeps the local `vp` binary on subprocess PATH. The generator updates server, desktop, web, and contracts package versions together. Artifact names use `Sigma-T3-<version>-<arch>`. The packaging script always passes `--publish never`. Preview versions omit updater feed configuration and cannot update from official T3. A stable/nightly build embeds only the `drenkas/sigma-t3` GitHub feed, regardless of ambient GitHub repository hints.

On this macOS 27 host, `hdiutil convert` can fail with `Resource temporarily unavailable`; dmgbuild then reports `plistlib.InvalidFileException` because conversion returned no plist. ZIP packaging avoids disk-image conversion. After a successful bundle build from the same sources, reuse it with:

```sh
SIGMA_T3_HOME="$PWD/.scratch/package-home" SIGMA_T3_TELEMETRY_ENABLED=false T3CODE_DESKTOP_SIGNED=false corepack pnpm exec node scripts/build-desktop-artifact.ts --platform mac --target zip --arch arm64 --build-version 0.1.0-preview.1 --skip-build --keep-stage
```

`--keep-stage` preserves the staged `.app` for inspection. A ZIP success does not establish a working DMG.

A preview with `T3CODE_DESKTOP_SIGNED=false` uses electron-builder's explicit ad-hoc signing (`mac.identity: "-"`) and skips notarization. This replaces Electron's inherited signature after renaming the bundle; hardened runtime remains enabled with electron-builder's existing local Electron entitlements. Signed builds retain their release signing and notarization path. Verify the resulting bundle with `codesign --verify --deep --strict`.

macOS keys privacy permissions (microphone, accessibility, screen recording, and the rest of TCC) on the app's designated requirement. For an ad-hoc signature that is the per-build cdhash, so every preview rebuild starts with no permissions. `sigma:preview-install` signs with the first Apple Development identity in the keychain when one exists. Otherwise set `SIGMA_PREVIEW_SIGNING_IDENTITY` (or pass `--preview-signing-identity` to the build script) to a code-signing identity from `security find-identity -v -p codesigning`, such as an Apple Development certificate or a self-signed one made in Keychain Access, and the preview's requirement becomes the certificate plus bundle identifier, which is stable across rebuilds. Grant permissions once more after switching; stale ad-hoc entries can be cleared with `tccutil reset All com.drenkas.sigma-t3`.

Ad-hoc and Apple Development signatures provide local bundle integrity, not Developer ID trust or notarization. Archive creation and signature verification do not establish launch readiness. Do not launch or install artifacts without the applicable user authorization.

## Release

Releases deliberately skip Developer ID and notarization, so Gatekeeper blocks the first launch; that is accepted. A release is a stable version (no `-preview.` or `-nightly.`), which embeds the `drenkas/sigma-t3` update feed, and the same unsigned path signs it with `SIGMA_PREVIEW_SIGNING_IDENTITY`. Keep that identity across releases: Squirrel.Mac only installs an update whose designated requirement matches the running app.

1. Commit `node scripts/update-release-package-versions.ts <version>` to `main` and push. Fork versions stay independent of upstream's and survive upstream merges.
2. In `../sigma-t3-build`, check out that commit, copy `.env`/`.env.local`, run `pnpm install --frozen-lockfile`, then build with the preview command above using `--target zip --build-version <version>` and `SIGMA_PREVIEW_SIGNING_IDENTITY` set.
3. Verify the app with `codesign --verify --deep --strict` and check that `Contents/Resources/app-update.yml` names the fork.
4. `gh release create v<version> --target <full commit sha>` with the ZIP, its blockmap, and `latest-mac.yml`. Installed releases update from the latest non-prerelease.

## Publication boundaries

GitHub Actions stays disabled until its jobs are reviewed. Preserve upstream publication guards; the upstream release workflow also publishes npm/mobile/AUR/hosted services and must not be repointed wholesale. Both server and generated npm launcher manifests are private. Standalone install scripts fail before network or disk changes; no standalone CLI channel is released. CLI release lookup defaults to the fork only.

Releases use generated platform YAML, ZIP and blockmaps; the old Sigma Tauri `latest.json` process does not apply. Publish only assets built from the exact tagged fork revision. Upstream sync never signs, installs, publishes, or changes stored app data.

## Privacy and auxiliary runtimes

Analytics is disabled by default and ignores upstream `T3CODE_TELEMETRY_*` / `T3CODE_POSTHOG_*` settings. Opting in requires `SIGMA_T3_TELEMETRY_ENABLED=true` and explicit `SIGMA_T3_POSTHOG_KEY` / `SIGMA_T3_POSTHOG_HOST`; this fork includes no default ingest destination or key. Disabled analytics does not inspect provider credentials or telemetry owners.

WSL caches and SSH device helpers use their own `.sigma-t3/wsl-runtime` and `.sigma-t3/device` roots. Linux capture helpers install below the `sigma-t3` data namespace; KDE authorization entries and GNOME extension UUID, bus name, object path, and allowed clients are fork-specific. Native Linux/WSL execution still needs platform acceptance.

`migrate-dev-db` defaults to the fork's `~/.sigma-t3/userdata/statev2.sqlite` and an isolated worktree destination. A deliberate import from another app requires a separately authorized explicit `--source`; it never happens as a fallback.
