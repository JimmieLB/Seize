// Draws map cells onto a 2D canvas context using the tile sheet.
import { BRIDGE, GRASS, MOUNTAIN, ROADS, SHEET_COLUMNS, SHEET_URL, TILE, WATER, objectTile } from "./tiles.js";

function sheetXY(tile) {
  return [(tile % SHEET_COLUMNS) * TILE, Math.floor(tile / SHEET_COLUMNS) * TILE];
}

export function drawTile(ctx, sheet, tile, dx, dy, size) {
  const [sx, sy] = sheetXY(tile);
  ctx.drawImage(sheet, sx, sy, TILE, TILE, dx, dy, size, size);
}

// Quarter q: 0 = NW, 1 = NE, 2 = SW, 3 = SE.
function drawQuarter(ctx, sheet, tile, q, dx, dy, size) {
  const [sx, sy] = sheetXY(tile);
  const half = TILE / 2;
  const qx = q & 1;
  const qy = q >> 1;
  ctx.drawImage(sheet, sx + qx * half, sy + qy * half, half, half, dx + qx * (size / 2), dy + qy * (size / 2), size / 2, size / 2);
}

function grassTile(x, y) {
  const hash = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
  const roll = hash % 100;
  return roll < 6 ? GRASS[2] : roll < 26 ? GRASS[1] : GRASS[0];
}

const QUARTERS = [
  { dx: -1, dy: -1, corner: "nw", v: "n", h: "w" },
  { dx: 1, dy: -1, corner: "ne", v: "n", h: "e" },
  { dx: -1, dy: 1, corner: "sw", v: "s", h: "w" },
  { dx: 1, dy: 1, corner: "se", v: "s", h: "e" },
];

function waterQuarterTile(isWater, x, y, { dx, dy, corner, v, h }) {
  const vertical = isWater(x, y + dy);
  const horizontal = isWater(x + dx, y);
  if (!vertical && !horizontal) return WATER.outer[corner];
  if (!vertical) return WATER.edgeH[v];
  if (!horizontal) return WATER.edgeV[h];
  if (!isWater(x + dx, y + dy)) return WATER.inner[corner];
  return WATER.center;
}

/**
 * Draws one cell. Cells outside the map are open ocean: off-map counts as water everywhere, so
 * land on the map's edge gets a beach drawn on the ocean tile next to it, just like a lake shore.
 * `margin` (in tiles) shifts drawing right/down to leave room for that ring of ocean.
 */
export function drawCell(ctx, sheet, map, x, y, { scale = 1, grid = false, margin = 0 } = {}) {
  const size = TILE * scale;
  const px = (x + margin) * size;
  const py = (y + margin) * size;
  const index = y * map.width + x;
  const inside = (cx, cy) => cx >= 0 && cy >= 0 && cx < map.width && cy < map.height;
  const isWater = (cx, cy) => !inside(cx, cy) || map.terrain[cy * map.width + cx] === 1;
  const hasRoad = (cx, cy) => inside(cx, cy) && map.roads[cy * map.width + cx] === 1;

  if (!inside(x, y)) {
    QUARTERS.forEach((quarter, q) => drawQuarter(ctx, sheet, waterQuarterTile(isWater, x, y, quarter), q, px, py, size));
    return;
  }

  const water = map.terrain[index] === 1;
  if (water) {
    QUARTERS.forEach((quarter, q) => drawQuarter(ctx, sheet, waterQuarterTile(isWater, x, y, quarter), q, px, py, size));
  } else {
    drawTile(ctx, sheet, grassTile(x, y), px, py, size);
    if (map.terrain[index] === 2) drawTile(ctx, sheet, MOUNTAIN, px, py, size);
  }

  if (map.roads[index]) {
    const mask = (hasRoad(x, y - 1) ? 1 : 0) | (hasRoad(x + 1, y) ? 2 : 0) | (hasRoad(x, y + 1) ? 4 : 0) | (hasRoad(x - 1, y) ? 8 : 0);
    let tile = ROADS[mask];
    if (water) tile = mask & 0b0101 && !(mask & 0b1010) ? BRIDGE.vertical : BRIDGE.horizontal;
    drawTile(ctx, sheet, tile, px, py, size);
  }

  const object = map.objects[index];
  if (object) drawTile(ctx, sheet, objectTile(object.kind, object.owner), px, py, size);

  if (grid) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(px, py, size, 1);
    ctx.fillRect(px, py, 1, size);
  }
}

/** Draws the whole map, plus `options.margin` rings of ocean around it. */
export function drawMap(ctx, sheet, map, options = {}) {
  const margin = options.margin ?? 0;
  for (let y = -margin; y < map.height + margin; y += 1) {
    for (let x = -margin; x < map.width + margin; x += 1) drawCell(ctx, sheet, map, x, y, options);
  }
}

export function loadSheet(url) {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => image);
}

let sheetPromise = null;
/** Loads the tile sheet once and shares it. */
export function getSheet() {
  sheetPromise ??= loadSheet(SHEET_URL).catch((error) => {
    sheetPromise = null;
    throw error;
  });
  return sheetPromise;
}
