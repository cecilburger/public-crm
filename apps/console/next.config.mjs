/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
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
