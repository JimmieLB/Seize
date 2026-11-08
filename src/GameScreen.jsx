import { useEffect, useRef, useState } from "react";
import {
  CAPTURE_TARGET,
  MAX_HP,
  PRODUCTION,
  attackBonus,
  attackTargets,
  buildingAt,
  buyError,
  canBoard,
  canMove,
  captureError,
  captureGain,
  captureProgress,
  cargoOf,
  dropTiles,
  hpOf,
  incomeFor,
  moveCost,
  pathCost,
  pathTo,
  previewAttack,
  propertyAt,
  reachable,
  unitAt,
  unitSpeed,
} from "../shared/gameRules.js";
import { api } from "./api.js";
import { MapView } from "./map/MapView.js";
import { PLAYERS, fromSaved } from "./map/mapModel.js";
import { getSheet } from "./map/renderMap.js";
import TileIcon from "./map/TileIcon.jsx";
import { KIND_LABELS, arrowTiles, unitTile } from "./map/tiles.js";

const POLL_MS = 1000;
const formatFunds = (value) => `$${value.toLocaleString()}`;
const RANGE_TINT = "rgba(70, 160, 255, 0.35)";
const TARGET_TINT = "rgba(255, 60, 60, 0.45)";
const DROP_TINT = "rgba(76, 217, 100, 0.5)";
const DIGIT_TILE = 180; // tiles 180-189 are the digits 0-9 (cargo count on transports)
const CURSOR_TILE = 61;
const CAPTURE_BADGE_TILE = 194; // small white flag
const sameCell = (a, b) => a.x === b.x && a.y === b.y;

/**
 * Next path while dragging: backtracking trims the path, an adjacent affordable step extends it,
 * and anything else snaps to the cheapest path to that tile (if it's in range).
 */
function extendPath(drag, map, game, cell) {
  const { path, reach, def, unit } = drag;
  const last = path[path.length - 1];
  if (sameCell(cell, last)) return path;
  const existing = path.findIndex((step) => sameCell(step, cell));
  if (existing !== -1) return path.slice(0, existing + 1);
  const index = cell.y * map.width + cell.x;
  if (!reach.has(index)) return path;
  const adjacent = Math.abs(cell.x - last.x) + Math.abs(cell.y - last.y) === 1;
  const other = unitAt(game, cell.x, cell.y);
  const blocked = other && other.owner !== unit.owner;
  if (adjacent && !blocked && pathCost(map, def, path) + moveCost(map, def, cell.x, cell.y) <= unitSpeed(def, unit)) {
    return [...path, cell];
  }
  return pathTo(reach, map, index);
}


