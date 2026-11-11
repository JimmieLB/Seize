// Game rules, shared by the server (authoritative) and the client (UI hints).
// Maps here are in the saved format: terrain/roads are strings, objects is a list of { x, y, kind, owner }.
//
// Game state:
// {
//   turn: 1,                 // increases each time play returns to the first seat
//   active: 0,               // index into seats of the player whose turn it is
//   income: { kind: cash per day } | null,      // building income, copied from the Buildings tab at start
//   seats: [{ playerId, name, owner, funds, defeated }],   // owner = map colour slot (1-4); defeated = lost their HQ
//   winner: owner number of the last player standing (game over), if any
//   undoSeat: seat index allowed to undo the latest change (set by the server), or null
//   blockades: [{ x, y, hp }],   // obstacles from the map; removed when their hp reaches 0
//   properties: [{ x, y, kind, owner, capture }], // buildings + flags; owner changes when captured
//                                                 // capture: null | { unitId, progress (0-100) }
//   units: [{ id, unitId, owner, x, y, hp, moved, acted, carriedBy }],
//                            // hp: health % (100 = full); moved: has moved this turn;
//                            // acted: captured / attacked / waited / boarded — done for the turn;
//                            // carriedBy: id of the transport carrying it (then it is off the map)
//   nextUnitId: 1,
//   lastAction: null | { version, text },   // latest attack/capture, shown to every player
//   version: 1,              // bumped on every change so clients can skip redraws
// }

export const PRODUCTION = { factory: "land", airport: "air", port: "sea" };
export const INCOME_PER_BUILDING = 1000;
export const MAX_HP = 100;
export const CAPTURE_TARGET = 100;

export const hpOf = (unit) => unit.hp ?? MAX_HP;
const defOf = (unitDefs, unit) => unitDefs.find((def) => def.id === unit.unitId);
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function propertyAt(game, x, y) {
  return game.properties.find((property) => property.x === x && property.y === y) ?? null;
}

/** A building (not a flag) at (x, y), with its current owner. */
export function buildingAt(game, x, y) {
  const property = propertyAt(game, x, y);
  return property && property.kind !== "flag" ? property : null;
}

/** The unit standing on (x, y). Units being carried by a transport aren't on the map. */
export function unitAt(game, x, y) {
  return game.units.find((unit) => unit.x === x && unit.y === y && !unit.carriedBy) ?? null;
}

/** Every unit standing on (x, y) — two at most, and only on a bridge (see below). */
export function unitsAt(game, x, y) {
  return game.units.filter((unit) => unit.x === x && unit.y === y && !unit.carriedBy);
}

// ---- Sharing a tile ----
// A bridge is the only place two units can be: one boat underneath and one land or air unit on
// top. Units on different levels of a bridge don't block each other (passing or stopping);
// everywhere else, every unit on a tile counts.

export function layerOf(def) {
  return def?.type === "sea" ? "sea" : "surface";
}

