/**
 * The *Meridian* — the station Space Mystery is played on.
 *
 * ## Why the map is data and why it lives on the server
 *
 * Movement is server-authoritative: a client sends a direction, and the server
 * decides where that actually puts you. That only works if the server is the
 * one holding the walls. The same description is handed to the client at match
 * start so it can draw the ship, but drawing it is all the client does with
 * it — a client that deletes a wall from its own copy simply walks into one it
 * cannot see.
 *
 * ## Why rectangles
 *
 * Every walkable space is an axis-aligned rectangle, and the floor plan is the
 * union of them. Collision is then a handful of interval tests per tick rather
 * than polygon clipping, line-of-sight is a sampled segment test, and the
 * whole map is legible as a literal. A curved hull would look better and would
 * cost a geometry library, a slower tick and a class of bug where a player
 * ends up inside a wall and has to be teleported out.
 *
 * Rooms and corridors are the same kind of thing to the physics. They are
 * separate lists only because a room has a name a player can say out loud in a
 * meeting — "I was in the reactor" — and a corridor does not.
 *
 * ## The coordinate space
 *
 * 100 × 60 arbitrary units, origin top-left, y increasing downwards, which is
 * the orientation every client canvas already uses. Distances below are in
 * those units: a crewmate is 1.2 across and walks 14 units a second, so
 * crossing the cafeteria takes about two seconds.
 */

export const WORLD = { width: 100, height: 60 } as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Room extends Rect {
  id: string;
  /** What a player calls it in a meeting. */
  name: string;
}

export interface TaskStation {
  id: string;
  roomId: string;
  name: string;
  x: number;
  y: number;
  /** How long a crewmate has to stand there, in milliseconds. */
  durationMs: number;
}

/** A vent mouth. Traitors only, and only between mouths on the same network. */
export interface Vent {
  id: string;
  roomId: string;
  x: number;
  y: number;
  /** Vents connect only to other mouths carrying the same network id. */
  network: string;
}

export const ROOMS: readonly Room[] = [
  { id: 'bridge', name: 'Bridge', x: 4, y: 4, width: 18, height: 12 },
  { id: 'observatory', name: 'Observatory', x: 40, y: 2, width: 20, height: 10 },
  { id: 'medbay', name: 'Med Bay', x: 78, y: 4, width: 18, height: 12 },
  { id: 'reactor', name: 'Reactor', x: 2, y: 24, width: 16, height: 14 },
  { id: 'cafeteria', name: 'Cafeteria', x: 38, y: 22, width: 24, height: 16 },
  { id: 'comms', name: 'Comms', x: 82, y: 24, width: 16, height: 14 },
  { id: 'engine', name: 'Engine Bay', x: 4, y: 46, width: 18, height: 12 },
  { id: 'storage', name: 'Storage', x: 42, y: 46, width: 16, height: 12 },
  { id: 'cargo', name: 'Cargo Hold', x: 76, y: 44, width: 20, height: 14 },
] as const;

/**
 * The corridors, which make the deck a ring with a hub in the middle.
 *
 * Each one runs three units **into** both rooms it joins rather than stopping
 * at the wall. That overlap is load-bearing: a body inset by its own radius
 * standing exactly on a seam would otherwise be inside neither rectangle and
 * so inside no floor at all, and every doorway on the ship would be a wall.
 *
 * A ring matters more than it sounds. On a map shaped like a tree there is
 * always exactly one way out of a room, so anybody who walks in behind you has
 * you trapped and the game turns into a queue. A loop means every room has two
 * exits, which is what makes "I went round the other way" a thing a player can
 * say and a thing that can be true.
 */
export const CORRIDORS: readonly Rect[] = [
  { x: 19, y: 5, width: 24, height: 6 },   // bridge — observatory
  { x: 57, y: 5, width: 24, height: 6 },   // observatory — med bay
  { x: 7, y: 13, width: 6, height: 14 },   // bridge — reactor
  { x: 85, y: 13, width: 6, height: 14 },  // med bay — comms
  { x: 15, y: 28, width: 26, height: 6 },  // reactor — cafeteria
  { x: 59, y: 28, width: 26, height: 6 },  // cafeteria — comms
  { x: 47, y: 9, width: 6, height: 16 },   // observatory — cafeteria
  { x: 7, y: 35, width: 6, height: 14 },   // reactor — engine
  { x: 85, y: 35, width: 6, height: 12 },  // comms — cargo
  { x: 47, y: 35, width: 6, height: 14 },  // cafeteria — storage
  { x: 19, y: 49, width: 26, height: 6 },  // engine — storage
  { x: 55, y: 49, width: 24, height: 6 },  // storage — cargo
] as const;

