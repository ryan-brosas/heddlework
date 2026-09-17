# Linux / Omarchy bootstrap

## Browser-free daily-driver acceptance (2026-09-15)

- [x] Reproducible pin + one declared patch set per repository; unexplained build inputs fail the install,
  and the preserved portal/appearance work is now declared rather than sitting in the cache.
- [x] Shared native copy/paste through the element's caret-aware action, plus one `paste` event per gesture
  carrying the inserted text, so the composer attaches the image half exactly once.
- [x] Composer/session/submit and web-companion behaviour covered; the JavaScript-owner lane still passes.
- [x] Lane evidence exercises the gesture it claims: `insert-keys-single-owner` presses `Ctrl+Insert` over a
  real selection and asserts no app-side clipboard write, and the native paste checks are named skips that
  point at the live compositor lane. Native *copy* is not automatable - see the serial note below - so it is
  a manual acceptance step.
- [x] `bun run check` green (517 passed, 0 failed; 101 structural native-renderer skips); `bun run build`
  matches the installed executable; the stubbed lane passes on the installed build with named skips; the
  live nested-Hyprland lane passes paste byte-for-byte and reports native copy as manual.
- [x] Lane evidence re-measured after the merge (`af72318`, installed artifact `sha256=41f3f8b9…`): the live
  nested-Hyprland lane reports 4 checks passed and 1 named manual skip, and the stub lane 4 passed with 10
  named skips. The copy skip now says the runtime's missing-serial diagnostic is not observable on this
  build; the copy verdict, and both clipboard stages, are decided by `scripts/linux-clipboard-live-evidence.ts`
  so a failed or timed-out helper can no longer count as evidence.
- [ ] Device-level acceptance on this machine's own Hyprland session: physical `Ctrl+V`/`Super+C` (including
  the `Ctrl+Insert` copy half, which no automated lane can stimulate) through the
  desktop launcher, the 150%/100% monitor pair, IME/accessibility, real Pi work, and PTY
  interruption/cleanup. Automated results do not check this box.

### Physical acceptance record (operator, own session)

Run `bun scripts/linux-artifact-check.ts` first and record its hash with every row below as **pass / fail /
blocked**; a row without a hash is not evidence. Automated results never close these rows.

| Gesture or check | Where | What counts as pass |
| --- | --- | --- |
| `Ctrl+V` -> `Shift+Insert` paste | composer | text lands at the caret exactly once, undo restores the previous draft |
| Image-only clipboard paste | composer | exactly one attachment, draft preserved |
| `Super+C` -> `Ctrl+Insert` copy | dragged transcript selection | `wl-paste --no-newline --type text` returns exactly the dragged text |
| `Ctrl+Insert` copy | terminal viewport | zero PTY bytes are written, and the clipboard holds the visible viewport with trailing padding and unused blank rows trimmed; for an empty or all-blank viewport the app copies nothing, so pre-existing clipboard contents stay as they were - that is a pass, not a failure |
| Plain `Ctrl+C` | terminal | foreground process is interrupted, nothing is copied |
| Move between 150% and 100% monitors | window | caret and selection still line up, no clipped chrome |
| IME composition | composer | commit, cancel and no premature submit |
| Session close | terminal | no child process survives the session |

Which owner should handle each gesture, so a row is not failed for doing what the design intends:

- The **composer** is a native text element, so `Ctrl+V`/`Shift+Insert` and `Ctrl+Insert` belong to the pinned runtime's caret-aware actions. The composer only attaches the clipboard *image* half, once per runtime `paste` event (`nativeClipboardEditing()` in `src/ui/clipboard-ownership.ts`).
- The **terminal** paints through `setTerminalFrame`, so the application dispatches its keys itself: `TerminalView.onKeyDown` sends every key to `dispatchTerminalKey` (`src/terminal/keys.ts`) with no runtime-capability check. Its copy exports the visible viewport, not a modeled selection - terminal drag-selection is separate follow-up work (`docs/terminal.md`), so composing that row against a drag selection would test a feature the plan does not claim. No automated lane establishes what the runtime does with `Ctrl+Insert` while a terminal has focus, which is why the row asks the helper log to show exactly one clipboard write and zero PTY bytes rather than assuming the app path handled it.
- Every copy row is read back with `wl-paste --no-newline --type text` and recorded against the artifact hash from `bun scripts/linux-artifact-check.ts`. Clipboard bytes that do not match the source are a failure; an unchanged clipboard is only a pass when the surface that handled the gesture is the one that owns it above.

