// Replays a game recorded by check_parity.py through shared/gameRules.js and prints the state
// after every step, plus any move the JS rules reject or offer differently.
// Input (stdin): { map, units, income, seats, ops: [...] }. Output (stdout): { snapshots, problems }.
import {
  applyAttack, applyBuy, applyCapture, applyDrop, applyMove, applyWait, attackError, attackTargets,
  buyError, captureError, createGame, dropError, endTurn, moveError, pathTo, reachable, stopError, waitError,
} from "../shared/gameRules.js";

const input = JSON.parse(await new Promise((resolve) => {
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => resolve(text));
}));
const { map, units: unitDefs, income, ops } = input;
const players = Array.from({ length: input.seats }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const game = createGame(map, players, income);
const defOf = (unit) => unitDefs.find((def) => def.id === unit.unitId);
const unitById = (id) => game.units.find((unit) => unit.id === id);
const problems = [];
const snapshots = [];

function snapshot() {
  return {
    turn: game.turn,
    active: game.active,
    winner: game.winner ?? 0,
    funds: game.seats.map((seat) => seat.funds),
    defeated: game.seats.map((seat) => Boolean(seat.defeated)),
    nextUnitId: game.nextUnitId,
    properties: game.properties.map(({ x, y, kind, owner, capture }) => ({
      x, y, kind, owner, capture: capture ? { unitId: capture.unitId, progress: capture.progress } : null,
    })),
    blockades: (game.blockades ?? []).map(({ x, y, hp }) => [x, y, hp]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    units: game.units.map(({ id, unitId, owner, x, y, hp, moved, acted, carriedBy }) => ({
      id, unitId, owner, x, y, hp: hp ?? 100, moved: Boolean(moved), acted: Boolean(acted), carriedBy: carriedBy ?? null,
    })),
  };
}

const key = (list) => JSON.stringify([...list].map((item) => JSON.stringify(item)).sort());

ops.forEach((op, step) => {
  const fail = (message) => problems.push({ step, op, message });
  const { seat } = op;
  switch (op.op) {
    case "buy": {
      const error = buyError(game, unitDefs, seat, op.x, op.y, op.unitId);
      if (error) fail(`buyError: ${error}`);
      else applyBuy(game, unitDefs, seat, op.x, op.y, op.unitId);
      break;
    }
    case "move": {
      const unit = unitById(op.unitId);
      const def = defOf(unit);
      const reach = reachable(game, map, def, unit, unitDefs);
      const start = unit.y * map.width + unit.x;
      const stops = [...reach.keys()]
        .filter((index) => index !== start && !stopError(game, map, unitDefs, unit, def, index % map.width, Math.floor(index / map.width)))
        .map((index) => [index % map.width, Math.floor(index / map.width)]);
      if (op.stops && key(stops) !== key(op.stops)) {
        fail(`destinations differ: js=${key(stops)} py=${key(op.stops)}`);
      }
      if (op.x === undefined) break; // hold: only the destination check
      const path = pathTo(reach, map, op.y * map.width + op.x);
      const error = moveError(game, map, unitDefs, seat, op.unitId, path);
      if (error) fail(`moveError: ${error}`);
      else applyMove(game, op.unitId, path, unitDefs, map);
      break;
    }
    case "targets": {
      const unit = unitById(op.unitId);
      const js = attackTargets(game, unitDefs, seat, unit).map((t) => (t.kind === "unit" ? ["unit", t.unit.id] : ["blockade", t.x, t.y]));
      if (key(js) !== key(op.targets)) fail(`attack targets differ: js=${key(js)} py=${key(op.targets)}`);
      const canCapture = !captureError(game, unitDefs, seat, op.unitId);
      if (canCapture !== op.capture) fail(`capture availability differs: js=${canCapture} py=${op.capture}`);
      break;
    }
    case "attack": {
      const error = attackError(game, unitDefs, seat, op.unitId, op.x, op.y, op.targetId);
      if (error) fail(`attackError: ${error}`);
      else applyAttack(game, unitDefs, op.unitId, op.x, op.y, op.targetId);
      break;
    }
    case "capture": {
      const error = captureError(game, unitDefs, seat, op.unitId);
      if (error) fail(`captureError: ${error}`);
      else applyCapture(game, unitDefs, op.unitId);
      break;
    }
    case "drop": {
      const error = dropError(game, map, unitDefs, seat, op.unitId, op.cargoId, op.x, op.y);
      if (error) fail(`dropError: ${error}`);
      else applyDrop(game, op.unitId, op.cargoId, op.x, op.y);
      break;
    }
    case "wait": {
      const error = waitError(game, unitDefs, seat, op.unitId);
      if (error) fail(`waitError: ${error}`);
      else applyWait(game, op.unitId);
      break;
    }
    case "end":
      endTurn(game, () => true, unitDefs);
      break;
    default:
      fail(`unknown op ${op.op}`);
  }
  snapshots.push(snapshot());
});

process.stdout.write(JSON.stringify({ snapshots, problems }));
