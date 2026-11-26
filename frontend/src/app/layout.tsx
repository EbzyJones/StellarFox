// ============================================================
// BANKERCHANGER — Root Layout
// Wraps all pages with Header and global providers.
// ============================================================

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Header } from '../components/layout/Header';
import { Breadcrumb } from '../components/layout/Breadcrumb';
import { QueryProvider } from '../providers/QueryProvider';
import { OfflineProvider } from '../providers/OfflineProvider';
import { ToastProvider } from '../components/ui/ToastProvider';
import { PWAInstallPrompt } from '../components/ui/PWAInstallPrompt';
import { PWAUpdateBanner } from '../components/ui/PWAUpdateBanner';
import { OfflineIndicator } from '../components/ui/OfflineIndicator';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#fbbf24' },
    { media: '(prefers-color-scheme: light)', color: '#fbbf24' },
  ],
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
};

export const metadata: Metadata = {
  title: {
    default: 'BANKERCHANGER — Boxing Prediction Markets',
    template: '%s — BANKERCHANGER',
  },
  description: 'Decentralized boxing prediction market powered by Stellar Soroban smart contracts.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'BANKERCHANGER',
  },
  formatDetection: { telephone: false },
  openGraph: {
    siteName: 'BANKERCHANGER',
    type: 'website',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en" className={inter.className}>
      {/* Inline script runs before paint to set dark/light class — prevents flash */}
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('bankerchanger_theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');})();`,
          }}
        />
      </head>
      <body className="bg-white dark:bg-gray-950 text-gray-900 dark:text-white min-h-screen transition-colors">
        <QueryProvider>
          <ToastProvider>
            <OfflineProvider>
              <Header />
              <Breadcrumb />
              {children}
            </OfflineProvider>
            <Header />
            <Breadcrumb />
            {children}
            {/* PWA UI — rendered client-side, harmless if SW not supported */}
            <PWAInstallPrompt />
            <PWAUpdateBanner />
            <OfflineIndicator />
          </ToastProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
