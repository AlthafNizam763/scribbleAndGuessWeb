import type { ReactNode } from 'react';

import { GameProvider } from '@/web/GameProvider';
import { RoomInvitationToast } from '@/web/components/RoomInvitationToast';

import './globals.css';

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
