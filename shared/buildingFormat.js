// Building settings shared by the Buildings tab (client) and the buildings API (server).
// One entry per building kind (plus flags): how much it earns per day (turn) and a design note.

import { BUILDING_KINDS } from "./mapFormat.js";

export const BUILDING_IDS = [...BUILDING_KINDS, "flag"];

export const BUILDING_LIMITS = {
  income: { min: 0, max: 99999 },
  noteLength: 300,
};

export const DEFAULT_BUILDINGS = [
  { id: "hq", income: 1000, note: "Each player's headquarters — maps give every player exactly one." },
  { id: "city", income: 1000, note: "" },
  { id: "factory", income: 1000, note: "Builds land units." },
  { id: "airport", income: 1000, note: "Builds air units." },
  { id: "port", income: 1000, note: "Builds sea units. Ships can move into ports." },
  { id: "barracks", income: 1000, note: "All infantry get +2 attack per Barracks." },
  { id: "tower", income: 1000, note: "All vehicles get +1 attack per Comm Tower." },
  { id: "silo", income: 1000, note: "" },
  { id: "flag", income: 0, note: "+25% to all sources of income per flag." },
];

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

/** Validates the full building list and returns a clean copy in the standard order. Throws (status 400) on bad data. */
export function validateBuildings(input) {
  if (!Array.isArray(input)) fail("Building data must be a list.");
  const byId = new Map(input.map((building) => [building?.id, building]));
  return DEFAULT_BUILDINGS.map((base) => {
    const building = byId.get(base.id);
    if (!building) fail(`Missing building "${base.id}".`);
    const { min, max } = BUILDING_LIMITS.income;
    if (!Number.isInteger(building.income) || building.income < min || building.income > max) {
      fail(`${base.id}: cash per day must be a whole number between ${min} and ${max}.`);
    }
    const note = typeof building.note === "string" ? building.note.trim() : "";
    if (note.length > BUILDING_LIMITS.noteLength) fail(`${base.id}: notes can be at most ${BUILDING_LIMITS.noteLength} characters.`);
    return { id: base.id, income: building.income, note };
  });
}

/** Fills in any buildings missing from saved data with defaults. */
export function withDefaults(saved) {
  const byId = new Map((Array.isArray(saved) ? saved : []).map((building) => [building?.id, building]));
  return DEFAULT_BUILDINGS.map((base) => ({ ...base, ...byId.get(base.id), id: base.id }));
}

/** { kind: income } lookup, as stored in game state. */
export function incomeTable(buildings) {
  return Object.fromEntries(buildings.map((building) => [building.id, building.income]));
}
