// Replays: every game state of a finished game, so it can be watched again.
//
// While a game runs, each state is appended as one line to recordings/<roomId>.ndjson (cheap to
// write, survives restarts). Undo appends an "undo" line that removes the previous state.
// When a game is won, the recording becomes replays/<id>.json.gz and is listed in replays.json.
//
// The replays folder never grows past REPLAY_STORAGE_LIMIT_MB: before a new replay is written, the
// oldest replays are deleted until it fits.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);
const MB = 1024 * 1024;
const REPLAY_EXTENSION = ".json.gz";
const REPLAY_ID = /^[a-z0-9]{6,32}$/;

export function createReplayStore(dataDirectory, { limitBytes } = {}) {
  const recordingsDirectory = path.join(dataDirectory, "recordings");
  const replaysDirectory = path.join(dataDirectory, "replays");
  const indexFile = path.join(dataDirectory, "replays.json");
  const limit = Math.floor(limitBytes ?? (Number(process.env.REPLAY_STORAGE_LIMIT_MB) || 200) * MB);
  let index = []; // replay summaries, newest first
  // One queue for every replay file operation, so appends, saves and deletes never interleave.
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task, task);
    queue = run.catch((error) => console.error("Replay storage:", error));
    return queue;
  };

  const recordingFile = (roomId) => path.join(recordingsDirectory, `${roomId}.ndjson`);
  const replayFile = (id) => path.join(replaysDirectory, `${id}${REPLAY_EXTENSION}`);

  async function writeIndex() {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(`${indexFile}.tmp`, JSON.stringify(index, null, 2), "utf8");
    await rename(`${indexFile}.tmp`, indexFile);
  }

  /** Replay files on disk, oldest first: [{ id, file, bytes, time }]. */
  async function filesOnDisk() {
    await mkdir(replaysDirectory, { recursive: true });
    const names = (await readdir(replaysDirectory)).filter((name) => name.endsWith(REPLAY_EXTENSION));
    const files = await Promise.all(names.map(async (name) => {
      const file = path.join(replaysDirectory, name);
      const info = await stat(file);
      return { id: name.slice(0, -REPLAY_EXTENSION.length), file, bytes: info.size, time: info.mtimeMs };
    }));
    return files.sort((a, b) => a.time - b.time);
  }

  /** Deletes the oldest replays until `incoming` more bytes fit under the limit. */
  async function makeRoom(incoming) {
    const files = await filesOnDisk();
    let used = files.reduce((total, file) => total + file.bytes, 0);
    const removed = new Set();
    for (const file of files) {
      if (used + incoming <= limit) break;
      await unlink(file.file).catch(() => {});
      used -= file.bytes;
      removed.add(file.id);
      console.log(`Replay storage full: deleted oldest replay ${file.id} (${file.bytes} bytes)`);
    }
    if (removed.size) index = index.filter((entry) => !removed.has(entry.id));
  }

  /**
   * Saves a replay ({ roomName, startedAt, endedAt, map, unitDefs, frames, source?, note? }) and lists
   * it. Returns its summary, or null if it's bigger than the whole storage limit.
   */
  async function writeReplay({ roomName, startedAt, endedAt, map, unitDefs, frames, source, note }) {
    const last = frames[frames.length - 1];
    const winner = last.seats.find((seat) => seat.owner === last.winner);
    const summary = {
      id: `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
      roomName,
      mapName: map.name,
      width: map.width,
      height: map.height,
      players: last.seats.map(({ name, owner }) => ({ name, owner })),
      winner: winner ? { name: winner.name, owner: winner.owner } : null,
      turns: last.turn,
      frames: frames.length,
      startedAt,
      endedAt,
      ...(source ? { source } : {}),
      ...(note ? { note } : {}),
    };
    const data = await gzip(JSON.stringify({ ...summary, map, unitDefs, frames }));
    summary.bytes = data.length;
    if (data.length > limit) return null;
    await makeRoom(data.length);
    await writeFile(replayFile(summary.id), data);
    index.unshift(summary);
    await writeIndex();
    console.log(`Saved replay ${summary.id} (${data.length} bytes, ${frames.length} states)`);
    return summary;
  }

  return {
    limitBytes: limit,

    /** Loads the index and drops entries whose file is gone. */
    async load() {
      try {
        index = JSON.parse(await readFile(indexFile, "utf8"));
        if (!Array.isArray(index)) index = [];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        index = [];
      }
      const onDisk = new Set((await filesOnDisk()).map((file) => file.id));
      const before = index.length;
      index = index.filter((entry) => onDisk.has(entry.id));
      if (index.length !== before) await writeIndex();
    },

    list() {
      return index;
    },

    async usedBytes() {
      return (await filesOnDisk()).reduce((total, file) => total + file.bytes, 0);
    },

    isValidId: (id) => REPLAY_ID.test(id),

    /** The gzipped replay file, or null. */
    async read(id) {
      if (!REPLAY_ID.test(id) || !index.some((entry) => entry.id === id)) return null;
      try {
        return await readFile(replayFile(id));
      } catch {
        return null;
      }
    },

    remove(id) {
      return enqueue(async () => {
        await unlink(replayFile(id)).catch(() => {});
        index = index.filter((entry) => entry.id !== id);
        await writeIndex();
      });
    },

    /** Starts a recording: the game's setup and its first state. */
    start(room) {
      const header = {
        start: {
          roomName: room.name,
          startedAt: room.startedAt,
          map: room.gameMap,
          unitDefs: room.gameUnits,
        },
      };
      const lines = `${JSON.stringify(header)}\n${JSON.stringify({ frame: room.game })}\n`;
      return enqueue(async () => {
        await mkdir(recordingsDirectory, { recursive: true });
        await writeFile(recordingFile(room.id), lines, "utf8");
      });
    },

    /** Adds the room's current game state. */
    frame(room) {
      const line = `${JSON.stringify({ frame: room.game })}\n`;
      return enqueue(() => appendFile(recordingFile(room.id), line, "utf8"));
    },

    /** The last change was undone: the previous state is dropped from the replay. */
    undo(room) {
      return enqueue(() => appendFile(recordingFile(room.id), `{"undo":true}\n`, "utf8"));
    },

    /** Throws the recording away (game abandoned, or replays turned off). */
    discard(roomId) {
      return enqueue(() => unlink(recordingFile(roomId)).catch(() => {}));
    },

    /** Turns a won game's recording into a saved replay, freeing space first if needed. */
    finish(room) {
      return enqueue(async () => {
        let text;
        try {
          text = await readFile(recordingFile(room.id), "utf8");
        } catch {
          return; // nothing was recorded
        }
        let setup = null;
        const frames = [];
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue; // a half-written line from a crash
          }
          if (entry.start) setup = entry.start;
          else if (entry.frame) frames.push(entry.frame);
          else if (entry.undo && frames.length > 1) frames.pop();
        }
        await unlink(recordingFile(room.id)).catch(() => {});
        if (!setup || frames.length === 0) return;

        const summary = await writeReplay({
          roomName: setup.roomName,
          startedAt: setup.startedAt,
          endedAt: new Date().toISOString(),
          map: setup.map,
          unitDefs: setup.unitDefs,
          frames,
        });
        if (!summary) console.warn(`Replay of room ${room.id} is bigger than the whole replay limit; not saved.`);
      });
    },

    /** Saves an uploaded replay (see writeReplay). Resolves to its summary; rejects (413) if it can't fit. */
    save(replay) {
      return new Promise((resolve, reject) => {
        enqueue(async () => {
          try {
            const summary = await writeReplay(replay);
            if (summary) resolve(summary);
            else reject(Object.assign(new Error("That replay is bigger than the whole replay storage limit."), { status: 413 }));
          } catch (error) {
            reject(error);
          }
        });
      });
    },

    /** Waits for pending replay writes (used on shutdown). */
    flush: () => queue,
  };
}
