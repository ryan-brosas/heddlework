/**
 * Bundler defines that resolve React to its production build in shipped bundles.
 *
 * Without `process.env.NODE_ENV` the bundler keeps the development React branch,
 * and the packaged desktop binary measured 73-90% JS self time in dev-only React
 * code (hooks order checks, jsxDEV, profiler shims) versus 29% with this define.
 * The web build adds platform defines on top; the desktop compile uses it as is.
 */
export const reactProductionDefine: Record<string, string> = {
  'process.env.NODE_ENV': '"production"',
}