Status vocabulary, so implemented work is not re-planned as absent:

- **Implemented**: the runtime capability APIs (`getWindowState`, `minimizeWindow`, `toggleMaximizeWindow`, `closeWindow` in `src/native-runtime.ts`, declared by `patches/gpuix/0001-linux-native-runtime.patch`), the capability-driven client chrome and drag/resize regions (`src/ui/linux-window-chrome.tsx`, `src/ui/window-controls.ts`), and the portal-first project picker (`src/ui/portal-file-chooser.ts`).
- **Automatically verified**: `tests/window-controls.test.ts`, `tests/linux-window-chrome.test.tsx`, `tests/window-options.test.ts`, `tests/native-window-lifecycle.test.ts`, `tests/portal-file-chooser.test.ts`, plus the headless PTY and nested-compositor clipboard lanes.
- **Physically verified**: nothing in this table yet. The window chrome above is implemented and unit-tested but never confirmed on this box's own Hyprland session; decorations, fractional scaling, multi-monitor moves and fullscreen stay unverified until the rows below are filled in.

Scope: browser-free Omarchy daily use. Linux CEF, OS notifications and appearance/picker polish are
separate follow-ups.

Working plan for the Linux (Omarchy: Arch + Hyprland + Wayland, x86_64) support lane of the
ryan-brosas/heddlework fork. Ground truth over this file: verify pins, branches and gates before
acting on them.

## Verified state (2026-09-12)

- Fork `main` = upstream fork point `fd4496d` (`feat(platform): align native runtime and add web companion`)
  plus the re-landed Linux foundations, merged from PR #1 (`67653a1`, head `3be39b3`) on 2026-09-12; it no
  longer mirrors `upstream/main`. The previous Linux work (35 commits, incl. WP-12/WP-13) is
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
(backup: `backups/config.pre-linux-lane.json`; 2026-09-12 branch revision fix backup:
`backups/config.pre-linux-workspace-foundations.json`), with revisions
`feat/heddlework-platform-alignment` + `feat/linux-omarchy-bootstrap`
+ `feat/linux-workspace-foundations` (added 2026-09-12 after the fork recreation, so the
active Linux work branch is indexed — project AGENTS.md makes Sourcebot the code-truth
authority and carries the standing explicit `ask_codebase` request):

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
first transcript paint **31 860 ms -> 8 ms** after the click. Regression coverage lives in `tests/session-switch.test.ts`.

**Linux UI-thread polls during a switch.** Optimistic JSONL preview is not enough if JS is stuck in
`getWindowSize`/`getWindowState`: both are `recv_ui_response` round trips with a 2s timeout while
GPUI paints the remounted transcript (gpuix `packages/native/src/renderer.rs`). The workbench now
uses a 300 ms idle size/chrome poll and backs both off to 1.5 s while streaming or `Opening thread`.
Row identity is reset on `sessionKey` so a switch cannot reuse the previous thread's memoized rows.
The native virtual list is not remounted per session (appearance only), so Linux does not rebuild
every GPUI view on each click.

**Do not hold the click lock for Pi parse.** `switchSession` used to `await #bootstrap` /
`get_state`. Pi parses the whole JSONL on a cold `--session` open (~5–10 s at 117 MiB), and the
desktop launcher `cd`s to `$HOME`, so the sidebar is full of those threads. The click now paints
the JSONL tail, attaches the harness (120 ms spawn), marks Ready, and bootstraps in the background.
A later `get_state` cannot clobber a newer click (`#bootstrapGeneration` bumps at switch start).
Dogfood the installed preview (`packaging/linux/install-user.sh`) after this change; the running
`.desktop` process keeps the previous image.

