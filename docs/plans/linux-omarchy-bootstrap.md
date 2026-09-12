# Linux / Omarchy bootstrap

Working plan for the Linux (Omarchy: Arch + Hyprland + Wayland, x86_64) support lane of the
ryan-brosas/heddlework fork. Ground truth over this file: verify pins, branches and gates before
acting on them.

## Verified state (2026-09-12)

- Fork `main` = fresh fork of upstream: `fd4496d` (`feat(platform): align native runtime and add web companion`),
  identical to `upstream/main` and `origin/main`. The previous Linux work (35 commits, incl. WP-12/WP-13) is
  preserved locally on `backup/main-35ahead` and `feat/linux-adoption-foundations` (`4298ef3`).
- `gpuix-runtime.json` pins `monotykamary/gpuix@2b94075` and `monotykamary/zed@e94e7f5`. Both pins are the tip
  of each fork's `feat/heddlework-platform-alignment` branch and strictly contain that fork's `main`
  (verified: `rev-list --count pin..main` = 0 on both). The pins are not stale relative to their forks.
- Fork branches ahead of the gpuix pin by +2 commits: `feat/embedding-primitives`, `feat/dynamic-image-primitives`,
  `reference/native-terminal-surface`, `reference/heddlework-native-primitives`, `reference/embedded-primary-clicks`.
  Ahead of the zed pin: `fix/anthropic-cache-control-logic` (+3), `reference/gpuix-render-pipeline` (+2).
- Toolchain present: bun, cargo 1.98, node 24. Native source cache exists at
  `node_modules/.cache/heddlework-gpuix/2b94075d1cb6c33b29fd884b0b2928bb261e56a8`.
- Upstream heads move daily (`zed-industries/zed` = `a9cdfc99`, `remorses/gpuix` = `18e695ed` as of this check);
  the alignment branches must periodically merge upstream main and re-pin.

## Sourcebot corpus

Indexed and usable: `remorses/gpuix`, `zed-industries/zed` (wayland seams: `crates/gpui/src/platform.rs`
`set_app_id` / `set_app_identity`, `feature = "wayland"` gates; no `xdg-activation` hits in the indexed snapshot),
`omacom/omarchy` (default branch `quattro`), `monotykamary/heddlework`.

Ingested 2026-09-12 via a `heddlework-lane` connection in `/home/utopia/sourcebot/config.json`
(backup: `backups/config.pre-linux-lane.json`), with revisions
`feat/heddlework-platform-alignment` + `feat/linux-omarchy-bootstrap`:

1. `monotykamary/gpuix` - alignment branch indexed at the pin `2b94075` (`isIndexed: true`).
2. `monotykamary/zed` - alignment branch indexed at the pin `e94e7f5` (`isIndexed: true`).
3. `ryan-brosas/heddlework` - fork (`exclude.forks` deliberately off); default branch indexed.
   `feat/linux-omarchy-bootstrap` indexes once it is pushed to origin. The pre-reset
   `feat/linux-adoption-foundations` exists remotely but is not in the revisions list.

Verified cross-repo finds from the new corpus: the fork's GPUI `activate()`
(`crates/gpui/src/platform/linux/wayland/window.rs:850-865`, monotykamary/zed) requests an
xdg-activation token bound to app_id + serial + surface - the prior art for Heddlework's
focus-on-launch and app-identity workstream. Fractional scaling is wp_fractional_scale v1 in
`crates/gpui/src/platform/linux/wayland/client.rs`; Ghostty's Wayland activation prior art is
`src/apprt/gtk/winproto/wayland.zig`.

## Zed <> GPUix Wayland workstream

Grounded in `docs/platform-alignment.md` (validation passed against GPUix `2b94075` on Mutter Wayland,
Sway Wayland, Mutter/X11) and the gaps it records:

1. Expose window capabilities from the native UI thread through GPUix: effective server/client decorations,
   maximized/fullscreen state, resizability. `titlebarTransparent` alone is not a portable switch.
2. Expose minimize / maximize-restore / close through GPUix's JS API (close must run terminal/browser cleanup,
   not terminate the process).
3. Begin move/resize from the initiating native pointer press, preserving Wayland serials.
4. App identity: keep `io.github.monotykamary.heddlework` set via GPUIX window options on Linux; Zed's
   `set_app_id` seam is the upstream reference (`crates/gpui/src/platform.rs`).
5. Candidate absorption: review the +2/+3 fork branches listed above before repinning; adopt per concern,
   never wholesale.
6. Test explicitly on Hyprland (wlroots) and GNOME (Mutter): decoration negotiation, fractional scaling,
   multi-monitor moves, fullscreen, XWayland/X11 fallback. macOS headless layout tests prove nothing here.

## Heddlework alignment loop

To move pins or absorb fork work: update `gpuix-runtime.json`, run `bun run setup:native` (builds native + React
from the pinned sources; the reconciler/React symlink discipline is enforced by the script), then run the gates.
Pin the ABI, JS and declarations from one artifact; never publish a pin without passing checks.

## Verification gates (Linux, verified in this repo's package.json)

```bash
bun install --frozen-lockfile
bun run typecheck && bun run typecheck:web
bun test ./tests
bun run check          # typecheck + typecheck:web + test + test:performance + web-dom-e2e
bun run build          # HEDDLEWORK_WITHOUT_CEF=1 for browser-free
```

`check:native` / `check:ai-slop` do not exist in the fresh-fork `package.json`; re-add or drop them from agent
instructions deliberately.

Local-workspace traps (both hit and fixed 2026-09-12):

- The untracked `external/gpuix` checkout sweeps into root `bun test`, and GPUix's `TestGpuixRenderer`
  is macOS/Windows-only (wgpu has no Linux readback yet). Locally, gate with `bun test ./tests` +
  `bun run typecheck` + `bun run typecheck:web`; CI checkouts have no `external/` and can run
  `bun run check` directly.
- Global git config `diff.mnemonicprefix=true` rewrote `a/ b/` prefixes to `c/ w/`, breaking
  workspace-diff parsing into `changed file` placeholders. Fixed in `src/workspace/git-diff.ts` by
  forcing `-c diff.mnemonicprefix=false -c diff.noprefix=false` on every diff invocation; regression
  coverage in `tests/workspace-diff.test.ts` (GIT_CONFIG_GLOBAL fixture).
- A `hyprctl -j clients` probe verifies window registration only: app_id/class, pid, geometry,
  liveness. It does NOT exercise decorations, fractional scaling, minimize/maximize/close, or
  multi-monitor moves - scope Wayland claims to what the probe covered (2026-09-12 probe verified
  app_id registration only). Write the jq filter to a file and run `jq -f`; inline jq quoting is
  eaten by the shell (hit twice 2026-09-12).

## Open items

- `.github/workflows/check.yml` runs on `macos-latest`; the fork's purpose is Linux-first - move the primary
  job to `ubuntu-24.04` with `NAPI_RS_NATIVE_LIBRARY_PATH`-based testing, keep macOS/Windows best-effort.
- Restore or re-derive `docs/linux-acceptance.md` and the native-runtime notes from `backup/main-35ahead`
  when the corresponding work is re-landed on `main`.
- CEF on Linux is unaddressed (macOS-only today, see `docs/browser.md`); browser-free builds are the Linux
  default until a Linux CEF packaging path exists.
