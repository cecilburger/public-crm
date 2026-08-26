/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  env: { KIRANA_API_URL: process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080' },
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
