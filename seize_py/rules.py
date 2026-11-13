"""Python port of shared/gameRules.js, for headless analysis (MetaFinder).

The JavaScript file is the source of truth. Function names and comments follow it so the
two can be compared side by side; `check_parity.py` replays random games through both and
fails if they disagree. When you change gameRules.js, change this file too.

Not ported (the search doesn't need them): undo, resigning, connection checks, lastAction
text, version counters, upgradeGame.

Differences in representation only:
  * Players are seats 0..n-1; `owner` is seat + 1 as in JS (0 = neutral).
  * Static map data (terrain, property positions, unit definitions, move costs) lives in a
    shared `Board`; `Game` holds only what changes, so clone() is cheap.
  * Math.round is reproduced by js_round() (Python's round() rounds halves to even).
"""
from __future__ import annotations

import heapq
import math

PRODUCTION = {"factory": "land", "airport": "air", "port": "sea"}
INCOME_PER_BUILDING = 1000
MAX_HP = 100
CAPTURE_TARGET = 100
BARRACKS_INFANTRY_ATTACK = 2
TOWER_VEHICLE_ATTACK = 1
FLAG_INCOME_BONUS = 0.25
BLOCKADE_HP = 10
BLOCKADE_DEF = {"id": "blockade", "name": "Blockade", "type": "structure", "attack": 0, "defense": 0, "traits": ()}
RESUPPLY_AMOUNT = 10
INF = math.inf
DIRECTIONS = ((0, -1), (1, 0), (0, 1), (-1, 0))


def js_round(x: float) -> int:
    """JavaScript Math.round: halves round up (towards +infinity)."""
    return math.floor(x + 0.5)


def distance(ax: int, ay: int, bx: int, by: int) -> int:
    return abs(ax - bx) + abs(ay - by)


# --------------------------------------------------------------------------- unit definitions
class UnitDef:
    __slots__ = ("id", "name", "type", "price", "speed", "attack", "defense", "traits",
                 "captures", "ranged", "speedy", "treads", "resupply", "capacity", "heavy",
                 "infantry", "vehicle")

    def __init__(self, d: dict):
        self.id = d["id"]
        self.name = d["name"]
        self.type = d["type"]
        self.price = int(d["price"])
        self.speed = int(d["speed"])
        self.attack = int(d["attack"])
        self.defense = int(d["defense"])
        self.traits = frozenset(d.get("traits") or ())
        t = self.traits
        self.captures = "captures" in t
        self.ranged = "ranged" in t
        self.speedy = "speedy" in t
        self.treads = "treads" in t
        self.resupply = "resupply" in t
        self.heavy = "heavyTransport" in t
        # transportCapacity()
        self.capacity = 2 if self.heavy else 1 if "transport" in t else 0
        self.infantry = self.type == "land" and self.captures  # isInfantry()
        self.vehicle = self.type == "land" and not self.captures  # isVehicle()


def layer_of(d: UnitDef) -> str:
    return "sea" if d.type == "sea" else "surface"


def can_carry_type(transport: UnitDef, cargo: UnitDef) -> bool:
    if cargo.type != "land":
        return False
    if transport.heavy:
        return True
    return transport.capacity > 0 and cargo.captures


def damage(attacker: UnitDef | dict, attacker_hp: int, defender: UnitDef | dict, bonus: int = 0) -> int:
    """Damage (health %) = (Attack + bonus) × 15 × (hp / 100) × multipliers × 10 / (10 + 2 × Defense),
    minus 10 vs Armored; rounded, never below 0. Same operation order as JS for identical floats."""
    a_traits = attacker.traits
    d_type = defender["type"] if isinstance(defender, dict) else defender.type
    d_traits = defender["traits"] if isinstance(defender, dict) else defender.traits
    d_def = defender["defense"] if isinstance(defender, dict) else defender.defense
    d_vehicle = d_type == "land" and "captures" not in d_traits
    multiplier = 1
    if "antiAir" in a_traits and d_type == "air":
        multiplier *= 2
    if "antiArmor" in a_traits and d_vehicle:
        multiplier *= 1.5
    attack = attacker.attack + bonus
    value = attack * 15 * (attacker_hp / MAX_HP) * multiplier * (10 / (10 + 2 * d_def))
    if "armored" in d_traits:
        value -= 10
    return max(0, js_round(value))


