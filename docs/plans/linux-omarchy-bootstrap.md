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
3. `ryan-brosas/heddlework` - fork (`exclude.forks` deliberately off); the previous repository's
   default branch was indexed. The GitHub fork was deleted and recreated on 2026-09-12, so verify
   repository identity and indexed revision coverage again before relying on this entry. The
   pre-reset feature branches are now local backups, not branches in the recreated remote.

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

- Bare `bun test` also discovers the untracked `external/gpuix` checkout, whose `TestGpuixRenderer`
  is macOS/Windows-only (wgpu has no Linux readback yet). The package's `test` script now explicitly
  runs `bun test ./tests`, so `bun run check` uses the same project-owned tests locally and in CI.
- Global git config `diff.mnemonicprefix=true` rewrote `a/ b/` prefixes to `c/ w/`, breaking
  workspace-diff parsing into `changed file` placeholders. Fixed in `src/workspace/git-diff.ts` by
  pinning `diff.mnemonicprefix=false`, `diff.noprefix=false`, `diff.srcPrefix=a/`, and
  `diff.dstPrefix=b/` on every diff invocation. `tests/workspace-diff.test.ts` covers mnemonic,
  missing, and custom prefixes using isolated repository-local Git configuration.
- A `hyprctl -j clients` probe verifies window registration only: app_id/class, pid, geometry,
  liveness. It does NOT exercise decorations, fractional scaling, minimize/maximize/close, or
  multi-monitor moves - scope Wayland claims to what the probe covered (2026-09-12 probe verified
  app_id registration only). Write the jq filter to a file and run `jq -f`; inline jq quoting is
  eaten by the shell (hit twice 2026-09-12).

## Session switch latency (2026-09-12)

Switching threads was unusable on large sessions. Traced with `bun run benchmark:session-switch`
against a real `pi --mode rpc` (117 MiB transcript, 10 000+ entries) on this Omarchy box:

```
step                      milliseconds
local transcript page             11.1
switch_session                  7500.3
get_state                          0.3
get_session_stats                  0.9
get_fork_messages                  0.3
get_tree                       17600.1

interactive first paint           11.1  (optimistic preview from the session JSONL)
before: preview                 25111.5  (awaited switch_session + get_tree before the transcript)
```

Two facts drive this, and both are Pi-side, not renderer-side:

1. `switch_session` and `get_tree` are O(session size) in Pi. `get_tree` rebuilds the whole
   tree: ~17 s at 117 MiB, and it is also issued on every `message_end` refresh.
2. Pi processes RPC commands **serially**. A `get_tree` issued in the background blocks every
   later command for its full duration (measured: `get_state` 17.1 s behind an in-flight
   `get_tree`), so "just fire it and forget it" is not safe — it delays the next prompt.

`WorkbenchController` therefore no longer awaits or proactively issues `get_tree`:

- `switchSession` paints the clicked thread from its own persisted JSONL tail
  (`PiSessionHistoryPager`, ~11 ms) before `switch_session` resolves, and `#bootstrap` then
  replaces that preview with authoritative state. Header, workspace, queue, and diff scope move
  with the click.
- `#bootstrap` awaits only `get_state`; the transcript load no longer waits on the tree.
- `#refreshMessages` no longer fetches the tree at all.
- `get_tree` runs only when Pi's leaf cannot be derived from the file: in-memory tree navigation
  (`navigateTree`), `fork`, and `clone`. Pi's `branch()`/`resetLeaf()` move the leaf without
  appending, so `docs/pi-session-tree.md`'s leafId contract still holds — the anchor is captured
  from one `get_tree`, and every other path uses the file tip (Pi appends every new entry under
  the current leaf, and `_buildIndex` sets `leafId` to the file's last entry on load). An append,
  a different session file, or a `/reload` invalidates the anchor.
- A click that lands during a transition (a switch or `/new`) is kept as the newest target and
  opens when that transition ends - every transition exit drains it, not just `switchSession`. Its
  caller settles only once the target really opened, so no caller acts on a thread Pi has not
  switched to.
- A rejected `switch_session` puts the optimistic scope back and re-bootstraps from Pi: Pi keeps the
  previous session open, and leaving the clicked thread on screen sent the next prompt into the
  previous thread under the wrong header.

Measured end to end through `WorkbenchController` against real Pi and the same 117 MiB session:
first transcript paint **31 860 ms -> 8 ms** after the click; `switchSession` settles when Pi's own
`switch_session` returns (~3.7-8 s). Regression coverage lives in `tests/session-switch.test.ts`
(instant preview, deferred click settlement, rollback after a rejected switch, no `get_tree` on the
switch/refresh path, leaf anchor after navigation, anchor kept until the file grows, anchor dropped
across a session switch). Each rule was mutation-checked: reverting it fails its test.

## Open items

- `.github/workflows/check.yml` runs the Linux job `test` on `ubuntu-24.04` with
  `NAPI_RS_NATIVE_LIBRARY_PATH` testing. Its check name is unchanged. The macOS job was removed
  at the owner's request; do not reintroduce it as part of restoring the old fork.
- `bun run setup:native` failed on every fresh clone for two reasons, both fixed in the installer:
  `bun install` materializes `@gpuix/react` as a real directory that the guard refused to replace
  (it now replaces only the package manager's own copy, identified by its `package.json` name, and
  still refuses anything else); and the built addon was never installed, so `@gpuix/native` kept
  loading the published platform binary and the API check failed with `Missing native API:
  setTerminalFrame`. The pinned addon and its declarations are now installed over the resolved
  package, and a cache hit is verified against that API check before it is trusted - a stamp
  without its artifacts, or with artifacts that no longer answer, forces a rebuild.

- `.github/workflows/linux.yml` retains the six compositor cases behind `workflow_dispatch` only,
  at the owner's request. They no longer run automatically on PRs or pushes. The previous fork's
  compositor failures are not fixed by this scheduling change; manual Linux acceptance is still
  required before claiming compositor support.
- Restore or re-derive `docs/linux-acceptance.md` and the native-runtime notes from `backup/main-35ahead`
  when the corresponding work is re-landed on `main`.
- CEF on Linux is unaddressed (macOS-only today, see `docs/browser.md`); browser-free builds are the Linux
  default until a Linux CEF packaging path exists.
