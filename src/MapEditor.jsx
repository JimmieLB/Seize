import { useCallback, useEffect, useRef, useState } from "react";
import { BUILDING_KINDS, MAP_LIMITS } from "../shared/mapFormat.js";
import { api } from "./api.js";
import { MapView } from "./map/MapView.js";
import {
  PLAYERS,
  applyTool,
  clampSize,
  cloneMap,
  createMap,
  fromSaved,
  mirrorTargets,
  resizeMap,
  setPlayerCount,
  summarize,
  symmetryMode,
  toSaved,
} from "./map/mapModel.js";
import { loadSheet } from "./map/renderMap.js";
import TileIcon from "./map/TileIcon.jsx";
import { KIND_LABELS, SHEET_URL, objectTile } from "./map/tiles.js";

const TERRAIN_TOOLS = [
  { id: "land", label: "Land", tile: 0 },
  { id: "water", label: "Water", tile: 37 },
  { id: "road", label: "Road", tile: 110 },
  { id: "erase", label: "Erase", tile: null },
];
const OBJECT_TOOLS = [...BUILDING_KINDS, "flag"];
const UNDO_LIMIT = 50;
const PLAYER_OPTIONS = Array.from(
  { length: MAP_LIMITS.maxPlayers - MAP_LIMITS.minPlayers + 1 },
  (_, index) => MAP_LIMITS.minPlayers + index,
);

const mirrorFor = (mapRef, mode) =>
  mode === "off" ? null : (cell) => mirrorTargets(mapRef.current, mode, cell.x, cell.y);

const pickMeta = ({ name, width, height, players }) => ({ name, width, height, players });

function isTyping() {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
}