export function isBridge(map, x, y) {
  if (!map || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const index = y * map.width + x;
  return String(map.terrain[index]) === "1" && String(map.roads[index]) === "1";
}

/** Units on (x, y) that occupy the same space as a unit of type `def`. */
function sameSpace(game, map, unitDefs, def, x, y) {
  const here = unitsAt(game, x, y);
  if (!unitDefs || !isBridge(map, x, y)) return here;
  return here.filter((other) => layerOf(defOf(unitDefs, other)) === layerOf(def));
}

/** Whether an enemy stops `unit` (of type `def`) from passing through (x, y). */
export function blocksPath(game, map, unitDefs, unit, def, x, y) {
  return sameSpace(game, map, unitDefs, def, x, y).some((other) => other.owner !== unit.owner);
}

/** Why `unit` can't end its move on (x, y), or null if it can (boarding a transport counts as allowed). */
export function stopError(game, map, unitDefs, unit, def, x, y) {
  if (blockadeAt(game, x, y)) return "Units can't stop on a blockade.";
  const others = sameSpace(game, map, unitDefs, def, x, y).filter((other) => other !== unit);
  if (others.length === 0 || others.some((other) => canBoard(game, unitDefs, other, unit))) return null;
  return "Units can't stop on another unit.";
}

/** Units being carried by a transport. */
export function cargoOf(game, transport) {
  return game.units.filter((unit) => unit.carriedBy === transport.id);
}

/** Cash a property of this kind pays per day: from the game's income table, else the old defaults. */
export function propertyIncome(game, kind) {
  return game.income?.[kind] ?? (kind === "flag" ? 0 : INCOME_PER_BUILDING);
}

// ---- Building effects (from the Buildings tab notes) ----
//   Barracks:   all your infantry (land units with Captures) get +2 Attack per Barracks you own.
//   Comm tower: all your land vehicles (land units without Captures) get +1 Attack per Comm tower you own.
//   Flag:       +25% to all your income per flag you own (applied to the total, flags' own cash included).
export const BARRACKS_INFANTRY_ATTACK = 2;
export const TOWER_VEHICLE_ATTACK = 1;
export const FLAG_INCOME_BONUS = 0.25;

export function ownedCount(game, owner, kind) {
  return game.properties.filter((property) => property.owner === owner && property.kind === kind).length;
}

export function isInfantry(def) {
  return def.type === "land" && Boolean(def.traits?.includes("captures"));
}

/** Extra Attack a unit of this type gets from its owner's buildings (none for units that can't attack). */
export function attackBonus(game, def, owner) {
  if (def.attack <= 0) return 0;
  let bonus = 0;
  if (isInfantry(def)) bonus += BARRACKS_INFANTRY_ATTACK * ownedCount(game, owner, "barracks");
  if (isVehicle(def)) bonus += TOWER_VEHICLE_ATTACK * ownedCount(game, owner, "tower");
  return bonus;
}

/** Cash a player earns per day: every property's cash per day, then +25% per flag owned. */
export function incomeFor(game, owner) {
  const base = game.properties
    .filter((property) => property.owner === owner)
    .reduce((total, property) => total + propertyIncome(game, property.kind), 0);
  return Math.round(base * (1 + FLAG_INCOME_BONUS * ownedCount(game, owner, "flag")));
}

export function initialProperties(map) {
  return map.objects
    .filter((object) => object.kind !== "blockade")
    .map(({ x, y, kind, owner }) => ({ x, y, kind, owner, capture: null }));
}

// ---- Blockades ----
// Placed in the map editor. Land and sea units can't move through or onto them; air units can fly
// over but not stop on them. Any unit that can attack can hit one in range: they have
// BLOCKADE_HP health, no defense and never hit back. At 0 health they're removed.
export const BLOCKADE_HP = 10;
export const BLOCKADE_DEF = { id: "blockade", name: "Blockade", type: "structure", attack: 0, defense: 0, traits: [] };

export function initialBlockades(map) {
  return map.objects.filter((object) => object.kind === "blockade").map(({ x, y }) => ({ x, y, hp: BLOCKADE_HP }));
}

export function blockadeAt(game, x, y) {
  return game.blockades?.find((blockade) => blockade.x === x && blockade.y === y) ?? null;
}

/** `income` is a { kind: cash per day } table (from the Buildings tab), copied into the game. */
export function createGame(map, players, income = null) {
  const seats = players.map((player, index) => ({ playerId: player.id, name: player.name, owner: index + 1, funds: 0 }));
  const game = {
    turn: 1,
    active: 0,
    income,
    seats,
    properties: initialProperties(map),
    blockades: initialBlockades(map),
    units: [],
    nextUnitId: 1,
    lastAction: null,
    version: 1,
  };
  seats[0].funds += incomeFor(game, seats[0].owner);
  return game;
}

/** Common checks for acting with one of your units; returns [error, unit, def]. */
function ownUnit(game, unitDefs, seatIndex, unitId) {
  if (game.winner) return ["The game is over."];
  if (seatIndex !== game.active) return ["It's not your turn."];
  const unit = game.units.find((current) => current.id === unitId);
  if (!unit || unit.owner !== game.seats[seatIndex].owner) return ["That isn't your unit."];
  if (unit.carriedBy) return ["That unit is inside a transport."];
  return [null, unit, defOf(unitDefs, unit)];
}

function seatName(game, owner) {
  return game.seats.find((seat) => seat.owner === owner)?.name ?? "Neutral";
}

/** Removes a unit, along with anything it was carrying. */
function removeUnit(game, unit) {
  game.units = game.units.filter((current) => current !== unit && current.carriedBy !== unit.id);
  for (const property of game.properties) if (property.capture?.unitId === unit.id) property.capture = null;
}

// ---- Buying ----

/** Returns why a purchase isn't allowed, or null if it is. */
export function buyError(game, unitDefs, seatIndex, x, y, unitId) {
  if (game.winner) return "The game is over.";
  if (seatIndex !== game.active) return "It's not your turn.";
  const seat = game.seats[seatIndex];
  const building = buildingAt(game, x, y);
  if (!building || !PRODUCTION[building.kind]) return "Units can only be bought at a factory, airport or port.";
  if (building.owner !== seat.owner) return "You don't own that building.";
  if (unitsAt(game, x, y).length > 0) return "That building already has a unit on it.";
  const unit = unitDefs.find((def) => def.id === unitId);
  if (!unit) return "Unknown unit.";
  if (unit.type !== PRODUCTION[building.kind]) return `${unit.name} can't be built there.`;
  if (seat.funds < unit.price) return "Not enough funds.";
  return null;
}

export function applyBuy(game, unitDefs, seatIndex, x, y, unitId) {
  const seat = game.seats[seatIndex];
  const unit = unitDefs.find((def) => def.id === unitId);
  seat.funds -= unit.price;
  // New units can't move or act until their owner's next turn.
  game.units.push({ id: game.nextUnitId, unitId, owner: seat.owner, x, y, hp: MAX_HP, moved: true, acted: true });
  game.nextUnitId += 1;
  game.version += 1;
}

// ---- Turns ----

/**
 * Passes the turn to the next seat whose player is still connected, pays them income and
 * readies their units. `isConnected(playerId)` lets the server skip players who left.
 */
export function endTurn(game, isConnected = () => true, unitDefs = []) {
  let next = game.active;
  for (let step = 0; step < game.seats.length; step += 1) {
    next = (next + 1) % game.seats.length;
    if (next === 0) game.turn += 1;
    const seat = game.seats[next];
    if (!seat.defeated && isConnected(seat.playerId)) break; // skip defeated players and players who left
  }
  game.active = next;
  const { owner } = game.seats[next];
  game.seats[next].funds += incomeFor(game, owner);
  for (const unit of game.units) {
    if (unit.owner === owner) {
      unit.moved = false;
      unit.acted = false;
    }
  }
  resupply(game, unitDefs, owner);
  game.version += 1;
}

// ---- Resupply ----
// At the start of its owner's turn, each Resupply unit repairs adjacent friendly units by 10% health.

export const RESUPPLY_AMOUNT = 10;

function resupply(game, unitDefs, owner) {
  const suppliers = game.units.filter(
    (unit) => unit.owner === owner && !unit.carriedBy && defOf(unitDefs, unit)?.traits?.includes("resupply"),
  );
  for (const supplier of suppliers) {
    for (const unit of game.units) {
      if (unit.owner === owner && !unit.carriedBy && distance(unit, supplier) === 1) {
        unit.hp = Math.min(MAX_HP, hpOf(unit) + RESUPPLY_AMOUNT);
      }
    }
  }
}

// ---- Transports ----
// Transport: carries 1 infantry or mech (land units with the Captures trait).
// Heavy-Transport: carries any 2 land units.
// A unit boards by ending its move on a friendly transport with room (this ends its turn).
// Cargo moves with the transport and is destroyed with it. The transport drops cargo onto an
// adjacent empty tile the cargo could move onto; dropped units can't act that turn, and the
// transport can't move after dropping (but may drop more cargo).

export function transportCapacity(def) {
  if (def?.traits?.includes("heavyTransport")) return 2;
  if (def?.traits?.includes("transport")) return 1;
  return 0;
}

function canCarryType(transportDef, cargoDef) {
  if (cargoDef.type !== "land") return false;
  if (transportDef.traits?.includes("heavyTransport")) return true;
  return Boolean(transportDef.traits?.includes("transport") && cargoDef.traits?.includes("captures"));
}

/** Whether `unit` can board `transport` right now. */
export function canBoard(game, unitDefs, transport, unit) {
  if (!transport || transport === unit || transport.owner !== unit.owner || transport.carriedBy) return false;
  if (cargoOf(game, unit).length > 0) return false; // transports can't be loaded into each other
  const transportDef = defOf(unitDefs, transport);
  if (cargoOf(game, transport).length >= transportCapacity(transportDef)) return false;
  return canCarryType(transportDef, defOf(unitDefs, unit));
}

// ---- Movement ----
// Costs per tile entered:
//   air:  everything 1
//   sea:  water (including under bridges) and ports 1, everything else impassable
//   land: open water impassable; roads, bridges and buildings 1; grass 1 (2 with the Treads trait);
//         mountains 2 for infantry/mech (Captures trait), impassable for other land units
//   mountains: air 1, sea impassable
// Units can pass through friendly units but not enemies, and can't stop on any other unit.

const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const buildingGrids = new WeakMap();

function buildingGrid(map) {
  let grid = buildingGrids.get(map);
  if (!grid) {
    grid = new Array(map.width * map.height).fill(null);
    for (const object of map.objects) if (object.kind !== "flag") grid[object.y * map.width + object.x] = object.kind;
    buildingGrids.set(map, grid);
  }
  return grid;
}

export function moveCost(map, def, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return Infinity;
  const index = y * map.width + x;
  const water = map.terrain[index] === "1";
  const road = map.roads[index] === "1";
  const building = buildingGrid(map)[index];
  const mountain = map.terrain[index] === "2";
  if (def.type === "air") return 1;
  if (def.type === "sea") return water || building === "port" ? 1 : Infinity;
  if (mountain) return def.traits?.includes("captures") ? 2 : Infinity;
  if (water && !road) return Infinity;
  if (road || building) return 1;
  return def.traits?.includes("treads") ? 2 : 1;
}

/** Movement points: Speed, +1 with Speedy while at full health. */
export function unitSpeed(def, unit) {
  const speedy = def.traits?.includes("speedy") && (!unit || hpOf(unit) >= MAX_HP);
  return def.speed + (speedy ? 1 : 0);
}

export function canMove(unit) {
  return !unit.moved && !unit.acted;
}

/**
 * Entering a tile the unit can't normally enter (e.g. a Lander out on the water) costs 1 when
 * it holds a friendly transport the unit can board — but only as the last step of a move.
 */
function boardingCost(game, unitDefs, unit, x, y) {
  if (!game || !unitDefs || !unit) return Infinity;
  return unitsAt(game, x, y).some((other) => canBoard(game, unitDefs, other, unit)) ? 1 : Infinity;
}

/**
 * Every tile the unit can reach this turn: Map(index -> { cost, prev }) with prev = previous index
 * on the cheapest path. Pass `unitDefs` to include transports it can board.
 */
export function reachable(game, map, def, unit, unitDefs = null) {
  const speed = unitSpeed(def, unit);
  const start = unit.y * map.width + unit.x;
  const best = new Map([[start, { cost: 0, prev: -1 }]]);
  const queue = [[0, start]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [cost, index] = queue.shift();
    if (cost > best.get(index).cost) continue;
    const x = index % map.width;
    const y = Math.floor(index / map.width);
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      let step = moveCost(map, def, nx, ny);
      const boardOnly = step === Infinity;
      if (boardOnly) step = boardingCost(game, unitDefs, unit, nx, ny);
      const next = cost + step;
      if (next > speed) continue;
      if (blocksPath(game, map, unitDefs, unit, def, nx, ny)) continue;
      if (def.type !== "air" && blockadeAt(game, nx, ny)) continue;
      const nextIndex = ny * map.width + nx;
      if (!best.has(nextIndex) || next < best.get(nextIndex).cost) {
        best.set(nextIndex, { cost: next, prev: index });
        if (!boardOnly) queue.push([next, nextIndex]); // can board there, but not travel on from it
      }
    }
  }
  return best;
}

