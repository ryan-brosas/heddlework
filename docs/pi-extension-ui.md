# Pi extension UI

Heddlework runs Pi as an ordinary RPC sidecar, so installed Pi extensions remain authoritative for commands, tools, configuration, and session behavior. The native host projects the semantic RPC UI protocol rather than importing terminal components into the desktop process.

## Native RPC surfaces

Heddlework handles Pi's `select`, `confirm`, `input`, and `editor` requests in the main conversation area. Requests are queued by ID instead of replacing one another, retain independent timeout deadlines, and are cancelled together when their owning session closes. Choice lists are vertical, searchable when long, and preserve the exact wire value while presenting numbered labels, descriptions, and current values separately. Interactive option and settings rows are divider-free and use the same rounded hover fill as session cards. Session-only pi-ledger engagement prompts are dismissed in an empty draft and appear only after a conversation is active.

Fire-and-forget extension surfaces are also native:

- `notify` splits by kind: `info` banners are transient, appearing in a short-lived stack above the composer that expires after `TRANSIENT_NOTICE_TTL_MS` and never enters the ledger, the unread badge, or a transcript position. `warning` and `error` keep the durable path (notification stack and ledger), as does `extension_error`.
- String `setWidget` content and ANSI-safe `setStatus` entries share a horizontally scrollable rail above the composer. Above-editor widgets enter first, followed by below-editor widgets and then status chips; new items use that same order for staggered motion.
- `setTitle` updates the window title.
- `setEditorText` updates the draft.
- `get_commands` powers discovery for extension commands, prompt templates, and skills. Heddlework merges Pi's built-in command catalog locally because RPC intentionally omits TUI commands.

Visible custom messages retain text, extension source, and image blocks in the transcript. Tool calls retain their raw arguments, results, and details for keyed native presenters.

## Known adapters

### Pi Fabric

`pi-fabric` exposes its complete `/fabric settings` hierarchy through the standard RPC dialog primitives. The root shows the active project or global save layer. Every existing section, inline value, nested section, numeric or string input, model selector, list editor, and compaction threshold remains backed by Fabric's existing persistence and coercion callbacks. Selecting Back returns one level; leaving the root applies the same reload and notification behavior as the TUI.

### ask_user_question

When a running `ask_user_question` tool and its first RPC request agree on the authored question, Heddlework presents one native questionnaire instead of the package's sequential dialogs. It supports question tabs, single and multiple choices, custom answers, Markdown previews, a review tab, cancellation, and hide/reopen behavior. The questionnaire covers the complete conversation page with an opaque surface. Hiding moves a compact waiting control directly above the composer and expands the transcript spacer by the same height, so the control never covers the final conversation rows. Submission is translated back into the package's exact sequential select/input responses; unexpected request methods or question text are not guessed.

The package's RPC fallback does not carry per-question notes or a global note, so the native adapter does not expose controls that would silently discard them. Adding those fields requires an append-only package or Pi host-response contract.

## Protocol boundary

Arbitrary `ctx.ui.custom()` factories, custom editors, footers, headers, and TUI renderer closures do not cross Pi RPC. Heddlework cannot safely translate those imperative in-process components into React/GPUIX automatically. Exact support requires either a semantic JSON-safe extension contract or an explicit keyed adapter.

Pi also labels desktop-submitted prompts as `source: "rpc"`. Extensions that require terminal keystrokes or `source: "interactive"`, such as pi-ledger's first-keystroke and steering metering, still need a host-input provenance contract. Heddlework renders pi-ledger's status and dialogs, but does not claim that missing behavioral signal is restored.
