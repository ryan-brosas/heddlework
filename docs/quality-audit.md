# Quality audit harness (IDE inspections)

How this fork audits source quality with the IDE (MCP Steroid) and which findings are
actionable. Written after a full-tree sweep whose first runs were **false greens** — read
the pitfalls before reusing the harness.

## Harness

Run one script per small batch (3–4 files) through `steroid_execute_code`. Three rules make
the difference between real coverage and a silent zero:

1. **Every script needs its own `readAction { }`.** The previous script's read context does
   not carry over, and PSI/VFS access outside one aborts the whole batch (the platform logs
   an "IDE Exception Captured" block and the script returns nothing).
2. **Filter findings by the map key, not by a descriptor field.** `res.entries` is keyed by
   tool id; `it.toolId` does not exist, so `ds.filter { it.toolId ... }` is a *compile* error
   that surfaces as a generic MCP timeout. Print one `FILE|<path>|rows=N|failed=M` line per
   file and compare the count against the file list: a missing `FILE|` line is a failed batch,
   never a clean file.
3. **Anchor every finding to its source text before believing it.** A tool that crashes mid-file
   leaves the TypeScript proxy on a stale snapshot, and the next run then reports against line
   numbers from the *old* content ("Invalid line 24. Lines count: 24" for a 26-line file) and can
   assert nonsense. Print ~20 characters either side of the finding's offset; if the anchor does not
   match the description, re-run, and prove the claim by execution rather than editing code to
   satisfy a corrupted analysis.

```kotlin
import com.intellij.openapi.fileEditor.FileDocumentManager
val noise = setOf("JSUnusedGlobalSymbols","ES6PreferShortImport","HttpUrlsUsage",
                  "ES6RedundantAwait","SpellCheckingInspection","JSUnusedLocalSymbols","ES6MissingAwait")
for (p in listOf(/* files */)) {
  val vf = findProjectFile(p) ?: run { println("FILE|" + p + "|NOT_INDEXED"); continue }
  val res = runInspectionsDirectly(vf)
  val rows = readAction {
    val doc = FileDocumentManager.getInstance().getDocument(vf)
    res.entries.filter { (t, _) -> !noise.contains(t) }.flatMap { (t, ds) ->
      ds.map { d ->
        val off = d.psiElement?.textRange?.startOffset
        val ln = if (off != null && doc != null) doc.getLineNumber(off) + 1 else 0
        "ROW|" + t + "|" + p + "|" + ln + "|" + d.descriptionTemplate.replace("\n"," ").take(46)
      }
    }
  }
  println("FILE|" + p + "|rows=" + rows.size + "|failed=" + res.failedTools.size)
  for (r in rows.take(6)) println(r)
}
```

## Verified false-positive classes (do not "fix" these)

| Finding | Why it is rejected |
| --- | --- |
| `ES6ConvertVarToLetConst` on `declare global { var __x }` | `var` is required for the augmentation to become a `globalThis` property; `let`/`const` would not. |
| `JSUnusedGlobalSymbols` / `JSUnusedLocalSymbols` on test doubles and interface-backed classes | Members are reached through the double's own methods or an implemented interface; the tool counts direct references only. |
| `ExceptionCaughtLocallyJS` in `host/server.ts`, `workbench/controller.ts`, `browser/persistence.ts` | A `throw` inside `try` deliberately routes to the single recovery handler; rewriting it would duplicate that recovery. |
| `TypeScriptFieldCanBeMadeReadonly` on `PiSessionCatalog.#persisted` | The field is reassigned in `refresh` (`this.#persisted = nextPersisted`). |
| `ES6PreferShortImport` | The repo convention is explicit `.ts`/`.tsx` import specifiers. |
| `UnnecessaryLocalVariableJS` on the named `render` closure in `math-engine.ts` | The name carries the explicit `FormulaRenderer` annotation. |
| `PointlessBooleanExpressionJS` on `supportsNativeTerminal?.() === true` | Deliberate normalization at a benchmark gate. |
| `DuplicatedCode` short windows in `scripts/cef-artifacts.ts` | No deterministic 8-line/120-char duplicate exists there (see `heddlework-dup-scan`), and the counterpart location is not reported. |
| `JSUnreachableSwitchBranches` on every `case` of `Block` in `src/dom/rich.tsx` | The tool ran while the TS-Go proxy crashed on the same function ("Failed to find RemoteNode parent ... parent kind: 263" at the `function` keyword). `BlockNode` (`src/web/markdown-blocks.ts`) declares all six kinds, `tsc --noEmit` is clean, and the web DOM probe renders and clicks `case 'code'` at runtime — execution disproves the claim. |
| `JSVoidFunctionReturnValueUsed` on `src/web/main.tsx:22` | The anchor is `const root = document.getElementById('root')`; `getElementById` returns `HTMLElement \| null`, never `void`, and `tsc --noEmit -p src/web` is clean. The same run crashed the proxy on this file while reporting a stale 24-line snapshot, so the finding is line-mapped onto the wrong statement. |