/** Cheapest path (list of { x, y }) from the reachable() start to `index`. */
export function pathTo(reach, map, index) {
  const path = [];
  for (let current = index; current !== -1; current = reach.get(current).prev) {
    path.unshift({ x: current % map.width, y: Math.floor(current / map.width) });
  }
  return path;
}

/** Total cost of a path's steps (the starting tile is free). Pass game/unitDefs/unit to allow boarding at the end. */
export function pathCost(map, def, path, game = null, unitDefs = null, unit = null) {
  return path.slice(1).reduce((total, step, index) => {
    let cost = moveCost(map, def, step.x, step.y);
    if (cost === Infinity && index === path.length - 2) cost = boardingCost(game, unitDefs, unit, step.x, step.y);
    return total + cost;
  }, 0);
}

/** Returns why a move isn't allowed, or null if it is. `path` starts at the unit's tile. */
export function moveError(game, map, unitDefs, seatIndex, unitId, path) {
  const [error, unit, def] = ownUnit(game, unitDefs, seatIndex, unitId);
  if (error) return error;
  if (!canMove(unit)) return "That unit can't move again until your next turn.";
  if (!Array.isArray(path) || path.length < 2 || path.length > map.width * map.height) return "Invalid path.";
  for (const [index, step] of path.entries()) {
    if (!Number.isInteger(step?.x) || !Number.isInteger(step?.y)) return "Invalid path.";
    if (index === 0) {
      if (step.x !== unit.x || step.y !== unit.y) return "The path must start at the unit.";
      continue;
    }
    const previous = path[index - 1];
    if (distance(step, previous) !== 1) return "Paths must move one tile at a time.";
    const boarding = index === path.length - 1 && boardingCost(game, unitDefs, unit, step.x, step.y) !== Infinity;
    if (moveCost(map, def, step.x, step.y) === Infinity && !boarding) return `${def.name} can't move there.`;
    if (blocksPath(game, map, unitDefs, unit, def, step.x, step.y)) return "Enemy units block the way.";
    if (def.type !== "air" && blockadeAt(game, step.x, step.y)) return "A blockade is in the way.";
  }
  if (pathCost(map, def, path, game, unitDefs, unit) > unitSpeed(def, unit)) return "That's too far.";
  const end = path[path.length - 1];
  return stopError(game, map, unitDefs, unit, def, end.x, end.y);
}

