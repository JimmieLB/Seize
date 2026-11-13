// MetaFinder adapter for Seize: plays the real rules in shared/gameRules.js (no port to keep in sync).
//
// A turn is split into small decisions so the search sees tens of options, not thousands.
// Actions are strings:
//
//   idle → "select:<unitId>" | "buy:<x>:<y>:<unitType>" | "end"
//   move → "hold" | "move:<x>:<y>"                                  (the selected unit)
//   act  → "attack:<targetId>" | "blockade:<x>:<y>" | "capture" | "drop:<cargoId>:<x>:<y>" | "wait"
//
// After acting (or boarding a transport, or dying in a counter-attack) play returns to `idle`.
// Moving and acting are always done together, which the real game allows but doesn't force.
// When "wait" is the only thing a unit can do after moving, it waits automatically.
//
// Config (metafinder.json "config", or the MetaFinder UI):
//   map              map name or id from server/seed/maps.json (or examples/maps/), or a map object
//   max_turns        days before the game is scored with heuristicValue() (default 30)
//   move_candidates  destinations offered per move besides captures/attacks/boarding (default 8;
//                    0 = every reachable tile)
//   units            stat overrides, e.g. {"tank": {"price": 8000, "attack": 7}}
//   income           cash-per-day overrides, e.g. {"flag": 1000}
//   data_dir         where units/buildings/maps come from (default "server/seed")

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_HP, PRODUCTION, applyAttack, applyBuy, applyCapture, applyDrop, applyMove, applyWait, attackBonus,
  attackTargets, canBoard, captureError, cargoOf, createGame, damage, dropTiles, endTurn, incomeFor, isBridge,
  layerOf, moveCost, previewAttack, propertyAt, reachable, stopError, unitsAt,
} from "../shared/gameRules.js";
import { withDefaults as unitsWithDefaults } from "../shared/unitFormat.js";
import { incomeTable, withDefaults as buildingsWithDefaults } from "../shared/buildingFormat.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = path.join(REPO_ROOT, "server", "seed");

// ---------------------------------------------------------------------------- data loading
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function dataDir(config) {
  const d = config.data_dir || "server/seed";
  return path.isAbsolute(d) ? d : path.join(REPO_ROOT, d);
}

function dataFile(config, name) {
  const file = path.join(dataDir(config), name);
  return fs.existsSync(file) ? file : path.join(SEED_DIR, name);
}

function allMaps(config) {
  const maps = [];
  for (const dir of new Set([dataDir(config), SEED_DIR])) {
    const file = path.join(dir, "maps.json");
    if (fs.existsSync(file)) maps.push(...readJson(file));
  }
  const examples = path.join(REPO_ROOT, "examples", "maps");
  if (fs.existsSync(examples)) {
    for (const f of fs.readdirSync(examples).filter((f) => f.endsWith(".json")).sort()) maps.push(readJson(path.join(examples, f)));
  }
  return maps;
}

function loadMap(config) {
  const m = config.map;
  if (m && typeof m === "object") return m;
  const maps = allMaps(config);
  if (!maps.length) throw new Error("No maps found (expected server/seed/maps.json)");
  if (m == null) return maps[0];
  const key = String(m).trim().toLowerCase();
  const found = maps.find((c) => [String(c.name ?? "").trim().toLowerCase(), String(c.id ?? "").toLowerCase()].includes(key));
  if (!found) throw new Error(`Unknown map ${JSON.stringify(m)}. Available: ${[...new Set(maps.map((c) => c.name))].sort().join(", ")}`);
  return found;
}

/** Unit definitions, like the server's withDefaults(); `units` in config overrides stats. */
function loadUnits(config) {
  const overrides = config.units ?? {};
  return unitsWithDefaults(readJson(dataFile(config, "units.json"))).map((u) => ({ ...u, ...overrides[u.id] }));
}

