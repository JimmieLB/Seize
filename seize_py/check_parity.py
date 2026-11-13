"""Checks that rules.py still matches shared/gameRules.js.

Plays games in Python (random moves mixed with the rollout policy, on every map), then replays
each one through the JavaScript rules with Node and compares the full state after every step.
It also checks that both sides offer the same move destinations, attack targets and captures.

    python seize_py/check_parity.py            # all maps, 4 games each
    python seize_py/check_parity.py --games 10 --map "Test"

Run it after changing shared/gameRules.js or seize_py/rules.py.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from seize_py import adapter, data  # noqa: E402


def record_game(game, config: dict, seed: int, mode: str):
    """Plays one game; returns (ops for the JS replay, Python snapshot after each op)."""
    rng = random.Random(seed)
    s = game.new_game(seed, dict(config))
    ops, snaps = [], []
    w = s.board.width

    def emit(op, unacted=None):
        ops.append(op)
        snap = s.snapshot()
        if unacted is not None:  # the adapter auto-waited; JS sees the move first, then a wait
            for u in snap["units"]:
                if u["id"] == unacted:
                    u["acted"] = False
        snaps.append(snap)

    def emit_targets():
        if s.phase != "act":
            return
        u = s.units[s.sel]
        acts = s._act_actions(u)
        targets = [["unit", a[1]] if a[0] == "attack" else ["blockade", a[1], a[2]]
                   for a in acts if a[0] in ("attack", "blockade")]
        emit({"op": "targets", "seat": s.active, "unitId": u.id, "targets": targets, "capture": ("capture",) in acts})

    steps = 0
    while not s.is_terminal() and steps < game.max_steps:
        legal = s.legal_actions()
        if mode == "random" or rng.random() < 0.3:
            a = rng.choice(legal)
        else:
            a = game.default_rollout_policy(s, rng)
        seat = s.active
        unit = s.units.get(s.sel) if s.sel is not None else None
        stops = None
        if a[0] in ("hold", "move"):
            d = s.def_of(unit)
            start = unit.y * w + unit.x
            stops = [[i % w, i // w] for i in s.reachable(unit) if i != start and s.stop_ok(unit, d, i % w, i // w)]
        target = s.units.get(a[1]) if a[0] == "attack" else None
        s.apply(a)
        steps += 1
        kind = a[0]
        if kind == "select":
            continue
        if kind == "buy":
            emit({"op": "buy", "seat": seat, "x": a[1], "y": a[2], "unitId": a[3]})
        elif kind in ("hold", "move"):
            op = {"op": "move", "seat": seat, "unitId": unit.id, "stops": stops}
            if kind == "move":
                op.update(x=a[1], y=a[2])
            auto_wait = unit.id in s.units and unit.acted and not unit.carried_by
            emit(op, unacted=unit.id if auto_wait else None)
            if auto_wait:
                emit({"op": "wait", "seat": seat, "unitId": unit.id})
            else:
                emit_targets()
        elif kind == "attack":
            emit({"op": "attack", "seat": seat, "unitId": unit.id, "x": target.x, "y": target.y, "targetId": target.id})
        elif kind == "blockade":
            emit({"op": "attack", "seat": seat, "unitId": unit.id, "x": a[1], "y": a[2], "targetId": None})
        elif kind == "capture":
            emit({"op": "capture", "seat": seat, "unitId": unit.id})
        elif kind == "drop":
            emit({"op": "drop", "seat": seat, "unitId": unit.id, "cargoId": a[1], "x": a[2], "y": a[3]})
            emit_targets()
        elif kind == "wait":
            emit({"op": "wait", "seat": seat, "unitId": unit.id})
        elif kind == "end":
            emit({"op": "end", "seat": seat})
    return ops, snaps, s


def run_js(map_data, units, income, seats, ops):
    payload = json.dumps({"map": map_data, "units": units, "income": income, "seats": seats, "ops": ops})
    out = subprocess.run(["node", os.path.join(HERE, "parity.mjs")], input=payload, capture_output=True,
                         text=True, encoding="utf-8", check=False)
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def first_difference(a, b, path=""):
    if type(a) != type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return f"{path}: py={a!r} js={b!r}"
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{path}.{k}: missing on {'py' if k not in a else 'js'}"
            d = first_difference(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: length py={len(a)} js={len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_difference(x, y, f"{path}[{i}]")
            if d:
                return d
        return None
    return None if a == b else f"{path}: py={a!r} js={b!r}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=4, help="games per map")
    ap.add_argument("--map", help="only this map (name or id)")
    ap.add_argument("--max-turns", type=int, default=15)
    args = ap.parse_args()

    maps = [data.load_map({"map": args.map})] if args.map else data.all_maps({})
    failures = 0
    total_ops = 0
    for m in maps:
        game = adapter.SeizeGame(int(m["players"]))
        units, income = data.load_units({}), data.load_income({})
        for g in range(args.games):
            config = {"map": m, "max_turns": args.max_turns, "move_candidates": 0 if g % 2 else 8}
            mode = "random" if g % 3 == 0 else "policy"
            ops, snaps, final = record_game(game, config, seed=g, mode=mode)
            total_ops += len(ops)
            result = run_js(m, units, income, game.num_players, ops)
            problem = None
            if result["problems"]:
                p = result["problems"][0]
                problem = f"step {p['step']} {p['op']['op']}: {p['message']}"
            else:
                for i, (py, js) in enumerate(zip(snaps, result["snapshots"])):
                    diff = first_difference(py, js)
                    if diff:
                        problem = f"step {i} after {ops[i]['op']}: {diff}"
                        break
            status = "ok  " if problem is None else "FAIL"
            print(f"{status} {m['name']:<16} game {g} ({mode}, {len(ops)} steps, day {final.turn}, "
                  f"winner {final.winner or '-'})" + (f"\n     {problem}" if problem else ""))
            failures += problem is not None
    print(f"\n{failures} failing game(s); {total_ops} steps compared.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