/**
 * Moves a unit along a validated path. Ending on a friendly transport (on the same level) boards it.
 * Pass unitDefs and map so a unit can stop on a bridge above or below another unit.
 */
export function applyMove(game, unitId, path, unitDefs = null, map = null) {
  const unit = game.units.find((current) => current.id === unitId);
  // Leaving a tile abandons any capture in progress there.
  const left = propertyAt(game, unit.x, unit.y);
  if (left?.capture?.unitId === unit.id) left.capture = null;
  const end = path[path.length - 1];
  const transport = unitDefs
    ? sameSpace(game, map, unitDefs, defOf(unitDefs, unit), end.x, end.y).find(
      (other) => other !== unit && canBoard(game, unitDefs, other, unit),
    )
    : unitAt(game, end.x, end.y);
  unit.x = end.x;
  unit.y = end.y;
  unit.moved = true;
  for (const cargo of cargoOf(game, unit)) {
    cargo.x = end.x;
    cargo.y = end.y;
  }
  if (transport && transport !== unit) {
    unit.carriedBy = transport.id;
    unit.acted = true;
  }
  game.version += 1;
}

/** Free tiles next to the transport where `cargo` could be dropped. */
export function dropTiles(game, map, unitDefs, transport, cargo) {
  const cargoDef = defOf(unitDefs, cargo);
  return DIRECTIONS.map(([dx, dy]) => ({ x: transport.x + dx, y: transport.y + dy })).filter(
    (tile) =>
      moveCost(map, cargoDef, tile.x, tile.y) !== Infinity &&
      sameSpace(game, map, unitDefs, cargoDef, tile.x, tile.y).length === 0 &&
      !blockadeAt(game, tile.x, tile.y),
  );
}