/** Everything walkable, rooms and corridors alike, as the physics sees it. */
export const WALKABLE: readonly Rect[] = [...ROOMS, ...CORRIDORS];

/**
 * Where the work is.
 *
 * Spread so that a full task list cannot be finished without crossing the
 * ship. A crewmate who never leaves the cafeteria is a crewmate nobody can
 * vouch for, and a task list that let them stay there would remove the only
 * pressure the crew is under.
 */
export const TASK_STATIONS: readonly TaskStation[] = [
  { id: 'align-array', roomId: 'bridge', name: 'Align the array', x: 9, y: 9, durationMs: 4500 },
  { id: 'plot-course', roomId: 'bridge', name: 'Plot a course', x: 18, y: 12, durationMs: 3500 },
  { id: 'scan-field', roomId: 'observatory', name: 'Scan the field', x: 45, y: 6, durationMs: 5000 },
  { id: 'log-drift', roomId: 'observatory', name: 'Log the drift', x: 56, y: 9, durationMs: 3000 },
  { id: 'sort-samples', roomId: 'medbay', name: 'Sort samples', x: 83, y: 8, durationMs: 4000 },
  { id: 'run-bloodwork', roomId: 'medbay', name: 'Run bloodwork', x: 92, y: 13, durationMs: 5500 },
  { id: 'vent-coolant', roomId: 'reactor', name: 'Vent coolant', x: 6, y: 28, durationMs: 5000 },
  { id: 'balance-rods', roomId: 'reactor', name: 'Balance the rods', x: 14, y: 35, durationMs: 6000 },
  { id: 'clear-trays', roomId: 'cafeteria', name: 'Clear the trays', x: 42, y: 26, durationMs: 3000 },
  { id: 'brew-a-pot', roomId: 'cafeteria', name: 'Brew a pot', x: 58, y: 34, durationMs: 3500 },
  { id: 'tune-antenna', roomId: 'comms', name: 'Tune the antenna', x: 86, y: 28, durationMs: 4500 },
  { id: 'clear-static', roomId: 'comms', name: 'Clear the static', x: 94, y: 35, durationMs: 4000 },
  { id: 'prime-injector', roomId: 'engine', name: 'Prime the injector', x: 8, y: 50, durationMs: 5000 },
  { id: 'grease-bearings', roomId: 'engine', name: 'Grease the bearings', x: 18, y: 55, durationMs: 4000 },
  { id: 'count-crates', roomId: 'storage', name: 'Count the crates', x: 45, y: 50, durationMs: 3500 },
  { id: 'reseal-drums', roomId: 'storage', name: 'Reseal the drums', x: 55, y: 55, durationMs: 4500 },
  { id: 'lash-cargo', roomId: 'cargo', name: 'Lash the cargo', x: 80, y: 48, durationMs: 4000 },
  { id: 'weigh-manifest', roomId: 'cargo', name: 'Weigh the manifest', x: 92, y: 55, durationMs: 5000 },
] as const;

/**
 * Two separate vent networks rather than one.
 *
 * A single loop touching every room is a traitor that is never anywhere, which
 * removes the point of tracking where people go. Two short networks that do
 * not meet mean a traitor can move unseen down one side of the ship and has to
 * walk like everyone else to reach the other.
 */
export const VENTS: readonly Vent[] = [
  { id: 'vent-reactor', roomId: 'reactor', x: 5, y: 36, network: 'port' },
  { id: 'vent-engine', roomId: 'engine', x: 6, y: 56, network: 'port' },
  { id: 'vent-storage', roomId: 'storage', x: 44, y: 56, network: 'port' },
  { id: 'vent-comms', roomId: 'comms', x: 95, y: 26, network: 'starboard' },
  { id: 'vent-cargo', roomId: 'cargo', x: 94, y: 46, network: 'starboard' },
  { id: 'vent-medbay', roomId: 'medbay', x: 94, y: 6, network: 'starboard' },
] as const;

/** The emergency table. Everybody is dragged here when a meeting is called. */
export const MEETING_TABLE = { x: 50, y: 30 } as const;

/** Where a match starts. Spread round the table so nobody spawns inside anybody. */
export const SPAWN_POINTS: readonly { x: number; y: number }[] = [
  { x: 44, y: 26 }, { x: 50, y: 25 }, { x: 56, y: 26 },
  { x: 42, y: 30 }, { x: 58, y: 30 },
  { x: 44, y: 34 }, { x: 50, y: 35 }, { x: 56, y: 34 },
  { x: 47, y: 28 }, { x: 53, y: 32 },
] as const;

