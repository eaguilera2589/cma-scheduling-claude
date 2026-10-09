import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'CMA Scheduling',
  description: 'Scheduling interface for CMA inspections (backed by the Inspections sheet).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center px-4 py-3">
            <span className="text-lg font-semibold tracking-tight">CMA Scheduling</span>
            <span className="ml-2 hidden rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500 sm:inline">
              read &amp; write
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