/** { kind: cash per day }, like incomeTable(); `income` in config overrides entries. */
function loadIncome(config) {
  const table = incomeTable(buildingsWithDefaults(readJson(dataFile(config, "buildings.json"))));
  for (const [k, v] of Object.entries(config.income ?? {})) table[k] = Number.parseInt(v, 10);
  return table;
}

// ---------------------------------------------------------------------------- shared, read-only context
const contexts = new Map();

function contextFor(config) {
  const map = loadMap(config);
  const unitDefs = loadUnits(config);
  const income = loadIncome(config);
  const key = JSON.stringify([map, unitDefs, income]);
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = { map, unitDefs, income, defs: new Map(unitDefs.map((d) => [d.id, d])), fields: new Map() };
    contexts.set(key, ctx);
  }
  return ctx;
}

/**
 * Movement cost from every tile to (x, y) for a unit of this type, ignoring units and blockades
 * (they can move or be destroyed). Used only to steer the search, not by the rules.
 */
function distanceField(ctx, def, x, y) {
  const key = `${def.id}:${x}:${y}`;
  let field = ctx.fields.get(key);
  if (field) return field;
  const { map } = ctx;
  const w = map.width;
  const n = w * map.height;
  const costs = new Float64Array(n);
  for (let i = 0; i < n; i += 1) costs[i] = moveCost(map, def, i % w, Math.floor(i / w));
  field = new Float64Array(n).fill(Infinity);
  const start = y * w + x;
  field[start] = 0;
  // Backwards Dijkstra: stepping from a neighbour onto tile i costs costs[i]. Costs are 1 or 2,
  // so a bucket queue is enough.
  const buckets = [[start]];
  for (let c = 0; c < buckets.length; c += 1) {
    for (const i of buckets[c] ?? []) {
      if (c > field[i] || costs[i] === Infinity) continue;
      const cx = i % w;
      const cy = Math.floor(i / w);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
        const j = ny * w + nx;
        const next = c + costs[i];
        if (costs[j] !== Infinity && next < field[j]) {
          field[j] = next;
          (buckets[next] ??= []).push(j);
        }
      }
    }
  }
  ctx.fields.set(key, field);
  return field;
}

// ---------------------------------------------------------------------------- state
const WAIT = "wait";
const HOLD = "hold";
const CAPTURE = "capture";
const END = "end";

function cloneGame(g) {
  return {
    ...g,
    seats: g.seats.map((s) => ({ ...s })),
    properties: g.properties.map((p) => ({ ...p, capture: p.capture && { ...p.capture } })),
    blockades: g.blockades.map((b) => ({ ...b })),
    units: g.units.map((u) => ({ ...u })),
    lastAction: g.lastAction && { ...g.lastAction },
  };
}

class SeizeState {
  constructor(ctx, settings, game, phase = "idle", sel = null) {
    this.ctx = ctx;
    this.settings = settings;
    this.game = game;
    this.phase = phase;
    this.sel = sel;
    this.events = [];
  }

  // ------------------------------------------------------------------ helpers
  defOf(unit) {
    return this.ctx.defs.get(unit.unitId);
  }

  unit(id) {
    return this.game.units.find((u) => u.id === id) ?? null;
  }

  get owner() {
    return this.game.active + 1;
  }

  /** Units on (x, y) that share the space a unit of type `def` would use (bridges hold a boat and a land/air unit). */
  sameSpace(def, x, y) {
    const here = unitsAt(this.game, x, y);
    if (!isBridge(this.ctx.map, x, y)) return here;
    return here.filter((o) => layerOf(this.defOf(o)) === layerOf(def));
  }

  // ------------------------------------------------------------------ required
  clone() {
    return new SeizeState(this.ctx, this.settings, cloneGame(this.game), this.phase, this.sel);
  }

  currentPlayer() {
    return this.game.active;
  }

  isTerminal() {
    return Boolean(this.game.winner) || this.game.turn > this.settings.maxTurns;
  }

