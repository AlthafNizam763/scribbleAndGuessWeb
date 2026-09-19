import { Plus_Jakarta_Sans, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';

import { GameProvider } from '@/web/GameProvider';
import { RoomInvitationToast } from '@/web/components/RoomInvitationToast';

import './globals.css';

/**
 * The two typefaces of the platform, the same pair the Flutter client bundles.
 *
 * Self-hosted by Next rather than linked from Google: a `<link>` to a font CDN
 * costs a second connection before the first glyph can be drawn, and the page
 * spends that time showing the system fallback. These are served from our own
 * origin with `display: swap`, and their variable weights mean one file per
 * family covers the whole scale.
 */
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

const body = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-plus-jakarta',
  display: 'swap',
});

/**
 * The root layout.
 *
 * `GameProvider` is mounted here rather than per page on purpose: it owns the
 * socket connection, and a provider that remounted on navigation would tear
 * that connection down and open a new one every time the player moved between
 * the home screen and a room — losing their seat on each trip.
 */
export const metadata = {
  title: 'Scribble & Guess',
  description: 'Draw, guess and score with friends. Web client for the Scribble & Guess backend.',
};

/**
 * Painted behind the page before the stylesheet has applied, and used by the
 * browser for its own chrome. Both entries match the surface tokens in
 * `globals.css`, so there is no flash of a differently-coloured page.
 */
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f4fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0912' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        {/*
          * The invitation toast is a sibling of the page rather than part of
          * one, because an invitation can arrive on any screen and the player
          * should see it wherever they are. It renders null when there is
          * nothing to show, which is most of the time.
          */}
        <GameProvider>
          {children}
          <RoomInvitationToast />
        </GameProvider>
      </body>
    </html>
  );
}
