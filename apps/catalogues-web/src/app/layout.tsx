import type { Metadata } from 'next';
import { Poppins } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';
import { Providers } from '@/components/providers';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Ai Vastra — AI catalogues for fashion brands',
  description:
    'Generate premium ecommerce model shoots from your garment photos in minutes. No studio, no shoot day.',
  icons: {
    icon: [{ url: '/favicon.svg?v=3', type: 'image/svg+xml', sizes: '32x32' }],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved theme before first paint to avoid flash. suppressHydrationWarning:
            browsers always report element.nonce as "" (CSP nonce-hiding spec behavior),
            so React's hydration check sees a false mismatch against the real nonce
            attribute even though the correct nonce is applied and CSP is enforced. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          // biome-ignore lint/security/noDangerouslySetInnerHtml: theme flash prevention requires inline script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body className={poppins.variable} suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
