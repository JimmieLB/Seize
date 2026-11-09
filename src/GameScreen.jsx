import { useEffect, useRef, useState } from "react";
import {
  CAPTURE_TARGET,
  BLOCKADE_HP,
  MAX_HP,
  PRODUCTION,
  attackBonus,
  attackRange,
  attackTargets,
  buildingAt,
  buyError,
  blocksPath,
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
  layerOf,
  stopError,
  unitsAt,
  unitSpeed,
} from "../shared/gameRules.js";
import { api } from "./api.js";
import { isMuted, playSound, preloadSounds, setMuted } from "./sounds.js";
import { MapView } from "./map/MapView.js";
import { PLAYERS, fromSaved } from "./map/mapModel.js";
import { getSheet } from "./map/renderMap.js";
import TileIcon from "./map/TileIcon.jsx";
import { TRAITS } from "../shared/unitFormat.js";
import { KIND_LABELS, arrowTiles, unitTile } from "./map/tiles.js";

const POLL_MS = 1000;
const formatFunds = (value) => `$${value.toLocaleString()}`;
const RANGE_TINT = "rgba(70, 160, 255, 0.35)"; // where a unit can move (dragging, or after a click)
const ATTACK_RANGE_TINT = "rgba(255, 150, 30, 0.45)"; // where a ranged unit can hit (double click)
const DOUBLE_CLICK_MS = 400;
const TARGET_TINT = "rgba(255, 60, 60, 0.45)";
const DROP_TINT = "rgba(76, 217, 100, 0.5)";
const DIGIT_TILE = 180; // tiles 180-189 are the digits 0-9 (cargo count on transports)
const CURSOR_TILE = 61;
const CAPTURE_BADGE_TILE = 194; // small white flag
const sameCell = (a, b) => a.x === b.x && a.y === b.y;
const UNIT_TIP_DELAY_MS = 1000; // hover this long over a unit to see its info card
const TIP_WIDTH = 240;
const TRAIT_LABELS = Object.fromEntries(TRAITS.map((trait) => [trait.id, trait.label]));
const TYPE_LABELS = { land: "Land", air: "Air", sea: "Sea" };

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
  const blocked = blocksPath(game, map, drag.unitDefs, unit, def, cell.x, cell.y);
  if (adjacent && !blocked && pathCost(map, def, path) + moveCost(map, def, cell.x, cell.y) <= unitSpeed(def, unit)) {
    return [...path, cell];
  }
  return pathTo(reach, map, index);
}


