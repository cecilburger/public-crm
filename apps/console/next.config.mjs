/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep a page the browser has already rendered for 30 s, so going back to
  // it (or clicking a link that was just hovered) opens instantly instead of
  // waiting on a fresh server render. Every mutating server action calls
  // revalidatePath, which drops this cache, and the live pages refresh
  // themselves (AutoRefresh) — so what you just changed is never shown stale.
  experimental: { staleTimes: { dynamic: 30 } },
  eslint: { ignoreDuringBuilds: true },
  env: { KIRANA_API_URL: process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080' },
  // konva's package resolves to a Node build that `require`s the native
  // `canvas` package — never actually reached (the editor is dynamically
  // imported with `ssr: false`), but webpack still tries to resolve it while
  // bundling the client reference for that Client Component.
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
  // The same alias for Turbopack, which ignores the webpack block above and
  // says so on every start. Without it the dev server resolves `canvas` for
  // real and the two konva editors are the pages that would break. Turbopack
  // cannot map a module to `false`, so it gets an empty module instead.
  turbopack: {
    resolveAlias: { canvas: './empty-module.js' },
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'x-content-type-options', value: 'nosniff' },
        { key: 'referrer-policy', value: 'no-referrer' },
        { key: 'x-frame-options', value: 'DENY' },
      ],
    }];
  },
};
