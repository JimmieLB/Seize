// Unit definitions shared by the unit editor (client) and the unit API (server).
// Each unit is tied to one sprite column in the tile sheet; `id` and `sprite` are fixed,
// everything else is editable.

export const UNIT_TYPES = ["land", "air", "sea"];

export const UNIT_LIMITS = {
  nameLength: 20,
  price: { min: 0, max: 99999 },
  speed: { min: 0, max: 20 },
  attack: { min: 0, max: 99 },
  defense: { min: 0, max: 99 },
};

export const UNIT_STATS = ["price", "speed", "attack", "defense"];

// Traits are fixed here (the game implements their effects); units pick which ones they have.
export const TRAITS = [
  { id: "speedy", label: "Speedy", description: "If this unit is at full health, +1 Speed." },
  { id: "antiAir", label: "Anti-Air", description: "Does x2 damage to air units." },
  { id: "antiArmor", label: "Anti-Armor", description: "Does x1.5 damage to land vehicles." },
  { id: "armored", label: "Armored", description: "Every attack on this unit does 10 less damage (health %)." },
  { id: "ranged", label: "Ranged", description: "Attacks from 2–3 tiles away, but can't move and attack in the same turn." },
  { id: "transport", label: "Transport", description: "Can carry one infantry or mech unit." },
  { id: "heavyTransport", label: "Heavy-Transport", description: "Can carry any 2 land units." },
  { id: "treads", label: "Treads", description: "Moving onto grass costs double (2 Speed per tile)." },
  { id: "captures", label: "Captures", description: "Can capture buildings and flags." },
  { id: "resupply", label: "Resupply", description: "Repairs adjacent friendly units by 10% health at the start of your turn." },
];
export const TRAIT_IDS = TRAITS.map((trait) => trait.id);
export const MAX_TRAITS = 4;

// sprite = column offset within a player's unit row in the tile sheet.
export const DEFAULT_UNITS = [
  { id: "recon", sprite: 0, name: "Recon", type: "land", price: 4000, speed: 8, attack: 4, defense: 3, traits: ["speedy"] },
  { id: "supply", sprite: 1, name: "Supply Truck", type: "land", price: 5000, speed: 6, attack: 0, defense: 2, traits: ["resupply"] },
  { id: "apc", sprite: 2, name: "APC", type: "land", price: 5000, speed: 6, attack: 0, defense: 3, traits: ["transport", "treads"] },
  { id: "tank", sprite: 3, name: "Tank", type: "land", price: 7000, speed: 6, attack: 6, defense: 5, traits: ["armored", "treads"] },
  { id: "artillery", sprite: 4, name: "Artillery", type: "land", price: 6000, speed: 5, attack: 7, defense: 2, traits: ["antiAir", "ranged", "treads"] },
  { id: "fighter", sprite: 5, name: "Fighter", type: "air", price: 20000, speed: 9, attack: 7, defense: 5, traits: ["antiAir"] },
  { id: "helicopter", sprite: 6, name: "Helicopter", type: "air", price: 9000, speed: 6, attack: 6, defense: 3, traits: [] },
  { id: "transport", sprite: 7, name: "Transport Copter", type: "air", price: 5000, speed: 6, attack: 0, defense: 2, traits: ["transport"] },
  { id: "lander", sprite: 8, name: "Lander", type: "sea", price: 12000, speed: 6, attack: 0, defense: 4, traits: ["heavyTransport"] },
  { id: "battleship", sprite: 9, name: "Battleship", type: "sea", price: 28000, speed: 5, attack: 9, defense: 8, traits: ["armored", "ranged"] },
  { id: "gunboat", sprite: 10, name: "Gunboat", type: "sea", price: 6000, speed: 7, attack: 5, defense: 3, traits: ["speedy"] },
  { id: "infantry", sprite: 11, name: "Infantry", type: "land", price: 1000, speed: 3, attack: 2, defense: 1, traits: ["captures"] },
  { id: "mech", sprite: 12, name: "Mech", type: "land", price: 3000, speed: 2, attack: 4, defense: 2, traits: ["captures", "antiArmor"] },
];

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

/** Validates a full unit list and returns a clean copy in the standard order. Throws (status 400) on bad data. */
export function validateUnits(input) {
  if (!Array.isArray(input)) fail("Unit data must be a list.");
  const byId = new Map(input.map((unit) => [unit?.id, unit]));
  return DEFAULT_UNITS.map((base) => {
    const unit = byId.get(base.id);
    if (!unit) fail(`Missing unit "${base.id}".`);
    const name = typeof unit.name === "string" ? unit.name.trim() : "";
    if (!name || name.length > UNIT_LIMITS.nameLength) {
      fail(`Unit names must be between 1 and ${UNIT_LIMITS.nameLength} characters.`);
    }
    if (!UNIT_TYPES.includes(unit.type)) fail(`${name}: type must be land, air or sea.`);
    const stats = {};
    for (const stat of UNIT_STATS) {
      const { min, max } = UNIT_LIMITS[stat];
      const value = unit[stat];
      if (!Number.isInteger(value) || value < min || value > max) {
        fail(`${name}: ${stat} must be a whole number between ${min} and ${max}.`);
      }
      stats[stat] = value;
    }
    const traits = unit.traits ?? [];
    if (!Array.isArray(traits) || traits.length > MAX_TRAITS) fail(`${name}: a unit can have at most ${MAX_TRAITS} traits.`);
    if (traits.some((trait) => !TRAIT_IDS.includes(trait))) fail(`${name}: unknown trait.`);
    if (new Set(traits).size !== traits.length) fail(`${name}: duplicate trait.`);
    return { id: base.id, sprite: base.sprite, name, type: unit.type, ...stats, traits: [...traits] };
  });
}

/** Fills in any units missing from saved data (e.g. after new units are added) with defaults. */
export function withDefaults(saved) {
  const byId = new Map((Array.isArray(saved) ? saved : []).map((unit) => [unit?.id, unit]));
  return DEFAULT_UNITS.map((base) => ({ ...base, ...byId.get(base.id), id: base.id, sprite: base.sprite }));
}