/**
 * The two stations a reactor breach has to be held down at, at the same time.
 *
 * Deliberately at opposite ends of the ship. A sabotage one person can fix
 * alone is a sabotage that costs the crew nothing; this one splits the group,
 * which is exactly when a traitor wants everybody split.
 */
export const BREACH_STATIONS: readonly { id: string; x: number; y: number }[] = [
  { id: 'breach-port', x: 6, y: 32 },
  { id: 'breach-starboard', x: 95, y: 31 },
] as const;

// ---------------------------------------------------------------------------
// Geometry. Everything below is pure and allocation-free on the hot path,
// because it runs for every player on every tick.
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 1.2;

function insideRect(rect: Rect, x: number, y: number, inset: number): boolean {
  return x >= rect.x + inset
    && x <= rect.x + rect.width - inset
    && y >= rect.y + inset
    && y <= rect.y + rect.height - inset;
}

/**
 * Whether a body of [PLAYER_RADIUS] centred here fits inside the floor plan.
 *
 * "Inside any one rectangle" rather than "inside the union", which is a real
 * difference: a player standing exactly on the seam where a corridor meets a
 * room is inside the union but, inset by their own radius, may be outside both
 * rectangles. The corridors above therefore *overlap* the rooms they join
 * rather than butting against them, so every seam is several units deep and
 * the simpler test is the correct one.
 */
export function walkable(x: number, y: number): boolean {
  for (const rect of WALKABLE) {
    if (insideRect(rect, x, y, PLAYER_RADIUS)) return true;
  }
  return false;
}