export function dropError(game, map, unitDefs, seatIndex, unitId, cargoId, x, y) {
  const [error, transport] = ownUnit(game, unitDefs, seatIndex, unitId);
  if (error) return error;
  if (transport.acted) return "That unit has already acted this turn.";
  const cargo = game.units.find((current) => current.id === cargoId);
  if (!cargo || cargo.carriedBy !== transport.id) return "That unit isn't in this transport.";
  if (!dropTiles(game, map, unitDefs, transport, cargo).some((tile) => tile.x === x && tile.y === y)) {
    return "Units can only be dropped onto a free tile next to the transport.";
  }
  return null;
}

export function applyDrop(game, unitId, cargoId, x, y) {
  const transport = game.units.find((current) => current.id === unitId);
  const cargo = game.units.find((current) => current.id === cargoId);
  cargo.carriedBy = null;
  cargo.x = x;
  cargo.y = y;
  cargo.moved = true;
  cargo.acted = true;
  transport.moved = true;
  game.version += 1;
}

// ---- Combat ----
// Damage (in health %) = (Attack + building bonus) × 15 × (attacker health / 100) × trait multipliers × 10 / (10 + 2 × Defense),
// minus 10 if the defender is Armored; rounded, never below 0.
//   Anti-Air: ×2 against air units.  Anti-Armor: ×1.5 against land vehicles (land units without Captures).
// A defender that survives hits back at the attacker with its remaining health, if it can attack
// and the attacker is adjacent (Ranged units can't hit back).

