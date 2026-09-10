import type { ReactNode } from 'react';

/**
 * The root layout.
 *
 * Next requires one. It exists to satisfy that requirement and to give the
 * single status page a document to live in — this project has no web UI
 * (brief sections 62 and 63), so there is nothing else here.
 */
export const metadata = {
  title: 'Scribble & Guess API',
  description: 'REST and Socket.IO backend for the Scribble & Guess Flutter app.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