**Session-scoped harnesses (2026-09-12).** `switch_session` itself still costs ~7.5 s on a 117 MiB
thread (Pi parses the whole file), Pi's RPC loop is serial, and `runtimeHost.switchSession` aborts
the in-flight turn (`teardownCurrent` -> `session.abort()`) - so switching stopped running work no
matter what the client did. `WorkbenchController` therefore no longer shares one Pi RPC process:
each session gets a dedicated harness (`pi --mode rpc --session <file>`, ~4.9 s cold open on the
117 MiB thread, paid once per session), pooled per session file and reused on return. A switch is a
pointer swap plus the optimistic preview; the previous harness keeps running its turn, so work
continues while another thread is open. The visible overlay (streaming flag, live tools, dialogs)
is snapshotted per session file and restored on return. Switching must not send
`extension_ui_response cancelled` to the old Pi — that aborts the background turn. `createSessionTransport` is injected
(`createWorkbenchControllerPlugin` mirrors the app's transport options; tests spawn fakes).
Removed on the switch path: the client-side `abort` and `switch_session` requests. Events/status
route only from the active harness (guarded `#attachActiveTransport`); the pool re-keys after
`new_session` re-files the active harness and every pooled harness stops on dispose. `/reload`
still stop/starts and `switch_session`s the active harness. Background turns stay visible: each
harness is watched (`#attachBackgroundTracking`) and `state.sessionActivity[file]` drives the
sidebar's running badge for non-open threads (`src/ui/sidebar.tsx`), with crashed background
harnesses dropped from the pool so the next open respawns them.

## Clipboard write stall on Linux (2026-09-14, fixed)

Terminal copy did nothing on Wayland: `wl-copy`/`xclip` fork a selection owner that outlives the command
and inherits its stdio, so the promise in `src/ui/clipboard-media.ts` waited for a `close` event that
never fires. Measured on this box: `wl-copy` exited 0 in 33 ms while `copyTextToClipboard` was still
pending after 4 s. The helper now completes on the command's own exit after a bounded stdout drain
(`runClipboardProcess`), and a real Wayland round trip through `wl-paste` returns the written text.
The two directions need different completion rules, so the runner carries both: a **writer**
completes on the helper's own exit (the daemonized selection owner keeps the inherited stdout open,
so waiting for it would hang forever), while a **reader** completes when stdout ends, bounded at
3 s, because a reader's output *is* its payload and answering from a fixed grace window could
truncate a large clipboard image. Readers pass `completion: 'stdout-end'`.
Deterministic coverage: `tests/clipboard-media.test.ts` (daemonized descendant holding stdio) and the
real-PTY shortcut contract in `tests/terminal-pty.test.ts`.

## Ctrl+C signal delivery depends on the controlling terminal (2026-09-14, documented)

The interrupt shortcut writes one ETX byte. Whether that byte becomes `SIGINT` is the kernel's business: it
needs the PTY slave to have a foreground process group (`tpgid`), which requires the child to own the
controlling terminal. Measured with the production `BunPtyBackend`:

- this desktop: `tpgid` equals the child's process group for both a normal launch and `setsid`, and the
  child dies from the byte as expected;
- Docker (also with `--privileged` and with `seccomp=unconfined`) and the CI lane environment: `tpgid = -1`,
  the byte is echoed as `^C` and discarded, and the child survives. The smoke child therefore reads raw
  bytes (`stty -isig`), so the lane asserts what the app owns: exactly one ETX byte, and no copy. Real
  signal delivery stays part of manual Omarchy acceptance and of the real app with the pinned native addon.

## Runtime provenance and native clipboard editing (2026-09-15)

The pins in `gpuix-runtime.json` are immutable upstream revisions, so native work cannot ride in a pin, and
the checkout is two repositories. Every local native change is now declared in one patch set per repository
(`patches/README.md`) and applied by `bun run setup:native`:

| Set | Contents |
| --- | --- |
| `patches/gpuix/0001-linux-native-runtime.patch` | Clipboard: `Ctrl+Insert` copies in every text context and in the document-selection listener; `Ctrl+V`/`Cmd+V`/`Shift+Insert` run the element's caret-aware paste action, which reports each paste through a `paste` event carrying both the inserted text and the draft it replaced (`contentBefore`), so a host can put back exactly what the insertion changed. Portal: window-parented `org.freedesktop.portal.FileChooser` primitives and system-appearance reads. |
| `patches/zed/0001-portal-parent-and-appearance.patch` | The GPUI side of those primitives (`parent_window_identifier`, the portal file chooser, system appearance). |

Those rules are properties, not intent:

- the patch is applied idempotently - a patch that is already applied reverse-applies cleanly, so a cached
  checkout is not patched twice;
- the build stamp carries the patch-set hash and a fingerprint of the checkout's own native source, so a
  cached runtime is never reused when either changes;
- `sourceFingerprint` hashes the checkouts' build inputs by working-tree bytes - including a file that was
  never staged or tracked - and `assertDeclaredSource` reverse-applies the declared patches in a temporary Git
  index of those inputs, so anything left over fails the install instead of being built. The earlier revision
  only warned about such changes by filename, which is how unrecorded native work survived on this machine;