export function attackRange(def) {
  return def.traits?.includes("ranged") ? { min: 2, max: 3 } : { min: 1, max: 1 };
}

function isVehicle(def) {
  return def.type === "land" && !def.traits?.includes("captures");
}

/** `bonus` is extra Attack from the attacker's buildings (see attackBonus). */
export function damage(attackerDef, attackerHp, defenderDef, bonus = 0) {
  let multiplier = 1;
  if (attackerDef.traits?.includes("antiAir") && defenderDef.type === "air") multiplier *= 2;
  if (attackerDef.traits?.includes("antiArmor") && isVehicle(defenderDef)) multiplier *= 1.5;
  const attack = attackerDef.attack + bonus;
  let value = attack * 15 * (attackerHp / MAX_HP) * multiplier * (10 / (10 + 2 * defenderDef.defense));
  if (defenderDef.traits?.includes("armored")) value -= 10;
  return Math.max(0, Math.round(value));
}

function canCounter(attacker, defender, defenderDef) {
  return defenderDef.attack > 0 && !defenderDef.traits?.includes("ranged") && distance(attacker, defender) === 1;
}

/**
 * What `unit` could hit on (x, y): { kind: "unit", unit } | { kind: "blockade", blockade } | null.
 * A bridge can hold two enemies (boat + land unit): `targetId` picks one, otherwise the first.
 */
function targetAt(game, unit, x, y, targetId = null) {
  const enemies = unitsAt(game, x, y).filter((other) => other.owner !== unit.owner);
  const other = targetId == null ? enemies[0] : enemies.find((enemy) => enemy.id === targetId);
  if (other) return { kind: "unit", unit: other, x, y };
  if (targetId != null) return null;
  const blockade = blockadeAt(game, x, y);
  if (blockade) return { kind: "blockade", blockade, x, y };
  return null;
}

/** Returns why `unitId` can't attack the tile (x, y) (or unit `targetId` on it), or null if it can. */
export function attackError(game, unitDefs, seatIndex, unitId, x, y, targetId = null) {
  const [error, unit, def] = ownUnit(game, unitDefs, seatIndex, unitId);
  if (error) return error;
  if (unit.acted) return "That unit has already acted this turn.";
  if (def.attack <= 0) return `${def.name} can't attack.`;
  const target = Number.isInteger(x) && Number.isInteger(y) ? targetAt(game, unit, x, y, targetId) : null;
  if (!target) return "Pick an enemy unit or a blockade to attack.";
  const range = attackRange(def);
  if (range.min > 1 && unit.moved) return "Ranged units can't move and attack in the same turn.";
  const gap = distance(unit, target);
  if (gap < range.min || gap > range.max) return "That target is out of range.";
  return null;
}

/** Everything this unit could attack right now: [{ x, y, kind, unit?, blockade? }] (one per enemy unit/blockade). */
export function attackTargets(game, unitDefs, seatIndex, unit) {
  const enemies = game.units.filter((other) => other.owner !== unit.owner && !other.carriedBy);
  const blockades = game.blockades ?? [];
  return [
    ...enemies
      .filter((enemy) => !attackError(game, unitDefs, seatIndex, unit.id, enemy.x, enemy.y, enemy.id))
      .map((enemy) => targetAt(game, unit, enemy.x, enemy.y, enemy.id)),
    ...blockades
      .filter((blockade) => !attackError(game, unitDefs, seatIndex, unit.id, blockade.x, blockade.y))
      .map((blockade) => ({ kind: "blockade", blockade, x: blockade.x, y: blockade.y })),
  ];
}

