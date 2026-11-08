// Tile indices into public/sprites/tiny-battle/tilemap_packed.png
// (16px tiles, 18 columns, no spacing). Index = row * 18 + column.

export const SHEET_URL = "/sprites/tiny-battle/tilemap_packed.png";
export const TILE = 16;
export const SHEET_COLUMNS = 18;
export const SHEET_SIZE = { width: 288, height: 176 };

export const GRASS = [0, 1, 2]; // plain, tufts, flowers

// Water is drawn per 8px quarter so any shape (lakes, 1-wide rivers) gets correct shores.
export const WATER = {
  center: 37,
  outer: { nw: 18, ne: 20, sw: 54, se: 56 }, // land on both sides
  edgeH: { n: 19, s: 55 }, // land above / below
  edgeV: { w: 36, e: 38 }, // land left / right
  inner: { nw: 90, ne: 91, se: 92, sw: 93 }, // land only on the diagonal
};

// Road tile by connection mask: N=1, E=2, S=4, W=8.
export const ROADS = [108, 162, 109, 163, 126, 144, 127, 145, 111, 165, 110, 164, 129, 147, 128, 146];
export const BRIDGE = { horizontal: 130, vertical: 166 };

// First tile of each owner's building row: neutral, red, blue, green, orange.
const OWNER_ROW = [8, 62, 44, 26, 80];
const KIND_OFFSET = { city: 0, hq: 1, barracks: 2, factory: 3, airport: 7, tower: 5, silo: 6, port: 4, flag: 8 };

export const KIND_LABELS = {
  hq: "HQ",
  city: "City",
  factory: "Factory",
  airport: "Airport",
  port: "Port",
  barracks: "Barracks",
  tower: "Comm tower",
  silo: "Silo",
  flag: "Flag",
};

export function objectTile(kind, owner) {
  return OWNER_ROW[owner] + KIND_OFFSET[kind];
}

// First unit sprite of each owner's unit row: neutral, red, blue, green, orange.
const UNIT_ROW = [95, 149, 131, 113, 167];

export function unitTile(sprite, owner) {
  return UNIT_ROW[owner] + sprite;
}

// Movement arrow pieces. Directions: N=1, E=2, S=4, W=8.
const ARROW_BODY = { 5: 58, 10: 42, 6: 59, 12: 60, 3: 77, 9: 78 }; // N+S, E+W, E+S, S+W, N+E, N+W
const ARROW_HEAD = { 1: 40, 8: 41, 2: 43, 4: 76 }; // pointing N, W, E, S

function direction(from, to) {
  if (to.x > from.x) return 2;
  if (to.x < from.x) return 8;
  return to.y > from.y ? 4 : 1;
}

/** Arrow tiles for a path of adjacent cells; the start tile (the unit) gets no arrow. */
export function arrowTiles(path) {
  return path.slice(1).map((cell, offset) => {
    const index = offset + 1;
    const previous = path[index - 1];
    const next = path[index + 1];
    const tile = next ? ARROW_BODY[direction(cell, previous) | direction(cell, next)] : ARROW_HEAD[direction(previous, cell)];
    return { x: cell.x, y: cell.y, tile };
  });
}
