import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAP_LIMITS, validateMap } from "../shared/mapFormat.js";
import { validateUnits, withDefaults } from "../shared/unitFormat.js";
import { incomeTable, validateBuildings, withDefaults as buildingsWithDefaults } from "../shared/buildingFormat.js";
import {
  applyAttack,
  applyBuy,
  applyCapture,
  applyDrop,
  applyMove,
  applyResign,
  applyWait,
  attackError,
  buyError,
  captureError,
  createGame,
  dropError,
  endTurn,
  moveError,
  resignError,
  upgradeGame,
  waitError,
} from "../shared/gameRules.js";
import { allowMapCreation, isAdmin, login, requireAdmin } from "./admin.js";
import { createReplayStore } from "./replays.js";
import { createStaticHandler } from "./static.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
// Saved data: SEIZE_DATA_DIR if set, else a Railway volume if one is attached, else server/data.
const dataDirectory = path.resolve(
  process.env.SEIZE_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(directory, "data"),
);
const roomsFile = path.join(dataDirectory, "rooms.json");
const mapsFile = path.join(dataDirectory, "maps.json");
const unitsFile = path.join(dataDirectory, "units.json");
const buildingsFile = path.join(dataDirectory, "buildings.json");
const port = Number(process.env.PORT) || 3001;
const serveStatic = createStaticHandler(path.join(directory, "..", "dist"));
const heartbeatExpiryMs = 45_000;
const emptyRoomCloseMs = 15_000; // rooms with nobody connected for this long are deleted
const roomSweepMs = 2_000;
const maxRequestBytes = 16_384;
const maxMapRequestBytes = 262_144;
let rooms = [];
let maps = [];
let units = withDefaults([]);
let buildings = buildingsWithDefaults([]);
let saveQueue = Promise.resolve();
const replays = createReplayStore(dataDirectory);

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32);
}

