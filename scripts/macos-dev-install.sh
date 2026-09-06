#!/usr/bin/env bash
# S6.3 MINI-SMOKE dev-install (macOS) — scope: validate the kill-switch + data
# plane ONLY. This is NOT the production installer (SMAppService); it is the
# minimal path to run the mini-smoke. Requires admin (sudo prompts).
set -euo pipefail

DIR=/usr/local/tunnex
PLIST=/Library/LaunchDaemons/io.tunnex.helper.plist
SOCK=/var/run/tunnex/helper.sock
LOG=/var/run/tunnex/helper.log
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HELPER_SRC="$REPO/apps/helper"

# Generate the exact same configuration for preview and installation. Never
# promote a rejected caller or a log entry into the privileged trust list.
if [[ "${1:-}" == --print-plist ]]; then
  exec node "$REPO/scripts/macos-dev-plist.cjs"
fi
if [[ $# != 0 ]]; then echo 'usage: macos-dev-install.sh [--print-plist]' >&2; exit 2; fi
umask 077
BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tunnex-dev-install.XXXXXX")
node "$REPO/scripts/macos-dev-plist.cjs" > "$BUILD_DIR/helper.plist"
plutil -lint "$BUILD_DIR/helper.plist"
echo ">> private build directory retained: $BUILD_DIR"

echo ">> [1/6] build helper (CGO_ENABLED=1 → native caller-auth) + tunnelctl driver"
( cd "$HELPER_SRC"
  CGO_ENABLED=1 go build -mod=readonly -o "$BUILD_DIR/tunnex-helper" ./cmd/tunnex-helper
  CGO_ENABLED=1 go build -mod=readonly -o "$BUILD_DIR/tunnelctl" ./cmd/tunnelctl )

echo ">> [2/6] install to $DIR (sudo)"
# Reject symlink targets before privileged writes; never follow a legacy /tmp log.
sudo /bin/sh -c '
  set -e
  for p in /usr/local/tunnex /usr/local/tunnex/tunnex-helper /usr/local/tunnex/tunnelctl /var/run/tunnex /var/run/tunnex/helper.log /Library/LaunchDaemons/io.tunnex.helper.plist; do
    if [ -L "$p" ]; then echo "Refusing symlink: $p" >&2; exit 1; fi
  done
  mkdir -p /usr/local/tunnex /var/run/tunnex
  chown root:wheel /usr/local/tunnex /var/run/tunnex
  chmod 755 /usr/local/tunnex /var/run/tunnex
  touch /var/run/tunnex/helper.log
  chown root:wheel /var/run/tunnex/helper.log
  chmod 600 /var/run/tunnex/helper.log
'
sudo cp "$BUILD_DIR/tunnex-helper" "$BUILD_DIR/tunnelctl" "$DIR/"
sudo chown root:wheel "$DIR/tunnex-helper" "$DIR/tunnelctl"
sudo chmod 0755 "$DIR" "$DIR/tunnex-helper" "$DIR/tunnelctl"
# Re-apply an ad-hoc signature IN PLACE. On Apple Silicon the sudo cp above
# invalidates the Go build-time signature, and the kernel then kills the binary on
# exec ("Killed: 9"). Sign the installed copies so they can run. (Dev-install only;
# the production SMAppService installer ships a real Developer ID signature — S6.5b.)
sudo codesign --force --sign - "$DIR/tunnex-helper" "$DIR/tunnelctl"

echo ">> [3/6] STEP ZERO — caller-auth indicator MUST print 'native':"
"$DIR/tunnex-helper" --version

echo ">> [4/6] reference the pf anchor from /etc/pf.conf (backup first) so it is EVALUATED"
if ! grep -q 'anchor "tunnex"' /etc/pf.conf; then
  sudo cp /etc/pf.conf /etc/pf.conf.tunnex-bak
  echo 'anchor "tunnex"' | sudo tee -a /etc/pf.conf >/dev/null
  sudo pfctl -f /etc/pf.conf 2>/dev/null || true
fi

echo ">> [5/6] write + load the LaunchDaemon"
sudo cp "$BUILD_DIR/helper.plist" "$PLIST"
sudo chown root:wheel "$PLIST"
sudo chmod 644 "$PLIST"
sudo launchctl bootout system "$PLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST"
sleep 1

echo ">> [6/6] daemon up? (expect a pid + the 'caller-auth: native' startup log)"
sudo launchctl print system/io.tunnex.helper 2>/dev/null | grep -E 'state|pid' | head -2 || true
sudo grep 'caller-auth' "$LOG" 2>/dev/null | tail -1 || true
echo ">> DONE. Driver: $DIR/tunnelctl   Socket: $SOCK   Log: $LOG"