## Baseline (2026-09-13, branch `chore/ide-inspection-fixes`)

- Sweep coverage: `src` 156/156 files, `tests`+`scripts` 122/122 files, 0 harness failures.
- Signal after noise filtering: 10 rows in `src`, 38 in `tests`+`scripts`, of which exactly one
  was actionable (`src/main.tsx` redundant initializer). Everything else fell in the table above.
- Deterministic cross-checks: 0 unreferenced modules under `src`, 3 duplicate clusters repo-wide
  (two are import lists or test scaffolding).

## Addendum: what this harness cannot catch (async boundaries)

The sweep above inspects *syntax, types and symbol usage*. It reported **0 rows** for every file in
the 2026-09-13 async tranche `src/flows/runtime.ts`, `src/dom/rich.tsx`, `src/web/main.tsx`,
`src/ui/terminal-panel.tsx`, which nevertheless contained real defects: a rejected promise needs no
unused symbol, no bad type and no dead code to escape.

Two failure modes found by reading fire-and-forget paths (both now fixed):

1. **Fatal escape.** `src/main.tsx` installs `process.on('unhandledRejection', ...)` as
   `shutdown(error)` → `process.exit(1)`. So any `void asyncCall()` whose promise can reject is a
   potential whole-application crash, not a cosmetic warning. `FlowRuntime` launched `tick()` and
   `flushPending()` from `subscribe`, `setInterval` and `runScheduleNow` with no owner; a throwing
   `host.getSnapshot()` killed the workspace instead of recording `lastError`.
2. **Silent false success.** `src/dom/rich.tsx` called `navigator.clipboard.writeText()` directly and
   ignored the returned promise, so a refused write left the button on "Copied" — it reported success
   for a copy that never happened — and leaked a rejection besides.

Review checklist this adds (grep-visible, so keep it cheap):

- `void <call>` on an `async` function: does *some* owner `.catch`/`try` it, or does it reach the
  process handler in `src/main.tsx`?
- Callbacks passed to `setInterval`/`setTimeout`/`subscribe`/`addEventListener`: an `async` body
  there is unhandled by construction — route it through the owner's dispatch boundary
  (`FlowRuntime.#dispatch` is the reference implementation).
- React `onClick` handlers: prefer a helper that resolves to a boolean or `undefined` over a raw
  promise, and clear any follow-up `setTimeout` in an effect cleanup.
- Optional enhancements (service worker registration, clipboard, math renderer, external pickers)
  must consume their own failure; only required paths may reject.

3. **Third surface: terminal spawn.** `BunPtyBackend.spawn` throws
   `Bun.Terminal is not available in this runtime` on any runtime without pty support, and
   `TerminalPanel`/`TerminalDock`/`TerminalToolbar` launched `spawn`/`ensureSession`/`close` with
   `void`. The failure now becomes `TerminalServiceSnapshot.lastError` (rendered by
   `TerminalView`) via `TerminalSessionService.dispatch`.

### Structural audits over-report on delegation

A follow-up script that flagged every controller `async` method whose *own body* lacks `catch`
reported 7 of 23 methods — and 7 `void controller.X()` UI call sites — as leaks. All seven were
safe: `submit`/`compact` delegate to `#sendPrompt`/`#runBuiltinSlashCommand` (both wrapped),
`queueFabricPeerGate` to `#requestFabricPeers` (resolves, never rejects), `loadMoreSessions` and
`refreshWorkspaceDiff` to `refreshSessions` and `WorkspaceDiff.load` (both self-catch), `dispose`
is awaited by callers that handle it, and `reconnect`'s only throw path, `PiRpcTransport.stop`,
has no rejection path while real connection failures are already reported by `start()`. Structure
is not reachability — prove the leak by execution (see the terminal probe below) before rewriting a
call site.

Verified red→green in this tranche with the owning gates: `bun test tests/flow-runtime.test.ts`
(asserted `lastError`), `bun scripts/web-dom-e2e.ts` (asserted `process.on('unhandledRejection')`
stays empty while a code-block copy is refused, then succeeds), and
`bun test tests/terminal-service.test.ts` (a refused spawn leaked an unhandled rejection before,
and publishes `lastError` now).

