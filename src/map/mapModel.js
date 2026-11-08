// In-memory map model used by the editor (and later the game).
// Layers are flat row-major arrays: index = y * width + x.
//   terrain[i]: 0 land, 1 water, 2 mountain
//   roads[i]:   0 none, 1 road (a road on water renders as a bridge)
//   objects[i]: null | { kind, owner }   (kind is a building kind, "flag" or "blockade")

import { MAP_LIMITS } from "../../shared/mapFormat.js";

export const PLAYERS = [
  { label: "Neutral", color: "#9aa5b1" },
  { label: "Red", color: "#e5534b" },
  { label: "Blue", color: "#3fa9f5" },
  { label: "Green", color: "#5cb85c" },
  { label: "Orange", color: "#f0a030" },
];

export const TERRAIN = { land: 0, water: 1, mountain: 2 };

export function createMap({ name = "Untitled map", width = 20, height = 14, players = 2 } = {}) {
  const cells = width * height;
  return {
    name,
    width,
    height,
    players,
    terrain: new Array(cells).fill(0),
    roads: new Array(cells).fill(0),
    objects: new Array(cells).fill(null),
  };
}

export function cloneMap(map) {
  return {
    ...map,
    terrain: map.terrain.slice(),
    roads: map.roads.slice(),
    objects: map.objects.map((object) => (object ? { ...object } : null)),
  };
}

export function clampSize(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return MAP_LIMITS.minSize;
  return Math.min(MAP_LIMITS.maxSize, Math.max(MAP_LIMITS.minSize, number));
}

/** Returns a new map of the given size, keeping content anchored to the top-left. */
export function resizeMap(map, width, height) {
  const next = createMap({ name: map.name, width, height, players: map.players });
  for (let y = 0; y < Math.min(height, map.height); y += 1) {
    for (let x = 0; x < Math.min(width, map.width); x += 1) {
      const from = y * map.width + x;
      const to = y * width + x;
      next.terrain[to] = map.terrain[from];
      next.roads[to] = map.roads[from];
      next.objects[to] = map.objects[from] ? { ...map.objects[from] } : null;
    }
  }
  return next;
}

/** Lowers the player count; buildings owned by removed players become neutral, their HQs are removed. */
export function setPlayerCount(map, players) {
  map.players = players;
  map.objects = map.objects.map((object) => {
    if (!object || object.owner <= players) return object;
    return object.kind === "hq" ? null : { ...object, owner: 0 };
  });
}

/**
 * Applies an editor tool at (x, y), mutating the map.
 * Returns { changed: [[x, y], ...], message? }.
 */
export function applyTool(map, x, y, tool, owner) {
  const index = y * map.width + x;
  const changed = [[x, y]];
  const none = { changed: [] };
  const refuse = (message) => ({ changed: [], message });
  const object = map.objects[index];

  switch (tool) {
    case "land":
      if (map.terrain[index] === TERRAIN.land) return none;
      map.terrain[index] = TERRAIN.land;
      return { changed };
    case "water":
      if (map.terrain[index] === TERRAIN.water && !object) return none;
      map.terrain[index] = TERRAIN.water;
      map.objects[index] = null; // roads stay and become bridges
      return { changed };
    case "mountain":
      if (map.terrain[index] === TERRAIN.mountain) return none;
      map.terrain[index] = TERRAIN.mountain;
      map.roads[index] = 0;
      map.objects[index] = null;
      return { changed };
    case "road":
      if (map.terrain[index] === TERRAIN.mountain) return refuse("Roads can't go on mountains.");
      if (map.roads[index] === 1 && (!object || object.kind === "blockade")) return none;
      map.roads[index] = 1;
      if (object?.kind !== "blockade") map.objects[index] = null; // blockades can sit on roads
      return { changed };
    case "erase":
      if (!map.roads[index] && !object) return none;
      map.roads[index] = 0;
      map.objects[index] = null;
      return { changed };
    case "blockade":
      if (map.terrain[index] === TERRAIN.water) return refuse("Blockades can't go on water.");
      if (map.terrain[index] === TERRAIN.mountain) return refuse("Blockades can't go on mountains.");
      if (object?.kind === "blockade") return none;
      map.objects[index] = { kind: "blockade", owner: 0 };
      return { changed };
    default: {
      // Building kinds and "flag".
      if (map.terrain[index] === TERRAIN.water) return refuse("Buildings and flags can't go on water.");
      if (map.terrain[index] === TERRAIN.mountain) return refuse("Buildings and flags can't go on mountains.");
      if (tool === "hq" && owner === 0) return refuse("Pick a player for the HQ.");
      if (object && object.kind === tool && object.owner === owner) return none;
      if (tool === "hq") {
        // One HQ per player: remove the old one.
        map.objects.forEach((other, otherIndex) => {
          if (other?.kind === "hq" && other.owner === owner && otherIndex !== index) {
            map.objects[otherIndex] = null;
            changed.push([otherIndex % map.width, Math.floor(otherIndex / map.width)]);
          }
        });
      }
      map.roads[index] = 0;
      map.objects[index] = { kind: tool, owner };
      return { changed };
    }
  }
}

