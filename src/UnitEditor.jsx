import { useEffect, useState } from "react";
import { BUILDING_LIMITS, DEFAULT_BUILDINGS } from "../shared/buildingFormat.js";
import { PRODUCTION } from "../shared/gameRules.js";
import { DEFAULT_UNITS, MAX_TRAITS, TRAITS, UNIT_LIMITS, UNIT_STATS, UNIT_TYPES } from "../shared/unitFormat.js";
import { api } from "./api.js";
import { PLAYERS } from "./map/mapModel.js";
import TileIcon from "./map/TileIcon.jsx";
import { KIND_LABELS, objectTile, unitTile } from "./map/tiles.js";

const STAT_LABELS = { price: "Price", speed: "Speed", attack: "Attack", defense: "Defense" };
const TYPE_LABELS = { land: "Land", air: "Air", sea: "Sea" };
const TRAIT_BY_ID = Object.fromEntries(TRAITS.map((trait) => [trait.id, trait]));

/** Trait label; hovering or focusing it shows the description. */
function TraitChip({ trait, onRemove }) {
  return (
    <span className="trait" tabIndex={0}>
      {trait.label}
      {onRemove && (
        <button className="trait-remove" onClick={onRemove} aria-label={`Remove ${trait.label}`}>×</button>
      )}
      <span className="trait-tip" role="tooltip">{trait.description}</span>
    </span>
  );
}

const TYPE_NAMES = { land: "land", air: "air", sea: "sea" };
const formatFunds = (value) => `$${Number(value).toLocaleString()}`;

// Building income is kept as a string while editing, like unit stats.
const toBuildingDraft = (buildings) => buildings.map((building) => ({ ...building, income: String(building.income) }));
const toBuildingPayload = (draft) =>
  draft.map((building) => ({ ...building, income: building.income === "" ? null : Number(building.income) }));

function incomeValid(value) {
  const number = Number(value);
  const { min, max } = BUILDING_LIMITS.income;
  return value !== "" && Number.isInteger(number) && number >= min && number <= max;
}