  returns() {
    const { winner, seats } = this.game;
    if (winner) return seats.map((s) => (s.owner === winner ? 1 : 0));
    return this.heuristicValue(); // turn limit: score the position
  }

  legalActions() {
    if (this.phase === "move") return this.moveActions(this.unit(this.sel));
    if (this.phase === "act") return this.actActions(this.unit(this.sel));
    const { game, owner } = this;
    const actions = [];
    for (const u of game.units) if (u.owner === owner && !u.carriedBy && !u.acted) actions.push(`select:${u.id}`);
    const funds = game.seats[game.active].funds;
    for (const p of game.properties) {
      const type = PRODUCTION[p.kind];
      if (!type || p.owner !== owner || unitsAt(game, p.x, p.y).length) continue;
      for (const d of this.ctx.unitDefs) if (d.type === type && d.price <= funds) actions.push(`buy:${p.x}:${p.y}:${d.id}`);
    }
    actions.push(END);
    return actions;
  }

  apply(action) {
    const [kind, ...args] = action.split(":");
    const { game, ctx } = this;
    if (kind === "select") {
      this.sel = Number(args[0]);
      this.phase = "move";
      return;
    }
    if (kind === "buy") {
      const [x, y, uid] = args;
      applyBuy(game, ctx.unitDefs, game.active, Number(x), Number(y), uid);
      this.events.push({ type: "unit_bought", unit: ctx.defs.get(uid).name });
      return;
    }
    if (kind === "end") {
      endTurn(game, () => true, ctx.unitDefs);
      this.sel = null;
      this.phase = "idle";
      return;
    }
    const unit = this.unit(this.sel);
    if (kind === "hold" || kind === "move") {
      if (kind === "move") {
        applyMove(game, unit.id, [{ x: unit.x, y: unit.y }, { x: Number(args[0]), y: Number(args[1]) }], ctx.unitDefs, ctx.map);
      }
      this.phase = "act";
      const acts = unit.acted ? null : this.actActions(unit);
      if (acts && acts.length === 1) applyWait(game, unit.id); // nothing else to do: skip the forced "wait"
    } else if (kind === "attack" || kind === "blockade") {
      const before = new Map(game.units.map((u) => [u.id, u]));
      const blockades = game.blockades.length;
      if (kind === "attack") {
        const target = this.unit(Number(args[0]));
        applyAttack(game, ctx.unitDefs, unit.id, target.x, target.y, target.id);
      } else {
        applyAttack(game, ctx.unitDefs, unit.id, Number(args[0]), Number(args[1]));
      }
      const alive = new Set(game.units.map((u) => u.id));
      for (const [id, u] of before) if (!alive.has(id)) this.events.push({ type: "unit_destroyed", unit: this.defOf(u).name });
      if (game.blockades.length < blockades) this.events.push({ type: "blockade_broken" });
    } else if (kind === "capture") {
      const property = propertyAt(game, unit.x, unit.y);
      const was = property.owner;
      applyCapture(game, ctx.unitDefs, unit.id);
      if (property.owner !== was) this.events.push({ type: "captured", kind: property.kind });
    } else if (kind === "drop") {
      const [cargoId, x, y] = args.map(Number);
      applyDrop(game, unit.id, cargoId, x, y);
      return; // the transport may drop more cargo or still act
    } else if (kind === "wait") {
      applyWait(game, unit.id);
    } else {
      throw new Error(`Unknown action ${JSON.stringify(action)}`);
    }
    const sel = this.unit(this.sel);
    if (!sel || sel.acted) {
      this.sel = null;
      this.phase = "idle";
    }
  }

