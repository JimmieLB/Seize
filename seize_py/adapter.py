"""MetaFinder adapter for Seize: wraps rules.py in the GameModule / GameState contract.

A turn is split into small decisions so the search sees tens of options, not thousands:

    idle   → ("select", unit_id) | ("buy", x, y, unit_type) | ("end",)
    move   → ("hold",) | ("move", x, y)                      (the selected unit)
    act    → ("attack", target_id) | ("blockade", x, y) | ("capture",)
             | ("drop", cargo_id, x, y) | ("wait",)

After acting (or boarding a transport, or dying in a counter-attack) play returns to `idle`.
Moving and acting are always done together, which the real game allows but doesn't force.
When "wait" is the only thing a unit can do after moving, it waits automatically.

Config (metafinder.json "config", or the MetaFinder UI):
    map              map name or id from server/seed/maps.json (or examples/maps/), or a map object
    max_turns        days before the game is scored with heuristic_value() (default 30)
    move_candidates  destinations offered per move besides captures/attacks/boarding (default 8;
                     0 = every reachable tile)
    units            stat overrides, e.g. {"tank": {"price": 8000, "attack": 7}}
    income           cash-per-day overrides, e.g. {"flag": 1000}
    data_dir         where units/buildings/maps come from (default "server/seed")
"""
from __future__ import annotations

import json
import random

try:  # imported as a package (MetaFinder) or as a plain module (check_parity.py)
    from . import data
    from .rules import INF, MAX_HP, PRODUCTION, Board, Game, damage, distance
except ImportError:  # pragma: no cover
    import data  # type: ignore
    from rules import INF, MAX_HP, PRODUCTION, Board, Game, damage, distance  # type: ignore

END = ("end",)
HOLD = ("hold",)
WAIT = ("wait",)
CAPTURE = ("capture",)

_boards: dict[str, Board] = {}


def _board(config: dict) -> Board:
    map_data = data.load_map(config)
    units = data.load_units(config)
    income = data.load_income(config)
    key = json.dumps([map_data, units, income], sort_keys=True)
    board = _boards.get(key)
    if board is None:
        board = _boards[key] = Board(map_data, units, income)
    return board


class Settings:
    __slots__ = ("max_turns", "move_candidates")

    def __init__(self, config: dict):
        self.max_turns = int(config.get("max_turns", 30))
        self.move_candidates = int(config.get("move_candidates", 8))