# --------------------------------------------------------------------------- static board
class Board:
    """Everything about a game that never changes: map, property positions, unit types, income."""

    def __init__(self, map_data: dict, unit_defs: list[dict], income: dict | None):
        self.name = map_data.get("name", "map")
        self.width = w = int(map_data["width"])
        self.height = h = int(map_data["height"])
        self.players = int(map_data["players"])
        self.terrain = str(map_data["terrain"])
        self.roads = str(map_data["roads"])
        self.objects = [dict(o) for o in map_data["objects"]]
        self.defs = {d["id"]: UnitDef(d) for d in unit_defs}
        self.def_order = [d["id"] for d in unit_defs]
        self.income = dict(income) if income is not None else None

        # buildingGrid(): every object except flags (blockades included, as in JS).
        self.building_grid = [None] * (w * h)
        for o in self.objects:
            if o["kind"] != "flag":
                self.building_grid[o["y"] * w + o["x"]] = o["kind"]
        self.bridge = [self.terrain[i] == "1" and self.roads[i] == "1" for i in range(w * h)]

        # Properties (buildings + flags) never move; only owner/capture change.
        self.props = [(o["x"], o["y"], o["kind"]) for o in self.objects if o["kind"] != "blockade"]
        self.prop_owner0 = [o["owner"] for o in self.objects if o["kind"] != "blockade"]
        self.prop_index = {(x, y): i for i, (x, y, _) in enumerate(self.props)}
        self.blockades0 = [(o["x"], o["y"]) for o in self.objects if o["kind"] == "blockade"]

        # moveCost() per unit type, per tile.
        self.costs = {uid: [self._move_cost(d, i % w, i // w) for i in range(w * h)]
                      for uid, d in self.defs.items()}
        self._fields: dict = {}

    def property_income(self, kind: str) -> int:
        if self.income is not None and kind in self.income:
            return self.income[kind]
        return 0 if kind == "flag" else INCOME_PER_BUILDING

    def _move_cost(self, d: UnitDef, x: int, y: int) -> float:
        index = y * self.width + x
        water = self.terrain[index] == "1"
        road = self.roads[index] == "1"
        building = self.building_grid[index]
        mountain = self.terrain[index] == "2"
        if d.type == "air":
            return 1
        if d.type == "sea":
            return 1 if water or building == "port" else INF
        if mountain:
            return 2 if d.captures else INF
        if water and not road:
            return INF
        if road or building:
            return 1
        return 2 if d.treads else 1

    def move_cost(self, d: UnitDef, x: int, y: int) -> float:
        if x < 0 or y < 0 or x >= self.width or y >= self.height:
            return INF
        return self.costs[d.id][y * self.width + x]

    def is_bridge(self, x: int, y: int) -> bool:
        if x < 0 or y < 0 or x >= self.width or y >= self.height:
            return False
        return self.bridge[y * self.width + x]

    def distance_field(self, unit_type: str, x: int, y: int) -> list[float]:
        """Movement cost from every tile to (x, y) for this unit type, ignoring units and
        blockades (they can move or be destroyed). Used only to steer the search, not by the rules."""
        key = (unit_type, x, y)
        field = self._fields.get(key)
        if field is None:
            w, h = self.width, self.height
            costs = self.costs[unit_type]
            field = [INF] * (w * h)
            start = y * w + x
            field[start] = 0
            queue = [(0, start)]
            # Backwards Dijkstra: stepping from a neighbour n onto tile i costs costs[i].
            while queue:
                c, i = heapq.heappop(queue)
                if c > field[i]:
                    continue
                step = costs[i]
                if step == INF:
                    continue
                cx, cy = i % w, i // w
                for dx, dy in DIRECTIONS:
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        n = ny * w + nx
                        if costs[n] != INF and c + step < field[n]:
                            field[n] = c + step
                            heapq.heappush(queue, (c + step, n))
            self._fields[key] = field
        return field


# --------------------------------------------------------------------------- dynamic state
class Unit:
    __slots__ = ("id", "kind", "owner", "x", "y", "hp", "moved", "acted", "carried_by")

    def copy(self) -> "Unit":
        u = Unit.__new__(Unit)
        u.id, u.kind, u.owner, u.x, u.y = self.id, self.kind, self.owner, self.x, self.y
        u.hp, u.moved, u.acted, u.carried_by = self.hp, self.moved, self.acted, self.carried_by
        return u


class Game:
    """The mutable part of a game, with the rules from gameRules.js as methods."""

    __slots__ = ("board", "turn", "active", "funds", "defeated", "winner", "prop_owner",
                 "prop_capture", "blockades", "units", "next_unit_id", "events")

    # ---- setup / copying ----------------------------------------------------
    @classmethod
    def create(cls, board: Board, n_seats: int) -> "Game":
        """createGame(): seat 0 is paid its first day's income immediately."""
        g = cls.__new__(cls)
        g.board = board
        g.turn = 1
        g.active = 0
        g.funds = [0] * n_seats
        g.defeated = [False] * n_seats
        g.winner = 0
        g.prop_owner = list(board.prop_owner0)
        g.prop_capture = [None] * len(board.props)  # None | (unit_id, progress)
        g.blockades = {(x, y): BLOCKADE_HP for x, y in board.blockades0}
        g.units = {}  # id -> Unit, in creation order like the JS array
        g.next_unit_id = 1
        g.events = []
        g.funds[0] += g.income_for(1)
        return g

    def clone(self):
        g = self.__class__.__new__(self.__class__)
        self._copy_into(g)
        return g

    def _copy_into(self, g: "Game") -> None:
        g.board = self.board
        g.turn, g.active, g.winner, g.next_unit_id = self.turn, self.active, self.winner, self.next_unit_id
        g.funds = self.funds[:]
        g.defeated = self.defeated[:]
        g.prop_owner = self.prop_owner[:]
        g.prop_capture = self.prop_capture[:]
        g.blockades = dict(self.blockades)
        g.units = {k: u.copy() for k, u in self.units.items()}
        g.events = []

    # ---- lookups ------------------------------------------------------------
    def def_of(self, unit: Unit) -> UnitDef:
        return self.board.defs[unit.kind]

    def owner_of_seat(self, seat: int) -> int:
        return seat + 1

    def property_at(self, x: int, y: int) -> int | None:
        """Index of the property (building or flag) on (x, y), or None."""
        return self.board.prop_index.get((x, y))

    def building_at(self, x: int, y: int) -> int | None:
        i = self.board.prop_index.get((x, y))
        return i if i is not None and self.board.props[i][2] != "flag" else None

    def units_at(self, x: int, y: int) -> list[Unit]:
        return [u for u in self.units.values() if u.x == x and u.y == y and not u.carried_by]

    def blockade_at(self, x: int, y: int) -> bool:
        return (x, y) in self.blockades

    def cargo_of(self, transport: Unit) -> list[Unit]:
        return [u for u in self.units.values() if u.carried_by == transport.id]

    def same_space(self, d: UnitDef, x: int, y: int) -> list[Unit]:
        """Units on (x, y) that occupy the same space as a unit of type `d` (bridges have two levels)."""
        here = self.units_at(x, y)
        if not self.board.is_bridge(x, y):
            return here
        layer = layer_of(d)
        return [o for o in here if layer_of(self.def_of(o)) == layer]

    def blocks_path(self, unit: Unit, d: UnitDef, x: int, y: int) -> bool:
        return any(o.owner != unit.owner for o in self.same_space(d, x, y))

    def stop_ok(self, unit: Unit, d: UnitDef, x: int, y: int) -> bool:
        """stopError() == null."""
        if self.blockade_at(x, y):
            return False
        others = [o for o in self.same_space(d, x, y) if o is not unit]
        return not others or any(self.can_board(o, unit) for o in others)

    def owned_count(self, owner: int, kind: str) -> int:
        props = self.board.props
        return sum(1 for i, o in enumerate(self.prop_owner) if o == owner and props[i][2] == kind)

    def attack_bonus(self, d: UnitDef, owner: int) -> int:
        if d.attack <= 0:
            return 0
        bonus = 0
        if d.infantry:
            bonus += BARRACKS_INFANTRY_ATTACK * self.owned_count(owner, "barracks")
        if d.vehicle:
            bonus += TOWER_VEHICLE_ATTACK * self.owned_count(owner, "tower")
        return bonus

    def income_for(self, owner: int) -> int:
        props, board = self.board.props, self.board
        base = 0
        flags = 0
        for i, o in enumerate(self.prop_owner):
            if o == owner:
                kind = props[i][2]
                base += board.property_income(kind)
                if kind == "flag":
                    flags += 1
        return js_round(base * (1 + FLAG_INCOME_BONUS * flags))

    # ---- units --------------------------------------------------------------
    def remove_unit(self, unit: Unit) -> None:
        """Removes a unit, along with anything it was carrying, and abandons its captures."""
        for uid in [k for k, u in self.units.items() if k == unit.id or u.carried_by == unit.id]:
            del self.units[uid]
        for i, cap in enumerate(self.prop_capture):
            if cap is not None and cap[0] == unit.id:
                self.prop_capture[i] = None
        self.events.append({"type": "unit_destroyed", "unit": self.def_of(unit).name})

    # ---- buying -------------------------------------------------------------
    def buy_ok(self, seat: int, x: int, y: int, unit_id: str) -> bool:
        if self.winner or seat != self.active:
            return False
        b = self.building_at(x, y)
        if b is None:
            return False
        kind = self.board.props[b][2]
        if kind not in PRODUCTION or self.prop_owner[b] != seat + 1:
            return False
        if self.units_at(x, y):
            return False
        d = self.board.defs.get(unit_id)
        return d is not None and d.type == PRODUCTION[kind] and self.funds[seat] >= d.price

    def apply_buy(self, seat: int, x: int, y: int, unit_id: str) -> Unit:
        d = self.board.defs[unit_id]
        self.funds[seat] -= d.price
        u = Unit.__new__(Unit)
        u.id, u.kind, u.owner, u.x, u.y = self.next_unit_id, unit_id, seat + 1, x, y
        u.hp, u.moved, u.acted, u.carried_by = MAX_HP, True, True, None  # waits until next turn
        self.units[u.id] = u
        self.next_unit_id += 1
        self.events.append({"type": "unit_bought", "unit": d.name})
        return u

    # ---- turns --------------------------------------------------------------
    def end_turn(self) -> None:
        n = len(self.funds)
        nxt = self.active
        for _ in range(n):
            nxt = (nxt + 1) % n
            if nxt == 0:
                self.turn += 1
            if not self.defeated[nxt]:
                break
        self.active = nxt
        owner = nxt + 1
        self.funds[nxt] += self.income_for(owner)
        for u in self.units.values():
            if u.owner == owner:
                u.moved = False
                u.acted = False
        self.resupply(owner)

    def resupply(self, owner: int) -> None:
        suppliers = [u for u in self.units.values()
                     if u.owner == owner and not u.carried_by and self.def_of(u).resupply]
        for s in suppliers:
            for u in self.units.values():
                if u.owner == owner and not u.carried_by and distance(u.x, u.y, s.x, s.y) == 1:
                    u.hp = min(MAX_HP, u.hp + RESUPPLY_AMOUNT)

    # ---- transports ---------------------------------------------------------
    def can_board(self, transport: Unit, unit: Unit) -> bool:
        if transport is None or transport is unit or transport.owner != unit.owner or transport.carried_by:
            return False
        if self.cargo_of(unit):
            return False  # transports can't be loaded into each other
        tdef = self.def_of(transport)
        if len(self.cargo_of(transport)) >= tdef.capacity:
            return False
        return can_carry_type(tdef, self.def_of(unit))

    def drop_tiles(self, transport: Unit, cargo: Unit) -> list[tuple[int, int]]:
        cdef = self.def_of(cargo)
        out = []
        for dx, dy in DIRECTIONS:
            x, y = transport.x + dx, transport.y + dy
            if (self.board.move_cost(cdef, x, y) != INF and not self.same_space(cdef, x, y)
                    and not self.blockade_at(x, y)):
                out.append((x, y))
        return out

    def apply_drop(self, transport: Unit, cargo: Unit, x: int, y: int) -> None:
        cargo.carried_by = None
        cargo.x, cargo.y = x, y
        cargo.moved = True
        cargo.acted = True
        transport.moved = True

    # ---- movement -----------------------------------------------------------
    def unit_speed(self, d: UnitDef, unit: Unit) -> int:
        return d.speed + (1 if d.speedy and unit.hp >= MAX_HP else 0)

    def boarding_cost(self, unit: Unit, x: int, y: int) -> float:
        return 1 if any(self.can_board(o, unit) for o in self.units_at(x, y)) else INF

    def reachable(self, unit: Unit) -> dict[int, int]:
        """reachable(): tile index -> cheapest cost for every tile the unit can enter this turn
        (including tiles it can only board a transport on). Stopping rules are checked separately."""
        board = self.board
        w, h = board.width, board.height
        d = self.def_of(unit)
        costs = board.costs[d.id]
        speed = self.unit_speed(d, unit)
        air = d.type == "air"
        start = unit.y * w + unit.x
        best = {start: 0}
        queue = [(0, start)]
        while queue:
            cost, index = heapq.heappop(queue)
            if cost > best[index]:
                continue
            x, y = index % w, index // w
            for dx, dy in DIRECTIONS:
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    step = INF
                else:
                    step = costs[ny * w + nx]
                board_only = step == INF
                if board_only:
                    if nx < 0 or ny < 0 or nx >= w or ny >= h:
                        continue
                    step = self.boarding_cost(unit, nx, ny)
                nc = cost + step
                if nc > speed:
                    continue
                if self.blocks_path(unit, d, nx, ny):
                    continue
                if not air and (nx, ny) in self.blockades:
                    continue
                ni = ny * w + nx
                if ni not in best or nc < best[ni]:
                    best[ni] = nc
                    if not board_only:
                        heapq.heappush(queue, (nc, ni))
        return best

    def apply_move(self, unit: Unit, x: int, y: int) -> None:
        """applyMove() to (x, y). Ending on a friendly transport (same level) boards it."""
        left = self.property_at(unit.x, unit.y)
        if left is not None and self.prop_capture[left] is not None and self.prop_capture[left][0] == unit.id:
            self.prop_capture[left] = None
        d = self.def_of(unit)
        transport = next((o for o in self.same_space(d, x, y) if o is not unit and self.can_board(o, unit)), None)
        unit.x, unit.y = x, y
        unit.moved = True
        for c in self.cargo_of(unit):
            c.x, c.y = x, y
        if transport is not None:
            unit.carried_by = transport.id
            unit.acted = True

    # ---- combat -------------------------------------------------------------
    def attack_range(self, d: UnitDef) -> tuple[int, int]:
        return (2, 3) if d.ranged else (1, 1)

    def can_counter(self, attacker: Unit, defender: Unit, ddef: UnitDef) -> bool:
        return ddef.attack > 0 and not ddef.ranged and distance(attacker.x, attacker.y, defender.x, defender.y) == 1

    def can_attack_from(self, unit: Unit, d: UnitDef, moved: bool, tx: int, ty: int, x: int, y: int) -> bool:
        """attackError() == null for a unit of type d standing on (x, y), against a target on (tx, ty)."""
        if d.attack <= 0:
            return False
        lo, hi = self.attack_range(d)
        if lo > 1 and moved:
            return False
        gap = distance(x, y, tx, ty)
        return lo <= gap <= hi

    def apply_attack_unit(self, attacker: Unit, defender: Unit) -> None:
        adef, ddef = self.def_of(attacker), self.def_of(defender)
        bonus = self.attack_bonus(adef, attacker.owner)
        dealt = min(damage(adef, attacker.hp, ddef, bonus), defender.hp)
        defender.hp -= dealt
        if defender.hp <= 0:
            self.remove_unit(defender)
        elif self.can_counter(attacker, defender, ddef):
            counter = min(damage(ddef, defender.hp, adef, self.attack_bonus(ddef, defender.owner)), attacker.hp)
            attacker.hp -= counter
            if attacker.hp <= 0:
                self.remove_unit(attacker)
        attacker.acted = True

    def apply_attack_blockade(self, attacker: Unit, x: int, y: int) -> None:
        adef = self.def_of(attacker)
        hp = self.blockades[(x, y)]
        dealt = min(damage(adef, attacker.hp, BLOCKADE_DEF, self.attack_bonus(adef, attacker.owner)), hp)
        hp -= dealt
        if hp <= 0:
            del self.blockades[(x, y)]
            self.events.append({"type": "blockade_broken"})
        else:
            self.blockades[(x, y)] = hp
        attacker.acted = True

    # ---- capturing ----------------------------------------------------------
    def capture_ok(self, unit: Unit) -> bool:
        if unit.acted or not self.def_of(unit).captures:
            return False
        p = self.property_at(unit.x, unit.y)
        return p is not None and self.prop_owner[p] != unit.owner

    def capture_progress(self, unit: Unit) -> int:
        p = self.property_at(unit.x, unit.y)
        cap = self.prop_capture[p] if p is not None else None
        return cap[1] if cap is not None and cap[0] == unit.id else 0

    def apply_capture(self, unit: Unit) -> None:
        p = self.property_at(unit.x, unit.y)
        progress = min(CAPTURE_TARGET, self.capture_progress(unit) + js_round(unit.hp * 0.5))
        kind = self.board.props[p][2]
        if progress >= CAPTURE_TARGET:
            previous = self.prop_owner[p]
            self.prop_owner[p] = unit.owner
            self.prop_capture[p] = None
            self.events.append({"type": "captured", "kind": kind})
            if kind == "hq" and previous > 0:
                self.defeat(previous, unit.owner)
        else:
            self.prop_capture[p] = (unit.id, progress)
        unit.acted = True

    def defeat(self, loser: int, conqueror: int) -> None:
        self.defeated[loser - 1] = True
        for u in [u for u in self.units.values() if u.owner == loser]:
            if u.id in self.units:
                self.remove_unit(u)
        for i, o in enumerate(self.prop_owner):
            if o == loser:
                self.prop_owner[i] = conqueror
                self.prop_capture[i] = None
        remaining = [s for s, d in enumerate(self.defeated) if not d]
        if len(remaining) == 1:
            self.winner = remaining[0] + 1

    # ---- serialization (for checks and replays) -------------------------------
    def snapshot(self) -> dict:
        """The complete state, in a JSON shape check_parity.py can compare with the JS game object."""
        return {
            "turn": self.turn,
            "active": self.active,
            "winner": self.winner,
            "funds": self.funds[:],
            "defeated": self.defeated[:],
            "nextUnitId": self.next_unit_id,
            "properties": [
                {"x": x, "y": y, "kind": k, "owner": self.prop_owner[i],
                 "capture": None if self.prop_capture[i] is None
                 else {"unitId": self.prop_capture[i][0], "progress": self.prop_capture[i][1]}}
                for i, (x, y, k) in enumerate(self.board.props)
            ],
            "blockades": sorted([x, y, hp] for (x, y), hp in self.blockades.items()),
            "units": [
                {"id": u.id, "unitId": u.kind, "owner": u.owner, "x": u.x, "y": u.y, "hp": u.hp,
                 "moved": u.moved, "acted": u.acted, "carriedBy": u.carried_by}
                for u in self.units.values()
            ],
        }