  // ------------------------------------------------------------------ action generation
  actActions(unit) {
    const { game, ctx } = this;
    const d = this.defOf(unit);
    const actions = [];
    if (d.attack > 0) {
      for (const t of attackTargets(game, ctx.unitDefs, game.active, unit)) {
        actions.push(t.kind === "unit" ? `attack:${t.unit.id}` : `blockade:${t.x}:${t.y}`);
      }
    }
    if (!captureError(game, ctx.unitDefs, game.active, unit.id)) actions.push(CAPTURE);
    if (!unit.acted) {
      for (const cargo of cargoOf(game, unit)) {
        for (const t of dropTiles(game, ctx.map, ctx.unitDefs, unit, cargo)) actions.push(`drop:${cargo.id}:${t.x}:${t.y}`);
      }
    }
    actions.push(WAIT);
    return actions;
  }

  moveActions(unit) {
    const { game, ctx } = this;
    const w = ctx.map.width;
    const d = this.defOf(unit);
    const start = unit.y * w + unit.x;
    let stops = [];
    for (const i of reachable(game, ctx.map, d, unit, ctx.unitDefs).keys()) {
      if (i !== start && !stopError(game, ctx.map, ctx.unitDefs, unit, d, i % w, Math.floor(i / w))) stops.push(i);
    }
    const limit = this.settings.moveCandidates;
    if (limit > 0 && stops.length > limit) stops = this.prune(unit, d, stops, limit);
    stops.sort((a, b) => a - b);
    return [HOLD, ...stops.map((i) => `move:${i % w}:${Math.floor(i / w)}`)];
  }

  enemyTiles(unit) {
    const out = new Set();
    for (const o of this.game.units) if (o.owner !== unit.owner && !o.carriedBy) out.add(`${o.x},${o.y}`);
    return out;
  }