class SeizeState(Game):
    __slots__ = ("settings", "phase", "sel")

    def _copy_into(self, g):
        Game._copy_into(self, g)
        g.settings, g.phase, g.sel = self.settings, self.phase, self.sel

    # ------------------------------------------------------------------ required
    def current_player(self) -> int:
        return self.active

    def is_terminal(self) -> bool:
        return bool(self.winner) or self.turn > self.settings.max_turns

    def returns(self) -> list[float]:
        if self.winner:
            return [1.0 if s + 1 == self.winner else 0.0 for s in range(len(self.funds))]
        return self.heuristic_value()  # turn limit: score the position

    def legal_actions(self) -> list[tuple]:
        if self.phase == "move":
            return self._move_actions(self.units[self.sel])
        if self.phase == "act":
            return self._act_actions(self.units[self.sel])
        seat, owner = self.active, self.active + 1
        actions = [("select", u.id) for u in self.units.values()
                   if u.owner == owner and not u.carried_by and not u.acted]
        board = self.board
        funds = self.funds[seat]
        for i, (x, y, kind) in enumerate(board.props):
            utype = PRODUCTION.get(kind)
            if utype is None or self.prop_owner[i] != owner or self.units_at(x, y):
                continue
            for uid in board.def_order:
                d = board.defs[uid]
                if d.type == utype and d.price <= funds:
                    actions.append(("buy", x, y, uid))
        actions.append(END)
        return actions

    def apply(self, a: tuple) -> None:
        kind = a[0]
        if kind == "select":
            self.sel, self.phase = a[1], "move"
            return
        if kind == "buy":
            self.apply_buy(self.active, a[1], a[2], a[3])
            return
        if kind == "end":
            self.end_turn()
            self.sel, self.phase = None, "idle"
            return
        unit = self.units[self.sel]
        if kind in ("hold", "move"):
            if kind == "move":
                self.apply_move(unit, a[1], a[2])
            self.phase = "act"
            if not unit.acted and self._act_actions(unit) == [WAIT]:
                unit.acted = True  # nothing else to do: skip the forced "wait" decision
        elif kind == "attack":
            self.apply_attack_unit(unit, self.units[a[1]])
        elif kind == "blockade":
            self.apply_attack_blockade(unit, a[1], a[2])
        elif kind == "capture":
            self.apply_capture(unit)
        elif kind == "drop":
            self.apply_drop(unit, self.units[a[1]], a[2], a[3])
            return  # the transport may drop more cargo or still act
        elif kind == "wait":
            unit.acted = True
        else:
            raise ValueError(f"Unknown action {a!r}")
        if self.sel not in self.units or self.units[self.sel].acted:
            self.sel, self.phase = None, "idle"

    # ------------------------------------------------------------------ action generation
    def _act_actions(self, unit) -> list[tuple]:
        d = self.def_of(unit)
        actions = []
        if d.attack > 0:
            for o in self.units.values():
                if (o.owner != unit.owner and not o.carried_by
                        and self.can_attack_from(unit, d, unit.moved, o.x, o.y, unit.x, unit.y)):
                    actions.append(("attack", o.id))
            for (bx, by) in sorted(self.blockades):
                if self.can_attack_from(unit, d, unit.moved, bx, by, unit.x, unit.y):
                    actions.append(("blockade", bx, by))
        if self.capture_ok(unit):
            actions.append(CAPTURE)
        for cargo in self.cargo_of(unit):
            for x, y in self.drop_tiles(unit, cargo):
                actions.append(("drop", cargo.id, x, y))
        actions.append(WAIT)
        return actions

    def _move_actions(self, unit) -> list[tuple]:
        w = self.board.width
        start = unit.y * w + unit.x
        d = self.def_of(unit)
        stops = [i for i in self.reachable(unit) if i != start and self.stop_ok(unit, d, i % w, i // w)]
        limit = self.settings.move_candidates
        if limit > 0 and len(stops) > limit:
            stops = self._prune(unit, d, stops, limit)
        stops.sort()
        return [HOLD] + [("move", i % w, i // w) for i in stops]

    def _prune(self, unit, d, stops: list[int], limit: int) -> list[int]:
        """Keep every tile that enables a capture, an attack or boarding, plus the `limit` tiles
        closest to the unit's objectives."""
        w = self.board.width
        enemies = {(o.x, o.y) for o in self.units.values() if o.owner != unit.owner and not o.carried_by}
        targets = enemies | set(self.blockades) if d.attack > 0 and not d.ranged else set()
        keep, rest = [], []
        for i in stops:
            x, y = i % w, i // w
            if self._special_tile(unit, d, x, y, targets):
                keep.append(i)
            else:
                rest.append(i)
        score = self._goal_scorer(unit, d, enemies)
        rest.sort(key=lambda i: (score(i), i))
        return keep + rest[:limit]

    def _special_tile(self, unit, d, x, y, targets) -> bool:
        if d.captures:
            p = self.property_at(x, y)
            if p is not None and self.prop_owner[p] != unit.owner:
                return True
        if targets and ((x + 1, y) in targets or (x - 1, y) in targets
                        or (x, y + 1) in targets or (x, y - 1) in targets):
            return True
        return any(o is not unit and self.can_board(o, unit) for o in self.same_space(d, x, y))

    def _goal_scorer(self, unit, d, enemies):
        """Returns tile index -> distance to the unit's nearest objective (lower is better)."""
        board, w = self.board, self.board.width
        fields = []
        for i, (x, y, kind) in enumerate(board.props):
            owner = self.prop_owner[i]
            if owner == unit.owner:
                continue
            if d.captures or (kind == "hq" and owner > 0):
                fields.append(board.distance_field(d.id, x, y))
        attackers = d.attack > 0
        enemy_list = list(enemies) if attackers else []

        def score(i: int) -> float:
            best = INF
            for f in fields:
                v = f[i]
                if v < best:
                    best = v
            if enemy_list:
                x, y = i % w, i // w
                for ex, ey in enemy_list:
                    v = abs(ex - x) + abs(ey - y) - 1
                    if v < best:
                        best = v
            return best

        return score

    # ------------------------------------------------------------------ optional
    def heuristic_value(self) -> list[float]:
        """Each seat's share of total strength: funds + unit value (price × health) + 4 days of
        income + capture progress on other players' properties."""
        n = len(self.funds)
        strength = [0.0] * n
        for s in range(n):
            if not self.defeated[s]:
                strength[s] = self.funds[s] + 4 * self.income_for(s + 1)
        for u in self.units.values():
            strength[u.owner - 1] += self.def_of(u).price * u.hp / MAX_HP
        for i, cap in enumerate(self.prop_capture):
            if cap is not None and cap[0] in self.units:
                worth = 30000 if self.board.props[i][2] == "hq" else 3000
                strength[self.units[cap[0]].owner - 1] += worth * cap[1] / 100
        for s in range(n):
            if self.defeated[s]:
                strength[s] = 0.0
        total = sum(strength)
        if total <= 0:
            return [1.0 / n] * n
        return [v / total for v in strength]

    def drain_events(self) -> list[dict]:
        ev, self.events = self.events, []
        return ev

    def action_label(self, a: tuple) -> str:
        kind = a[0]
        if kind == "buy":
            return f"buy {self.board.defs[a[3]].name} @{a[1]},{a[2]}"
        if kind == "select":
            u = self.units.get(a[1])
            return f"select {self.def_of(u).name}#{a[1]}" if u else f"select #{a[1]}"
        if kind == "move":
            return f"move to {a[1]},{a[2]}"
        if kind == "attack":
            u = self.units.get(a[1])
            return f"attack {self.def_of(u).name}#{a[1]}" if u else f"attack #{a[1]}"
        if kind == "blockade":
            return f"attack blockade @{a[1]},{a[2]}"
        if kind == "capture" and self.sel in self.units:
            u = self.units[self.sel]
            p = self.property_at(u.x, u.y)
            return f"capture {self.board.props[p][2]}" if p is not None else "capture"
        if kind == "drop":
            u = self.units.get(a[1])
            return f"drop {self.def_of(u).name if u else ''}#{a[1]} @{a[2]},{a[3]}"
        return {"end": "end turn", "hold": "hold", "wait": "wait", "capture": "capture"}.get(kind, str(a))

    def strategy_key(self) -> str:
        if self.phase == "idle":
            return f"turn start, ${self.funds[self.active] // 1000}k"
        name = self.def_of(self.units[self.sel]).name
        return f"{'move' if self.phase == 'move' else 'act'}: {name}"

    def describe(self) -> str:
        parts = []
        for s in range(len(self.funds)):
            if self.defeated[s]:
                parts.append(f"P{s} out")
                continue
            owner = s + 1
            n_units = sum(1 for u in self.units.values() if u.owner == owner)
            n_props = sum(1 for o in self.prop_owner if o == owner)
            parts.append(f"P{s} ${self.funds[s]:,} {n_units}u {n_props}p")
        sel = ""
        if self.sel in self.units:
            u = self.units[self.sel]
            sel = f" · {self.phase} {self.def_of(u).name}@{u.x},{u.y}"
        return f"Day {self.turn} P{self.active}{sel} · " + " · ".join(parts)

    def to_json(self) -> dict:
        snap = self.snapshot()
        snap.update(phase=self.phase, sel=self.sel)
        return snap


class SeizeGame:
    perfect_information = True
    max_steps = 5000
    rollout_depth = 40  # ~1 player-turn of playout, then heuristic_value()

    def __init__(self, num_players: int = 2):
        self.num_players = num_players
        self.name = "Seize" if num_players == 2 else f"Seize ({num_players} players)"

    def new_game(self, seed: int, config: dict) -> SeizeState:
        board = _board(config)
        if board.players != self.num_players:
            raise ValueError(f"Map {board.name!r} is for {board.players} players, but this entry plays "
                             f"{self.num_players}. Use seize_py.adapter:GAME{board.players} or pick another map.")
        s = SeizeState.create(board, self.num_players)
        s.settings = Settings(config)
        s.phase, s.sel = "idle", None
        return s

    def default_rollout_policy(self, state: SeizeState, rng: random.Random) -> tuple:
        """Moves every unit before ending the turn, captures and attacks when it can, otherwise
        heads for the nearest objective; buys with what is left. 10% of moves are random."""
        legal = state.legal_actions()
        if rng.random() < 0.1:
            return rng.choice(legal)
        if state.phase == "idle":
            selects = [a for a in legal if a[0] == "select"]
            if selects:
                return rng.choice(selects)
            buys = [a for a in legal if a[0] == "buy"]
            if buys:
                defs = state.board.defs
                owner = state.active + 1
                capturers = sum(1 for u in state.units.values() if u.owner == owner and state.def_of(u).captures)
                if capturers < 3:
                    infantry = [a for a in buys if defs[a[3]].captures]
                    if infantry:
                        return min(infantry, key=lambda a: (defs[a[3]].price, rng.random()))
                if rng.random() < 0.6:
                    return max(buys, key=lambda a: (defs[a[3]].price, rng.random()))
                return rng.choice(buys)
            return END
        unit = state.units[state.sel]
        d = state.def_of(unit)
        if state.phase == "act":
            if CAPTURE in legal:
                return CAPTURE
            best, best_value = None, 0.0
            for a in legal:
                if a[0] == "attack":
                    target = state.units[a[1]]
                    tdef = state.def_of(target)
                    dealt = min(damage(d, unit.hp, tdef, state.attack_bonus(d, unit.owner)), target.hp)
                    value = dealt * tdef.price
                    left = target.hp - dealt
                    if left > 0 and state.can_counter(unit, target, tdef):
                        value -= min(damage(tdef, left, d, state.attack_bonus(tdef, target.owner)), unit.hp) * d.price
                    if value > best_value:
                        best, best_value = a, value
                elif a[0] == "blockade" and best is None:
                    best = a
            if best is not None:
                return best
            drops = [a for a in legal if a[0] == "drop"]
            return rng.choice(drops) if drops else WAIT
        # move phase
        p = state.property_at(unit.x, unit.y)
        if d.captures and p is not None and state.prop_owner[p] != unit.owner:
            return HOLD  # keep capturing
        if d.ranged and any(a[0] == "attack" for a in state._act_actions(unit)):
            return HOLD
        w = state.board.width
        enemies = {(o.x, o.y) for o in state.units.values() if o.owner != unit.owner and not o.carried_by}
        targets = enemies if d.attack > 0 and not d.ranged else set()
        special = [a for a in legal if a[0] == "move" and state._special_tile(unit, d, a[1], a[2], targets)]
        if special:
            if d.captures:
                hq = [a for a in special if (p2 := state.property_at(a[1], a[2])) is not None
                      and state.board.props[p2][2] == "hq"]
                if hq:
                    return hq[0]
            return rng.choice(special)
        score = state._goal_scorer(unit, d, enemies)
        return min(legal, key=lambda a: (score(a[2] * w + a[1]) if a[0] == "move"
                                         else score(unit.y * w + unit.x), rng.random()))


GAME = SeizeGame(2)
GAME2 = GAME
GAME3 = SeizeGame(3)
GAME4 = SeizeGame(4)
