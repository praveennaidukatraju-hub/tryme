import { NextResponse } from 'next/server';

export function GET() {
  const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return NextResponse.json({
    name: 'Try On Library',
    short_name: 'Try On',
    start_url: `${BASE}/tryon-library-app`,
    scope: `${BASE}/tryon-library-app`,
    display: 'standalone',
    background_color: '#080C18',
    theme_color: '#080C18',
    icons: [
      { src: `${BASE}/tryon-library-app-icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${BASE}/tryon-library-app-icon-512.png`, sizes: '512x512', type: 'image/png' },
    ],
  });
}