  /** Keep every tile that enables a capture, an attack or boarding, plus the `limit` tiles closest to the unit's objectives. */
  prune(unit, d, stops, limit) {
    const w = this.ctx.map.width;
    const enemies = this.enemyTiles(unit);
    const targets = this.meleeTargets(d, enemies);
    const keep = [];
    const rest = [];
    for (const i of stops) (this.specialTile(unit, d, i % w, Math.floor(i / w), targets) ? keep : rest).push(i);
    const score = this.goalScorer(unit, d, enemies);
    const scored = rest.map((i) => [score(i), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return [...keep, ...scored.slice(0, limit).map(([, i]) => i)];
  }

  meleeTargets(d, enemies) {
    if (!(d.attack > 0) || d.traits?.includes("ranged")) return new Set();
    const targets = new Set(enemies);
    for (const b of this.game.blockades) targets.add(`${b.x},${b.y}`);
    return targets;
  }

  specialTile(unit, d, x, y, targets) {
    const { game, ctx } = this;
    if (d.traits?.includes("captures")) {
      const p = propertyAt(game, x, y);
      if (p && p.owner !== unit.owner) return true;
    }
    if (targets.size && (targets.has(`${x + 1},${y}`) || targets.has(`${x - 1},${y}`) || targets.has(`${x},${y + 1}`) || targets.has(`${x},${y - 1}`))) {
      return true;
    }
    return this.sameSpace(d, x, y).some((o) => o !== unit && canBoard(game, ctx.unitDefs, o, unit));
  }

  /** Returns tile index -> distance to the unit's nearest objective (lower is better). */
  goalScorer(unit, d, enemies) {
    const w = this.ctx.map.width;
    const captures = d.traits?.includes("captures");
    const fields = [];
    for (const p of this.game.properties) {
      if (p.owner === unit.owner) continue;
      if (captures || (p.kind === "hq" && p.owner > 0)) fields.push(distanceField(this.ctx, d, p.x, p.y));
    }
    const enemyList = d.attack > 0 ? [...enemies].map((k) => k.split(",").map(Number)) : [];
    return (i) => {
      let best = Infinity;
      for (const f of fields) if (f[i] < best) best = f[i];
      if (enemyList.length) {
        const x = i % w;
        const y = Math.floor(i / w);
        for (const [ex, ey] of enemyList) {
          const v = Math.abs(ex - x) + Math.abs(ey - y) - 1;
          if (v < best) best = v;
        }
      }
      return best;
    };
  }

  // ------------------------------------------------------------------ optional
  /**
   * Each seat's share of total strength: funds + unit value (price × health) + 4 days of income
   * + capture progress on other players' properties.
   */
  heuristicValue() {
    const { game } = this;
    const n = game.seats.length;
    const strength = game.seats.map((s) => (s.defeated ? 0 : s.funds + 4 * incomeFor(game, s.owner)));
    for (const u of game.units) strength[u.owner - 1] += (this.defOf(u).price * u.hp) / MAX_HP;
    for (const p of game.properties) {
      const capturer = p.capture && this.unit(p.capture.unitId);
      if (capturer) strength[capturer.owner - 1] += ((p.kind === "hq" ? 30000 : 3000) * p.capture.progress) / 100;
    }
    game.seats.forEach((s, i) => {
      if (s.defeated) strength[i] = 0;
    });
    const total = strength.reduce((t, v) => t + v, 0);
    return total > 0 ? strength.map((v) => v / total) : new Array(n).fill(1 / n);
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  actionLabel(action) {
    const [kind, ...a] = action.split(":");
    const name = (id) => {
      const u = this.unit(Number(id));
      return u ? `${this.defOf(u).name}#${id}` : `#${id}`;
    };
    switch (kind) {
      case "buy": return `buy ${this.ctx.defs.get(a[2]).name} @${a[0]},${a[1]}`;
      case "select": return `select ${name(a[0])}`;
      case "move": return `move to ${a[0]},${a[1]}`;
      case "attack": return `attack ${name(a[0])}`;
      case "blockade": return `attack blockade @${a[0]},${a[1]}`;
      case "drop": return `drop ${name(a[0])} @${a[1]},${a[2]}`;
      case "capture": {
        const u = this.unit(this.sel);
        const p = u && propertyAt(this.game, u.x, u.y);
        return p ? `capture ${p.kind}` : "capture";
      }
      case "end": return "end turn";
      default: return action;
    }
  }

  strategyKey() {
    if (this.phase === "idle") return `turn start, $${Math.floor(this.game.seats[this.game.active].funds / 1000)}k`;
    return `${this.phase}: ${this.defOf(this.unit(this.sel)).name}`;
  }

  describe() {
    const { game } = this;
    const parts = game.seats.map((s, i) => {
      if (s.defeated) return `P${i} out`;
      const units = game.units.filter((u) => u.owner === s.owner).length;
      const props = game.properties.filter((p) => p.owner === s.owner).length;
      return `P${i} $${s.funds.toLocaleString("en-US")} ${units}u ${props}p`;
    });
    const u = this.sel !== null ? this.unit(this.sel) : null;
    const sel = u ? ` · ${this.phase} ${this.defOf(u).name}@${u.x},${u.y}` : "";
    return `Day ${game.turn} P${game.active}${sel} · ${parts.join(" · ")}`;
  }

  toJSON() {
    const { lastAction, version, ...game } = this.game;
    return { ...game, phase: this.phase, sel: this.sel };
  }
}

// ---------------------------------------------------------------------------- game module
const pickMin = (list, key, rng) => {
  let best = null;
  let bestKey = null;
  for (const item of list) {
    const k = [key(item), rng.random()];
    if (best === null || k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
      best = item;
      bestKey = k;
    }
  }
  return best;
};

class SeizeGame {
  constructor(numPlayers = 2) {
    this.numPlayers = numPlayers;
    this.name = numPlayers === 2 ? "Seize" : `Seize (${numPlayers} players)`;
    this.perfectInformation = true;
    this.maxSteps = 5000;
    this.rolloutDepth = 40; // ~1 player-turn of playout, then heuristicValue()
  }

  newGame(_seed, config) {
    const ctx = contextFor(config);
    const players = ctx.map.players ?? 2;
    if (players !== this.numPlayers) {
      throw new Error(`Map ${JSON.stringify(ctx.map.name)} is for ${players} players, but this entry plays ${this.numPlayers}. ` +
        `Use metafinder/adapter.js:GAME${players} or pick another map.`);
    }
    const seats = Array.from({ length: players }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const settings = {
      maxTurns: Number.parseInt(config.max_turns ?? 30, 10),
      moveCandidates: Number.parseInt(config.move_candidates ?? 8, 10),
    };
    return new SeizeState(ctx, settings, createGame(ctx.map, seats, ctx.income));
  }

  /**
   * Moves every unit before ending the turn, captures and attacks when it can, otherwise heads for
   * the nearest objective; buys with what is left. 10% of moves are random.
   */
  defaultRolloutPolicy(state, rng) {
    const legal = state.legalActions();
    if (rng.random() < 0.1) return rng.choice(legal);
    const { game, ctx } = state;
    if (state.phase === "idle") {
      const selects = legal.filter((a) => a.startsWith("select:"));
      if (selects.length) return rng.choice(selects);
      const buys = legal.filter((a) => a.startsWith("buy:"));
      if (!buys.length) return END;
      const defOfBuy = (a) => ctx.defs.get(a.slice(a.lastIndexOf(":") + 1));
      const capturers = game.units.filter((u) => u.owner === state.owner && state.defOf(u).traits?.includes("captures")).length;
      if (capturers < 3) {
        const infantry = buys.filter((a) => defOfBuy(a).traits?.includes("captures"));
        if (infantry.length) return pickMin(infantry, (a) => defOfBuy(a).price, rng);
      }
      if (rng.random() < 0.6) return pickMin(buys, (a) => -defOfBuy(a).price, rng);
      return rng.choice(buys);
    }

    const unit = state.unit(state.sel);
    const d = state.defOf(unit);
    if (state.phase === "act") {
      if (legal.includes(CAPTURE)) return CAPTURE;
      let best = null;
      let bestValue = 0;
      for (const a of legal) {
        if (a.startsWith("attack:")) {
          const target = state.unit(Number(a.slice(7)));
          const { dealt, counter } = previewAttack(game, ctx.unitDefs, unit, target.x, target.y, target.id);
          const value = dealt * state.defOf(target).price - counter * d.price;
          if (value > bestValue) {
            best = a;
            bestValue = value;
          }
        } else if (a.startsWith("blockade:") && best === null) {
          best = a;
        }
      }
      if (best !== null) return best;
      const drops = legal.filter((a) => a.startsWith("drop:"));
      return drops.length ? rng.choice(drops) : WAIT;
    }

    // move phase
    const captures = d.traits?.includes("captures");
    const here = propertyAt(game, unit.x, unit.y);
    if (captures && here && here.owner !== unit.owner) return HOLD; // keep capturing
    if (d.traits?.includes("ranged") && attackTargets(game, ctx.unitDefs, game.active, unit).length) return HOLD;
    const enemies = state.enemyTiles(unit);
    const targets = d.attack > 0 && !d.traits?.includes("ranged") ? enemies : new Set();
    const moves = legal.filter((a) => a !== HOLD).map((a) => [a, ...a.slice(5).split(":").map(Number)]);
    const special = moves.filter(([, x, y]) => state.specialTile(unit, d, x, y, targets));
    if (special.length) {
      if (captures) {
        const hq = special.find(([, x, y]) => propertyAt(game, x, y)?.kind === "hq");
        if (hq) return hq[0];
      }
      return rng.choice(special)[0];
    }
    const w = ctx.map.width;
    const score = state.goalScorer(unit, d, enemies);
    const options = [[HOLD, unit.x, unit.y], ...moves];
    return pickMin(options, ([, x, y]) => score(y * w + x), rng)[0];
  }
}

export const GAME = new SeizeGame(2);
export const GAME2 = GAME;
export const GAME3 = new SeizeGame(3);
export const GAME4 = new SeizeGame(4);
