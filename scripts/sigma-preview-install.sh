#!/usr/bin/env bash
# Builds a local ad-hoc signed macOS arm64 preview of Sigma T3 from origin/main
# and installs it into /Applications. See docs/operations/sigma-fork.md.
#
# Usage: scripts/sigma-preview-install.sh [version]
#   version  defaults to <desktop version>-preview.<UTC timestamp>
#
# Env: SIGMA_PREVIEW_BUILD_DIR  build worktree (default: ../sigma-t3-build next to this checkout)
#      SIGMA_PREVIEW_REF        ref to build (default: origin/main)
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: this script builds a macOS arm64 preview and must run on an Apple Silicon Mac." >&2
  exit 1
fi

APP_NAME="Sigma T3"
INSTALL_PATH="/Applications/${APP_NAME}.app"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
BUILD_DIR="${SIGMA_PREVIEW_BUILD_DIR:-$(dirname "$REPO_ROOT")/sigma-t3-build}"
REF="${SIGMA_PREVIEW_REF:-origin/main}"

# Replacing the bundle under a running app corrupts its session; ask instead of killing it.
if pgrep -xq "$APP_NAME"; then
  echo "error: ${APP_NAME} is running. Quit it and run this script again." >&2
  exit 1
fi

echo "==> Fetching origin"
git -C "$REPO_ROOT" fetch origin

# The build rewrites package versions, so it never runs in the developer's checkout.
if [[ -d "$BUILD_DIR" ]]; then
  echo "==> Updating build worktree ${BUILD_DIR} to ${REF}"
  git -C "$BUILD_DIR" checkout --force --detach "$REF"
else
  echo "==> Creating build worktree ${BUILD_DIR} at ${REF}"
  git -C "$REPO_ROOT" worktree add --detach "$BUILD_DIR" "$REF"
fi
cd "$BUILD_DIR"

# `pnpm run` can put a node without corepack first on PATH, so prefer pnpm itself.
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  echo "error: neither pnpm nor corepack is on PATH." >&2
  exit 1
fi

BASE_VERSION="$(node -p 'require("./apps/desktop/package.json").version.split("-")[0]')"
VERSION="${1:-${BASE_VERSION}-preview.$(date -u +%Y%m%d%H%M)}"
if [[ "$VERSION" != *-preview.* ]]; then
  echo "error: version '${VERSION}' must contain '-preview.' so the build omits the update feed." >&2
  exit 1
fi
echo "==> Building ${APP_NAME} ${VERSION} from $(git rev-parse --short HEAD)"

"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" exec node scripts/update-release-package-versions.ts "$VERSION"

rm -rf release
# ZIP rather than DMG: hdiutil conversion is unreliable on recent macOS hosts.
SIGMA_T3_HOME="$PWD/.scratch/package-home" \
  SIGMA_T3_TELEMETRY_ENABLED=false \
  T3CODE_DESKTOP_SIGNED=false \
  "${PNPM[@]}" exec node scripts/build-desktop-artifact.ts \
  --platform mac --target zip --arch arm64 --build-version "$VERSION"

ZIP_PATH="release/Sigma-T3-${VERSION}-arm64.zip"
if [[ ! -f "$ZIP_PATH" ]]; then
  echo "error: expected artifact ${ZIP_PATH} was not produced." >&2
  exit 1
fi

UNPACK_DIR="$PWD/.scratch/preview-unpack"
rm -rf "$UNPACK_DIR"
mkdir -p "$UNPACK_DIR"
ditto -x -k "$ZIP_PATH" "$UNPACK_DIR"
codesign --verify --deep --strict "$UNPACK_DIR/${APP_NAME}.app"

if [[ -d "$INSTALL_PATH" ]]; then
  BACKUP_PATH="$HOME/.Trash/${APP_NAME} $(date +%Y%m%d-%H%M%S).app"
  echo "==> Moving previous install to ${BACKUP_PATH}"
  mv "$INSTALL_PATH" "$BACKUP_PATH"
fi
mv "$UNPACK_DIR/${APP_NAME}.app" "$INSTALL_PATH"
rm -rf "$UNPACK_DIR"

echo "==> Installed ${APP_NAME} ${VERSION} to ${INSTALL_PATH}"
echo "    Data stays in ~/.sigma-t3/userdata; the previous app is in the Trash."
