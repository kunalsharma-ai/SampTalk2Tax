import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  reactStrictMode: true,
  // The container image (apps/web/Dockerfile) runs the self-contained server; `next start` is used otherwise.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  transpilePackages: ['@talk2tax/ui', '@talk2tax/design-system'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
