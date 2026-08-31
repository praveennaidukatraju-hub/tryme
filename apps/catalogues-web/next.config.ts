import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true, // Biome handles linting; Next.js ESLint pass conflicts with flat config
  },
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  transpilePackages: ['@tryme/types'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '0' }, // disabled — rely on CSP when added
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Content-Security-Policy is set per-request in middleware.ts — it
          // needs a fresh nonce every request, which a static header here can't do.
        ],
      },
    ];
  },
  async redirects() {
    const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
    return [
      { source: `${base}/dashboard`, destination: `${base}/catalogs`, permanent: true },
      { source: `${base}/jobs`, destination: `${base}/catalogs`, permanent: true },
      { source: `${base}/credits`, destination: `${base}/pricing`, permanent: true },
      { source: `${base}/account`, destination: `${base}/settings`, permanent: true },
      { source: `${base}/catalogues`, destination: `${base}/catalogs`, permanent: true },
      {
        source: `${base}/catalogues/:path*`,
        destination: `${base}/catalogs/:path*`,
        permanent: true,
      },
      // Exact match only — /assets/:path* would shadow the public/assets static
      // folder, since next.config redirects run before filesystem/public files.
      { source: `${base}/assets`, destination: `${base}/my-products`, permanent: true },
    ];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
  images: {
    // Image optimizer fetches local images without basePath prefix → 404.
    // Disable optimization so Next.js renders plain <img> with the full
    // basePath-prefixed URL that NGINX can route correctly.
    unoptimized: true,
    remotePatterns: [
      { protocol: 'http', hostname: '127.0.0.1' },
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
      { protocol: 'https', hostname: 'app.tryme.com' },
    ],
  },
};

export default withSentryConfig(nextConfig, {
  // Upload source maps to Sentry only when SENTRY_AUTH_TOKEN is set (CI/prod build).
  // In local dev this is a no-op so the build stays fast.
  silent: !process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  // Disable tunnel route — we're not worried about ad-blocker interference.
  tunnelRoute: undefined,
  webpack: {
    // Don't instrument server components with Sentry's auto-wrapping (avoids bundle bloat).
    autoInstrumentServerFunctions: false,
    treeshake: { removeDebugLogging: true },
  },
});