function GameScreen({ room, playerId, onLeave }) {
  const canvasRef = useRef(null);
  const viewRef = useRef(null);
  const modelRef = useRef(null); // map model drawn by the view; property owners are synced into it
  const handlersRef = useRef({});
  const dragRef = useRef(null); // { unit, def, reach, path } while dragging a unit
  const lastActionRef = useRef(null);
  const [setup, setSetup] = useState(null); // { map (saved format), unitDefs }
  const [game, setGame] = useState(null);
  const [shop, setShop] = useState(null); // { x, y, kind, side } of the building being bought from
  const [selectedId, setSelectedId] = useState(null); // unit choosing an action (capture / attack / wait)
  const [droppingId, setDroppingId] = useState(null); // cargo unit being dropped from the selected transport
  const [hover, setHover] = useState(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null); // { text, tone }
  const [busy, setBusy] = useState(false);

  const notify = (text, tone = "error") => setToast({ text, tone });
  // Only ever move forward: a slow poll must not overwrite a newer state from our own action.
  const acceptGame = (latest) => setGame((current) => (current && current.version >= latest.version ? current : latest));

  useEffect(() => {
    let view;
    let cancelled = false;
    Promise.all([
      getSheet(),
      api(`/api/rooms/${room.id}/map`),
      api(`/api/rooms/${room.id}/units`),
      api(`/api/rooms/${room.id}/game`),
    ])
      .then(([sheet, { map }, { units }, { game: initial }]) => {
        if (cancelled) return;
        view = new MapView(canvasRef.current, sheet, {
          onCellClick: (cell) => handlersRef.current.click(cell),
          onPaint: (x, y) => handlersRef.current.drag({ x, y }),
          onPaintEnd: () => handlersRef.current.drop(),
          onHover: (cell) => setHover(cell),
        });
        view.setGrid(false);
        modelRef.current = fromSaved(map);
        view.setMap(modelRef.current, { fit: true });
        viewRef.current = view;
        lastActionRef.current = initial.lastAction?.version ?? null;
        setSetup({ map, unitDefs: units });
        setGame(initial);
      })
      .catch((requestError) => !cancelled && setError(requestError.message));
    return () => {
      cancelled = true;
      view?.dispose();
      viewRef.current = null;
    };
  }, [room.id]);

  useEffect(() => {
    if (!setup) return undefined;
    const intervalId = window.setInterval(() => {
      api(`/api/rooms/${room.id}/game`).then(({ game: latest }) => acceptGame(latest)).catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [setup, room.id]);

  const defsById = setup ? new Map(setup.unitDefs.map((def) => [def.id, def])) : new Map();
  const mySeatIndex = game ? game.seats.findIndex((seat) => seat.playerId === playerId) : -1;
  const mySeat = game?.seats[mySeatIndex];
  const myTurn = Boolean(game) && mySeatIndex === game.active;
  const activeSeat = game?.seats[game.active];
  const selected = myTurn ? game.units.find((unit) => unit.id === selectedId && !unit.acted) ?? null : null;
  const selectedDef = selected ? defsById.get(selected.unitId) : null;
  const targets = selected ? attackTargets(game, setup.unitDefs, mySeatIndex, selected) : [];
  const cargo = selected ? cargoOf(game, selected) : [];
  const dropping = cargo.find((unit) => unit.id === droppingId) ?? null;
  const dropTargets = dropping ? dropTiles(game, setup.map, setup.unitDefs, selected, dropping) : [];

  useEffect(() => setDroppingId(null), [selectedId]);

  // Units, health bars and capture flags.
  useEffect(() => {
    if (!game || !setup || !viewRef.current) return;
    const activeOwner = game.seats[game.active].owner;
    viewRef.current.setUnits(
      game.units.filter((unit) => !unit.carriedBy).map((unit) => {
        const badges = [];
        if (propertyAt(game, unit.x, unit.y)?.capture?.unitId === unit.id) badges.push({ tile: CAPTURE_BADGE_TILE, corner: "tl" });
        const carrying = cargoOf(game, unit).length;
        if (carrying > 0) badges.push({ tile: DIGIT_TILE + carrying, corner: "tr" });
        return {
          x: unit.x,
          y: unit.y,
          tile: unitTile(defsById.get(unit.unitId).sprite, unit.owner),
          dim: unit.acted && unit.owner === activeOwner, // done for this turn
          badges,
          health: hpOf(unit) < MAX_HP ? hpOf(unit) : undefined, // health bar only when damaged
        };
      }),
    );
  }, [game, setup]);

  // Captured buildings/flags change colour.
  useEffect(() => {
    const model = modelRef.current;
    if (!game || !model || !viewRef.current) return;
    for (const property of game.properties) {
      const object = model.objects[property.y * model.width + property.x];
      if (object && object.owner !== property.owner) {
        object.owner = property.owner;
        viewRef.current.markDirty(property.x, property.y);
      }
    }
  }, [game]);

  // Tell everyone what just happened (attacks, captures).
  useEffect(() => {
    const action = game?.lastAction;
    if (!action || action.version === lastActionRef.current) return;
    lastActionRef.current = action.version;
    notify(action.text, "info");
  }, [game]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeoutId = window.setTimeout(() => setToast(null), toast.tone === "info" ? 3500 : 2500);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    if (!myTurn) {
      setShop(null);
      setSelectedId(null);
    }
  }, [myTurn]);

  function renderOverlay() {
    const view = viewRef.current;
    if (!view || !setup) return;
    const width = setup.map.width;
    const cells = new Map();
    const drag = dragRef.current;
    if (drag) {
      for (const index of drag.reach.keys()) cells.set(index, { x: index % width, y: Math.floor(index / width), tint: RANGE_TINT });
      for (const arrow of arrowTiles(drag.path)) {
        const index = arrow.y * width + arrow.x;
        cells.set(index, { ...cells.get(index), ...arrow });
      }
    } else if (selected) {
      cells.set(selected.y * width + selected.x, { x: selected.x, y: selected.y, tile: CURSOR_TILE });
      for (const target of targets) cells.set(target.y * width + target.x, { x: target.x, y: target.y, tint: TARGET_TINT });
      for (const tile of dropTargets) cells.set(tile.y * width + tile.x, { x: tile.x, y: tile.y, tint: DROP_TINT });
    }
    view.setOverlay([...cells.values()]);
  }

  useEffect(renderOverlay);

  function startDrag(unit) {
    const def = defsById.get(unit.unitId);
    setShop(null);
    setSelectedId(null);
    dragRef.current = {
      unit,
      def,
      reach: reachable(game, setup.map, def, unit, setup.unitDefs),
      path: [{ x: unit.x, y: unit.y }],
    };
    renderOverlay();
  }

  async function dropDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    renderOverlay();
    if (drag.path.length < 2) {
      setSelectedId(drag.unit.id); // clicked without dragging: choose an action here
      return;
    }
    const end = drag.path[drag.path.length - 1];
    const occupant = unitAt(game, end.x, end.y);
    if (occupant && occupant.id !== drag.unit.id && !canBoard(game, setup.unitDefs, occupant, drag.unit)) {
      notify("Units can't stop on another unit.");
      return;
    }
    const updated = await gameAction("move", { unitId: drag.unit.id, path: drag.path });
    const moved = updated?.units.find((unit) => unit.id === drag.unit.id);
    if (moved && !moved.carriedBy) setSelectedId(drag.unit.id); // after moving, pick capture / attack / wait
  }

  function clickUnit(unit) {
    // Attacking: with a unit selected, clicking an enemy in range attacks it.
    if (selected && unit.owner !== selected.owner) {
      if (targets.some((target) => target.id === unit.id)) {
        gameAction("attack", { unitId: selected.id, targetId: unit.id }).then((updated) => updated && setSelectedId(null));
      } else {
        notify(selectedDef.attack > 0 ? "That target is out of range." : `${selectedDef.name} can't attack.`);
      }
      return;
    }
    if (unit.owner !== mySeat?.owner) return;
    if (!myTurn) return notify("Wait for your turn.");
    if (canMove(unit)) return startDrag(unit);
    if (unit.acted) return notify("That unit can't act again until your next turn.");
    setSelectedId(unit.id); // moved but hasn't acted yet
  }

  handlersRef.current.drag = (cell) => {
    if (!dragRef.current) return;
    const path = extendPath(dragRef.current, setup.map, game, cell);
    if (path !== dragRef.current.path) {
      dragRef.current.path = path;
      renderOverlay();
    }
  };
  handlersRef.current.drop = dropDrag;
  handlersRef.current.click = (cell) => {
    if (!game || !setup) return;
    if (dropping) {
      if (dropTargets.some((tile) => sameCell(tile, cell))) {
        gameAction("drop", { unitId: selected.id, cargoId: dropping.id, x: cell.x, y: cell.y }).then(() => setDroppingId(null));
      } else {
        setDroppingId(null);
      }
      return;
    }
    const unit = unitAt(game, cell.x, cell.y);
    if (unit) return clickUnit(unit);
    setSelectedId(null);
    const building = buildingAt(game, cell.x, cell.y);
    if (!building || !PRODUCTION[building.kind]) return setShop(null);
    if (!myTurn) return notify("Wait for your turn.");
    if (building.owner !== mySeat?.owner) return notify("That isn't your building.");
    // Open the panel on the side of the screen away from the building so it stays visible.
    const side = (viewRef.current?.cellScreenX(cell.x) ?? 0) < 0.5 ? "right" : "left";
    return setShop({ x: cell.x, y: cell.y, kind: building.kind, side });
  };

  /** Sends an action; resolves to the new game state, or null if it was refused. */
  async function gameAction(action, body = {}) {
    setBusy(true);
    try {
      const { game: updated } = await api(`/api/rooms/${room.id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ playerId, ...body }),
      });
      acceptGame(updated);
      setShop(null);
      return updated;
    } catch (requestError) {
      notify(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const connected = (id) => room.players.some((player) => player.id === id);
  const shopUnits = shop ? setup.unitDefs.filter((def) => def.type === PRODUCTION[shop.kind]) : [];

  // Action panel details for the selected unit.
  const canCapture = selected && !captureError(game, setup.unitDefs, mySeatIndex, selected.id);
  const progress = selected ? captureProgress(game, selected) : 0;
  const hoverTarget = selected && hover ? targets.find((target) => sameCell(target, hover)) : null;
  const preview = hoverTarget ? previewAttack(game, setup.unitDefs, selected, hoverTarget) : null;

  return (
    <div className="game-screen">
      <canvas ref={canvasRef} className="game-canvas" />
      <button className="btn btn-red game-leave" onClick={onLeave}>Leave room</button>

      {game && (
        <div className="turn-banner" style={{ "--owner": PLAYERS[activeSeat.owner].color }}>
          <span>Turn {game.turn}</span>
          <strong>{myTurn ? "Your turn" : `${activeSeat.name}'s turn`}</strong>
        </div>
      )}

      {game && (
        <div className="game-info">
          <strong>{room.name}</strong>
          {game.seats.map((seat, index) => (
            <span key={seat.playerId} className={index === game.active ? "seat-active" : ""}>
              <i style={{ background: PLAYERS[seat.owner].color }} />
              <span className="seat-name">
                {seat.name}
                {seat.playerId === playerId ? " (you)" : ""}
                {!connected(seat.playerId) ? " (left)" : ""}
              </span>
              <b>{formatFunds(seat.funds)}</b>
              <small title="Income per day">+{formatFunds(incomeFor(game, seat.owner))}</small>
            </span>
          ))}
        </div>
      )}

      {myTurn && !shop && !selected && (
        <div className="game-hint">Drag a unit to move it (onto a transport to board), or click your factory, airport or port to buy units.</div>
      )}

      {selected && (
        <section className="panel action-panel" aria-label="Unit actions">
          <div className="action-unit">
            <TileIcon tile={unitTile(selectedDef.sprite, selected.owner)} size={40} />
            <div>
              <strong>{selectedDef.name}</strong>
              <span>
                Health {hpOf(selected)}% · Atk {selectedDef.attack + attackBonus(game, selectedDef, selected.owner)}
              </span>
            </div>
          </div>
          {cargo.length > 0 && (
            <ul className="cargo-list">
              {cargo.map((unit) => {
                const def = defsById.get(unit.unitId);
                const canDrop = dropTiles(game, setup.map, setup.unitDefs, selected, unit).length > 0;
                return (
                  <li key={unit.id}>
                    <TileIcon tile={unitTile(def.sprite, unit.owner)} size={28} />
                    <span>{def.name} · {hpOf(unit)}%</span>
                    <button
                      className={`btn btn-small ${droppingId === unit.id ? "btn-green" : "btn-blue"}`}
                      disabled={busy || !canDrop}
                      title={canDrop ? undefined : "No free tile next to the transport"}
                      onClick={() => setDroppingId(droppingId === unit.id ? null : unit.id)}
                    >
                      Drop
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {dropping ? (
            <p className="action-note">Click a green tile to drop the {defsById.get(dropping.unitId).name}.</p>
          ) : preview ? (
            <p className="action-note">
              Attack {hoverTarget && defsById.get(hoverTarget.unitId).name}: deal <b>{preview.dealt}%</b>
              {preview.counter > 0 ? <>, take <b>{preview.counter}%</b> back</> : null}
            </p>
          ) : targets.length > 0 ? (
            <p className="action-note">Click a red enemy to attack.</p>
          ) : null}
          <div className="action-buttons">
            {canCapture && (
              <button className="btn btn-blue btn-small" disabled={busy} onClick={() => gameAction("capture", { unitId: selected.id }).then((updated) => updated && setSelectedId(null))}>
                Capture {progress}% → {Math.min(CAPTURE_TARGET, progress + captureGain(selected))}%
              </button>
            )}
            <button className="btn btn-gray btn-small" disabled={busy} onClick={() => gameAction("wait", { unitId: selected.id }).then((updated) => updated && setSelectedId(null))}>
              Wait
            </button>
            <button className="action-cancel" onClick={() => setSelectedId(null)}>Cancel</button>
          </div>
        </section>
      )}

      {game && (
        <button className="btn btn-green game-end-turn" disabled={!myTurn || busy} onClick={() => gameAction("end-turn")}>
          {myTurn ? "End turn" : "Waiting..."}
        </button>
      )}

      {shop && (
        <section className={`panel shop shop-${shop.side}`} aria-label="Buy units">
          <header className="shop-head">
            <h2>{KIND_LABELS[shop.kind]}</h2>
            <span>Funds: <b>{formatFunds(mySeat.funds)}</b></span>
            <button className="shop-close" onClick={() => setShop(null)} aria-label="Close">×</button>
          </header>
          <ul className="shop-list">
            {shopUnits.map((def) => {
              const reason = buyError(game, setup.unitDefs, mySeatIndex, shop.x, shop.y, def.id);
              return (
                <li key={def.id}>
                  <TileIcon tile={unitTile(def.sprite, mySeat.owner)} size={40} />
                  <div className="shop-unit">
                    <strong>{def.name}</strong>
                    <span>
                      Spd {def.speed} · Atk {def.attack}
                      {attackBonus(game, def, mySeat.owner) > 0 && <em> +{attackBonus(game, def, mySeat.owner)}</em>} · Def {def.defense}
                    </span>
                  </div>
                  <button
                    className="btn btn-blue btn-small"
                    disabled={Boolean(reason) || busy}
                    title={reason ?? undefined}
                    onClick={() => gameAction("buy", { x: shop.x, y: shop.y, unitId: def.id })}
                  >
                    {formatFunds(def.price)}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {toast && <div className={`game-toast game-toast-${toast.tone}`} role="status">{toast.text}</div>}
      {error && <div className="game-error">{error}</div>}
    </div>
  );
}

export default GameScreen;
