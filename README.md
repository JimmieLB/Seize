# Seize

A React and Vite game-room lobby with a JavaScript HTTP API.

## Run locally

Requires Node.js 20.19 or newer.

```sh
npm install
npm run dev
```

Vite serves the lobby at `http://localhost:5173` and proxies API requests to the room server at `http://localhost:3001`. To build the frontend, run `npm run build`. To run only the API server, run `npm start`.

## Room data

Rooms are saved in `server/data/rooms.json`, created automatically on the first write. Room passwords are salted and hashed before storage. Connected player records are refreshed by a heartbeat and treated as disconnected after 45 seconds without one. A room closes (is deleted) once nobody has been connected to it for 15 seconds; rejoining within that window keeps it open. Full rooms are hidden from the joinable-room list.

The API supports listing and creating rooms, joining with an optional password, heartbeats, and leaving a room. The lobby polls room status every five seconds.

## Map editor

Open it from the lobby with **Map editor**. Set the map name, size in tiles (5–50 each side) and player count (2–4), then paint land, water, roads, buildings and flags using the Kenney Tiny Battle tiles in `public/sprites/tiny-battle/`. Water shorelines and road connections are picked automatically from neighbouring tiles; a road on water becomes a bridge. Each player can have one HQ.

Controls: left-click/drag to paint, right-drag or hold Space to pan, mouse wheel to zoom, Ctrl+Z to undo.

Maps are saved in `server/data/maps.json` through `/api/maps` (list, create, get, update, delete). The format and its validation live in `shared/mapFormat.js` and are used by both the editor and the server.

## Game rooms