/** Buildings and flags: sprite, name, editable cash per day and design note, and what they can build. */
function BuildingsTab({ owner, units, buildings, onChange, readOnly }) {
  return (
    <>
      <section className="panel trait-legend">
        <h3>All buildings</h3>
        <p className="buildings-note">
          Buildings and flags can be captured by units with the Captures trait — each capture adds
          (unit health × 0.5)% progress, and at 100% it becomes yours. Each day (turn) you earn the
          cash per day of everything you own. Land units always enter a building for 1 Speed, even with Treads.
        </p>
      </section>
      <div className="unit-grid">
        {buildings.map((building) => {
          const kind = building.id;
          const builds = PRODUCTION[kind];
          const buildable = builds ? (units ?? []).filter((unit) => unit.type === builds) : [];
          return (
            <section className="panel unit-card building-card" key={kind}>
              <div className="unit-head">
                <TileIcon tile={objectTile(kind, owner)} size={64} className="unit-sprite" />
                <h2>{KIND_LABELS[kind]}</h2>
              </div>
              <div className="unit-stats building-income">
                <label>
                  Cash per day
                  <input
                    type="number"
                    className={incomeValid(building.income) ? "" : "field-invalid"}
                    min={BUILDING_LIMITS.income.min}
                    max={BUILDING_LIMITS.income.max}
                    step={500}
                    value={building.income}
                    readOnly={readOnly}
                    onChange={(event) => onChange(kind, "income", event.target.value)}
                  />
                </label>
              </div>
              <label className="building-note-field">
                Note
                <textarea
                  value={building.note}
                  maxLength={BUILDING_LIMITS.noteLength}
                  rows={3}
                  placeholder={readOnly ? "No note yet." : "What should this building do?"}
                  readOnly={readOnly}
                  onChange={(event) => onChange(kind, "note", event.target.value)}
                />
              </label>
              {builds && <p className="building-builds-title">Builds {TYPE_NAMES[builds]} units:</p>}
              {buildable.length > 0 && (
                <ul className="building-builds">
                  {buildable.map((unit) => (
                    <li key={unit.id} title={unit.name}>
                      <TileIcon tile={unitTile(unit.sprite, owner)} size={28} />
                      <span>{unit.name}</span>
                      <b>{formatFunds(unit.price)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

// Number fields are kept as strings while editing so they can be briefly empty.
const toDraft = (units) =>
  units.map((unit) => ({ ...unit, ...Object.fromEntries(UNIT_STATS.map((stat) => [stat, String(unit[stat])])) }));

const toPayload = (draft) =>
  draft.map((unit) => ({
    ...unit,
    ...Object.fromEntries(UNIT_STATS.map((stat) => [stat, unit[stat] === "" ? null : Number(unit[stat])])),
  }));

function statValid(stat, value) {
  const number = Number(value);
  const { min, max } = UNIT_LIMITS[stat];
  return value !== "" && Number.isInteger(number) && number >= min && number <= max;
}

/** `readOnly`: non-admins can see everything but not change or save it. */
function UnitEditor({ onExit, readOnly = false }) {
  const [units, setUnits] = useState(null);
  const [savedJson, setSavedJson] = useState("");
  const [buildings, setBuildings] = useState(null);
  const [savedBuildingsJson, setSavedBuildingsJson] = useState("");
  const [owner, setOwner] = useState(1);
  const [tab, setTab] = useState("units"); // "units" | "buildings"
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/units")
      .then(({ units: loaded }) => {
        setUnits(toDraft(loaded));
        setSavedJson(JSON.stringify(loaded));
      })
      .catch((error) => setStatus({ text: error.message, error: true }));
    api("/api/buildings")
      .then(({ buildings: loaded }) => {
        setBuildings(toBuildingDraft(loaded));
        setSavedBuildingsJson(JSON.stringify(loaded));
      })
      .catch((error) => setStatus({ text: error.message, error: true }));
  }, []);

  const unitsChanged = units !== null && JSON.stringify(toPayload(units)) !== savedJson;
  const buildingsChanged = buildings !== null && JSON.stringify(toBuildingPayload(buildings)) !== savedBuildingsJson;
  const unsaved = unitsChanged || buildingsChanged;

  useEffect(() => {
    if (!unsaved) return undefined;
    const warn = (event) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function update(id, field, value) {
    setUnits((current) => current.map((unit) => (unit.id === id ? { ...unit, [field]: value } : unit)));
    setStatus(null);
  }

  function updateBuilding(id, field, value) {
    setBuildings((current) => current.map((building) => (building.id === id ? { ...building, [field]: value } : building)));
    setStatus(null);
  }

  /** Saves whichever of units / buildings changed. */
  async function save() {
    setSaving(true);
    try {
      if (unitsChanged) {
        const { units: saved } = await api("/api/units", { method: "PUT", body: JSON.stringify({ units: toPayload(units) }) });
        setUnits(toDraft(saved));
        setSavedJson(JSON.stringify(saved));
      }
      if (buildingsChanged) {
        const { buildings: saved } = await api("/api/buildings", {
          method: "PUT",
          body: JSON.stringify({ buildings: toBuildingPayload(buildings) }),
        });
        setBuildings(toBuildingDraft(saved));
        setSavedBuildingsJson(JSON.stringify(saved));
      }
      setStatus({ text: "Saved." });
    } catch (error) {
      setStatus({ text: error.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  function resetDefaults() {
    if (tab === "buildings") {
      if (!window.confirm("Reset every building's cash per day and note? (Nothing is saved until you press Save.)")) return;
      setBuildings(toBuildingDraft(DEFAULT_BUILDINGS));
    } else {
      if (!window.confirm("Reset every unit to its default name and stats? (Nothing is saved until you press Save.)")) return;
      setUnits(toDraft(DEFAULT_UNITS));
    }
    setStatus(null);
  }

  function exit() {
    if (!unsaved || window.confirm("You have unsaved changes. Discard them?")) onExit();
  }

  return (
    <div className={`units-screen${readOnly ? " read-only" : ""}`}>
      <header className="room-bar">
        <button className="btn btn-gray btn-small" onClick={exit}>← Back</button>
        <div className="page-tabs" role="tablist">
          {[["units", "Units"], ["buildings", "Buildings"]].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`page-tab${tab === id ? " page-tab-active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="owner-row units-colors" aria-label="Preview colour">
          {PLAYERS.slice(1).map((player, index) => (
            <button
              key={player.label}
              className={`owner${owner === index + 1 ? " owner-active" : ""}`}
              style={{ "--owner": player.color }}
              onClick={() => setOwner(index + 1)}
              title={`Preview in ${player.label}`}
            >
              P{index + 1}
            </button>
          ))}
        </div>
        {readOnly && <span className="view-only">View only — log in as admin to edit</span>}
        <div className="editor-actions" hidden={readOnly}>
          <button className="btn btn-gray btn-small" onClick={resetDefaults} disabled={tab === "buildings" ? !buildings : !units}>
            Reset to defaults
          </button>
          <button className="btn btn-green btn-small" onClick={save} disabled={saving || !unsaved}>
            {saving ? "Saving..." : unsaved ? "Save" : "Saved"}
          </button>
        </div>
      </header>

      {status && (
        <div className={`units-status${status.error ? " units-status-error" : ""}`} role="status">{status.text}</div>
      )}

      {tab === "buildings" ? (
        buildings === null ? (
          !status && <p className="room-note units-loading">Loading buildings...</p>
        ) : (
          <BuildingsTab owner={owner} units={units} buildings={buildings} onChange={updateBuilding} readOnly={readOnly} />
        )
      ) : (
        <>
          <section className="panel trait-legend">
            <h3>Traits</h3>
            <ul>
              {TRAITS.map((trait) => (
                <li key={trait.id}>
                  <TraitChip trait={trait} />
                  <span>{trait.description}</span>
                </li>
              ))}
            </ul>
          </section>

          {units === null ? (
            !status && <p className="room-note units-loading">Loading units...</p>
          ) : (
            <div className="unit-grid">
              {units.map((unit) => (
                <section className="panel unit-card" key={unit.id}>
                  <div className="unit-head">
                    <TileIcon tile={unitTile(unit.sprite, owner)} size={64} className="unit-sprite" />
                    <input
                      className={`unit-name${unit.name.trim() ? "" : " field-invalid"}`}
                      value={unit.name}
                      maxLength={UNIT_LIMITS.nameLength}
                      readOnly={readOnly}
                      onChange={(event) => update(unit.id, "name", event.target.value)}
                      aria-label="Unit name"
                      autoComplete="off"
                    />
                  </div>

                  <div className="type-toggle" role="radiogroup" aria-label={`${unit.name} type`}>
                    {UNIT_TYPES.map((type) => (
                      <button
                        key={type}
                        role="radio"
                        aria-checked={unit.type === type}
                        className={`type-${type}${unit.type === type ? " type-active" : ""}`}
                        disabled={readOnly}
                        onClick={() => update(unit.id, "type", type)}
                      >
                        {TYPE_LABELS[type]}
                      </button>
                    ))}
                  </div>

                  <div className="unit-traits">
                    {unit.traits.map((id) => (
                      <TraitChip
                        key={id}
                        trait={TRAIT_BY_ID[id]}
                        onRemove={readOnly ? null : () => update(unit.id, "traits", unit.traits.filter((trait) => trait !== id))}
                      />
                    ))}
                    {readOnly && unit.traits.length === 0 && <span className="no-traits">No traits</span>}
                    {!readOnly && unit.traits.length < MAX_TRAITS && (
                      <select
                        className="trait-add"
                        value=""
                        onChange={(event) => event.target.value && update(unit.id, "traits", [...unit.traits, event.target.value])}
                        aria-label={`Add a trait to ${unit.name}`}
                      >
                        <option value="">+ Trait</option>
                        {TRAITS.filter((trait) => !unit.traits.includes(trait.id)).map((trait) => (
                          <option key={trait.id} value={trait.id}>{trait.label}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="unit-stats">
                    {UNIT_STATS.map((stat) => (
                      <label key={stat}>
                        {STAT_LABELS[stat]}
                        <input
                          type="number"
                          className={statValid(stat, unit[stat]) ? "" : "field-invalid"}
                          min={UNIT_LIMITS[stat].min}
                          max={UNIT_LIMITS[stat].max}
                          step={stat === "price" ? 500 : 1}
                          value={unit[stat]}
                          readOnly={readOnly}
                          onChange={(event) => update(unit.id, stat, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default UnitEditor;