/** Predicted damage both ways for attacking (x, y) (or unit `targetId` there), for UI previews. */
export function previewAttack(game, unitDefs, unit, x, y, targetId = null) {
  const target = targetAt(game, unit, x, y, targetId);
  const attackerDef = defOf(unitDefs, unit);
  const bonus = attackBonus(game, attackerDef, unit.owner);
  if (target.kind === "blockade") {
    return { dealt: Math.min(damage(attackerDef, hpOf(unit), BLOCKADE_DEF, bonus), target.blockade.hp), counter: 0 };
  }
  const targetDef = defOf(unitDefs, target.unit);
  const dealt = damage(attackerDef, hpOf(unit), targetDef, bonus);
  const remaining = hpOf(target.unit) - dealt;
  const counter = remaining > 0 && canCounter(unit, target.unit, targetDef)
    ? damage(targetDef, remaining, attackerDef, attackBonus(game, targetDef, target.unit.owner))
    : 0;
  return { dealt: Math.min(dealt, hpOf(target.unit)), counter: Math.min(counter, hpOf(unit)) };
}

export function applyAttack(game, unitDefs, unitId, x, y, targetId = null) {
  const attacker = game.units.find((current) => current.id === unitId);
  const attackerDef = defOf(unitDefs, attacker);
  const bonus = attackBonus(game, attackerDef, attacker.owner);
  const target = targetAt(game, attacker, x, y, targetId);
  const who = `${seatName(game, attacker.owner)}'s ${attackerDef.name}`;
  let text;
  if (target.kind === "blockade") {
    const { blockade } = target;
    const dealt = Math.min(damage(attackerDef, hpOf(attacker), BLOCKADE_DEF, bonus), blockade.hp);
    blockade.hp -= dealt;
    if (blockade.hp <= 0) {
      game.blockades = game.blockades.filter((current) => current !== blockade);
      text = `${who} broke a blockade.`;
    } else {
      text = `${who} hit a blockade for ${dealt} (${blockade.hp}/${BLOCKADE_HP} left).`;
    }
  } else {
    const defender = target.unit;
    const targetDef = defOf(unitDefs, defender);
    const dealt = Math.min(damage(attackerDef, hpOf(attacker), targetDef, bonus), hpOf(defender));
    defender.hp = hpOf(defender) - dealt;
    const parts = [`${who} hit ${seatName(game, defender.owner)}'s ${targetDef.name} for ${dealt}%`];
    if (defender.hp <= 0) {
      removeUnit(game, defender);
      parts.push(`destroying it`);
    } else if (canCounter(attacker, defender, targetDef)) {
      const counter = Math.min(damage(targetDef, defender.hp, attackerDef, attackBonus(game, targetDef, defender.owner)), hpOf(attacker));
      attacker.hp = hpOf(attacker) - counter;
      parts.push(`and took ${counter}% back`);
      if (attacker.hp <= 0) {
        removeUnit(game, attacker);
        parts.push(`(destroyed)`);
      }
    }
    text = `${parts.join(" ")}.`;
  }
  attacker.acted = true;
  game.version += 1;
  game.lastAction = { version: game.version, text };
}

// ---- Capturing ----
// A unit with the Captures trait standing on a building or flag it doesn't own adds
// (its health % × 0.5) to the capture progress each time it captures. At 100% the property
// becomes its owner's. Progress resets if the capturing unit leaves or is destroyed.

export function captureGain(unit) {
  return Math.round(hpOf(unit) * 0.5);
}

export function captureError(game, unitDefs, seatIndex, unitId) {
  const [error, unit, def] = ownUnit(game, unitDefs, seatIndex, unitId);
  if (error) return error;
  if (unit.acted) return "That unit has already acted this turn.";
  if (!def.traits?.includes("captures")) return `${def.name} can't capture.`;
  const property = propertyAt(game, unit.x, unit.y);
  if (!property) return "Stand on a building or flag to capture it.";
  if (property.owner === unit.owner) return "You already own this.";
  return null;
}

