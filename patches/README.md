# Local native patches

`gpuix-runtime.json` pins immutable upstream revisions, so a native fix cannot live in a pin. Each
directory here is one repository of that checkout, and `bun run setup:native` applies, verifies and
fails on anything they do not explain.

| Set | Repository | Contents |
| --- | --- | --- |
| `gpuix/0001-linux-native-runtime.patch` | the GPUix runtime | Desktop clipboard editing (`Ctrl+Insert` copy, `Ctrl+V`/`Cmd+V`/`Shift+Insert` paste through the caret-aware action, plus a `paste` event the host uses to attach clipboard images) and the XDG portal parent-window plus system-appearance primitives. |
| `zed/0001-portal-parent-and-appearance.patch` | the nested GPUI checkout | The GPUI side of those primitives (`parent_window_identifier`, portal file chooser, system appearance). |

## The contract

- A patch is applied once: a patch that is already applied reverse-applies cleanly, so re-running
  `setup:native` on a cache is idempotent.
- `sourceIdentity`/`sourceFingerprint` hash the *working-tree bytes* of the build inputs, so a cached
  runtime is never reused after a build input changes - including a change that was never staged.
- `assertDeclaredSource` reverse-applies the declared patches in a temporary Git index of the real build
  inputs. Anything left over is an undeclared change, and the installer fails instead of building it. That
  is the difference between "the pin plus patches" and "whatever this machine happened to have".
- Generated artifacts (`packages/native/index.js`, `index.d.ts`, `bun.lock` outputs, Cargo targets) are not
  build inputs, so a build that rewrites them does not invalidate the stamp.

When adding work: keep it in a patch, keep the patch focused, and let the fingerprint prove it. Upstream
it to the fork branches before the next pin bump, then delete the patch.
