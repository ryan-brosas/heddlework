# Terminal

Heddlework owns PTY sessions in-process. The byte stream, VT state, and painter are separate so desktop can use native GPUI today while a future web/mobile client can keep the same session contract and substitute a WASM VT engine and browser painter.

## Placements

- **Bottom dock** — layout-owned in `WorkbenchApp`; sessions stay alive when the dock closes.
- **Right surface** — the existing `terminal` workbench surface.
- Both placements share `TerminalSessionService`. The most recently focused placement owns PTY rows and columns. When the bottom placement enters fullscreen, an open right terminal stays alive but its hidden projection is suspended so one session is not staged and painted twice.

## Keyboard and clipboard

Terminal key routing resolves copy, paste, and interrupt commands **before** terminal encoding, in the shared `dispatchTerminalKey` seam (`src/terminal/keys.ts`) that `TerminalView.onKeyDown` calls. Precedence is explicit because an unqualified `ctrl`+`c` check would otherwise swallow the copy shortcut and send ETX to the foreground process.

- **Copy**: `Ctrl+Shift+C` (Linux/Windows) and `Command+C` (macOS). A copy command writes **zero PTY bytes**, including when the clipboard write fails.
- **Interrupt**: plain `Ctrl+C` writes exactly one ETX, never a copy.
- **Paste**: `Ctrl+V` / `Command+V` reads the clipboard once and writes it to the focused session, wrapped in bracketed-paste markers when the emulator enabled DEC mode 2004. A failed read stays local and never falls through to key encoding.

The Linux text readers name the type they want (`wl-paste --no-newline --type text`, `xclip -target
UTF8_STRING -type`): an inferred MIME type can hand image bytes to a UTF-8 decode. A helper that overruns its
wall bound or output bound is killed with SIGTERM and then SIGKILL, and that escalation must survive the
failed result - a settled failure used to cancel its own kill timer, so a helper that ignored SIGTERM stayed
alive. `tests/clipboard-media.test.ts` runs both cases against a real child that traps SIGTERM.

**PTY lifetime: close on stream end, never on process exit.** Bun resolves `subprocess.exited` before it
dispatches the last chunk it already read, so closing the PTY from the exit path dropped the final output of
`printf x; exit 0` in 1 of 60 measured runs - the intermittent `hello-pty` failure in CI. `BunPtyBackend`
now releases the PTY (and flushes the output buffer) from the terminal's own stream-end callback, which also
keeps a session readable while a child still holds the slave. The limitation that remains is upstream: a
child that writes *after* the shell exits is not delivered at all (measured through the same probe), because
Bun stops reading the PTY when the spawned process exits. `tests/terminal-pty.test.ts` pins the ordering
deterministically through `BunPtyBackend`'s injected PTY lifecycle.
- **Direct events**: `textInput` and `paste` events carry their own text and bypass keyboard encoding.

Copy currently exports the **visible terminal viewport**, not a modeled selection. Terminal drag-selection and a distinct "copy visible terminal" action are separate follow-up work; do not promise selection-scoped copy from this path.

A failed copy reports one generic, local message (`terminal-copy-failure-<placement>`, message text in `src/ui/terminal-copy-feedback.ts`) and never falls through to interrupt. The feedback is owned by the terminal view: a new attempt clears it, stale completions cannot overwrite newer feedback, and it is withdrawn on unmount, on a session change, or on writer replacement. One view instance serves every session, so the action is scoped to the session and a copy still in flight for a session that was left cannot report over its successor. Published feedback never contains the clipboard payload or an exception detail.

