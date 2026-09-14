import { describe } from 'bun:test'
import { hasNativeTestRenderer } from '@gpuix/react/testing'

/**
 * Shared gate for every suite that needs the native GPUIX test renderer.
 *
 * The test renderer only exists where the addon was compiled with test support, which the pinned
 * gpuix restricts to macOS and Windows (`cfg!(test-support && (macos || windows))`). On Linux these
 * suites are therefore a structural skip, not a failure: a green run with skips is expected, but the
 * reason stays in one place so it cannot be mistaken for coverage or quietly weakened per file.
 */
export const NATIVE_RENDERER_SKIP_REASON = 'the native GPUIX test renderer is only built for macOS and Windows'

if (!hasNativeTestRenderer) console.warn(`[tests] skipping native GPUIX suites: ${NATIVE_RENDERER_SKIP_REASON}`)

export const describeNative = hasNativeTestRenderer ? describe : describe.skip