/** Current capture progress for this unit on its tile (0 if it hasn't started). */
export function captureProgress(game, unit) {
  const capture = propertyAt(game, unit.x, unit.y)?.capture;
  return capture?.unitId === unit.id ? capture.progress : 0;
}

// ---- Defeat and victory ----
// Losing your HQ defeats you: your units are removed, your buildings and flags go to whoever
// captured it, and your turns are skipped. When only one player is left, they win
// (game.winner = their owner number) and the game is over.

function defeat(game, loser, conqueror) {
  const seat = game.seats.find((current) => current.owner === loser);
  if (seat) seat.defeated = true;
  for (const unit of game.units.filter((current) => current.owner === loser)) removeUnit(game, unit);
  for (const property of game.properties) {
    if (property.owner === loser) {
      property.owner = conqueror;
      property.capture = null;
    }
  }
  const remaining = game.seats.filter((current) => !current.defeated);
  if (remaining.length === 1) game.winner = remaining[0].owner;
}

export function isGameOver(game) {
  return Boolean(game.winner);
}

export function applyCapture(game, unitDefs, unitId) {
  const unit = game.units.find((current) => current.id === unitId);
  const property = propertyAt(game, unit.x, unit.y);
  const progress = Math.min(CAPTURE_TARGET, captureProgress(game, unit) + captureGain(unit));
  const label = property.kind === "hq" ? "HQ" : property.kind;
  const who = seatName(game, unit.owner);
  if (progress >= CAPTURE_TARGET) {
    const previousOwner = property.owner;
    property.owner = unit.owner;
    property.capture = null;
    game.lastAction = { text: `${who} captured a ${label}!` };
    if (property.kind === "hq" && previousOwner > 0) {
      const loser = seatName(game, previousOwner);
      defeat(game, previousOwner, unit.owner);
      game.lastAction.text = game.winner
        ? `${who} captured ${loser}'s HQ and wins the game!`
        : `${who} captured ${loser}'s HQ! ${loser} is defeated.`;
    }
  } else {
    property.capture = { unitId: unit.id, progress };
    game.lastAction = { text: `${who} is capturing a ${label} (${progress}%).` };
  }
  unit.acted = true;
  game.version += 1;
  game.lastAction.version = game.version;
}

// ---- Resigning ----
// A player can give up at any time (not just on their turn). They are defeated like losing their
// HQ, except their buildings and flags go neutral. If it was their turn, play moves on.

export function resignError(game, seatIndex) {
  const seat = game.seats[seatIndex];
  if (!seat) return "You aren't playing in this game.";
  if (game.winner) return "The game is over.";
  if (seat.defeated) return "You're already out of this game.";
  return null;
}

export function applyResign(game, seatIndex, isConnected = () => true, unitDefs = []) {
  const seat = game.seats[seatIndex];
  defeat(game, seat.owner, 0);
  seat.resigned = true;
  game.version += 1;
  const remaining = game.seats.filter((current) => !current.defeated);
  game.lastAction = {
    version: game.version,
    text: game.winner ? `${seat.name} resigned. ${remaining[0].name} wins the game!` : `${seat.name} resigned.`,
  };
  if (!game.winner && game.active === seatIndex) {
    const text = game.lastAction.text;
    endTurn(game, isConnected, unitDefs);
    game.lastAction = { version: game.version, text };
  }
}

// ---- Waiting ----

export function waitError(game, unitDefs, seatIndex, unitId) {
  const [error, unit] = ownUnit(game, unitDefs, seatIndex, unitId);
  if (error) return error;
  if (unit.acted) return "That unit has already acted this turn.";
  return null;
}

export function applyWait(game, unitId) {
  const unit = game.units.find((current) => current.id === unitId);
  unit.acted = true;
  game.version += 1;
}

/** Fills in fields added after a game was saved (older rooms.json data). */
export function upgradeGame(game, map) {
  game.properties ??= initialProperties(map);
  game.blockades ??= initialBlockades(map);
  game.lastAction ??= null;
  for (const unit of game.units) {
    unit.hp ??= MAX_HP;
    unit.acted ??= Boolean(unit.moved);
  }
}