function passwordMatches(password, stored) {
  if (!password || !stored?.salt || !stored?.hash) return false;
  const expected = Buffer.from(stored.hash, "hex");
  const supplied = hashPassword(password, stored.salt);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function cleanPlayers(room, now = Date.now()) {
  const connected = room.players.filter(
    (player) => now - player.lastSeen < heartbeatExpiryMs,
  );
  if (connected.length !== room.players.length) room.players = connected;
  return connected;
}

// Short, URL-friendly game ids (no 0/o/1/l/i to avoid mix-ups), e.g. "k7m2qx".
const roomIdAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";

function newRoomId() {
  let id;
  do {
    id = Array.from(randomBytes(6), (byte) => roomIdAlphabet[byte % roomIdAlphabet.length]).join("");
  } while (rooms.some((room) => room.id === id));
  return id;
}

/**
 * Closes rooms nobody has been connected to for `emptyRoomCloseMs`. A room's empty timer starts
 * when its last player leaves (or their heartbeat expires) and resets if someone joins.
 */
async function closeEmptyRooms(now = Date.now()) {
  let changed = false;
  rooms = rooms.filter((room) => {
    if (cleanPlayers(room, now).length > 0) {
      if (room.emptySince) {
        room.emptySince = null;
        changed = true;
      }
      return true;
    }
    if (!room.emptySince) {
      room.emptySince = now;
      changed = true;
    }
    if (now - room.emptySince < emptyRoomCloseMs) return true;
    changed = true;
    if (room.recording) replays.discard(room.id);
    return false;
  });
  if (changed) await persistRooms();
}

/** Brings older saved rooms up to date and keeps host/status consistent with who is connected. */
function normalizeRoom(room) {
  room.maxPlayers = Math.min(room.maxPlayers, MAP_LIMITS.maxPlayers);
  room.status ??= "waiting";
  room.mapId ??= null;
  room.gameMap ??= null;
  room.gameUnits ??= null;
  room.game ??= null;
  room.saveReplay ??= true;
  const players = cleanPlayers(room);
  if (!players.some((player) => player.id === room.hostId)) room.hostId = players[0]?.id ?? null;
  if (room.status === "playing" && (players.length === 0 || !room.game)) {
    // Everyone left mid-game (or an old room has no game state): reopen the room.
    room.status = "waiting";
    room.gameMap = null;
    room.gameUnits = null;
    room.game = null;
    room.gameUndo = null;
    if (room.recording) replays.discard(room.id);
    room.recording = false;
  }
  if (room.game) {
    upgradeGame(room.game, room.gameMap);
    // Don't let the game stall on a player who left: skip their turn.
    const connected = (playerId) => players.some((player) => player.id === playerId);
    const activePlayer = room.game.seats[room.game.active].playerId;
    if (!room.game.winner && !connected(activePlayer)) {
      endTurn(room.game, connected, room.gameUnits);
      clearUndo(room);
      recordFrame(room);
    }
  }
  if (room.mapId && room.status === "waiting" && !maps.some((map) => map.id === room.mapId)) room.mapId = null;
  return players;
}

// ---- Undo ----
// Before each successful buy/move/attack/capture/wait/drop the previous game state is kept in
// room.gameUndo (one level only). The player who made that change can put it back during the same
// turn. Ending a turn clears it. game.undoSeat tells clients who may undo (null = nobody).

function clearUndo(room) {
  room.gameUndo = null;
  if (room.game) room.game.undoSeat = null;
}

function undoLast(room, seatIndex) {
  const undo = room.gameUndo;
  if (!undo || undo.seatIndex !== seatIndex || seatIndex !== room.game.active) return "There's nothing to undo.";
  const version = room.game.version + 1; // keep moving forward so clients accept the restored state
  room.game = undo.snapshot;
  room.game.version = version;
  room.game.undoSeat = null;
  room.game.lastAction = { version, kind: "undo", text: `${room.game.seats[seatIndex].name} undid their last change.` };
  room.gameUndo = null;
  return null;
}

// ---- Replays ----
// room.recording is true while this game is being recorded (the room's "Save replay" option).

function recordFrame(room) {
  if (!room.recording) return;
  replays.frame(room);
  if (room.game.winner) {
    room.recording = false; // saved once, when the game is won
    replays.finish(room);
  }
}

function roomMap(room) {
  return room.gameMap ?? maps.find((map) => map.id === room.mapId) ?? null;
}

function publicRoom(room) {
  const players = normalizeRoom(room);
  const map = roomMap(room);
  return {
    id: room.id,
    name: room.name,
    maxPlayers: room.maxPlayers,
    hasPassword: Boolean(room.password),
    createdAt: room.createdAt,
    hostId: room.hostId,
    status: room.status,
    saveReplay: room.saveReplay,
    map: map ? mapSummary(map) : null,
    players: players.map(({ id, name }) => ({ id, name })),
    playerCount: players.length,
    isFull: players.length >= room.maxPlayers,
  };
}

function persistJson(file, data) {
  const snapshot = JSON.stringify(data, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${file}.tmp`;
    await writeFile(temporaryFile, snapshot, "utf8");
    await rename(temporaryFile, file);
  });
  return saveQueue;
}

const persistRooms = () => persistJson(roomsFile, rooms);
const persistMaps = () => persistJson(mapsFile, maps);
const persistUnits = () => persistJson(unitsFile, units);
const persistBuildings = () => persistJson(buildingsFile, buildings);

/**
 * Reads a JSON array from the data directory. If the file doesn't exist yet (e.g. a fresh
 * Railway volume) and `seed` is true, starts from server/seed/<same name> when present.
 */
async function readJsonArray(file, { seed = false } = {}) {
  const sources = seed ? [file, path.join(directory, "seed", path.basename(file))] : [file];
  for (const source of sources) {
    try {
      const data = JSON.parse(await readFile(source, "utf8"));
      if (!Array.isArray(data)) throw new Error(`${path.basename(source)} must contain a JSON array.`);
      if (source !== file) console.log(`Seeded ${path.basename(file)} from server/seed.`);
      return data;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return [];
}

async function readJson(request, limit = maxRequestBytes) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function send(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function validateText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} must be between 1 and ${maxLength} characters.`), {
      status: 400,
    });
  }
  return value.trim();
}

