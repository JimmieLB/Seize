// Map format shared by the editor (client) and the map API (server).
//
// Saved shape:
// {
//   name: string,
//   width, height: integer tile counts,
//   players: integer (2-4),
//   terrain: string of width*height chars, "0" = land, "1" = water, "2" = mountain (row-major),
//   roads:   string of width*height chars, "0" = none, "1" = road / bridge,
//   objects: [{ x, y, kind, owner }]  owner 0 = neutral, 1..players = player
// }

export const MAP_LIMITS = {
  minSize: 5,
  maxSize: 50,
  minPlayers: 2,
  maxPlayers: 4,
  nameLength: 32,
};

export const BUILDING_KINDS = ["hq", "city", "factory", "airport", "port", "barracks", "tower", "silo"];
// Blockades are obstacles, not buildings: no owner, no income, can sit on roads, destroyed by attacks.
export const OBJECT_KINDS = [...BUILDING_KINDS, "flag", "blockade"];

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function checkRange(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be a whole number between ${min} and ${max}.`);
  }
}

/** Validates a saved map and returns a clean copy. Throws (status 400) on bad data. */
export function validateMap(input) {
  if (!input || typeof input !== "object") fail("Map data is missing.");

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAP_LIMITS.nameLength) {
    fail(`Map name must be between 1 and ${MAP_LIMITS.nameLength} characters.`);
  }

  const { width, height, players } = input;
  checkRange(width, "Width", MAP_LIMITS.minSize, MAP_LIMITS.maxSize);
  checkRange(height, "Height", MAP_LIMITS.minSize, MAP_LIMITS.maxSize);
  checkRange(players, "Player count", MAP_LIMITS.minPlayers, MAP_LIMITS.maxPlayers);

  const cells = width * height;
  const layer = (value, label, allowed) => {
    if (typeof value !== "string" || value.length !== cells || !allowed.test(value)) {
      fail(`${label} data is invalid.`);
    }
    return value;
  };
  const terrain = layer(input.terrain, "Terrain", /^[012]*$/);
  const roads = layer(input.roads, "Road", /^[01]*$/);
  for (let index = 0; index < cells; index += 1) {
    if (terrain[index] === "2" && roads[index] === "1") fail("Roads can't be built on mountains.");
  }

  if (!Array.isArray(input.objects) || input.objects.length > cells) fail("Object data is invalid.");
  const occupied = new Set();
  const hqOwners = new Set();
  const objects = input.objects.map((object) => {
    const { x, y, kind, owner } = object ?? {};
    if (!Number.isInteger(x) || x < 0 || x >= width || !Number.isInteger(y) || y < 0 || y >= height) {
      fail("An object is outside the map.");
    }
    if (!OBJECT_KINDS.includes(kind)) fail("Unknown object type.");
    if (!Number.isInteger(owner) || owner < 0 || owner > players) fail("An object has an invalid owner.");
    const index = y * width + x;
    if (occupied.has(index)) fail("Two objects share a tile.");
    occupied.add(index);
    if (terrain[index] === "1") fail("Buildings, flags and blockades can't be placed on water.");
    if (terrain[index] === "2") fail("Buildings, flags and blockades can't be placed on mountains.");
    if (kind === "blockade") {
      if (owner !== 0) fail("Blockades don't belong to a player.");
    } else if (roads[index] === "1") {
      fail("Buildings and flags can't be placed on roads."); // blockades can sit on roads
    }
    if (kind === "hq") {
      if (owner === 0) fail("Each HQ must belong to a player.");
      if (hqOwners.has(owner)) fail(`Player ${owner} has more than one HQ.`);
      hqOwners.add(owner);
    }
    return { x, y, kind, owner };
  });

  return { name, width, height, players, terrain, roads, objects };
}
