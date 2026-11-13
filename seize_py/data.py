"""Loads maps, units and building income from the same JSON files the server uses."""
from __future__ import annotations

import glob
import json
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_DIR = os.path.join(REPO_ROOT, "server", "seed")


def _read(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _data_dir(config: dict) -> str:
    """`data_dir` (relative to the repo root) picks where units/buildings/maps come from.
    Defaults to server/seed, which is committed; server/data is the live, git-ignored copy."""
    d = config.get("data_dir") or "server/seed"
    return d if os.path.isabs(d) else os.path.join(REPO_ROOT, d)


def all_maps(config: dict) -> list[dict]:
    maps = []
    for d in dict.fromkeys([_data_dir(config), SEED_DIR]):
        path = os.path.join(d, "maps.json")
        if os.path.isfile(path):
            maps += _read(path)
    for path in sorted(glob.glob(os.path.join(REPO_ROOT, "examples", "maps", "*.json"))):
        maps.append(_read(path))
    return maps


def load_map(config: dict) -> dict:
    """`map` is a map object (as exported from the editor), or a map name or id to look up."""
    m = config.get("map")
    if isinstance(m, dict):
        return m
    maps = all_maps(config)
    if not maps:
        raise ValueError("No maps found (expected server/seed/maps.json)")
    if m is None:
        return maps[0]
    key = str(m).strip().lower()
    for candidate in maps:
        if key in (str(candidate.get("name", "")).strip().lower(), str(candidate.get("id", "")).lower()):
            return candidate
    names = ", ".join(sorted({str(c.get("name")) for c in maps}))
    raise ValueError(f"Unknown map {m!r}. Available: {names}")


def load_units(config: dict) -> list[dict]:
    """Unit definitions; `units` in config overrides stats, e.g. {"tank": {"price": 8000}}."""
    path = os.path.join(_data_dir(config), "units.json")
    units = _read(path if os.path.isfile(path) else os.path.join(SEED_DIR, "units.json"))
    overrides = config.get("units") or {}
    out = []
    for u in units:
        u = dict(u)
        u.update(overrides.get(u["id"], {}))
        out.append(u)
    return out


def load_income(config: dict) -> dict:
    """{kind: cash per day}, like incomeTable(); `income` in config overrides entries."""
    path = os.path.join(_data_dir(config), "buildings.json")
    buildings = _read(path if os.path.isfile(path) else os.path.join(SEED_DIR, "buildings.json"))
    table = {b["id"]: int(b["income"]) for b in buildings}
    table.update({k: int(v) for k, v in (config.get("income") or {}).items()})
    return table
