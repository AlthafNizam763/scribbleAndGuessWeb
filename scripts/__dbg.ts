import { SpaceMysteryEngine } from '@/games/spaceMystery/engine';
import { MEETING_TABLE, SPAWN_POINTS, VENTS, distance } from '@/games/spaceMystery/map';
import type { PlatformPlayerState } from '@/games/game.types';

const seat = (id: string): PlatformPlayerState => ({
  playerId: id, userId: id, username: id, avatarId: 0, avatarColorIndex: 0,
  isBot: false, botDifficulty: null, isReady: true, connected: true, joinedAtMs: 0,
});

console.log('spawn distances from the emergency table:');
for (const p of SPAWN_POINTS) console.log(' ', p.x, p.y, '->', distance(p.x, p.y, MEETING_TABLE.x, MEETING_TABLE.y).toFixed(2));

const e = new SpaceMysteryEngine();
e.begin({ matchId: 'm', roomId: 'r', players: ['a','b','c','d','e'].map(seat) });
const traitor = ['a','b','c','d','e'].find(id => (e.viewFor('m', id)!.you as any).role === 'traitor')!;
console.log('traitor =', traitor);

const m = (e as any).matches.get('m');
const p = m.players.get(traitor);
const vent = VENTS[0]!;
p.x = vent.x; p.y = vent.y;
console.log('placed at', p.x, p.y, 'vent at', vent.x, vent.y, 'dist', distance(p.x, p.y, vent.x, vent.y));
e.input('m', traitor, { type: 'vent' });
console.log('ventId after input =', p.ventId, '| projected =', (e.viewFor('m', traitor)!.you as any).ventId);
e.end('m');