/** `readOnly`: non-admins can open and look at maps but not edit, save or delete them. */
function MapEditor({ onExit, readOnly = false }) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const canvasRef = useRef(null);
  const viewRef = useRef(null);
  const mapRef = useRef(createMap());
  const undoRef = useRef([]);
  const strokeRef = useRef({ changed: false, message: "" });
  const toolRef = useRef("land");
  const ownerRef = useRef(1);
  const modeRef = useRef("off");

  const [tool, setTool] = useState("land");
  const [owner, setOwner] = useState(1);
  const [meta, setMeta] = useState(() => pickMeta(mapRef.current));
  const [sizeDraft, setSizeDraft] = useState({ width: "20", height: "14" });
  const [summary, setSummary] = useState(() => summarize(mapRef.current));
  const [grid, setGrid] = useState(true);
  const [mapId, setMapId] = useState(null);
  const [unsaved, setUnsaved] = useState(false);
  const [status, setStatus] = useState(null);
  const [undoCount, setUndoCount] = useState(0);
  const [hover, setHover] = useState(null);
  const [savedMaps, setSavedMaps] = useState(null);
  const [saving, setSaving] = useState(false);
  const [symmetryOn, setSymmetryOn] = useState(false);
  const [axis, setAxis] = useState("vertical");

  const symmetryAvailable = meta.players === 2 || meta.players === 4;
  const mode = symmetryMode(meta.players, symmetryOn, axis);
  toolRef.current = tool;
  ownerRef.current = owner;
  modeRef.current = mode;

  useEffect(() => {
    viewRef.current?.setMirror(mirrorFor(mapRef, mode));
  }, [mode]);

  const pushUndo = useCallback(() => {
    undoRef.current.push(cloneMap(mapRef.current));
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
  }, []);

  const clearUndo = useCallback(() => {
    undoRef.current = [];
    setUndoCount(0);
  }, []);

  /** Replaces the whole map and syncs UI + view. */
  const replaceMap = useCallback((map, { fit = false } = {}) => {
    mapRef.current = map;
    setMeta(pickMeta(map));
    setSizeDraft({ width: String(map.width), height: String(map.height) });
    setSummary(summarize(map));
    setOwner((current) => Math.min(current, map.players));
    viewRef.current?.setMap(map, { fit });
  }, []);

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    setUndoCount(undoRef.current.length);
    replaceMap(previous);
    setUnsaved(true);
  }, [replaceMap]);

  useEffect(() => {
    let view;
    let cancelled = false;
    loadSheet(SHEET_URL)
      .then((sheet) => {
        if (cancelled) return;
        view = new MapView(canvasRef.current, sheet, {
          onPaintStart: () => {
            if (readOnlyRef.current) return;
            undoRef.current.push(cloneMap(mapRef.current));
            strokeRef.current = { changed: false, message: "" };
          },
          onPaint: (x, y) => {
            if (readOnlyRef.current) return;
            const map = mapRef.current;
            for (const target of mirrorTargets(map, modeRef.current, x, y, ownerRef.current)) {
              const result = applyTool(map, target.x, target.y, toolRef.current, target.owner);
              for (const [cx, cy] of result.changed) view.markDirty(cx, cy);
              if (result.changed.length) strokeRef.current.changed = true;
              if (result.message) strokeRef.current.message = result.message;
            }
          },
          onPaintEnd: () => {
            if (readOnlyRef.current) return;
            const { changed, message } = strokeRef.current;
            if (changed) {
              if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
              setUnsaved(true);
              setSummary(summarize(mapRef.current));
            } else {
              undoRef.current.pop();
            }
            setUndoCount(undoRef.current.length);
            setStatus(message ? { text: message, error: true } : null);
          },
          onHover: setHover,
        });
        view.setGrid(true);
        view.panWithLeftButton = readOnlyRef.current; // nothing to paint in view-only mode
        view.updateCursor();
        view.setMirror(mirrorFor(mapRef, modeRef.current));
        view.setMap(mapRef.current, { fit: true });
        viewRef.current = view;
      })
      .catch(() => setStatus({ text: "Couldn't load the tile sheet.", error: true }));
    return () => {
      cancelled = true;
      view?.dispose();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (readOnlyRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isTyping()) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  useEffect(() => {
    if (!unsaved) return undefined;
    const warn = (event) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function confirmDiscard() {
    return !unsaved || window.confirm("You have unsaved changes. Discard them?");
  }

  function changeName(name) {
    mapRef.current.name = name;
    setMeta(pickMeta(mapRef.current));
    setUnsaved(true);
  }

  function changePlayers(players) {
    pushUndo();
    setPlayerCount(mapRef.current, players);
    setMeta(pickMeta(mapRef.current));
    setSummary(summarize(mapRef.current));
    setOwner((current) => Math.min(current, players));
    viewRef.current?.redrawAll();
    setUnsaved(true);
  }

  function applySize(event) {
    event.preventDefault();
    const width = clampSize(sizeDraft.width);
    const height = clampSize(sizeDraft.height);
    setSizeDraft({ width: String(width), height: String(height) });
    if (width === mapRef.current.width && height === mapRef.current.height) return;
    pushUndo();
    replaceMap(resizeMap(mapRef.current, width, height), { fit: true });
    setUnsaved(true);
  }

  function newMap() {
    if (!confirmDiscard()) return;
    clearUndo();
    setMapId(null);
    replaceMap(createMap(), { fit: true });
    setUnsaved(false);
    setStatus(null);
  }

  async function saveMap() {
    if (!mapRef.current.name.trim()) {
      setStatus({ text: "Give the map a name first.", error: true });
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify(toSaved(mapRef.current));
      const { map } = mapId
        ? await api(`/api/maps/${mapId}`, { method: "PUT", body })
        : await api("/api/maps", { method: "POST", body });
      setMapId(map.id);
      setUnsaved(false);
      setStatus({ text: "Map saved." });
    } catch (error) {
      setStatus({ text: error.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  // Viewers start by picking a map to look at.
  useEffect(() => {
    if (readOnly) showOpenDialog();
  }, []);

  async function showOpenDialog() {
    setSavedMaps("loading");
    try {
      const { maps } = await api("/api/maps");
      setSavedMaps(maps);
    } catch (error) {
      setSavedMaps(null);
      setStatus({ text: error.message, error: true });
    }
  }

  async function openMap(id) {
    if (!confirmDiscard()) return;
    try {
      const { map } = await api(`/api/maps/${id}`);
      clearUndo();
      replaceMap(fromSaved(map), { fit: true });
      setMapId(map.id);
      setUnsaved(false);
      setSavedMaps(null);
      setStatus(null);
    } catch (error) {
      setStatus({ text: error.message, error: true });
    }
  }

  async function deleteMap(saved) {
    if (!window.confirm(`Delete "${saved.name}"? This can't be undone.`)) return;
    try {
      await api(`/api/maps/${saved.id}`, { method: "DELETE" });
      setSavedMaps((current) => current.filter((item) => item.id !== saved.id));
      if (saved.id === mapId) {
        setMapId(null);
        setUnsaved(true);
      }
    } catch (error) {
      setStatus({ text: error.message, error: true });
    }
  }

  function exit() {
    if (confirmDiscard()) onExit();
  }

  function toggleGrid(value) {
    setGrid(value);
    viewRef.current?.setGrid(value);
  }

  const missingHq = summary.slice(1).map((entry, index) => (entry.hq ? null : index + 1)).filter(Boolean);

  return (
    <div className="editor">
      <header className="editor-bar">
        <button className="btn btn-gray btn-small" onClick={exit}>← Back</button>
        {readOnly ? (
          <>
            <h1 className="editor-title">{mapId ? meta.name : "Maps"}</h1>
            {mapId && <span className="editor-hint">{meta.width} × {meta.height} · {meta.players} players</span>}
            <span className="view-only">View only — log in as admin to edit</span>
            <div className="editor-actions">
              <button className="btn btn-blue btn-small" onClick={showOpenDialog}>Open</button>
            </div>
          </>
        ) : (
          <>
            <input
              className="editor-name"
              value={meta.name}
              onChange={(event) => changeName(event.target.value)}
              placeholder="Map name"
              maxLength={MAP_LIMITS.nameLength}
              aria-label="Map name"
            />
            <form className="editor-size" onSubmit={applySize}>
              <input
                type="number"
                min={MAP_LIMITS.minSize}
                max={MAP_LIMITS.maxSize}
                value={sizeDraft.width}
                onChange={(event) => setSizeDraft((draft) => ({ ...draft, width: event.target.value }))}
                aria-label="Width in tiles"
              />
              <span>×</span>
              <input
                type="number"
                min={MAP_LIMITS.minSize}
                max={MAP_LIMITS.maxSize}
                value={sizeDraft.height}
                onChange={(event) => setSizeDraft((draft) => ({ ...draft, height: event.target.value }))}
                aria-label="Height in tiles"
              />
              <button className="btn btn-blue btn-small" type="submit">Resize</button>
            </form>
            <label className="editor-players">
              Players
              <select value={meta.players} onChange={(event) => changePlayers(Number(event.target.value))}>
                {PLAYER_OPTIONS.map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
            <div className="editor-symmetry">
              <label
                className="check"
                title={symmetryAvailable ? "Mirror everything you paint; buildings get each player's colour" : "Symmetry needs 2 or 4 players"}
              >
                <input
                  type="checkbox"
                  checked={symmetryOn && symmetryAvailable}
                  disabled={!symmetryAvailable}
                  onChange={(event) => setSymmetryOn(event.target.checked)}
                />
                Symmetry
              </label>
              {mode !== "off" && meta.players === 2 && (
                <select value={axis} onChange={(event) => setAxis(event.target.value)} aria-label="Symmetry axis">
                  <option value="vertical">Vertical (left | right)</option>
                  <option value="horizontal">Horizontal (top / bottom)</option>
                  <option value="both">Vertical and horizontal</option>
                </select>
              )}
              {mode === "quad" && <span className="editor-hint">4-way</span>}
            </div>
            <div className="editor-actions">
              <button className="btn btn-gray btn-small" onClick={newMap}>New</button>
              <button className="btn btn-blue btn-small" onClick={showOpenDialog}>Open</button>
              <button className="btn btn-green btn-small" onClick={saveMap} disabled={saving}>
                {saving ? "Saving..." : unsaved || !mapId ? "Save" : "Saved"}
              </button>
            </div>
          </>
        )}
      </header>

      <div className="editor-body">
        {!readOnly && (
          <aside className="editor-palette">
            <h3>Terrain</h3>
            <div className="tool-grid">
              {TERRAIN_TOOLS.map((item) => (
                <button
                  key={item.id}
                  className={`tool${tool === item.id ? " tool-active" : ""}`}
                  onClick={() => setTool(item.id)}
                  title={item.label}
                >
                  {item.tile === null ? <span className="tool-erase">✕</span> : <TileIcon tile={item.tile} />}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>

            <h3>Owner</h3>
            <div className="owner-row">
              {PLAYERS.slice(0, meta.players + 1).map((player, index) => (
                <button
                  key={player.label}
                  className={`owner${owner === index ? " owner-active" : ""}`}
                  style={{ "--owner": player.color }}
                  onClick={() => setOwner(index)}
                  title={index === 0 ? "Neutral" : `Player ${index} (${player.label})`}
                >
                  {index === 0 ? "N" : `P${index}`}
                </button>
              ))}
            </div>

            <h3>Buildings</h3>
            <div className="tool-grid">
              {OBJECT_TOOLS.map((kind) => (
                <button
                  key={kind}
                  className={`tool${tool === kind ? " tool-active" : ""}`}
                  onClick={() => setTool(kind)}
                  title={KIND_LABELS[kind]}
                >
                  <TileIcon tile={objectTile(kind, kind === "hq" && owner === 0 ? 1 : owner)} />
                  <span>{KIND_LABELS[kind]}</span>
                </button>
              ))}
            </div>

            <h3>Players</h3>
            <ul className="player-summary">
              {summary.map((entry, index) => (
                <li key={index}>
                  <i style={{ background: PLAYERS[index].color }} />
                  <span>{index === 0 ? "Neutral" : `P${index}`}</span>
                  <span>{entry.buildings} bldg · {entry.flags} flag</span>
                  {index > 0 && !entry.hq && <b title="No HQ">!</b>}
                </li>
              ))}
            </ul>
            {missingHq.length > 0 && (
              <p className="editor-warning">No HQ for {missingHq.map((player) => `P${player}`).join(", ")}</p>
            )}

            <div className="palette-footer">
              <label className="check">
                <input type="checkbox" checked={grid} onChange={(event) => toggleGrid(event.target.checked)} />
                Grid
              </label>
              <button className="btn btn-gray btn-small" onClick={undo} disabled={undoCount === 0} title="Undo (Ctrl+Z)">
                Undo
              </button>
            </div>
          </aside>
        )}

        <div className="editor-stage">
          <canvas ref={canvasRef} className="editor-canvas" />
          <div className="editor-hud">
            {hover ? `${hover.x}, ${hover.y}` : `${meta.width} × ${meta.height}`}
            <span>{readOnly ? " · Drag or Space: pan" : " · Left: paint · Right-drag or Space: pan"} · Wheel: zoom</span>
          </div>
          {status && (
            <div className={`editor-toast${status.error ? " editor-toast-error" : ""}`} role="status">
              {status.text}
            </div>
          )}
        </div>
      </div>

      {savedMaps && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSavedMaps(null);
        }}>
          <section className="panel modal" role="dialog" aria-modal="true" aria-labelledby="open-title">
            <h2 id="open-title">Open map</h2>
            <div className="room-list">
              {savedMaps === "loading" ? (
                <div className="room-empty">Loading...</div>
              ) : savedMaps.length === 0 ? (
                <div className="room-empty">No saved maps yet.</div>
              ) : (
                savedMaps.map((saved) => (
                  <div className="room-row" key={saved.id}>
                    <span className="room-name">{saved.name}</span>
                    <span className="room-count">{saved.width}×{saved.height} · {saved.players}P</span>
                    <button className="btn btn-blue btn-small" onClick={() => openMap(saved.id)}>Open</button>
                    {!readOnly && (
                      <button className="btn btn-red btn-small" onClick={() => deleteMap(saved)} aria-label={`Delete ${saved.name}`}>✕</button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-gray" onClick={() => setSavedMaps(null)}>Close</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default MapEditor;
