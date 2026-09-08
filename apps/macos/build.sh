#!/usr/bin/env bash
# Build ModelBot.app — the native macOS shell.
#
#   npm run app:mac                  # build the JS, then the app
#   npm run app:mac -- --no-js       # app only (dist/ already built)
#   npm run app:mac -- --arm64       # skip the universal slice
#   SIGN_IDENTITY="Developer ID Application: You (TEAMID)" npm run app:mac
#                                    # real signature; required for notifications
#
# Requires: Xcode Command Line Tools (swiftc, lipo, codesign, plutil) and Node.
# Produces: apps/macos/build/ModelBot.app, ad-hoc signed.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
BUILD_DIR="$APP_DIR/build"
APP="$BUILD_DIR/ModelBot.app"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 0.0.1)"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
DEPLOY_TARGET="13.0"

SKIP_JS=0
ARM_ONLY=0
SELFTEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-js) SKIP_JS=1 ;;
    --arm64) ARM_ONLY=1 ;;
    # Build arm64 only, then run the shell's own assertions and exit.
    --selftest) SELFTEST=1; ARM_ONLY=1; SKIP_JS=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m›\033[0m %s\n' "$1"; }

# 1. TypeScript → dist (the daemon the app supervises).
if [ "$SKIP_JS" = "1" ]; then
  say "skipping npm run build (--no-js)"
else
  say "building dist/"
  ( cd "$REPO_ROOT" && npm run build )
fi
if [ "$SELFTEST" = "0" ] && [ ! -f "$REPO_ROOT/dist/cli/index.js" ]; then
  echo "error: $REPO_ROOT/dist/cli/index.js is missing — run 'npm run build' first" >&2
  exit 1
fi

# 2. Compile. Universal when the x86_64 slice builds, arm64-only otherwise.
say "compiling Swift sources"
mkdir -p "$BUILD_DIR/obj" "$BUILD_DIR/modcache"
SOURCES=("$APP_DIR"/Sources/*.swift)

compile_slice() {
  arch="$1"
  out="$BUILD_DIR/obj/ModelBot-$arch"
  swiftc -O \
    -target "${arch}-apple-macosx${DEPLOY_TARGET}" \
    -module-cache-path "$BUILD_DIR/modcache" \
    -framework AppKit -framework WebKit -framework UserNotifications \
    -o "$out" "${SOURCES[@]}"
}

compile_slice arm64
ARM_SLICE="$BUILD_DIR/obj/ModelBot-arm64"

if [ "$SELFTEST" = "1" ]; then
  say "running the shell selftest"
  exec "$ARM_SLICE" --selftest
fi
X86_SLICE=""
if [ "$ARM_ONLY" = "0" ]; then
  if compile_slice x86_64 2>"$BUILD_DIR/x86_64.log"; then
    X86_SLICE="$BUILD_DIR/obj/ModelBot-x86_64"
    say "x86_64 slice built — universal binary"
  else
    say "x86_64 slice unavailable (see build/x86_64.log) — arm64 only"
  fi
fi

# 3. Assemble the bundle.
say "assembling $APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ -n "$X86_SLICE" ]; then
  lipo -create "$ARM_SLICE" "$X86_SLICE" -output "$APP/Contents/MacOS/ModelBot"
else
  cp "$ARM_SLICE" "$APP/Contents/MacOS/ModelBot"
fi
chmod +x "$APP/Contents/MacOS/ModelBot"
printf 'APPL????' > "$APP/Contents/PkgInfo"

sed -e "s|__VERSION__|$VERSION|" \
    -e "s|__BUILD__|$BUILD_NUMBER|" \
    -e "s|__REPO_ROOT__|$REPO_ROOT|" \
    "$APP_DIR/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# 4. Brand: the menu-bar mark, the About panel's wordmark, and the icon.
if [ -f "$REPO_ROOT/assets/brand/mark-mono.svg" ]; then
  cp "$REPO_ROOT/assets/brand/mark-mono.svg" "$APP/Contents/Resources/mark.svg"
  say "menu-bar mark: assets/brand/mark-mono.svg"
else
  say "menu-bar mark: assets/brand/mark-mono.svg not found — using the drawn fallback"
fi
for wordmark in wordmark wordmark-dark; do
  if [ -f "$REPO_ROOT/assets/brand/$wordmark.svg" ]; then
    cp "$REPO_ROOT/assets/brand/$wordmark.svg" "$APP/Contents/Resources/$wordmark.svg"
  fi
done
if [ -f "$APP/Contents/Resources/wordmark.svg" ]; then
  say "About panel wordmark: assets/brand/wordmark{,-dark}.svg"
else
  say "About panel wordmark: not found — falling back to the icon-only mark"
fi
if [ -f "$REPO_ROOT/assets/brand/ModelBot.icns" ]; then
  cp "$REPO_ROOT/assets/brand/ModelBot.icns" "$APP/Contents/Resources/AppIcon.icns"
  say "icon: assets/brand/ModelBot.icns"
else
  say "icon: assets/brand/ModelBot.icns not found — building without one"
fi

# Keep the source licence and redistribution notices with the compiled shell.
mkdir -p "$APP/Contents/Resources/licenses"
cp "$REPO_ROOT/LICENSE" "$REPO_ROOT/NOTICE" "$REPO_ROOT/THIRD_PARTY_NOTICES.md" \
  "$REPO_ROOT/sandbox/Moby-LICENSE.txt" "$REPO_ROOT/sandbox/Moby-NOTICE.txt" \
  "$APP/Contents/Resources/licenses/"

# 5. Signature.
#
# Ad-hoc by default: enough to run, and it is what a contributor gets with no
# certificate on the machine. It is NOT enough for notifications — macOS refuses
# UNUserNotificationCenter authorisation to an ad-hoc bundle, so the "your bot
# needs you" banner needs a real identity. Set SIGN_IDENTITY to one from
# `security find-identity -v -p codesigning` to get that; a Developer ID
# Application certificate is the one that works outside Xcode.
if [ -n "${SIGN_IDENTITY:-}" ]; then
  say "signing as $SIGN_IDENTITY"
  codesign --force --options runtime --sign "$SIGN_IDENTITY" --timestamp "$APP"
else
  say "signing (ad-hoc — notifications will be refused by macOS; see README)"
  codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1
fi
codesign -dv "$APP" 2>&1 | sed -n 's/^\(Identifier\|Format\|Authority\|flags\)/  &/p' || true

say "built $APP"
lipo -archs "$APP/Contents/MacOS/ModelBot" | sed 's/^/  archs: /'
du -sh "$APP" | sed 's/^/  size:  /'
