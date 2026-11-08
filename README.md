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

On your turn, press on one of your units and drag: the tiles it can reach are tinted blue and an arrow follows the exact path you drag (dragging back over the path shortens it; dragging to a tile you can't reach in a straight continuation snaps to the cheapest route). Release to move. Each unit moves once per turn, and newly bought units wait until your next turn; moved units are greyed out. Movement points are the unit's Speed (+1 with Speedy). Costs per tile: air units 1 everywhere; sea units 1 on open water or a port (bridges block ships); land units 1 on roads, bridges and buildings and 1 on grass (2 with Treads), and can't enter water. Units can pass through friendly units but not enemies, and can't stop on another unit. The server re-checks every move (`POST /api/rooms/:id/move`).

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

Editing maps, units and buildings requires the admin password. Use **Admin login** under the lobby panel; the login lasts 30 days on that browser (Log out removes it). Everyone else can still open the **Maps** viewer and the **Units** page, but only to look. The server enforces this: changes without a valid admin token are refused, and repeated wrong passwords are blocked for 10 minutes.

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
