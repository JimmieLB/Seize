import { useState } from "react";
import { BARRACKS_INFANTRY_ATTACK, BLOCKADE_HP, FLAG_INCOME_BONUS, TOWER_VEHICLE_ATTACK } from "../shared/gameRules.js";
import { TRAITS } from "../shared/unitFormat.js";
import TileIcon from "./map/TileIcon.jsx";
import { BLOCKADE, BRIDGE, GRASS, MOUNTAIN, ROADS, WATER, objectTile, unitTile } from "./map/tiles.js";

const RED = 1;

const STEPS = [
  {
    id: "goal",
    title: "The goal",
    icon: objectTile("hq", RED),
    body: (
      <>
        <p>Every player starts with an <b>HQ</b>, some buildings and some cash. Take turns buying units, moving them and fighting.</p>
        <p><b>Capture an enemy HQ to knock that player out.</b> The last player standing wins.</p>
      </>
    ),
  },
  {
    id: "start",
    title: "Starting a game",
    icon: objectTile("city", 0),
    body: (
      <>
        <ol>
          <li>Type a nickname on the main screen and press <b>Create room</b>.</li>
          <li>As host, pick a map. Its preview shows the buildings each colour starts with.</li>
          <li>Share the link in the address bar (it ends in the game ID) so friends can join, then press <b>Start game</b>.</li>
        </ol>
        <p>Anyone can also <b>Watch</b> a live game from the lobby without playing.</p>
      </>
    ),
  },
  {
    id: "turns",
    title: "Turns and cash",
    icon: objectTile("factory", RED),
    body: (
      <>
        <p>Only the active player can act. When you're done, press <b>End turn</b>. A sound plays when it's your turn again.</p>
        <p>At the start of each of your turns you earn the <b>cash per day</b> of every building you own. Each flag you own adds +{FLAG_INCOME_BONUS * 100}% on top.</p>
        <p>
          Click a <b>Factory</b> you own to buy land units, an <b>Airport</b> for air units, or a <b>Port</b> for boats.
          A new unit appears on the building and can move on your next turn.
        </p>
      </>
    ),
  },
  {
    id: "move",
    title: "Moving",
    icon: unitTile(11, RED),
    body: (
      <>
        <p>
          <b>Click and drag</b> from one of your units to draw its path with arrows, then let go to move there.
          A unit can spend up to its <b>Speed</b> each turn.
        </p>
        <ul>
          <li><b>Click</b> any unit (yours or not) to see where it could move, in blue.</li>
          <li><b>Double-click</b> a Ranged unit to see what it can hit, in orange.</li>
          <li>After moving, choose an action from the panel, or press <b>Wait</b> to end that unit's move.</li>
          <li>Made a mistake? <b>Ctrl+Z</b> or the <b>Undo</b> button takes back your latest change only.</li>
        </ul>
      </>
    ),
  },
  {
    id: "terrain",
    title: "Terrain",
    icon: MOUNTAIN,
    body: (
      <>
        <ul className="tutorial-tiles">
          <li><TileIcon tile={GRASS[0]} /> <span><b>Grass</b> costs 1 Speed. Units with <b>Treads</b> pay 2.</span></li>
          <li><TileIcon tile={ROADS[10]} /> <span><b>Roads</b> cost 1 for everyone, including Treads.</span></li>
          <li><TileIcon tile={MOUNTAIN} /> <span><b>Mountains</b> can only be climbed by units that Capture (infantry), for 2 Speed.</span></li>
          <li><TileIcon tile={WATER.center} /> <span><b>Water</b> is for boats. Air units fly over everything.</span></li>
          <li><TileIcon tile={BRIDGE.horizontal} /> <span><b>Bridges</b> carry land units, and boats can sail underneath. Press <b>F</b> to switch between a boat and the unit above it.</span></li>
          <li><TileIcon tile={BLOCKADE} /> <span><b>Blockades</b> block land units until destroyed. They have {BLOCKADE_HP} health and no defense.</span></li>
        </ul>
      </>
    ),
  },
  {
    id: "fight",
    title: "Fighting",
    icon: unitTile(3, RED),
    body: (
      <>
        <p>
          Move next to an enemy, then click it to attack. Hovering an enemy shows how much damage you'd deal and take.
          If the defender survives and is next to you, it hits back.
        </p>
        <ul>
          <li>Damage grows with <b>Attack</b> and your unit's health, and shrinks with the target's <b>Defense</b>.</li>
          <li><b>Ranged</b> units attack from 2–3 tiles away but can't move and fire in the same turn. They never take a counterattack.</li>
          <li>A unit can't move again after it attacks or captures.</li>
          <li>Hurt units show a health bar. Units with <b>Resupply</b> repair neighbours each turn.</li>
        </ul>
      </>
    ),
  },
  {
    id: "capture",
    title: "Capturing",
    icon: objectTile("flag", RED),
    body: (
      <>
        <p>
          Units with the <b>Captures</b> trait (infantry) can take buildings and flags. Move onto one and press <b>Capture</b>.
        </p>
        <p>
          Each capture adds <b>health × 0.5</b>% progress, so a full-health unit takes 2 turns. At 100% the building turns your colour.
          Keep your capturers healthy.
        </p>
        <ul className="tutorial-tiles">
          <li><TileIcon tile={objectTile("barracks", RED)} /> <span><b>Barracks</b>: your infantry get +{BARRACKS_INFANTRY_ATTACK} Attack per Barracks you own.</span></li>
          <li><TileIcon tile={objectTile("tower", RED)} /> <span><b>Comm tower</b>: your vehicles get +{TOWER_VEHICLE_ATTACK} Attack per tower.</span></li>
          <li><TileIcon tile={objectTile("flag", RED)} /> <span><b>Flag</b>: +{FLAG_INCOME_BONUS * 100}% income each.</span></li>
        </ul>
        <p className="tutorial-muted">The Buildings tab on the Units page lists every building and its cash per day.</p>
      </>
    ),
  },
  {
    id: "transport",
    title: "Transports",
    icon: unitTile(7, RED),
    body: (
      <>
        <p>
          Drag a land unit onto a friendly <b>Transport</b> to board it. Move the transport, then select it and press <b>Drop</b> to unload onto a green tile next to it.
        </p>
        <p>A Transport carries one Infantry or Mech. A <b>Heavy-Transport</b> (like the Lander) carries any two land units.</p>
      </>
    ),
  },
];

