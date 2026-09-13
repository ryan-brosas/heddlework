# Quality audit harness (IDE inspections)

How this fork audits source quality with the IDE (MCP Steroid) and which findings are
actionable. Written after a full-tree sweep whose first runs were **false greens** — read
the pitfalls before reusing the harness.

## Harness

Run one script per small batch (3–4 files) through `steroid_execute_code`. Two rules make
the difference between real coverage and a silent zero:

1. **Every script needs its own `readAction { }`.** The previous script's read context does
   not carry over, and PSI/VFS access outside one aborts the whole batch (the platform logs
   an "IDE Exception Captured" block and the script returns nothing).
2. **Filter findings by the map key, not by a descriptor field.** `res.entries` is keyed by
   tool id; `it.toolId` does not exist, so `ds.filter { it.toolId ... }` is a *compile* error
   that surfaces as a generic MCP timeout. Print one `FILE|<path>|rows=N|failed=M` line per
   file and compare the count against the file list: a missing `FILE|` line is a failed batch,
   never a clean file.

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

## Baseline (2026-09-13, branch `chore/ide-inspection-fixes`)

- Sweep coverage: `src` 156/156 files, `tests`+`scripts` 122/122 files, 0 harness failures.
- Signal after noise filtering: 10 rows in `src`, 38 in `tests`+`scripts`, of which exactly one
  was actionable (`src/main.tsx` redundant initializer). Everything else fell in the table above.
- Deterministic cross-checks: 0 unreferenced modules under `src`, 3 duplicate clusters repo-wide
  (two are import lists or test scaffolding).