Clipboard I/O is injectable in both directions (`TerminalView`'s `copy` and `readPaste` props) so the production dispatch seam, its failure feedback, and paste delivery are regression-tested without a native GPUIX renderer or an operating-system clipboard.

On Linux the clipboard helpers (`wl-copy`/`xclip`) fork a selection owner that outlives the command and
inherits its stdio, so Node's `close` event never fires. `runClipboardProcess` therefore carries two
completion rules. A **write** completes on the helper's own exit after a short bounded drain; waiting for
`close` left every clipboard write pending forever, which made terminal copy silently do nothing on both
Wayland and X11. A **read** passes `completion: 'stdout-end'` and completes when stdout ends, bounded at
3 s: a reader's output *is* its payload, so answering it from the fixed write window could truncate a
large clipboard image, while the bound keeps a helper that hands its stdio to a survivor from wedging
the read.

## UI text selection and copy

Text selection and Ctrl+C belong to the native runtime, not to a Heddlework key handler: the pinned
GPUiX paints selectable text runs and a window-level copy listener writes the selection to the platform
clipboard. Heddlework deliberately installs no app-level Ctrl+C, so a focused input (composer, search,
settings) and the terminal keep their own copy/interrupt semantics.

What Heddlework owns is the selection policy, which decides whether the runtime may start a drag at all:
a `userSelect: 'none'` on an element *or any ancestor* makes that text unselectable and therefore
uncopyable. Content stays selectable and only chrome opts out:

| Surface | Selection |
| --- | --- |
| Messages, markdown, tool output, reasoning text | selectable |
| Tool args, tool output, tool diffs (`codeSurfaceStyle`) | selectable |
| Expanded trace rows and their nested tool calls | selectable |
| Changed-file paths and diff rows | selectable |
| Tool and trace header toggles, status labels, sidebar,
  composer chrome | not selectable (chrome) |

The lane is runnable from any session, and every case in `scripts/linux-compositor-smoke.sh` runs it
after the window smoke:

```bash
bun run smoke:selection
```

It drives `scripts/smoke-linux-selection.tsx`, which renders the production `codeSurfaceStyle()` and
`transcriptRowShellStyle()` helpers, and fails when content becomes unselectable or chrome becomes
selectable. The web companion is deliberately different: its fenced-code Copy action leaves the label on
"Copy" when the browser refuses a write instead of reporting a message, and `scripts/web-dom-probe.ts`
asserts that it never claims a write that did not happen.

`transcriptRowShellStyle` (row shell) and `codeSurfaceStyle` (tool code surface) own that policy and are
pinned by `tests/transcript-selection.test.ts`; reintroducing `none` on read-only content is a regression,
not a styling choice.

Explicit copy controls (message footer, tool row, diff header) share one implementation
(`src/ui/copy-feedback.ts` plus the `useClipboardCopy` hook in `src/ui/clipboard-copy.ts`): a failed
write is reported instead of silently ignored, and an older attempt still in flight cannot overwrite a
newer one. `createTerminalCopyAction` binds the same core to the terminal's own message.

### Insert-key clipboard shortcuts (Omarchy/Hyprland)

Omarchy's Hyprland bindings rewrite clipboard shortcuts before any window sees them: `Ctrl+V`
becomes `Shift+Insert` (`Direct paste`) and `Super+C` becomes `Ctrl+Insert` (`Universal copy`). The
pinned GPUiX input element bound `ctrl-v`/`cmd-v` only, so before the patch described below landed the
app looked as if it had no clipboard at all - measured on this box against the installed build: `Ctrl+C` then
`Ctrl+V` round-tripped, while `Shift+Insert` and `Ctrl+Insert` did nothing.

**Who owns the keystroke.** The pinned runtime is patched (`patches/gpuix/0001-linux-native-runtime.patch`,
applied by `bun run setup:native`) so it binds the desktop clipboard keys itself: `Ctrl+Insert` - the key
Omarchy delivers for `Super+C` - runs the same selection-aware action as `Ctrl+C` in input and textarea
contexts alike and in the runtime's document-selection copy listener, while `Ctrl+V`/`Cmd+V`/`Shift+Insert`
run that element's own paste action, so text lands at the caret with undo and no app-side handler appends it.

A text input cannot hold a clipboard image, so each paste action also emits one `paste` event carrying the
text it inserted. The composer uses that event - never the key - to attach the image half, and an image
attach still delays a submit until its bounded read finishes. The earlier design (native copy only, with the
app appending pasted text at the end of the draft) is gone: one gesture now produces one insertion and one
image.

The capability is probed (`supportsNativeClipboardEditing`) rather than required: when the runtime answers it,
this repository's fallback stands down - the copy listener in `src/main.tsx` and the composer's own key
handler - so one keystroke never has two owners. A runtime that does not answer keeps the fallback, which is
also what the web companion uses, and the chosen mode is logged at startup.

**Which thread it belongs to.** A clipboard read, an attached image, and a submit that waited for a paste
all outlive a click on another thread, because the composer is not remounted on a switch. Each step
re-checks the session file it started in (`pasteTargetsSameSession`) and drops a late result instead of
writing it into the thread that is open now. The current side of that comparison is read from the
controller at the moment of the write (`attachClipboardImage`), never from React state or a ref: the
switch publishes the new session synchronously, while the effect that tracks it runs after the next
render, so a read resolving inside that window would pass a stale check and attach the previous thread's
image to the thread on screen. `tests/composer-paste-session.test.ts` drives that window directly.

`src/ui/insert-key.ts` still resolves that convention and the terminal uses it for its own routing, and it is
what the composer's fallback handler consults when the runtime does not bind the keys - there, the window
listener copies the document selection and the composer reads the clipboard, appends the text and attaches
an image, which is as far as a draft-level handler can go without knowing the caret. A clipboard read is asynchronous, so every way of submitting
the composer - Enter, Alt+Enter and the Send button - waits for a paste already in flight and then
submits the draft that paste produced (`resolveSubmittedText`). Without that wait an Enter pressed
right after the paste key submits the pre-paste draft and the pasted text reappears in the composer,
which reads as "paste did nothing". `tests/insert-key.test.ts` pins the policy and `tests/terminal-keys.test.ts` the
terminal routing, both on Linux without a compositor.

The wiring itself is proven end to end by a lane that runs the real application in demo mode on a
private Xvfb display, with `wl-copy`/`wl-paste` stubbed in a temporary `PATH` so a run can neither
depend on nor disturb the operator's clipboard:

```bash
bun run smoke:workbench-keys
```

The lane is owner-aware, and the owner decides what it can even observe. A runtime that binds the clipboard
keys performs both gestures against the **real** platform clipboard, which the stubbed helpers deliberately
do not serve: the app never reaches them, so nothing the lane can stage produces a native copy or paste. It
reports those ten checks as named **skips** that say so and name the lane that can prove them, rather than
asserting an app route that no longer exists. What still runs is everything the stub *can* observe plus the
owner-independent checks: exact transcript accounting, the empty-draft rule, the renderer's own
`Ctrl+C`/`Ctrl+V` round trip, and `insert-keys-single-owner`, which drags a real selection and presses
`Ctrl+Insert` to prove the app wrote nothing. With a runtime that does not bind the keys, the whole paste
route and the copy checks run instead, and the lane drags over a message, sends `Ctrl+Insert`, and asserts
the clipboard helper received exactly that selection. The pinned Linux automation text tree does not expose the composer's draft, so
the lane checks submitted user-message rows instead. Byte-level proof of the native path needs a real
compositor: `HEDDLEWORK_CLIPBOARD_LIVE=1 bun run smoke:clipboard-live` starts a disposable nested Hyprland
with the real helpers and asserts that `Shift+Insert` pasted the staged text into a submitted message, that
`Ctrl+Insert` left exactly the dragged selection on the session clipboard, and that a `Shift+Insert` against
a clipboard holding only a PNG added exactly one composer attachment and submitted nothing - the screenshot
half a text input cannot hold. In the fallback mode, positive paste checks wait for the stub to log a
text-read attempt before Enter, then allow two polling intervals for the asynchronous paste to settle. The logged
75 ms in a local run included that deliberate wait; it is **not** a measured paste-latency guarantee.

The image-only stub rejects both image and text reads: its negative check covers refusal to paste stale
text, not successful screenshot attachment, and the live lane - not the stub - is what asserts a real
screenshot attachment. Empty-Enter checks and the exact-message checks provide indirect evidence about
drafts, not a native input-value readback. Stubbed Xvfb results do not prove
Hyprland input-serial handling or real Wayland clipboard ownership; those need a separate live test.

The lane defaults to the checkout's `dist/heddlework`; rebuild it with `bun run build` before testing
source changes. Use `--installed` for the installed app or `HEDDLEWORK_APP_BINARY` for an explicit
artifact. It is separate from `scripts/linux-compositor-smoke.sh`, whose cases build a purpose-made
window rather than launching the full application.

Practical note for verifying copy on Linux: writing the compositor clipboard needs an input serial, and a
key event injected through the automation protocol carries none — a synthetic Ctrl+C cannot copy even when
the selection is correct (measured: the selection is present, the clipboard is unchanged). Drive the real
window or press the key by hand, then read the clipboard back with `wl-paste`.

### Live clipboard acceptance (real compositor, real helpers)

`bun run smoke:clipboard-live` is the one lane that runs on a real Wayland compositor with real clipboard tools. It
needs the explicit opt-in `HEDDLEWORK_CLIPBOARD_LIVE=1` and starts a disposable nested Hyprland on a private
`XDG_RUNTIME_DIR` and `WAYLAND_DISPLAY`. The host `DISPLAY` is stripped from every child, so the run can
neither read nor replace the operator's clipboard. `wl-paste`/`wl-copy` are logging shims that delegate to the real tools, so the bytes are
real and the call log is evidence. It asserts four things: the session clipboard round-trips through the real
`wl-copy`/`wl-paste` helpers; the application submits the exact real clipboard text through `Shift+Insert`; `Ctrl+Insert`
over a dragged transcript selection puts that exact text on the session clipboard; and a `Shift+Insert`
against a clipboard holding only a PNG adds exactly one composer attachment and submits nothing.

What it does not judge: a compositor's own remap to `Shift+Insert` is not exercised, because the lane delivers
the paste key through the application's automation surface. Submits
are queued while a turn streams, so the lane waits for the paste key and Enter *separately*, waits for the turn
to settle before Enter, and calibrates: a typed probe must land before any paste verdict counts - without
that gate a queued submit looks exactly like a dropped paste.

### Compositor verification

`.github/workflows/linux.yml` (manual `workflow_dispatch`) runs `scripts/linux-window-smoke.ts` against real
compositors. That driver now also hosts the production `TerminalView` over a real PTY
(`scripts/smoke-linux-window.tsx`; markers and evidence schema in `scripts/linux-terminal-smoke-contract.ts`)
and asserts this section's contract end to end:

- `Ctrl+Shift+C` reaches the operating-system clipboard (`wl-copy`/`xclip`) and writes **zero** PTY bytes, with
  no `terminal-copy-failure-<placement>` feedback;
- `Ctrl+V` reads that clipboard through the production `pasteClipboardText` path, and the PTY child echoes the
  copied marker line back;
- plain `Ctrl+C` arrives as exactly one ETX byte, which the child observes on stdin, and never as a copy.

The smoke child reads raw bytes (`stty -isig`) and asserts the ETX byte itself, because a real shell only
turns that byte into `SIGINT` when the PTY slave has a foreground process group. That holds for a desktop
launch (measured here with and without a controlling terminal: `tpgid` equals the child's process group) but
not in a container or CI lane (measured `tpgid=-1` on Docker, with and without `--privileged`), where the
kernel echoes `^C` and delivers no signal at all. Asserting the byte our dispatch owns keeps this lane
meaningful in every environment; tty signal delivery stays part of manual compositor/desktop acceptance.

Those assertions live in one shared implementation, `scripts/linux-terminal-smoke-lane.ts`, which three
hosts run: the compositor driver, `tests/linux-terminal-smoke-lane-harness.test.ts` (the lane's own
assertions over a real PTY, with the PTY, smoke shell, dispatch, clipboard recorder and evidence document
all shared with the fixture), and `tests/linux-terminal-smoke-lane.test.tsx` in-process against the local
renderer (a structural skip on Linux, where no native test renderer exists). The shell command and the
production `dispatchTerminalKey` seam are additionally exercised over a real PTY in
`tests/terminal-pty.test.ts`, so a shortcut or clipboard-payload regression fails `bun run check` on Linux
without a compositor. The compositor lane adds only the windowing, GPUIX input routing and OS-clipboard
layers on top.


## Runtime

- Default backend: `Bun.Terminal` through `BunPtyBackend`.
- Platform adapters can inject the exported `TerminalBackend` contract.
- Tests use `MemoryTerminalBackend` or a push-driven backend.
- `subscribe()` remains the compatibility channel for every published update. Renderers should use `subscribeFrames(listener)` (which supplies the changed session ID); chrome and plugins that only need sessions, selection, status, titles, or appearance should pair `subscribeState()` with `getStateSnapshot()` to avoid frame-rate updates.
- Shell: `$SHELL -l` (or `cmd.exe` on Windows), with `TERM=xterm-256color` and `COLORTERM=truecolor`.

## Output and presentation pacing

Heddlework follows the important invariants from Localterm without moving browser-specific xterm behavior into the native app:

1. `Bun.Terminal` can fragment a dense frame into hundreds of roughly 1 KiB callbacks. `TerminalOutputBuffer` copies those fragments into reusable buffers, finds DEC 2026 boundaries across arbitrary splits, and delivers each completed synchronized frame to the VT parser once. Adjacent end/start markers in one transport chunk remain separate frames.
2. Ordinary output flushes at microtask latency, so prompts and device-status/capability queries are not delayed behind a paint callback. A one-second ingress escape hatch forwards an abandoned synchronized frame instead of retaining bytes indefinitely.
3. Ordinary frame notifications are coalesced to an 8 ms (~125 Hz) deadline. The deadline is measured from the previous frame start, so native paint work does not accumulate on top of every interval. Parsing never runs inside the timer. Session-scoped frame listeners are independent from structural state listeners: terminal tabs and chrome do not enter React for animated output, while the direct native surface projects and stages the completed grid synchronously before the next React or GPUI flush. Browser and older-native fallbacks consume the same frame channel through `useSyncExternalStore`.
4. DEC private mode 2026 holds the last committed grid while a synchronized frame is incomplete. `TerminalOutputBuffer` preserves a completed-frame tag when it joins fragmented PTY callbacks, so the service publishes that frame immediately instead of accidentally passing it through the ordinary 60 Hz-era deadline. A one-second stale escape hatch prevents a broken application from freezing the surface indefinitely without exposing healthy, high-volume frames halfway through.
5. User input can preempt a held synchronized frame. The first response of at most 8 KiB within 500 ms of input also publishes immediately, preserving prompt and completion latency without making an unrelated output firehose synchronous. A detached scrollback viewport remains anchored as new rows arrive, and explicit terminal input returns to the live tail.

`VtEmulator` parses complete CSI controls directly from a decoded chunk and falls back to its incremental state machine when a sequence straddles chunks. A complete DEC 2026 OpenTUI frame gets an additional byte-native fast path matching the upstream native renderer: the synchronized hide-cursor envelope, absolute changed-run cursors, RGB/indexed/default colors, independent text attributes, and mixed ASCII or UTF-8 glyph runs are consumed directly from the PTY `Uint8Array`. One-glyph changed runs—the dominant framebuffer shape when adjacent cell colors differ—decode and commit once. Wide glyphs, combining sequences, and contiguous runs retain canonical VT cell semantics. The grammar stops at the first mismatch and decodes only that remainder through the canonical parser, avoiding a multi-megabyte transient UTF-16 string without changing partial or ordinary output behavior. Mutable pen colors and the screen, alternate screen, and scrollback backing rows use tagged four-word `Uint32Array` cells rather than per-cell JavaScript objects. Sparse maps retain only multi-codepoint graphemes, including across insertion, deletion, erase, scrollback, and resize. Erase operations retain the active rendition (BCE), so inverse and explicit-background TUI rows reach the final column. `snapshot()` copies only changed packed rows by mutable-row revision. Native projection reads those rows directly; public `TerminalRow` objects and color unions are materialized lazily only for the React fallback, copy, or tests. Historical snapshots remain immutable and unchanged public rows retain identity.

On a patched GPUIX runtime, `TerminalView` projects each session-scoped frame directly into a versioned binary payload: each cell is one 16-byte little-endian record containing a glyph reference, final foreground/background RGB, and flags. Multi-codepoint graphemes live in a small side table. Each terminal overwrites one aligned JavaScript cell buffer, and `setTerminalFrame(elementId, metadata, cells)` sends it through NAPI immediately, outside both React reconciliation and the React mutation JSON. The native call invalidates GPUI itself. The mailbox validates and copies arrivals but defers cell decoding, block rasterization, and text-run construction until GPUI consumes only the latest payload. Animated frames retain a stable image identity and update their same-sized Metal, WGPU, or DirectX atlas tile in place rather than reallocating it every paint. Older GPUIX builds retain the base64 single-prop native path; browser/unpatched runtimes retain the memoized React-run fallback.

Run the repeatable hot-path benchmarks with:

```bash
bun run benchmark:terminal
bun run benchmark:terminal:hires
```

The UI probe pre-encodes four fully changed frames outside the timed region, cycles them to bound fixture memory, fragments each into 1 KiB PTY callbacks, and measures synchronized scanning, packed VT mutation, direct projection/NAPI staging, the post-stage event-loop handoff, GPUI rasterization, layout, and paint. It mechanically verifies that every timed frame reached the direct transport without requiring a React commit; a separate 8→1 burst measures raw mailbox coalescing. The wire reproduces OpenTUI's DEC 2026 prefix, initial hidden-cursor control, absolute changed-cell cursors, truecolor foreground/background, mixed spaces and Unicode blocks, and SGR run resets—the shape used by the Golden Star workload. The high-resolution command covers 220×65, 320×90, 480×120, 640×180, and 960×240, and intentionally fails unless the patched native test renderer exposes the direct binary transport.

On the development machine, the native offscreen renderer is Retina (`100×50` logical pixels capture as `200×100`). A repeat matrix of the direct faithful path measured 1.73 ms median / 2.05 ms p95 at 220×65, 5.31 / 8.47 ms at 480×120, 8.93 / 11.39 ms at 640×180, and 18.09 / 26.54 ms at the deliberately extreme 960×240 grid. Even at 960×240, eight raw arrivals coalesced into one raster/upload in 3.09 ms median. At 2× scale with the current 7.83×17 logical-cell metrics, the 480×120 terminal surface is already approximately 7549×4104 physical pixels; 960×240 is approximately 15066×8184, near Metal's maximum texture dimension and much larger than a 5K fullscreen terminal. The 640×180 case remains below a 16.7 ms frame budget through p95. A three-second full-workbench Golden Star probe delivered 169 PTY frames at 56.3 producer FPS as exactly 169 session notifications and 169 native stages, with zero structural notifications or React commits; the terminal callback measured 0.20 ms median / 0.29 ms p90. Treat timings as hardware-dependent; synchronized provenance, realistic byte ingress, pre-commit direct staging, direct-transport capability, raw-mailbox coalescing, workload shape, node count, immutable row reuse, and single visible projection are the structural guards.

### Live GPUIX window harness

The offscreen probes deliberately remove the operating-system event loop. Use the live harness when the problem only appears in a real, maximized, or Retina window:

```bash
bun run benchmark:terminal:gpuix -- --fullscreen --duration 15 --overlay full --report screenshots/terminal-gpuix-live.json
```

The command creates a production `GpuixRenderer`, uses Heddlework's real window options and `startFrameLoop`, mounts the production `TerminalView`, and runs a real `Bun.Terminal` PTY. When the sibling `../opentui-examples` executable exists, the harness starts it and selects **Golden Star Demo**. Otherwise, `--fixture` is implied and a bundled 60 FPS DEC 2026 truecolor framebuffer producer supplies a deterministic full-grid workload. Use `--help` for custom commands, logical window dimensions, warmup, focus, and report options.

The one-second line and final `TERMINAL_GPUIX_REPORT` JSON expose every handoff independently:

- PTY complete-frame rate and wire MiB/s;
- session notifications and direct native stages, which must remain 1:1;
- service-to-stage time (packed projection) and the isolated NAPI call;
- actual GPUI draw count and native draw percentiles;
- React commits during animation;
- macOS `tick()` rate, latency, and wall occupancy, distinct from CPU use.

For an event-pump A/B with an identical producer and grid, run:

```bash
bun run benchmark:terminal:gpuix -- --fixture --duration 10 --frame-ms 8
bun run benchmark:terminal:gpuix -- --fixture --duration 10 --frame-ms 33
```

On the development machine at 800×600, the default 8 ms loop delivered approximately 23 producer/service/stage/draw FPS even though every pipeline ratio was exactly 1.0 and GPUI draw p90 was about 0.30 ms. `tick()` itself occupied roughly 93% of wall time at a 15.6 ms median. The 33 ms diagnostic delivered approximately 55 FPS with a 0.27 ms GPUI draw p90, zero animated React commits, and 3.5% tick wall occupancy. This isolates the remaining live-window slowdown to the embedded macOS event pump starving Bun's PTY/JavaScript loop, rather than terminal projection, retained nodes, rasterization, or texture upload. The 33 ms mode is an A/B diagnostic, not a production fix: it lowers AppKit pump frequency while proving where the contention occurs.

## Native rendering versus xterm.js

The xterm.js/WebGL fork in Localterm is not copied into the desktop bundle. Instead, Heddlework adds the missing low-level primitive to GPUIX: one fixed-cell `<terminal>` host consumes compact complete frames through a coalescing binary mailbox and paints directly into the GPUI scene.

The native surface preserves terminal geometry rather than treating the grid as flexbox text:

- one nearest-sampled `(cols × 2) × (rows × 2)` BGRA texture paints cell backgrounds plus exact half-block, quadrant, and shade masks, including BCE highlights through the rightmost column;
- ordinary and double-width glyphs retain explicit column positions at fractional cell coordinates;
- shaping is cached by text and font geometry, not ANSI color, then cached glyph-atlas masks are painted directly with the current foreground;
- adjacent compatible cells remain one shaped run, preserving programming ligatures without per-cell retained nodes;
- cursor, underline, and strike are exact grid quads; framebuffer block elements bypass shaping and thousands of glyph draws by becoming quarter-cell texture pixels;
- disabling ligatures inserts zero-width non-joiners; Nerd Font ranges can use a separate family;
- bold base ANSI colors resolve to bright variants, and muted emoji requests text presentation (`VS15`).

This is the Localterm alpha-mask optimization in native form. GPUI caches ordinary glyph coverage in its monochrome atlas and applies terminal foreground color during GPU composition; changing ANSI color does not reshape text or create another atlas entry. There is no browser canvas polarity to reconstruct and no second xterm/WebGL atlas to maintain. Emoji that remain color presentation use GPUI's polychrome atlas; `VS15` routes supported muted forms through the monochrome coverage path. Platform color-font fallback can still override unsupported text-presentation sequences.

## Fonts and live settings

Settings → **Terminal** applies changes to every open terminal without restarting its PTY:

- primary installed font family;
- programming ligatures;
- Nerd Font symbol routing and fallback family;
- muted emoji.

The native text system resolves installed font family names. Heddlework does not bundle Localterm's WOFF2 webfonts because GPUix does not currently expose runtime font-byte registration to React hosts. A full Nerd Font can also be selected directly as the primary family.

Preferences are stored in `terminal.json` under the platform application configuration directory:

- macOS: `~/Library/Application Support/Heddlework/terminal.json`
- Windows: `%APPDATA%/Heddlework/terminal.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/heddlework/terminal.json`

Plugin hosts can override or disable the path through `createTerminalPlugin({ appearancePath })` and can provide initial values with `appearance`.

## Color, gamma, and light mode

The first 16 ANSI colors are theme anchors. Indices 16–255 are regenerated in CIELAB space as a 216-color cube plus a 24-step grayscale ramp, avoiding the harsh and low-contrast fixed xterm cube on light themes.

Light mode enforces a 4.5:1 minimum foreground/background contrast ratio using WCAG relative luminance. Color adjustment and dim compositing happen in linear sRGB rather than interpolating gamma-encoded channel bytes. Dim dark-on-light text uses the Localterm-derived 0.9 opacity policy and is checked again after blending; dark themes retain author colors and use the conventional 0.5 dim blend.

## GPUIX focus boundary

GPUix 0.7 removed its process-wide `Tab` and `Shift+Tab` traversal bindings. Both keys now reach the focused terminal's `onKeyDown` handler directly, while applications that want traversal can call `focusNext()` or `focusPrevious()` explicitly. Heddlework therefore no longer needs the temporary `captureTab` host prop, and its terminal UI regression always sends both Tab variants through the native input pipeline.

The desktop runtime is provisioned with `bun run setup:native` from the immutable GPUix/Zed revisions in `gpuix-runtime.json`. The installer builds matching native and React packages, preserves the application React singleton, and verifies the terminal/window APIs. Desktop startup rejects incompatible stock GPUix rather than silently losing terminal or window behavior. `patches/gpuix-0.7.0-heddlework.patch` is a historical patch against the published 0.7.0 baseline, not the current installation recipe; do not apply it over the reconciled upstream sources.

The renderer still feature-detects `supportsNativeTerminal()` to choose the native painter or the portable grid fallback. This painter fallback does not substitute for installing a compatible desktop runtime.

## Native frame pipeline

The desktop renderer keeps framebuffer backgrounds and block graphics in one stable nearest-sampled atlas image. After the first paint, GPUIX prepares the newest packed frame at the NAPI boundary and compares only primitives that remain in the GPUI scene: shaped text, visible cursor, dimensions, and text geometry. Box-drawing backgrounds are excluded because the updated image already owns those pixels; foreground and glyph changes are not.

When that overlay is unchanged on macOS, GPUIX waits for the newest ordered Metal command-buffer submission to finish sampling the tile, updates the existing atlas tile, and presents the current scene directly. This completion fence prevents CPU `replace_region` writes from racing an in-flight GPU frame. The terminal frame still avoids React commits, root invalidation, retained-tree conversion, layout, prepaint, paint, and scene rebuilding. Overlay changes and failed atlas updates use the full path, and the latest prepared frame remains available for any unrelated redraw.

The embedded AppKit pump drains pending native events and ready CoreFoundation sources without waiting for a display-link wake. This matters because a blocking 8 ms polling loop previously occupied about 91% of Bun's wall time and reduced the Golden Star workload to roughly 13 staged frames per second. The nonblocking pump returns in well under a millisecond in the same harness and lets the terminal track the raw PTY producer ceiling. `bun run benchmark:terminal:gpuix -- --fullscreen --frame-ms 8 --duration 8` reports PTY, service, native-stage, GPUI-draw, stable-layer avoidance, tick-wall, and CPU rates for regressions.

## Web and mobile path

The browser client now reuses the existing terminal UI through a remote terminal-service adapter. The authenticated host owns the PTY and VT state, sends grid snapshots, and accepts bounded terminal input/resize commands. The DOM host provides browser composition/paste input and a mobile software-keyboard target; neither xterm.js nor a WASM runtime is required for this path.

Keep the following extension boundary for future companion renderers:

1. a host process owns the PTY and transports ordered bytes plus resize/input events;
2. Ghostty's VT core, compiled natively or to WASM, can replace `VtEmulator` behind the snapshot/session boundary;
3. each platform owns its painter: GPUI on desktop, a browser renderer on web, and a platform view on mobile. The packed cell contract is platform-neutral, uses a WASM-compatible decoder, and has validated WGPU/WebGL shader paths, so a GPUIX WebAssembly renderer can expose the same host element.

The Localterm xterm/WebGL work remains an appropriate browser implementation when GPUIX/WASM is not the UI host. Heddlework shares pacing, color, font, frame, and accessibility policy rather than importing browser renderer internals into desktop.
