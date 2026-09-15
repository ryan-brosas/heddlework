#!/usr/bin/env bash
#
# Live clipboard acceptance lane: real compositor, real clipboard tools, no stubs.
#
# It starts a disposable nested Hyprland on a private XDG_RUNTIME_DIR and WAYLAND_DISPLAY, so the run
# owns its own clipboard and can never read or replace the operator's. The host DISPLAY is removed from
# every child's environment; nothing here touches the session you are sitting in.
#
# Explicit opt-in because it starts a compositor:
#   HEDDLEWORK_CLIPBOARD_LIVE=1 bun run smoke:clipboard-live
#
set -euo pipefail

if [ "${HEDDLEWORK_CLIPBOARD_LIVE:-0}" != "1" ]; then
  echo 'refusing to run: set HEDDLEWORK_CLIPBOARD_LIVE=1 to start a disposable nested compositor' >&2
  exit 2
fi
if [ -z "${WAYLAND_DISPLAY:-}" ] || [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo 'this lane needs a live Wayland session to nest inside (WAYLAND_DISPLAY and XDG_RUNTIME_DIR)' >&2
  exit 2
fi

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
binary=${HEDDLEWORK_APP_BINARY:-"$repo_root/dist/heddlework"}
if [ ! -x "$binary" ]; then
  echo "app binary not found at $binary; run: bun run build" >&2
  exit 2
fi

root=$(mktemp -d "${TMPDIR:-/tmp}/heddlework-clipboard-live-XXXXXX")
mkdir -p "$root/config" "$root/runtime" "$root/cache" "$root/data" "$root/home" "$root/bin"
chmod 700 "$root/runtime"

# Logging shims: they delegate to the real tools, so the clipboard stays real while every call is
# recorded for evidence (which arguments the app used, what its own read returned).
cat > "$root/bin/wl-paste" <<EOF
#!/bin/sh
out=\$(mktemp)
/usr/bin/wl-paste "\$@" > "\$out" 2>/dev/null
code=\$?
printf '%s wl-paste args=[%s] exit=%s bytes=%s head=%s\n' "\$(date +%H:%M:%S.%3N)" "\$*" "\$code" "\$(wc -c < "\$out")" "\$(head -c 40 "\$out")" >> "$root/helper.log"
cat "\$out"
rm -f "\$out"
exit \$code
EOF
chmod 755 "$root/bin/wl-paste"
cat > "$root/bin/wl-copy" <<EOF
#!/bin/sh
printf '%s wl-copy args=[%s]\n' "\$(date +%H:%M:%S.%3N)" "\$*" >> "$root/helper.log"
exec /usr/bin/wl-copy "\$@"
EOF
chmod 755 "$root/bin/wl-copy"

# Nested session: a headless output is created after startup, and DISPLAY stays unset so no client can
# reach an X server from the operator's session.
printf 'monitor = ,1280x900@60,auto,1\nanimations {\n  enabled = false\n}\n' > "$root/hyprland.conf"
parent_display="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
env -u DISPLAY XDG_RUNTIME_DIR="$root/runtime" WAYLAND_DISPLAY="$parent_display" \
  XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" \
  LIBSEAT_BACKEND=seatd SEATD_SOCK="$root/no-seat.sock" \
  Hyprland -c "$root/hyprland.conf" > "$root/compositor.log" 2>&1 &
compositor_pid=$!
cleanup() { kill "$compositor_pid" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  [ -S "$root/runtime/wayland-1" ] && break
  sleep 0.5
done
if [ ! -S "$root/runtime/wayland-1" ]; then
  echo 'the nested compositor did not create a socket; last log lines:' >&2
  tail -20 "$root/compositor.log" >&2
  exit 1
fi
export XDG_RUNTIME_DIR="$root/runtime" WAYLAND_DISPLAY=wayland-1
hyprctl output create headless HW-CLIPBOARD-PROBE >/dev/null 2>&1 || true
sleep 1

marker="live-clipboard-$(od -An -N3 -tu4 /dev/urandom | tr -d ' ')"
status=0
PROBE_RUNTIME_DIR="$root/runtime" \
PROBE_WAYLAND_DISPLAY=wayland-1 \
PROBE_BINARY="$binary" \
PROBE_WORKSPACE="$root/home" \
PROBE_MARKER="$marker" \
PATH="$root/bin:$PATH" \
  bun "$repo_root/scripts/linux-clipboard-live-probe.ts" || status=$?

echo '--- clipboard helper calls recorded during the run'
cat "$root/helper.log" 2>/dev/null || echo '(no helper calls recorded)'
exit "$status"