/** A short how-to-play guide: a list of topics on the left, one topic at a time on the right. */
function Tutorial({ onExit }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  return (
    <div className="units-screen tutorial-screen">
      <header className="room-bar">
        <button className="btn btn-gray btn-small" onClick={onExit}>← Back</button>
        <h1>How to play</h1>
      </header>
      <div className="tutorial-layout">
        <nav className="panel tutorial-nav" aria-label="Tutorial topics">
          {STEPS.map((item, i) => (
            <button
              key={item.id}
              className={`tutorial-topic${i === index ? " tutorial-topic-active" : ""}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => setIndex(i)}
            >
              <span className="tutorial-num">{i + 1}</span>
              {item.title}
            </button>
          ))}
        </nav>
        <article className="panel tutorial-card">
          <div className="tutorial-head">
            <TileIcon tile={step.icon} size={48} />
            <h2>{step.title}</h2>
            <span className="tutorial-count">{index + 1} / {STEPS.length}</span>
          </div>
          <div className="tutorial-body">{step.body}</div>
          {step.id === "fight" && (
            <ul className="tutorial-traits">
              {TRAITS.map((trait) => (
                <li key={trait.id}><b>{trait.label}</b> {trait.description}</li>
              ))}
            </ul>
          )}
          <div className="tutorial-buttons">
            <button className="btn btn-gray btn-small" disabled={index === 0} onClick={() => setIndex(index - 1)}>← Back</button>
            {last ? (
              <button className="btn btn-green btn-small" onClick={onExit}>Let's play!</button>
            ) : (
              <button className="btn btn-blue btn-small" onClick={() => setIndex(index + 1)}>Next →</button>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}

export default Tutorial;
