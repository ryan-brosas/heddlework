# Heddlework (ryan-brosas fork) - agent guidance

Compact, durable context for any agent working in this repo. Prefer ground truth over this file;
these notes encode invariants that are expensive to rediscover.

## What this is

A native, harness-neutral desktop workspace for agent sessions, task graphs, diffs, and durable
work. React + GPUIX (GPU-rendered) on the client; Pi RPC is the first harness adapter. Core model:
**the harness is authoritative for its own execution and transcripts; Heddlework projects state and
never invents a second agent loop.**

**This fork's purpose is the Linux support contribution** (Omarchy: Arch + Hyprland + Wayland,
x86_64). The Linux/Omarchy working plan - pin state, Sourcebot corpus, Zed<>GPUix Wayland workstream,
verification gates - lives in `docs/plans/linux-omarchy-bootstrap.md`; read it before native-runtime
or Wayland work.

## Lineage

- `main` tracks the fresh fork of upstream (`monotykamary/heddlework`, currently `fd4496d`).
- The pre-reset Linux work (35 commits) is preserved locally on `backup/main-35ahead` (`5bbc57c`)
  and `feat/linux-adoption-foundations` (`4298ef3`). Re-land it per concern; never merge wholesale.
- `gpuix-runtime.json` pins `monotykamary/gpuix@2b94075` + `monotykamary/zed@e94e7f5` (both are the
  tip of each fork's `feat/heddlework-platform-alignment` branch). Move pins only through
  `bun run setup:native` plus the full gate suite.

## Verification gates (verified in package.json - run these, do not guess)

```bash
bun install --frozen-lockfile   # never mutate the lockfile by hand
bun run check                   # typecheck + typecheck:web + test + test:performance + web-dom-e2e
bun run build                   # unsigned executable; HEDDLEWORK_WITHOUT_CEF=1 for browser-free
```

`check:native` and `check:ai-slop` do not exist in the fresh-fork package.json. Re-add them only
with their implementations.

## Invariants & traps

- **Harness authority**: never let UI code own harness truth. Streaming replaces transcript rows
  only after the authoritative `get_messages` settles.
- **Cordis composability**: every registration/listener/timer/process an owner attaches must attach
  its inverse to the same plugin/controller/React lifecycle. Unload withdraws effects in reverse.
- **GPUIX runtime authority**: `gpuix-runtime.json` is the runtime contract. `bun run setup:native`
  installs the built addon and symlinks `@gpuix/react` so a plain `bun run start` cannot load a
  stale binary. React/reconciler must share the application's one React instance (the installer
  enforces this).
- **Wayland correctness is Linux-only knowledge**: macOS headless layout tests prove nothing about
  decorations, serials, or fractional scaling. Validate on Hyprland and Mutter explicitly.
- `.pi/` is local agent-runtime state; `.pi/fabric/mesh/*` handoff files are session-local,
  never commit them.
- `docs/browser.md` documents the native browser (macOS CEF today); read it before touching that
  system. Linux browser-free builds are the default until a Linux CEF path exists.

## Deliverable hygiene

- Run the full `check` suite before pushing.
- Keep required-check names stable; rulesets match them exactly.
- **Push and PR to the fork only** (`origin` = ryan-brosas/heddlework). Never push to `upstream`
  (its push URL is disabled as a guard) and never open PRs there unless the user explicitly requests
  an upstream contribution. The existence of an `upstream` remote is NOT permission to push or PR
  to it. `gh pr create` must target the fork (`--repo ryan-brosas/heddlework`).
- CI runs the Linux `test` job on ubuntu-24.04. Compositor smoke is manual-only; macOS/Windows
  jobs must not be added without the owner's request.
