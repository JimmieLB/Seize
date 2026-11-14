// Uploaded replays: works out which format a file is in and turns it into a saved replay.
//
// Two formats are accepted, as plain JSON or gzipped:
//   original    what the server saves ({ map, unitDefs, frames: [game state, ...], ...summary })
//   metafinder-replay  a MetaFinder single-game replay ({ format: "metafinder-replay/1", referee_config, initial, moves }).
//               Every move carries a full state snapshot, so frames are built straight from those.
//   metafinder  a MetaFinder result file ({ type: "result", game: { config }, self_play: { sample_game } }).
//               It only stores the sample game's moves as action labels ("select Infantry#1",
//               "move to 3,5", ...), so they are played again through metafinder/adapter.js (the real
//               rules) with this server's maps, units and buildings, recording a frame per change.
//               Each move's recorded position is checked against the replayed one, so a file made with
//               different map/unit data is rejected instead of turning into a wrong replay.
import { gunzipSync } from "node:zlib";
import { validateMap } from "../shared/mapFormat.js";

const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** "original", "metafinder" or null. */
export function detectReplayFormat(data) {
  if (!isObject(data)) return null;
  if (typeof data.format === "string" && data.format.startsWith("metafinder-replay/") && isObject(data.initial?.state) && Array.isArray(data.moves)) return "metafinder-replay";
  if (data.type === "result" && Array.isArray(data.self_play?.sample_game?.moves)) return "metafinder";
  if (Array.isArray(data.frames) && isObject(data.map) && Array.isArray(data.unitDefs)) return "original";
  return null;
}

function parseBytes(buffer) {
  let bytes = buffer;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: MAX_UNZIPPED_BYTES });
    } catch {
      fail("That file looks gzipped but couldn't be unzipped.");
    }
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("That file isn't valid JSON.");
  }
}

const text = (value, fallback, max = 64) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback);
const isoDate = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

// ---- Original format ----

function checkFrame(frame, index) {
  const ok = isObject(frame)
    && Number.isInteger(frame.turn)
    && Number.isInteger(frame.active)
    && Array.isArray(frame.seats) && frame.seats.length > 0
    && Array.isArray(frame.units)
    && Array.isArray(frame.properties);
  if (!ok) fail(`Replay state ${index + 1} is missing game data.`);
}

function fromOriginal(data) {
  if (data.frames.length === 0) fail("That replay has no game states.");
  data.frames.forEach(checkFrame);
  const map = { ...validateMap(data.map), id: text(data.map.id, undefined) };
  if (data.unitDefs.some((def) => !isObject(def) || typeof def.id !== "string")) fail("That replay's unit list is invalid.");
  return {
    roomName: text(data.roomName, "Uploaded replay", 32),
    startedAt: isoDate(data.startedAt),
    endedAt: isoDate(data.endedAt),
    map,
    unitDefs: data.unitDefs,
    frames: data.frames,
  };
}

// ---- MetaFinder format ----

/** Config keys that change the rules or data; search-only settings (scoring, candidates) are dropped. */
function rulesConfig(config, map, dataDirectory) {
  return {
    map,
    units: isObject(config.units) ? config.units : undefined,
    income: isObject(config.income) ? config.income : undefined,
    data_dir: dataDirectory,
    move_candidates: 0, // offer every reachable tile so any recorded move is legal
    max_turns: Number.MAX_SAFE_INTEGER,
  };
}