- the runtime answers `supportsNativeClipboardEditing()`, and the app probes it, so a runtime built before the
  patch keeps its JavaScript fallback instead of losing the gesture, while a runtime that answers it never sees
  the app handle that key twice.

The earlier revision bound copy only and left paste to the app, which appended text at the end of the draft:
on a remapped Omarchy desktop that is the most-used gesture, and it could not place text at the caret. Binding
paste natively without losing the image half needed a paste *event* that fires once per action with the text
the runtime inserted. The composer now uses that event - never the key - to attach the clipboard image, so one
gesture produces one insertion and one image, and the caret is the runtime's.

Verify with `bun run setup:native`, then `bun run smoke:workbench-keys -- --installed` and
`HEDDLEWORK_CLIPBOARD_LIVE=1 bun run smoke:clipboard-live`. The stubbed Xvfb lane reports every
gesture the runtime performs itself as a named skip - a stubbed display can observe neither a native
clipboard write nor a native paste, and a green run must not imply it did. Measured on 2026-09-15 against the installed build
`sha256=e7a103ea…`: the stubbed lane passed four checks and reported ten named skips (a stubbed display can
stage neither gesture, and each skip names the lane that can), `insert-keys-single-owner` pressed
`Ctrl+Insert` over a real selection and saw no app-side write, and `native-round-trip-exact` proved the
runtime's own paste action with `Ctrl+A`, `Ctrl+C`, `Ctrl+V`. The live lane on a disposable nested Hyprland
passed with real helpers: `Shift+Insert` submitted exactly the text staged by `wl-copy`, a typed control
message submitted exactly, and the recorded helper calls show the app reading only the image half.

Its copy check is manual by necessity, and it says which reason it can support: the check stages a sentinel
and proves the clipboard is not already the selection before pressing `Ctrl+Insert`, and the sentinel
survived the gesture. The reason is in the pinned runtime, not in the application - and the runtime's own
warning is not visible in the application's stderr (no logger is wired to it), so the lane reports the
reason as source-documented rather than measured:
`SerialTracker::update` records a Wayland selection serial only from a real key or pointer press event
(`crates/gpui_linux/src/linux/wayland/client.rs`), and `write_to_clipboard` returns early with "Skipping
Wayland clipboard ownership request ..." when there is none, so a press delivered through the automation
surface can never own the clipboard. Physical `Ctrl+V`/`Super+C` behaviour on the operator's own Hyprland
session stays a manual acceptance step for the same class of reason: those bindings are delivered as insert
keys before any window sees them.



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
- Idle session harnesses are capped (`SESSION_IDLE_POOL_LIMIT`) so All-projects browsing cannot leave a Pi
  process per click. Streaming harnesses are never stopped. The Linux launcher remembers the last project in
  XDG state. The running `.desktop` process still keeps the previous image until restart.
- **Open project** on Linux talks to `org.freedesktop.portal.FileChooser` first (listen for Response before
  OpenFile). kdialog then zenity are fallbacks only when the portal is unavailable. This is a TypeScript
  gdbus/dbus-monitor seam, not a GPUIX pin or Omarchy palette change.
- Native-renderer suites are a structural Linux skip, not a failure: the pinned gpuix test renderer is built
  for macOS and Windows only, so ~97 `bun test` skips per run are expected. `tests/helpers/native-renderer.ts`
  owns the gate and prints the reason once per run; do not read those skips as coverage.
- Terminal copy/paste/interrupt is verified twice, from one child command
  (`scripts/linux-terminal-smoke-contract.ts`): headlessly over a real `Bun.Terminal` PTY in
  `tests/terminal-pty.test.ts` (runs in `bun run check` on Linux, no compositor) and on real
  compositors in `scripts/linux-window-smoke.ts` through the production `TerminalView`. The compositor
  driver, `tests/linux-terminal-smoke-lane-harness.test.ts` (the same assertions over a real PTY, no
  compositor) and `tests/linux-terminal-smoke-lane.test.tsx` (the in-process renderer) all call
  `scripts/linux-terminal-smoke-lane.ts`, so the assertions a compositor exercises are the same ones
  `bun run check` executes on Linux. Neither lane
  covers Hyprland: the `hyprctl -j clients` probe still verifies window registration only, so Hyprland
  acceptance of clipboard tooling, decorations, and fractional scaling stays a manual step.