/** Info card for the unit(s) on a tile, placed beside the tile (flipped left near the right edge). */
function UnitInfoCard({ game, cell, defsById, view }) {
  const units = unitsAt(game, cell.x, cell.y);
  if (!view || units.length === 0) return null;
  const rect = view.cellClientRect(cell.x, cell.y);
  const left = rect.right + 8 + TIP_WIDTH > window.innerWidth ? rect.left - 8 - TIP_WIDTH : rect.right + 8;
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 8 - 200 * units.length));
  return (
    <div className="unit-tip" style={{ left: Math.max(8, left), top, width: TIP_WIDTH }} role="tooltip">
      {units.map((unit) => {
        const def = defsById.get(unit.unitId);
        const seat = game.seats.find((item) => item.owner === unit.owner);
        const bonus = attackBonus(game, def, unit.owner);
        const speed = unitSpeed(def, unit);
        const range = attackRange(def);
        const cargo = cargoOf(game, unit);
        const capture = propertyAt(game, unit.x, unit.y)?.capture;
        const theirTurn = game.seats[game.active]?.owner === unit.owner;
        const status = !theirTurn ? null : unit.acted ? "Done this turn" : unit.moved ? "Moved" : null;
        return (
          <section className="unit-tip-card" key={unit.id}>
            <div className="unit-tip-head">
              <TileIcon tile={unitTile(def.sprite, unit.owner)} size={32} />
              <div>
                <b>{def.name}</b>
                <small style={{ color: PLAYERS[unit.owner].color }}>
                  {seat?.name ?? PLAYERS[unit.owner].label} · {TYPE_LABELS[def.type] ?? def.type}
                </small>
              </div>
            </div>
            <div className="unit-tip-health">
              <span style={{ width: `${hpOf(unit)}%` }} />
            </div>
            <dl className="unit-tip-stats">
              <dt>Health</dt><dd>{hpOf(unit)}%</dd>
              <dt>Attack</dt><dd>{def.attack}{bonus > 0 && <em> +{bonus}</em>}</dd>
              <dt>Defense</dt><dd>{def.defense}</dd>
              <dt>Speed</dt><dd>{speed}{speed > def.speed && <em> (Speedy)</em>}</dd>
              <dt>Range</dt><dd>{def.attack <= 0 ? "—" : range.min === range.max ? range.max : `${range.min}–${range.max}`}</dd>
              <dt>Price</dt><dd>{formatFunds(def.price)}</dd>
            </dl>
            {def.traits?.length > 0 && (
              <div className="unit-tip-traits">
                {def.traits.map((id) => <span key={id} className="trait">{TRAIT_LABELS[id] ?? id}</span>)}
              </div>
            )}
            {cargo.length > 0 && (
              <p className="unit-tip-note">Carrying: {cargo.map((item) => defsById.get(item.unitId).name).join(", ")}</p>
            )}
            {capture?.unitId === unit.id && <p className="unit-tip-note">Capturing: {capture.progress ?? 0}%</p>}
            {status && <p className="unit-tip-note">{status}</p>}
          </section>
        );
      })}
    </div>
  );
}