async function fromMetafinder(data, { maps, dataDirectory }) {
  const adapter = await import("../metafinder/adapter.js");
  const config = isObject(data.game?.config) ? data.game.config : {};
  const sample = data.self_play.sample_game;
  const moves = sample.moves;
  if (moves.length === 0) fail("That MetaFinder file's sample game has no moves.");

  const mapName = String(config.map ?? "").trim().toLowerCase();
  const liveMap = maps.find((map) => map.name.trim().toLowerCase() === mapName || map.id === config.map);
  const players = Number(data.game?.num_players) || liveMap?.players || 2;
  const game = { 2: adapter.GAME, 3: adapter.GAME3, 4: adapter.GAME4 }[players];
  if (!game) fail(`MetaFinder game has ${players} players; Seize supports 2–4.`);

  let state;
  try {
    state = game.newGame(0, rulesConfig(config, liveMap ?? config.map, dataDirectory));
  } catch (error) {
    fail(`Couldn't set up the MetaFinder game: ${error.message}`);
  }
  // Seat names show in the replay; the adapter's seats are P0, P1, ... like the file's positions.
  state.game.seats.forEach((seat, index) => {
    seat.name = `MetaFinder P${index}`;
  });

  const frames = [structuredClone(state.game)];
  let version = state.game.version;
  for (const [index, move] of moves.entries()) {
    const step = `Move ${index + 1} ("${move?.action}")`;
    if (typeof move?.action !== "string") fail(`Move ${index + 1} has no action.`);
    if (typeof move.position === "string" && move.position !== state.describe()) {
      fail(`${step}: the replayed position doesn't match the file (expected "${move.position}", got "${state.describe()}"). ` +
        "The game was probably run with different map, unit or building data than this server has.");
    }
    const action = state.legalActions().find((candidate) => state.actionLabel(candidate) === move.action);
    if (!action) fail(`${step} isn't a legal move here. The game was probably run with different rules or data.`);
    state.apply(action);
    if (state.game.version !== version) {
      version = state.game.version;
      frames.push(structuredClone(state.game));
    }
    if (state.game.winner) break;
  }

  const notes = [];
  const final = typeof sample.final === "string" ? sample.final : null;
  if (final && final !== state.describe()) {
    notes.push(`MetaFinder only saved the first ${moves.length} moves of this game, so the replay stops at day ${state.game.turn} (the game ran until "${final}").`);
  }
  const map = state.ctx.map;
  return {
    roomName: text(`MetaFinder: ${map.name}`, "MetaFinder game", 32),
    startedAt: null,
    endedAt: null,
    map: { ...validateMap(map), id: map.id },
    unitDefs: state.ctx.unitDefs,
    frames,
    source: "metafinder",
    note: notes.join(" ") || undefined,
  };
}

// ---- MetaFinder replay format ----

async function fromMetafinderReplay(data, { maps, dataDirectory }) {
  const adapter = await import("../metafinder/adapter.js");
  const referee = isObject(data.referee_config) ? data.referee_config : {};
  const mapName = String(referee.map ?? "").trim().toLowerCase();
  const liveMap = maps.find((map) => map.name.trim().toLowerCase() === mapName || map.id === referee.map);
  const players = Array.isArray(data.initial.state.seats) ? data.initial.state.seats.length : 2;
  const game = { 2: adapter.GAME, 3: adapter.GAME3, 4: adapter.GAME4 }[players];
  if (!game) fail(`MetaFinder replay has ${players} players; Seize supports 2–4.`);

  // Only used for the map and unit definitions (and any fields a snapshot leaves out).
  let base;
  try {
    base = game.newGame(data.seed ?? 0, rulesConfig(referee, liveMap ?? referee.map, dataDirectory));
  } catch (error) {
    fail(`Couldn't set up the MetaFinder game: ${error.message}`);
  }
  const names = Array.isArray(data.players) ? data.players : [];

  const snapshots = [data.initial.state, ...data.moves.map((move) => move?.state)];
  const frames = [];
  let previous = null;
  for (const [index, snapshot] of snapshots.entries()) {
    if (!isObject(snapshot)) fail(`Move ${index} has no game state.`);
    const { phase, sel, ...rest } = snapshot; // in-turn selection isn't part of a saved game
    const frame = { ...structuredClone(base.game), ...structuredClone(rest), lastAction: null };
    frame.seats.forEach((seat, i) => {
      seat.name = names[i]?.ai ? `P${i} (${names[i].ai})` : `P${i}`;
    });
    const key = JSON.stringify({ ...frame, version: 0 });
    if (key === previous) continue; // a selection or no-op step changes nothing visible
    previous = key;
    frame.version = frames.length + 1;
    frames.push(frame);
  }
  const last = frames[frames.length - 1];
  const alive = last.seats.filter((seat) => !seat.defeated);
  if (alive.length === 1 && !last.winner) last.winner = alive[0].owner;

  const map = base.ctx.map;
  return {
    roomName: text(`MetaFinder: ${map.name}`, "MetaFinder game", 32),
    startedAt: null,
    endedAt: null,
    map: { ...validateMap(map), id: map.id },
    unitDefs: base.ctx.unitDefs,
    frames,
    source: "metafinder",
    note: data.result?.finished === false ? "This MetaFinder game hadn't finished when it was saved." : undefined,
  };
}

/**
 * Turns an uploaded file into { format, replay } where replay is
 * { roomName, startedAt, endedAt, map, unitDefs, frames, source?, note? } (ready for the replay store).
 */
export async function importReplay(buffer, { maps, dataDirectory }) {
  const data = parseBytes(buffer);
  const format = detectReplayFormat(data);
  if (format === "original") return { format, replay: fromOriginal(data) };
  if (format === "metafinder-replay") return { format, replay: await fromMetafinderReplay(data, { maps, dataDirectory }) };
  if (format === "metafinder") return { format, replay: await fromMetafinder(data, { maps, dataDirectory }) };
  fail("Unrecognised replay file. Upload a Seize replay or a MetaFinder result/replay file.");
}