/** The room a point is in, or `null` for a corridor. */
export function roomAt(x: number, y: number): Room | null {
  for (const room of ROOMS) {
    if (insideRect(room, x, y, 0)) return room;
  }
  return null;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Whether two points can see each other.
 *
 * Samples the segment between them and asks whether every sample is on the
 * floor. Not exact — a sample step of half a unit can in principle skip the
 * corner of a wall — but the walls here are at minimum five units thick, so
 * nothing in this map is thin enough to see through. Exactness would cost a
 * segment-versus-rectangle intersection per wall per pair per tick, to fix a
 * case the floor plan does not contain.
 *
 * This is what stops a modified client from drawing players through walls: it
 * is not that the client is asked not to, it is that it is never sent them.
 */
export function lineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
  const span = distance(ax, ay, bx, by);
  const steps = Math.ceil(span / 0.5);
  if (steps <= 1) return true;

  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    // Sampled with no radius inset: a sight line passes through a doorway a
    // body could not, which is correct — you can see through a gap you cannot
    // walk through.
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    let open = false;
    for (const rect of WALKABLE) {
      if (insideRect(rect, x, y, 0)) { open = true; break; }
    }
    if (!open) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The navigation graph the bots walk on.
// ---------------------------------------------------------------------------

export interface NavNode {
  id: string;
  x: number;
  y: number;
}

/**
 * Waypoints: one in the middle of every room, one in the middle of every
 * corridor.
 *
 * Room centres, corridor centres, and one in every doorway (see below).
 *
 * Around forty nodes, which is small enough that a breadth-first search across
 * the whole graph costs less than the distance calculations a single tick of
 * movement already does. A grid would be more flexible and would need A* and a
 * tuned heuristic to stay cheap; a map this size does not need either.
 */
export const NAV_NODES: readonly NavNode[] = (() => {
  const nodes: NavNode[] = [
    ...ROOMS.map((room) => ({
      id: `room:${room.id}`,
      x: room.x + room.width / 2,
      y: room.y + room.height / 2,
    })),
    ...CORRIDORS.map((corridor, index) => ({
      id: `hall:${index}`,
      x: corridor.x + corridor.width / 2,
      y: corridor.y + corridor.height / 2,
    })),
  ];

  /**
   * A waypoint in every doorway — the patch of floor a corridor and a room
   * actually share.
   *
   * Without these the graph comes out empty, and the reason is worth keeping.
   * Edges are derived by asking whether a body can walk the straight line
   * between two waypoints, and the line from the middle of a room to the
   * middle of a corridor is a *diagonal* that leaves the room before it
   * enters the corridor: near the doorway it is inside neither rectangle, so
   * the test fails and two rooms that plainly connect end up with no edge.
   *
   * Putting a waypoint in the overlap fixes it by construction. Room centre
   * to doorway is a line that stays inside the room; doorway to corridor
   * centre stays inside the corridor. Every segment the derivation has to
   * prove now lives inside a single rectangle, which is the one case the test
   * can never get wrong.
   */
  for (let index = 0; index < CORRIDORS.length; index++) {
    const corridor = CORRIDORS[index]!;
    for (const room of ROOMS) {
      const left = Math.max(corridor.x, room.x);
      const right = Math.min(corridor.x + corridor.width, room.x + room.width);
      const top = Math.max(corridor.y, room.y);
      const bottom = Math.min(corridor.y + corridor.height, room.y + room.height);

      // Wide enough for a body to stand in with its radius to spare, or it is
      // a rounding artefact where two rectangles graze, not a doorway.
      const clearance = PLAYER_RADIUS * 2 + 0.2;
      if (right - left < clearance || bottom - top < clearance) continue;

      nodes.push({
        id: `door:${index}:${room.id}`,
        x: (left + right) / 2,
        y: (top + bottom) / 2,
      });
    }
  }

  return nodes;
})();

/**
 * Two waypoints are neighbours when the straight line between them is walkable
 * for a body.
 *
 * Derived rather than listed, so the adjacency cannot fall out of step with
 * the floor plan: moving a corridor five units to the left rewires the graph
 * on the next boot instead of leaving a bot walking into a wall. Built once at
 * module load — the map never changes at runtime.
 */
export const NAV_EDGES: Readonly<Record<string, readonly string[]>> = (() => {
  const edges: Record<string, string[]> = {};
  for (const node of NAV_NODES) edges[node.id] = [];

  for (let i = 0; i < NAV_NODES.length; i++) {
    for (let j = i + 1; j < NAV_NODES.length; j++) {
      const a = NAV_NODES[i]!;
      const b = NAV_NODES[j]!;
      if (!walkableSegment(a.x, a.y, b.x, b.y)) continue;
      edges[a.id]!.push(b.id);
      edges[b.id]!.push(a.id);
    }
  }
  return edges;
})();

/** Like [lineOfSight], but inset by a body: can something actually walk it? */
function walkableSegment(ax: number, ay: number, bx: number, by: number): boolean {
  const steps = Math.ceil(distance(ax, ay, bx, by) / 0.5);
  for (let step = 0; step <= steps; step++) {
    const t = steps === 0 ? 0 : step / steps;
    if (!walkable(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
  }
  return true;
}

const NAV_BY_ID: ReadonlyMap<string, NavNode> = new Map(NAV_NODES.map((node) => [node.id, node]));

export function navNode(id: string): NavNode | null {
  return NAV_BY_ID.get(id) ?? null;
}

/** The nearest waypoint that can actually be walked to from here. */
export function nearestNav(x: number, y: number): NavNode | null {
  let best: NavNode | null = null;
  let bestDistance = Infinity;

  for (const node of NAV_NODES) {
    const span = distance(x, y, node.x, node.y);
    if (span >= bestDistance) continue;
    if (!walkableSegment(x, y, node.x, node.y)) continue;
    best = node;
    bestDistance = span;
  }

  // A body wedged in a doorway can fail every segment test. Falling back to
  // raw proximity gets it moving again; the steering will free it within a
  // tick or two, which is better than a bot that stands still for a match.
  if (best !== null) return best;
  for (const node of NAV_NODES) {
    const span = distance(x, y, node.x, node.y);
    if (span < bestDistance) { best = node; bestDistance = span; }
  }
  return best;
}

/**
 * The waypoints from here to there, excluding where we already are.
 *
 * Breadth-first, so it is the fewest *hops* rather than the shortest walk.
 * With one node per room the two are near enough the same thing, and a bot
 * that takes a slightly odd route through a ship is indistinguishable from a
 * player who did.
 */
export function pathBetween(fromId: string, toId: string): NavNode[] {
  if (fromId === toId) {
    const node = navNode(toId);
    return node ? [node] : [];
  }

  const previous = new Map<string, string>([[fromId, fromId]]);
  const queue: string[] = [fromId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbour of NAV_EDGES[current] ?? []) {
      if (previous.has(neighbour)) continue;
      previous.set(neighbour, current);
      if (neighbour === toId) {
        const path: NavNode[] = [];
        for (let step = toId; step !== fromId; step = previous.get(step)!) {
          const node = navNode(step);
          if (node) path.unshift(node);
        }
        return path;
      }
      queue.push(neighbour);
    }
  }
  return [];
}

/** The whole floor plan, as the client is handed it at match start. */
export function mapDescription(): Record<string, unknown> {
  return {
    world: WORLD,
    rooms: ROOMS,
    corridors: CORRIDORS,
    stations: TASK_STATIONS,
    vents: VENTS,
    breachStations: BREACH_STATIONS,
    meetingTable: MEETING_TABLE,
    playerRadius: PLAYER_RADIUS,
  };
}