// ---- Symmetry ----
// Modes: "off", "vertical" (2P, mirror left <-> right), "horizontal" (2P, mirror top <-> bottom),
// "both" (2P, reflect through the centre point), "quad" (4P, mirror both ways). Owner swaps are fixed permutations, so painting in any
// region gives every player the same layout:
//   P1 | P2      (quad)        P1 | P2   (vertical)      P1 / P2 (horizontal)
//   P3 | P4
const OWNER_SWAP = {
  pair: [0, 2, 1],
  quadX: [0, 2, 1, 4, 3],
  quadY: [0, 3, 4, 1, 2],
  quadXY: [0, 4, 3, 2, 1],
};

/** Which symmetry applies for a player count; symmetry only exists for 2 and 4 players. */
export function symmetryMode(players, enabled, axis) {
  if (!enabled) return "off";
  if (players === 2) return axis;
  if (players === 4) return "quad";
  return "off";
}

/** The cells (and owners) a single paint at (x, y) affects under a symmetry mode. */
export function mirrorTargets(map, mode, x, y, owner = 0) {
  const mx = map.width - 1 - x;
  const my = map.height - 1 - y;
  const targets = [{ x, y, owner }];
  if (mode === "vertical") targets.push({ x: mx, y, owner: OWNER_SWAP.pair[owner] });
  else if (mode === "horizontal") targets.push({ x, y: my, owner: OWNER_SWAP.pair[owner] });
  else if (mode === "both") targets.push({ x: mx, y: my, owner: OWNER_SWAP.pair[owner] });
  else if (mode === "quad") {
    targets.push(
      { x: mx, y, owner: OWNER_SWAP.quadX[owner] },
      { x, y: my, owner: OWNER_SWAP.quadY[owner] },
      { x: mx, y: my, owner: OWNER_SWAP.quadXY[owner] },
    );
  }
  // On a centre line the mirror is the same cell; keep only the first (the one actually painted).
  const seen = new Set();
  return targets.filter(({ x: tx, y: ty }) => {
    const key = ty * map.width + tx;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Per-player building counts and HQ presence, for the editor sidebar. */
export function summarize(map) {
  const owners = Array.from({ length: map.players + 1 }, () => ({ buildings: 0, flags: 0, hq: false }));
  for (const object of map.objects) {
    if (!object || object.kind === "blockade") continue;
    const entry = owners[object.owner];
    if (object.kind === "flag") entry.flags += 1;
    else entry.buildings += 1;
    if (object.kind === "hq") entry.hq = true;
  }
  return owners;
}

export function toSaved(map) {
  const objects = [];
  map.objects.forEach((object, index) => {
    if (object) objects.push({ x: index % map.width, y: Math.floor(index / map.width), ...object });
  });
  return {
    name: map.name.trim(),
    width: map.width,
    height: map.height,
    players: map.players,
    terrain: map.terrain.join(""),
    roads: map.roads.join(""),
    objects,
  };
}

export function fromSaved(saved) {
  const map = createMap(saved);
  map.terrain = Array.from(saved.terrain, Number);
  map.roads = Array.from(saved.roads, Number);
  for (const { x, y, kind, owner } of saved.objects) map.objects[y * saved.width + x] = { kind, owner };
  return map;
}
