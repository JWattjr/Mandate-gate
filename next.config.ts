import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Evidence fixtures are fetched by GenLayer validators; keep them plain and uncached-stale.
        source: '/evidence/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=60' },
          { key: 'X-Robots-Tag', value: 'noindex' },
        ],
      },
    ];
  },
};

export default nextConfig;