Rooms hold 2–4 players. After creating a room the host waits in the room screen, picks a map (only maps built for at least the room's player limit are offered, each with a preview) and starts the game once at least two players are in. Starting snapshots the map into the room, so later edits to the map don't affect a running game, and closes the room to new players. If everyone leaves a running game, the room reopens. If the host leaves, the next player becomes host.

Environment overrides: `PORT` (API port), `SEIZE_DATA_DIR` (where `rooms.json` and `maps.json` live) and, for Vite, `SEIZE_API_URL` (API address to proxy to).

## Units

The **Units** page (from the lobby) lists the 13 unit sprites from the Tiny Battle sheet. Each unit has an editable name, type (land, air or sea), price, speed, attack and defense; press Save to store them in `server/data/units.json` via `GET`/`PUT /api/units`. Defaults and validation live in `shared/unitFormat.js`. When a game starts, the current unit list is snapshotted into the room (`GET /api/rooms/:id/units`), so later edits don't change a running game.

## Turns and buying units

When a game starts, players are seated in join order (P1 = red, P2 = blue, P3 = green, P4 = orange) and take turns; only the active player can act, and **End turn** passes play to the next connected player (players who leave are skipped). At the start of each of their turns a player earns $1,000 per building they own (flags don't pay). On your turn, click one of your factories (land units), airports (air) or ports (sea) to buy a unit at its price from the Units page; the unit appears on that building for everyone, and a building with a unit on it can't produce another. Rules live in `shared/gameRules.js`; the server is authoritative (`GET /api/rooms/:id/game`, `POST .../buy`, `POST .../end-turn`) and clients poll the game state every second.

## Moving units

On your turn, press on one of your units and drag: the tiles it can reach are tinted blue and an arrow follows the exact path you drag (dragging back over the path shortens it; dragging to a tile you can't reach in a straight continuation snaps to the cheapest route). Release to move. Each unit moves once per turn, and newly bought units wait until your next turn; moved units are greyed out. Movement points are the unit's Speed (+1 with Speedy). Costs per tile: air units 1 everywhere; sea units 1 on water (including under bridges) or a port; land units 1 on roads, bridges and buildings and 1 on grass (2 with Treads), and can't enter water. Units can pass through friendly units but not enemies, and can't stop on another unit. The server re-checks every move (`POST /api/rooms/:id/move`).

## Capturing and combat

Units have health (100% when bought); damaged units show a health bar along the bottom of their tile (green above 60%, yellow above 30%, red below). After moving (or instead of moving) a unit picks one action from the panel that opens when you release or click it: **Capture**, **Attack** (click a red-tinted enemy; hovering shows the predicted damage) or **Wait**. Once a unit has acted it can't move or act again until your next turn.

- **Capture** (units with the Captures trait, standing on a building or flag they don't own): adds health % × 0.5 to the capture progress; at 100% the property becomes yours and pays you income. Progress resets if the capturing unit leaves or is destroyed.
- **Attack**: adjacent enemies, or 2–3 tiles away for Ranged units that haven't moved this turn. Damage = Attack × 15 × (attacker health / 100) × trait multipliers × 10 / (10 + 2 × Defense), minus 10 if the target is Armored (Anti-Air ×2 vs air, Anti-Armor ×1.5 vs land vehicles). A surviving defender hits back if it can attack and the attacker is adjacent. Units at 0% are destroyed.
- Speedy now only applies at full health.

All of this lives in `shared/gameRules.js` and is enforced by the server (`POST /api/rooms/:id/attack`, `.../capture`, `.../wait`).

## Traits in play

| Trait | Effect |
|---|---|
| Speedy | +1 Speed while at full health. |
| Treads | Grass costs 2 movement instead of 1. |
| Anti-Air | ×2 damage against air units. |
| Anti-Armor | ×1.5 damage against land vehicles (land units without Captures). |
| Armored | Attacks on it do 10 less damage (health %). |
| Ranged | Attacks from 2–3 tiles away, only if it hasn't moved this turn; can't hit back. |
| Captures | Can capture buildings and flags. |
| Transport | Carries 1 infantry or mech (land unit with Captures). |
| Heavy-Transport | Carries any 2 land units. |
| Resupply | At the start of your turn, adjacent friendly units heal 10%. |

**Transports:** drag a unit onto a friendly transport with room to board it (this ends that unit's turn; land units can board a Lander from the tile next to it, even though it's on water). Carried units are hidden, move with the transport, and are destroyed with it; a digit on the transport shows how many it holds. To unload, select the transport, press **Drop** next to a cargo unit and click a green tile next to it. Dropped units can't act that turn, and the transport can't move after dropping (it can still drop other cargo).

## Game links

Every room has a short game id (e.g. `k7m2qx`). Creating or joining a room switches the address to `http://localhost:5173/<game_id>`, so the link can be shared: opening it joins that game (or, without a nickname yet, shows a "Join game" prompt). Refreshing the page keeps you in the game, the browser's Back button leaves it, and Leave room returns to `/`. Links to games that have closed show an error in the lobby.

## Buildings

The Units page has a **Buildings** tab listing every building and the flag. Each has an editable **Cash per day** (what it pays its owner at the start of each of their turns) and a free-text **Note** for what it should do; factories, airports and ports also list the units they build. Press Save (shared with the Units tab) to store them in `server/data/buildings.json` via `GET`/`PUT /api/buildings`. Defaults and validation live in `shared/buildingFormat.js`. When a game starts, the cash-per-day table is copied into the game, so later edits only affect new games.

### Building effects in play

- **Barracks:** your infantry (land units with Captures) get +2 Attack for each Barracks you own.
- **Comm tower:** your land vehicles (land units without Captures) get +1 Attack for each Comm tower you own.
- **Flag:** your daily income (including the flags' own cash per day) gets +25% for each flag you own.

Bonuses follow ownership, so capturing or losing these buildings changes them immediately; units with 0 Attack get no bonus. In a game, the player list shows each player's income per day, the buy panel shows Attack bonuses (e.g. `Atk 2 +4`), and the selected unit's panel shows its total Attack. The effects are coded in `shared/gameRules.js` (`attackBonus`, `incomeFor`).

## Admin

Editing units and buildings, and changing or deleting published maps, requires the admin password. Use **Admin login** under the lobby panel; the login lasts 30 days on that browser (Log out removes it). Anyone can open the map editor and **publish** a new map (limited to 20 per hour per address), but once published it is view-only for non-admins. Everyone can still view the Units page. The server enforces all of this: changes without a valid admin token are refused, and repeated wrong passwords are blocked for 10 minutes.

The password comes from the `ADMIN_PASSWORD` environment variable; if it isn't set, the default in `server/admin.js` is used. Changing the password logs every admin out.

## Production / deploying to Railway

`npm run build` builds the site into `dist/`, and `npm start` runs one Node process that serves both the site and the API (game links like `/k7m2qx` work), on `PORT` (default 3001).

1. Push this project to a GitHub repository.
2. In Railway: **New Project → Deploy from GitHub repo** and pick it. `railway.json` tells Railway to run `npm run build`, start with `npm start`, and health-check `/api/health`.
3. Add a **Volume** to the service (any mount path, e.g. `/data`). The server automatically stores its data there via `RAILWAY_VOLUME_MOUNT_PATH` (or set `SEIZE_DATA_DIR` yourself). Without a volume, data is lost on every deploy.
4. Under **Variables**, set `ADMIN_PASSWORD`.
5. Under **Settings → Networking**, click **Generate Domain** to get a public URL.
6. Keep the service at **one replica**: rooms and games live in that process's memory.

On first start with an empty volume, maps, units and buildings are seeded from `server/seed/` (a copy of the local data at the time). After that the volume is the source of truth; update `server/seed/` only if you want new deployments to start from different data.

Environment variables: `PORT`, `ADMIN_PASSWORD`, `SEIZE_DATA_DIR` (overrides the data location), and for local development `SEIZE_API_URL` (where Vite proxies `/api`).

## Winning

Capturing a player's HQ defeats them: their units are removed, their buildings and flags go to the capturer, and their turns are skipped (they can keep watching). When only one player is left, everyone sees the result screen — **Victory!** for the winner, "<name> wins!" for the others — and the game is over; no further actions are accepted. "Back to lobby" leaves the room.

## Ocean around the map

Every map sits in an endless ocean: a huge water plane is drawn behind it, and the map texture includes a one-tile ring of ocean so land on the map's edge gets a proper shoreline and edge water flows straight into the sea. The ocean is only scenery — nothing can enter it (units can't move off the map and the editor ignores clicks outside it), and the camera's centre is kept over the map so the view can't be scrolled away. Map thumbnails are unaffected.

## Mountains, blockades and the map border

- **Mountains** (Terrain → Mountain in the editor): infantry and mech (land units with Captures) can climb them for 2 movement; other land units and ships can't enter; air units fly over for 1. Roads, buildings, flags and blockades can't be placed on mountains.
- **Blockades** (Terrain → Blockade): obstacles that can sit on open land or on roads. Land and sea units can't move through or onto them; air units can fly over but not stop on them. Any unit that can attack can target one in range (it shows as a red target). Blockades have 10 health (`BLOCKADE_HP` in `shared/gameRules.js`), no defense, never hit back, and show a health bar once damaged; at 0 they're removed and the path opens for everyone.
- **Border:** the edge of the map is outlined (white with a dark edge, just outside the map) — always in the editor, and in a game only while you're dragging a unit to choose where it goes.

Attacks now target a tile (`POST /api/rooms/:id/attack` with `{ unitId, x, y }`), which can hold an enemy unit or a blockade.

## Sounds

Sound files live in `public/sounds/`: `notif.wav` plays when the turn passes to you, `notif2.wav` when it passes to anyone else, and `explode.wav` whenever a unit is destroyed (including units removed when a player is defeated). Nothing plays on first load. The 🔊 button next to Leave/Stop watching mutes sounds; the setting is remembered per browser. See `src/sounds.js`.

## Spectating

Games in progress are listed under **Live games** in the lobby with a **Watch** button, and opening a link to a running game you're not part of (with or without a nickname) also watches it. Spectators see the game update live (and hear its sounds) but can't click anything, don't take a player slot, and don't keep a room open — when the players leave and the room closes, spectators are sent back to the lobby. If you click Watch on a game you have a seat in, you rejoin as that player instead; returning players also no longer need the room password.

## Checking ranges

In a game (as a player or a spectator), click any unit — yours or an enemy's — to tint every tile it could move to on its turn **blue**. Double-click a ranged unit (Ranged trait) to tint its attack range (2–3 tiles away) **orange** instead. Click empty ground to clear it. Clicking your own unit on your turn still opens its action panel as before (and pressing and dragging still moves it).

## Boats under bridges

Ships can sail under bridges. A bridge is the only tile that can hold two units: one boat underneath and one land or air unit on top. Units on different levels of a bridge don't block each other — a boat can pass under an enemy tank, and a tank can drive over an enemy boat — and either can stop there as long as nothing on its own level already is. Both are drawn on the tile (the unit on top in the upper-left, the boat in the lower-right, each with its own health bar). Clicking the tile picks your own unit that can still act first; press **F** to switch to the other unit on the tile (a hint shows when there is one) — if it's yours and can still act it becomes the selected unit, and pressing or dragging on the tile then uses it. If an attacker can hit both units on the tile, a small picker asks which one (the attack request then includes `targetId`).

## Undo

On your turn, **Ctrl+Z** (⌘Z on Mac) or the **Undo** button above End turn reverts your latest change — a purchase, move, attack, capture, wait or drop — for everyone. Only one step is kept: undoing again does nothing until you make another change. You can't undo after ending your turn, can't undo another player's change, and the move that wins the game can't be undone. The server keeps the previous state (`room.gameUndo`) and exposes who may undo as `game.undoSeat`; the action is `POST /api/rooms/:id/undo`.