/** `spectator`: watching a live game — everything updates, but nothing can be clicked or changed. */
function GameScreen({ room, playerId, onLeave, spectator = false }) {
  const canvasRef = useRef(null);
  const viewRef = useRef(null);
  const modelRef = useRef(null); // map model drawn by the view; property owners are synced into it
  const handlersRef = useRef({});
  const dragRef = useRef(null); // { unit, def, reach, path } while dragging a unit
  const lastActionRef = useRef(null);
  const previousGameRef = useRef(null); // last game state seen, to detect turn changes and deaths
  const [setup, setSetup] = useState(null); // { map (saved format), unitDefs }
  const [game, setGame] = useState(null);
  const [shop, setShop] = useState(null); // { x, y, kind, side } of the building being bought from
  const [selectedId, setSelectedId] = useState(null); // unit choosing an action (capture / attack / wait)
  // Range highlight from clicking a unit: { unitId, mode: "move" | "attack" }.
  const [inspect, setInspect] = useState(null);
  const lastUnitClickRef = useRef(null); // { unitId, time }, to spot double clicks
  const [droppingId, setDroppingId] = useState(null); // cargo unit being dropped from the selected transport
  const [pickTarget, setPickTarget] = useState(null); // { x, y } bridge tile with two targets: choose which to hit
  const [hover, setHover] = useState(null);
  const [unitTip, setUnitTip] = useState(null); // { x, y } tile whose unit info card is showing
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null); // { text, tone }
  const [busy, setBusy] = useState(false);
  const [hideResult, setHideResult] = useState(false); // dismissed the win/defeat screen to look at the map
  const [muted, setMutedState] = useState(isMuted);

  useEffect(preloadSounds, []);

  function toggleMute() {
    setMuted(!muted);
    setMutedState(!muted);
  }

  // Sounds, worked out by comparing with the previous game state:
  //   a unit disappearing = it died; a unit/blockade losing health but surviving = hurt;
  //   a property changing hands (fully captured) = capture; a new active seat = new turn.
  useEffect(() => {
    if (!game) return;
    const previous = previousGameRef.current;
    previousGameRef.current = game;
    if (!previous || previous.version === game.version) return; // first load: stay quiet
    // An undo puts things back (units reappear, health returns, captures reset): no sounds.
    if (game.lastAction?.kind === "undo" && game.lastAction.version === game.version) return;
    const now = new Map(game.units.map((unit) => [unit.id, unit]));
    if (previous.units.some((unit) => !now.has(unit.id))) playSound("explode");
    const unitHurt = previous.units.some((unit) => now.has(unit.id) && hpOf(now.get(unit.id)) < hpOf(unit));
    const blockadeHurt = (previous.blockades ?? []).some((before) => {
      const after = game.blockades?.find((blockade) => blockade.x === before.x && blockade.y === before.y);
      return after && after.hp < before.hp;
    });
    if (unitHurt || blockadeHurt) playSound("hurt");
    const captured = previous.properties.some((before, index) => {
      const after = game.properties[index];
      if (!after || after.x !== before.x || after.y !== before.y) return false;
      return after.owner !== before.owner; // only a completed capture, not partial progress
    });
    if (captured) playSound("capture");
    const turnChanged = previous.active !== game.active || previous.turn !== game.turn;
    if (turnChanged && !game.winner) {
      playSound(!spectator && game.seats[game.active].playerId === playerId ? "myTurn" : "otherTurn");
    }
  }, [game]);

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
        view.setBorderVisible(false); // only shown while choosing where to move a unit
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
    setUnitTip(null);
    if (!hover || !game || dragRef.current || unitsAt(game, hover.x, hover.y).length === 0) return undefined;
    const timer = window.setTimeout(() => {
      if (!dragRef.current) setUnitTip({ x: hover.x, y: hover.y });
    }, UNIT_TIP_DELAY_MS);
    return () => window.clearTimeout(timer);
    // Only the hovered tile restarts the timer; game updates while waiting don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover?.x, hover?.y, Boolean(hover)]);

  useEffect(() => {
    if (!unitTip) return undefined;
    const hide = () => setUnitTip(null);
    window.addEventListener("pointerdown", hide);
    window.addEventListener("wheel", hide);
    window.addEventListener("keydown", hide);
    return () => {
      window.removeEventListener("pointerdown", hide);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide);
    };
  }, [unitTip]);

  useEffect(() => {
    if (!setup) return undefined;
    const intervalId = window.setInterval(() => {
      api(`/api/rooms/${room.id}/game`).then(({ game: latest }) => acceptGame(latest)).catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [setup, room.id]);

  const defsById = setup ? new Map(setup.unitDefs.map((def) => [def.id, def])) : new Map();
  const mySeatIndex = game ? game.seats.findIndex((seat) => seat.playerId === playerId) : -1;
  const mySeat = spectator ? undefined : game?.seats[mySeatIndex];
  const gameOver = Boolean(game?.winner);
  const myTurn = Boolean(game) && !spectator && !gameOver && mySeatIndex === game.active;
  const activeSeat = game?.seats[game.active];
  const winnerSeat = gameOver ? game.seats.find((seat) => seat.owner === game.winner) : null;
  const iWon = gameOver && winnerSeat?.playerId === playerId;
  const iLost = Boolean(mySeat?.defeated);
  // The server keeps one step of undo for the player who made the latest change this turn.
  const canUndo = myTurn && game?.undoSeat === mySeatIndex;

  // A defeated player who chose "Keep watching" still sees the final result when the game ends.
  useEffect(() => {
    if (gameOver) setHideResult(false);
  }, [gameOver]);
  const selected = myTurn ? game.units.find((unit) => unit.id === selectedId && !unit.acted) ?? null : null;
  const selectedDef = selected ? defsById.get(selected.unitId) : null;
  const targets = selected ? attackTargets(game, setup.unitDefs, mySeatIndex, selected) : [];
  const cargo = selected ? cargoOf(game, selected) : [];
  const dropping = cargo.find((unit) => unit.id === droppingId) ?? null;
  const dropTargets = dropping ? dropTiles(game, setup.map, setup.unitDefs, selected, dropping) : [];

  useEffect(() => {
    setDroppingId(null);
    setPickTarget(null);
  }, [selectedId]);

  // Units, health bars and capture flags.
  useEffect(() => {
    if (!game || !setup || !viewRef.current) return;
    const activeOwner = game.seats[game.active].owner;
    const entries = game.units.filter((unit) => !unit.carriedBy).map((unit) => {
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
          sea: layerOf(defsById.get(unit.unitId)) === "sea",
        };
    });
    const byTile = new Map();
    for (const entry of entries) {
      const key = `${entry.x},${entry.y}`;
      const other = byTile.get(key);
      // A boat under a bridge plus a unit on top: draw both, boat bottom-right, the other top-left.
      byTile.set(key, other ? { x: entry.x, y: entry.y, stack: entry.sea ? [other, entry] : [entry, other] } : entry);
    }
    viewRef.current.setUnits([
      ...byTile.values(),
      // Damaged blockades show a health bar too (the blockade sprite is part of the map).
      ...(game.blockades ?? [])
        .filter((blockade) => blockade.hp < BLOCKADE_HP)
        .map((blockade) => ({ x: blockade.x, y: blockade.y, health: (blockade.hp / BLOCKADE_HP) * 100 })),
    ]);
  }, [game, setup]);

  // Captured buildings/flags change colour; broken blockades disappear.
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
    model.objects.forEach((object, index) => {
      const x = index % model.width;
      const y = Math.floor(index / model.width);
      if (object?.kind === "blockade" && !game.blockades?.some((blockade) => blockade.x === x && blockade.y === y)) {
        model.objects[index] = null;
        viewRef.current.markDirty(x, y);
      }
    });
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
    } else {
      for (const tile of inspectTiles()) cells.set(tile.y * width + tile.x, tile);
    }
    if (!drag && selected) {
      cells.set(selected.y * width + selected.x, { x: selected.x, y: selected.y, tile: CURSOR_TILE });
      for (const target of targets) cells.set(target.y * width + target.x, { x: target.x, y: target.y, tint: TARGET_TINT });
      for (const tile of dropTargets) cells.set(tile.y * width + tile.x, { x: tile.x, y: tile.y, tint: DROP_TINT });
    }
    view.setOverlay([...cells.values()]);
    view.setBorderVisible(Boolean(drag));
  }

  useEffect(renderOverlay);

  /** Tiles for the click/double-click range highlight (recomputed from the current game state). */
  function inspectTiles() {
    const unit = inspect && game.units.find((current) => current.id === inspect.unitId && !current.carriedBy);
    if (!unit) return [];
    const def = defsById.get(unit.unitId);
    const { width, height } = setup.map;
    if (inspect.mode === "attack") {
      const { min, max } = attackRange(def);
      const tiles = [];
      for (let dy = -max; dy <= max; dy += 1) {
        for (let dx = -max; dx <= max; dx += 1) {
          const gap = Math.abs(dx) + Math.abs(dy);
          const x = unit.x + dx;
          const y = unit.y + dy;
          if (gap >= min && gap <= max && x >= 0 && y >= 0 && x < width && y < height) {
            tiles.push({ x, y, tint: ATTACK_RANGE_TINT });
          }
        }
      }
      return tiles;
    }
    // Where it could go on its turn (ignores whether it has already moved this turn).
    return [...reachable(game, setup.map, def, unit, setup.unitDefs).keys()].map((index) => ({
      x: index % width,
      y: Math.floor(index / width),
      tint: RANGE_TINT,
    }));
  }

  /**
   * Click on a unit shows where it can move; a quick second click on a ranged unit shows where
   * it can attack. Returns true if this click was such a double click.
   */
  function inspectUnit(unit) {
    const now = Date.now();
    const last = lastUnitClickRef.current;
    lastUnitClickRef.current = { unitId: unit.id, time: now };
    const ranged = attackRange(defsById.get(unit.unitId)).min > 1;
    const doubleClick = last?.unitId === unit.id && now - last.time < DOUBLE_CLICK_MS;
    if (doubleClick && ranged) {
      setInspect({ unitId: unit.id, mode: "attack" });
      return true;
    }
    setInspect({ unitId: unit.id, mode: "move" });
    return false;
  }

  function startDrag(unit) {
    const def = defsById.get(unit.unitId);
    setShop(null);
    setSelectedId(null);
    dragRef.current = {
      unit,
      def,
      unitDefs: setup.unitDefs,
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
    const cantStop = stopError(game, setup.map, setup.unitDefs, drag.unit, drag.def, end.x, end.y);
    if (cantStop) {
      notify(cantStop);
      return;
    }
    setInspect(null);
    const updated = await gameAction("move", { unitId: drag.unit.id, path: drag.path });
    const moved = updated?.units.find((unit) => unit.id === drag.unit.id);
    if (moved && !moved.carriedBy) setSelectedId(drag.unit.id); // after moving, pick capture / attack / wait
  }

  /**
   * The unit a click on this tile means. A bridge can hold two (boat below, unit on top): the one
   * you switched to with F if it is one of them, otherwise prefer your
   * own unit that can still act, then any of yours, then the first.
   */
  function pickUnitAt(cell) {
    const here = unitsAt(game, cell.x, cell.y);
    if (here.length < 2) return here[0] ?? null;
    // Stick with the one you switched to with F (selected or being looked at).
    const focused = here.find((unit) => unit.id === selectedId || unit.id === inspect?.unitId);
    if (focused) return focused;
    const mine = here.filter((unit) => unit.owner === mySeat?.owner);
    return (myTurn && mine.find((unit) => !unit.acted)) || mine[0] || here[0];
  }

  /** Attacks whatever the selected unit can hit on this tile; asks which one if there are two. */
  function attackAt(cell) {
    const options = targets.filter((target) => sameCell(target, cell));
    if (options.length === 0) return false;
    if (options.length === 1) attackTarget(options[0]);
    else setPickTarget({ x: cell.x, y: cell.y });
    return true;
  }

  function clickUnit(unit) {
    const doubleClick = inspectUnit(unit); // highlight its range (any unit, any time)
    if (unit.owner !== mySeat?.owner || !myTurn) return;
    if (doubleClick) return; // showing a ranged unit's attack range, not moving it
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
    if (spectator) {
      // Spectators can only look: clicking a unit shows its range.
      const unit = pickUnitAt(cell);
      if (unit) inspectUnit(unit);
      else setInspect(null);
      return;
    }
    if (dropping) {
      if (dropTargets.some((tile) => sameCell(tile, cell))) {
        gameAction("drop", { unitId: selected.id, cargoId: dropping.id, x: cell.x, y: cell.y }).then(() => setDroppingId(null));
      } else {
        setDroppingId(null);
      }
      return;
    }
    setPickTarget(null);
    // With a unit selected, clicking an enemy (or blockade) in range attacks it.
    if (selected && attackAt(cell)) return;
    const unit = pickUnitAt(cell);
    if (unit) return clickUnit(unit);
    setSelectedId(null);
    setInspect(null);
    const building = buildingAt(game, cell.x, cell.y);
    if (!building || !PRODUCTION[building.kind]) return setShop(null);
    if (!myTurn) return notify("Wait for your turn.");
    if (building.owner !== mySeat?.owner) return notify("That isn't your building.");
    // Open the panel on the side of the screen away from the building so it stays visible.
    const side = (viewRef.current?.cellScreenX(cell.x) ?? 0) < 0.5 ? "right" : "left";
    return setShop({ x: cell.x, y: cell.y, kind: building.kind, side });
  };

  function attackTarget(target) {
    setPickTarget(null);
    gameAction("attack", { unitId: selected.id, x: target.x, y: target.y, targetId: target.unit?.id ?? null }).then(
      (updated) => updated && setSelectedId(null),
    );
  }

  /** Puts back the latest change (server-side, one step). */
  function undoLast() {
    if (!canUndo || busy) return;
    dragRef.current = null;
    setSelectedId(null);
    setShop(null);
    setInspect(null);
    setPickTarget(null);
    gameAction("undo");
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
        event.preventDefault();
        handlersRef.current.undo();
      } else if (key === "f" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        handlersRef.current.swap();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  handlersRef.current.undo = undoLast;
  handlersRef.current.swap = swapUnit;

  /** The unit currently selected or being looked at, and the other unit sharing its bridge tile (if any). */
  function focusedPair() {
    const current = selected ?? (inspect ? game?.units.find((unit) => unit.id === inspect.unitId && !unit.carriedBy) : null);
    if (!current) return { current: null, other: null };
    const other = unitsAt(game, current.x, current.y).find((unit) => unit.id !== current.id) ?? null;
    return { current, other };
  }

  /** F: switch between the boat under a bridge and the unit on top of it. */
  function swapUnit() {
    if (dragRef.current) return;
    const { other } = focusedPair();
    if (!other) return;
    setPickTarget(null);
    setInspect({ unitId: other.id, mode: "move" });
    // Your own unit that can still act becomes the selected one (ready to move or act).
    if (myTurn && other.owner === mySeat?.owner && !other.acted) setSelectedId(other.id);
    else setSelectedId(null);
  }

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
  const hoverTargets = selected && hover ? targets.filter((target) => sameCell(target, hover)) : [];
  const hoverTarget = hoverTargets.length === 1 ? hoverTargets[0] : null;
  const preview = hoverTarget
    ? previewAttack(game, setup.unitDefs, selected, hoverTarget.x, hoverTarget.y, hoverTarget.unit?.id ?? null)
    : null;
  const targetName = (target) => (target.kind === "blockade" ? "Blockade" : defsById.get(target.unit.unitId).name);
  const pickOptions = selected && pickTarget ? targets.filter((target) => sameCell(target, pickTarget)) : [];
  const swapTarget = game && setup && !dragRef.current ? focusedPair().other : null; // unit F would switch to
  const hoverTargetName = hoverTarget ? targetName(hoverTarget) : "";

  return (
    <div className="game-screen">
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="game-top-left">
        <button className="btn btn-red" onClick={onLeave}>{spectator ? "Stop watching" : "Leave room"}</button>
        <button
          className="btn btn-gray btn-small game-mute"
          onClick={toggleMute}
          aria-pressed={muted}
          title={muted ? "Sound off" : "Sound on"}
          aria-label={muted ? "Turn sound on" : "Turn sound off"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
        {spectator && <span className="spectating-badge">Spectating</span>}
      </div>

      {game && (
        <div className="turn-banner" style={{ "--owner": PLAYERS[(winnerSeat ?? activeSeat).owner].color }}>
          <span>{gameOver ? "Game over" : `Turn ${game.turn}`}</span>
          <strong>{gameOver ? `${winnerSeat.name} wins` : myTurn ? "Your turn" : `${activeSeat.name}'s turn`}</strong>
        </div>
      )}

      {game && (
        <div className="game-info">
          <strong>{room.name}</strong>
          {game.seats.map((seat, index) => (
            <span
              key={seat.playerId}
              className={seat.defeated ? "seat-defeated" : index === game.active && !gameOver ? "seat-active" : ""}
            >
              <i style={{ background: PLAYERS[seat.owner].color }} />
              <span className="seat-name">
                {seat.name}
                {seat.playerId === playerId ? " (you)" : ""}
                {!connected(seat.playerId) ? " (left)" : ""}
                {seat.defeated ? " (defeated)" : ""}
              </span>
              <b>{formatFunds(seat.funds)}</b>
              <small title="Income per day">+{formatFunds(incomeFor(game, seat.owner))}</small>
            </span>
          ))}
        </div>
      )}

      {swapTarget ? (
        <div className={`game-hint${selected ? " game-hint-raised" : ""}`}>
          Press <kbd>F</kbd> to switch to the {defsById.get(swapTarget.unitId).name}
          {swapTarget.owner === mySeat?.owner ? "" : ` (${game.seats.find((seat) => seat.owner === swapTarget.owner)?.name ?? "enemy"})`}
        </div>
      ) : myTurn && !shop && !selected && (
        <div className="game-hint">Drag a unit to move it (onto a transport to board), or click your factory, airport or port to buy units.</div>
      )}

      {unitTip && <UnitInfoCard game={game} cell={unitTip} defsById={defsById} view={viewRef.current} />}

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
          {pickOptions.length > 1 ? (
            <div className="target-picker">
              <p className="action-note">Two targets on this bridge — which one?</p>
              {pickOptions.map((target) => {
                const hit = previewAttack(game, setup.unitDefs, selected, target.x, target.y, target.unit?.id ?? null);
                return (
                  <button
                    key={target.unit?.id ?? "blockade"}
                    className="btn btn-red btn-small"
                    disabled={busy}
                    onClick={() => attackTarget(target)}
                  >
                    {targetName(target)} · deal {hit.dealt}%{hit.counter > 0 ? `, take ${hit.counter}%` : ""}
                  </button>
                );
              })}
            </div>
          ) : dropping ? (
            <p className="action-note">Click a green tile to drop the {defsById.get(dropping.unitId).name}.</p>
          ) : hoverTargets.length > 1 ? (
            <p className="action-note">Two targets here (boat and unit on the bridge) — click to choose.</p>
          ) : preview ? (
            <p className="action-note">
              Attack {hoverTargetName}: deal{" "}
              {hoverTarget.kind === "blockade"
                ? <b>{preview.dealt} of {hoverTarget.blockade.hp}</b>
                : <b>{preview.dealt}%</b>}
              {preview.counter > 0 ? <>, take <b>{preview.counter}%</b> back</> : null}
            </p>
          ) : targets.length > 0 ? (
            <p className="action-note">Click a red target to attack.</p>
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

      {canUndo && (
        <button className="btn btn-gray game-undo" disabled={busy} onClick={undoLast} title="Undo your last change (Ctrl+Z)">
          Undo
        </button>
      )}

      {game && !spectator && (
        <button className="btn btn-green game-end-turn" disabled={!myTurn || busy} onClick={() => gameAction("end-turn")}>
          {gameOver ? "Game over" : iLost ? "Defeated" : myTurn ? "End turn" : "Waiting..."}
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

      {(gameOver || iLost) && !hideResult && (
        <div className="game-result-backdrop">
          <section
            className={`panel game-result${iWon ? " game-result-win" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="result-title"
            style={{ "--owner": PLAYERS[(winnerSeat ?? mySeat).owner].color }}
          >
            {gameOver ? (
              <>
                <p className="game-result-kicker">{iWon ? "You captured the last HQ" : "Game over"}</p>
                <h2 id="result-title">{iWon ? "Victory!" : `${winnerSeat.name} wins!`}</h2>
                <p className="game-result-detail">
                  {iWon ? "Every other player has lost their HQ." : iLost ? "Your HQ was captured." : "Their army took the last HQ."}
                </p>
              </>
            ) : (
              <>
                <p className="game-result-kicker">Your HQ was captured</p>
                <h2 id="result-title">Defeated</h2>
                <p className="game-result-detail">The others are still fighting. You can stay and watch.</p>
              </>
            )}
            <div className="modal-actions">
              <button className="btn btn-gray" onClick={() => setHideResult(true)}>{gameOver ? "View map" : "Keep watching"}</button>
              <button className="btn btn-green" onClick={onLeave}>Back to lobby</button>
            </div>
          </section>
        </div>
      )}

      {toast && <div className={`game-toast game-toast-${toast.tone}`} role="status">{toast.text}</div>}
      {error && <div className="game-error">{error}</div>}
    </div>
  );
}

export default GameScreen;
