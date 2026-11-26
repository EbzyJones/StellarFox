// ============================================================
// BANKERCHANGER — Offline Fallback Page
//
// The service worker serves this page when a navigation request
// fails and there's no cached version of the destination.
// ============================================================

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Offline — BANKERCHANGER',
  description: 'You are currently offline.',
  robots: { index: false, follow: false },
};

export default function OfflinePage(): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="max-w-sm space-y-6">
        {/* Icon */}
        <div
          aria-hidden="true"
          className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gray-800"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-10 w-10 text-gray-500"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 3l18 18M8.288 8.288A5.25 5.25 0 0 0 7.5 10.5a5.25 5.25 0 0 0 5.25 5.25c.78 0 1.52-.173 2.188-.484M4.5 10.5a9.75 9.75 0 0 1 15.456-7.956M19.5 10.5a9.738 9.738 0 0 1-2.573 6.634M12 2.25a9.75 9.75 0 0 1 9.75 9.75"
            />
          </svg>
        </div>

        {/* Heading */}
        <div>
          <h1 className="text-2xl font-black text-white">You&apos;re offline</h1>
          <p className="mt-2 text-gray-400">
            Check your connection and try again. Any bets or actions you take now will sync
            automatically when you&apos;re back online.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-semibold text-gray-950 hover:bg-amber-300 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-gray-700 px-5 py-2.5 text-sm font-medium text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
          >
            Go home
          </Link>
        </div>

        {/* Help text */}
        <p className="text-xs text-gray-600">
          Previously visited pages may still be available from cache.
        </p>
      </div>
    </main>
  );
}