function mapSummary({ id, name, width, height, players, updatedAt }) {
  return { id, name, width, height, players, updatedAt };
}

async function handleMapRequest(request, response, mapId) {
  if (!mapId) {
    if (request.method === "GET") {
      const full = new URL(request.url, "http://localhost").searchParams.get("full") === "1";
      return send(response, 200, { maps: full ? maps : maps.map(mapSummary) });
    }
    if (request.method === "POST") {
      allowMapCreation(request); // anyone can publish a new map (rate-limited); only admins can change it later
      const map = {
        id: randomUUID(),
        ...validateMap(await readJson(request, maxMapRequestBytes)),
        updatedAt: new Date().toISOString(),
      };
      maps.unshift(map);
      await persistMaps();
      return send(response, 201, { map });
    }
    return send(response, 405, { error: "Method not allowed." });
  }

  const index = maps.findIndex((map) => map.id === mapId);
  if (index === -1) return send(response, 404, { error: "Map not found." });

  if (request.method === "GET") return send(response, 200, { map: maps[index] });
  if (request.method === "PUT") {
    requireAdmin(request);
    const map = {
      id: mapId,
      ...validateMap(await readJson(request, maxMapRequestBytes)),
      updatedAt: new Date().toISOString(),
    };
    maps[index] = map;
    await persistMaps();
    return send(response, 200, { map });
  }
  if (request.method === "DELETE") {
    requireAdmin(request);
    maps.splice(index, 1);
    await persistMaps();
    return send(response, 200, { ok: true });
  }
  return send(response, 405, { error: "Method not allowed." });
}

function findRoom(roomId) {
  return rooms.find((room) => room.id === roomId);
}

