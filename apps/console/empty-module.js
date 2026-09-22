// Stands in for the native `canvas` package that `konva` reaches for.
//
// Turbopack cannot alias a module to `false` the way the webpack config next
// door does, so it needs something real to resolve to. Nothing ever calls
// into this: the two canvas editors are dynamically imported with
// `ssr: false`, and in the browser konva uses the DOM's own canvas. It exists
// so the bundler stops trying to resolve a native Node addon that would never
// be reached anyway.
export default {};