async function handleRequest(request, response) {
  const route = new URL(request.url, "http://localhost");
  // Everything outside /api is the website itself.
  if (route.pathname !== "/api" && !route.pathname.startsWith("/api/")) {
    return serveStatic(request, response, route.pathname);
  }

  if (request.method === "GET" && request.url === "/api/health") {
    return send(response, 200, { status: "ok" });
  }

  if (request.method === "GET" && request.url === "/api/rooms") {
    await closeEmptyRooms();
    const listedRooms = rooms.map(publicRoom);
    await persistRooms();
    return send(response, 200, { rooms: listedRooms });
  }

  if (route.pathname === "/api/admin") {
    if (request.method === "GET") return send(response, 200, { admin: isAdmin(request) });
    return send(response, 405, { error: "Method not allowed." });
  }

  if (route.pathname === "/api/admin/login") {
    if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." });
    const body = await readJson(request);
    return send(response, 200, { token: login(request, body.password) });
  }

  if (route.pathname === "/api/buildings") {
    if (request.method === "GET") return send(response, 200, { buildings });
    if (request.method === "PUT") {
      requireAdmin(request);
      const body = await readJson(request);
      buildings = validateBuildings(body.buildings);
      await persistBuildings();
      return send(response, 200, { buildings });
    }
    return send(response, 405, { error: "Method not allowed." });
  }

  if (route.pathname === "/api/units") {
    if (request.method === "GET") return send(response, 200, { units });
    if (request.method === "PUT") {
      requireAdmin(request);
      const body = await readJson(request);
      units = validateUnits(body.units);
      await persistUnits();
      return send(response, 200, { units });
    }
    return send(response, 405, { error: "Method not allowed." });
  }

  if (route.pathname === "/api/replays") {
    if (request.method !== "GET") return send(response, 405, { error: "Method not allowed." });
    return send(response, 200, { replays: replays.list(), usedBytes: await replays.usedBytes(), limitBytes: replays.limitBytes });
  }

  const replayRoute = route.pathname.match(/^\/api\/replays\/([^/]+)$/);
  if (replayRoute) {
    const replayId = replayRoute[1];
    if (request.method === "DELETE") {
      requireAdmin(request);
      if (!replays.list().some((entry) => entry.id === replayId)) return send(response, 404, { error: "Replay not found." });
      await replays.remove(replayId);
      return send(response, 200, { ok: true });
    }
    if (request.method !== "GET") return send(response, 405, { error: "Method not allowed." });
    const data = await replays.read(replayId);
    if (!data) return send(response, 404, { error: "Replay not found." });
    // Stored gzipped; the browser unzips it.
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    return response.end(data);
  }

  const mapRoute = route.pathname.match(/^\/api\/maps(?:\/([^/]+))?$/);
  if (mapRoute) return handleMapRequest(request, response, mapRoute[1]);

  const roomRoute = route.pathname.match(/^\/api\/rooms(?:\/([^/]+))?(?:\/(join|heartbeat|leave|map|start|units|game|buy|move|attack|capture|wait|drop|end-turn|undo|resign))?$/);
  if (!roomRoute) return send(response, 404, { error: "Not found." });

  const [, roomId, action] = roomRoute;
  if (request.method === "POST" && !roomId) {
    const body = await readJson(request);
    const name = validateText(body.name, "Room name", 32);
    const playerId = validateText(body.playerId, "Player ID", 64);
    const playerName = validateText(body.playerName, "Player name", 20);
    const maxPlayers = Number(body.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < MAP_LIMITS.minPlayers || maxPlayers > MAP_LIMITS.maxPlayers) {
      throw Object.assign(new Error(`Choose a player limit between ${MAP_LIMITS.minPlayers} and ${MAP_LIMITS.maxPlayers}.`), {
        status: 400,
      });
    }
    if (body.password !== undefined && typeof body.password !== "string") {
      throw Object.assign(new Error("Password must be text."), { status: 400 });
    }
    if (body.password?.length > 64) {
      throw Object.assign(new Error("Password must be 64 characters or fewer."), {
        status: 400,
      });
    }
    const password = body.password?.trim() ?? "";
    let storedPassword = null;
    if (password) {
      const salt = randomBytes(16).toString("hex");
      storedPassword = { salt, hash: hashPassword(password, salt).toString("hex") };
    }
    const room = {
      id: newRoomId(),
      name,
      maxPlayers,
      password: storedPassword,
      createdAt: new Date().toISOString(),
      hostId: playerId,
      status: "waiting",
      mapId: null,
      gameMap: null,
      saveReplay: body.saveReplay !== false,
      players: [{ id: playerId, name: playerName, lastSeen: Date.now() }],
    };
    rooms.unshift(room);
    await persistRooms();
    return send(response, 201, { room: publicRoom(room) });
  }

  const room = roomId && findRoom(roomId);
  if (roomId && !room) return send(response, 404, { error: "Room not found." });

  if (request.method === "GET" && action === "map") {
    normalizeRoom(room);
    const map = roomMap(room);
    if (!map) return send(response, 404, { error: "No map has been chosen yet." });
    return send(response, 200, { map });
  }

  if (request.method === "GET" && action === "game") {
    normalizeRoom(room);
    if (!room.game) return send(response, 404, { error: "This game hasn't started." });
    return send(response, 200, { game: room.game });
  }

  if (request.method === "GET" && action === "units") {
    normalizeRoom(room);
    return send(response, 200, { units: room.gameUnits ?? units });
  }

  if (request.method !== "POST" || !action) return send(response, 404, { error: "Not found." });

  const body = await readJson(request);
  const playerId = validateText(body.playerId, "Player ID", 64);
  if (action === "join") {
    const playerName = validateText(body.playerName, "Player name", 20);
    const player = room.players.find((current) => current.id === playerId);
    normalizeRoom(room);
    const hasSeat = room.game?.seats.some((seat) => seat.playerId === playerId);
    // Players coming back to their own room/game (e.g. after a refresh) don't need the password again.
    if (room.password && !player && !hasSeat && !passwordMatches(body.password, room.password)) {
      return send(response, 403, { error: "That room password is incorrect." });
    }
    if (!player && room.status === "playing" && !hasSeat) {
      return send(response, 409, { error: "This game has already started." });
    }
    if (!player && cleanPlayers(room).length >= room.maxPlayers) {
      return send(response, 409, { error: "This room is full." });
    }
    const joinedPlayer = player ?? { id: playerId, name: playerName, lastSeen: Date.now() };
    joinedPlayer.name = playerName;
    joinedPlayer.lastSeen = Date.now();
    if (!player) room.players.push(joinedPlayer);
    await persistRooms();
    return send(response, 200, { room: publicRoom(room) });
  }

  const player = room.players.find((current) => current.id === playerId);
  if (action === "heartbeat") {
    if (!player) return send(response, 404, { error: "You are no longer in this room." });
    player.lastSeen = Date.now();
    await persistRooms();
    return send(response, 200, { room: publicRoom(room) });
  }

  if (action === "map" || action === "start") {
    if (!player) return send(response, 404, { error: "You are no longer in this room." });
    normalizeRoom(room);
    if (room.hostId !== playerId) return send(response, 403, { error: "Only the host can do that." });
    if (room.status !== "waiting") return send(response, 409, { error: "The game has already started." });
    player.lastSeen = Date.now();

    if (action === "map") {
      const map = maps.find((current) => current.id === body.mapId);
      if (!map) return send(response, 404, { error: "Map not found." });
      if (map.players < room.maxPlayers) {
        return send(response, 400, { error: `That map only supports ${map.players} players.` });
      }
      room.mapId = map.id;
    } else {
      const map = roomMap(room);
      if (!map) return send(response, 400, { error: "Choose a map first." });
      if (cleanPlayers(room).length < 2) return send(response, 400, { error: "Wait for at least one more player." });
      room.status = "playing";
      // Snapshots, so editing the map or units later doesn't affect this game.
      room.gameMap = structuredClone(map);
      room.gameUnits = structuredClone(units);
      room.game = createGame(room.gameMap, cleanPlayers(room), incomeTable(buildings));
      room.startedAt = new Date().toISOString();
      room.recording = room.saveReplay;
      if (room.recording) replays.start(room);
    }
    await persistRooms();
    return send(response, 200, { room: publicRoom(room) });
  }

  if (action === "resign") {
    if (!player) return send(response, 404, { error: "You are no longer in this room." });
    normalizeRoom(room);
    if (!room.game) return send(response, 409, { error: "This game hasn't started." });
    player.lastSeen = Date.now();
    const seatIndex = room.game.seats.findIndex((seat) => seat.playerId === playerId);
    const error = resignError(room.game, seatIndex);
    if (error) return send(response, 400, { error });
    const connected = (id) => cleanPlayers(room).some((current) => current.id === id);
    applyResign(room.game, seatIndex, connected, room.gameUnits);
    clearUndo(room);
    recordFrame(room);
    await persistRooms();
    return send(response, 200, { game: room.game });
  }

  if (["buy", "move", "attack", "capture", "wait", "drop", "end-turn", "undo"].includes(action)) {
    if (!player) return send(response, 404, { error: "You are no longer in this room." });
    normalizeRoom(room);
    if (!room.game) return send(response, 409, { error: "This game hasn't started." });
    player.lastSeen = Date.now();
    const seatIndex = room.game.seats.findIndex((seat) => seat.playerId === playerId);
    if (seatIndex === -1) return send(response, 403, { error: "You aren't playing in this game." });
    if (room.game.winner) return send(response, 409, { error: "The game is over." });

    const before = structuredClone(room.game); // for undo
    if (action === "undo") {
      const error = undoLast(room, seatIndex);
      if (error) return send(response, 400, { error });
      if (room.recording) replays.undo(room);
      await persistRooms();
      return send(response, 200, { game: room.game });
    }

    if (action === "buy") {
      const { x, y, unitId } = body;
      const error = buyError(room.game, room.gameUnits, seatIndex, x, y, unitId);
      if (error) return send(response, 400, { error });
      applyBuy(room.game, room.gameUnits, seatIndex, x, y, unitId);
    } else if (action === "move") {
      const { unitId, path } = body;
      const error = moveError(room.game, room.gameMap, room.gameUnits, seatIndex, unitId, path);
      if (error) return send(response, 400, { error });
      applyMove(room.game, unitId, path, room.gameUnits, room.gameMap);
    } else if (action === "attack") {
      // The tile to attack (an enemy unit or a blockade); targetId picks one of two units on a bridge.
      const { unitId, x, y, targetId = null } = body;
      const error = attackError(room.game, room.gameUnits, seatIndex, unitId, x, y, targetId);
      if (error) return send(response, 400, { error });
      applyAttack(room.game, room.gameUnits, unitId, x, y, targetId);
    } else if (action === "capture") {
      const error = captureError(room.game, room.gameUnits, seatIndex, body.unitId);
      if (error) return send(response, 400, { error });
      applyCapture(room.game, room.gameUnits, body.unitId);
    } else if (action === "drop") {
      const { unitId, cargoId, x, y } = body;
      const error = dropError(room.game, room.gameMap, room.gameUnits, seatIndex, unitId, cargoId, x, y);
      if (error) return send(response, 400, { error });
      applyDrop(room.game, unitId, cargoId, x, y);
    } else if (action === "wait") {
      const error = waitError(room.game, room.gameUnits, seatIndex, body.unitId);
      if (error) return send(response, 400, { error });
      applyWait(room.game, body.unitId);
    } else {
      if (seatIndex !== room.game.active) return send(response, 400, { error: "It's not your turn." });
      const connected = (id) => cleanPlayers(room).some((current) => current.id === id);
      endTurn(room.game, connected, room.gameUnits);
    }
    if (action === "end-turn" || room.game.winner) {
      clearUndo(room); // can't undo into a previous turn, or out of a finished game
    } else {
      before.undoSeat = null;
      room.gameUndo = { seatIndex, snapshot: before };
      room.game.undoSeat = seatIndex;
    }
    recordFrame(room);
    await persistRooms();
    return send(response, 200, { game: room.game });
  }

  if (action === "leave") {
    room.players = room.players.filter((current) => current.id !== playerId);
    await persistRooms();
    return send(response, 200, { room: publicRoom(room) });
  }
}

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    console.error(error);
    send(response, error.status ?? 500, {
      error: error.status ? error.message : "The server could not complete the request.",
    });
  }
});

rooms = await readJsonArray(roomsFile);
maps = await readJsonArray(mapsFile, { seed: true });
units = withDefaults(await readJsonArray(unitsFile, { seed: true }));
buildings = buildingsWithDefaults(await readJsonArray(buildingsFile, { seed: true }));
await replays.load();

setInterval(() => closeEmptyRooms().catch((error) => console.error(error)), roomSweepMs);

server.listen(port, () => {
  console.log(`Seize listening on http://localhost:${port} (data in ${dataDirectory})`);
});

// On redeploy/stop (Railway sends SIGTERM), stop taking requests and finish any pending saves.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down...`);
    server.close();
    Promise.allSettled([saveQueue, replays.flush()]).finally(() => process.exit(0));
  });
}
