import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { api, getAdminToken, setAdminToken } from "./api.js";
import RoomLobby from "./RoomLobby.jsx";
import { MAP_LIMITS } from "../shared/mapFormat.js";

const GameScreen = lazy(() => import("./GameScreen.jsx"));
const MapEditor = lazy(() => import("./MapEditor.jsx"));
const UnitEditor = lazy(() => import("./UnitEditor.jsx"));
const Tutorial = lazy(() => import("./Tutorial.jsx"));
const Replays = lazy(() => import("./Replays.jsx"));

const playerIdKey = "seize-player-id";
const playerNameKey = "seize-player-name";
const PLAYER_LIMITS = Array.from(
  { length: MAP_LIMITS.maxPlayers - MAP_LIMITS.minPlayers + 1 },
  (_, index) => MAP_LIMITS.minPlayers + index,
);
// Stops browsers and password managers from filling saved login details into room forms.
const noAutofill = { autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "" };

/** The game id in the address bar (localhost:5173/<game_id>), or null on the lobby. */
function gameIdFromUrl() {
  return decodeURIComponent(window.location.pathname.slice(1)) || null;
}

function setUrl(path, { replace = false } = {}) {
  if (window.location.pathname === path) return;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
}

function getPlayerId() {
  let id = localStorage.getItem(playerIdKey);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(playerIdKey, id);
  }
  return id;
}

/**
 * Home screen background: plays a random saved replay (one change every 1.5 s), then another.
 * Shows nothing when there are no replays.
 */
function LobbyBackground() {
  const [replay, setReplay] = useState(null);
  const lastIdRef = useRef(null);
  const runRef = useRef(0); // remounts the view each time, even for the same replay
  const next = useCallback(async () => {
    try {
      const { replays } = await api("/api/replays");
      if (replays.length === 0) return setReplay(null);
      // Avoid showing the same replay twice in a row when there's a choice.
      const choices = replays.length > 1 ? replays.filter((item) => item.id !== lastIdRef.current) : replays;
      const pick = choices[Math.floor(Math.random() * choices.length)];
      const data = await api(`/api/replays/${pick.id}`);
      if (data.frames?.length > 0) {
        lastIdRef.current = pick.id;
        runRef.current += 1;
        setReplay({ ...data, run: runRef.current });
      }
    } catch {
      setReplay(null); // the background is decoration: fail quietly
    }
  }, []);
  useEffect(() => {
    next();
  }, [next]);
  if (!replay) return null;
  return (
    <Suspense fallback={null}>
      <GameScreen
        key={replay.run}
        room={{ id: replay.id, name: replay.roomName }}
        playerId=""
        onLeave={next}
        replay={replay}
        ambient
      />
    </Suspense>
  );
}

function App() {
  const [rooms, setRooms] = useState([]);
  const [joinedRoom, setJoinedRoom] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem(playerNameKey) || "",
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState("lobby");
  const [replay, setReplay] = useState(null); // loaded replay being watched
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminDialog, setAdminDialog] = useState(false);
  const [adminError, setAdminError] = useState("");

  // Check a saved admin token (it may have expired or the password may have changed).
  useEffect(() => {
    if (!getAdminToken()) return;
    api("/api/admin")
      .then(({ admin }) => {
        setIsAdmin(admin);
        if (!admin) setAdminToken(null);
      })
      .catch(() => {});
  }, []);

  async function adminLogin(event) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("adminPassword");
    try {
      const { token } = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      setAdminToken(token);
      setIsAdmin(true);
      setAdminDialog(false);
      setAdminError("");
    } catch (requestError) {
      setAdminError(requestError.message);
    }
  }

  function adminLogout() {
    setAdminToken(null);
    setIsAdmin(false);
  }
  // A game id from the URL we still need to join (opened a link, refreshed, or pressed Back/Forward).
  const [pendingGameId, setPendingGameId] = useState(gameIdFromUrl);
  const [inviteId, setInviteId] = useState(null); // game from a link, waiting for a nickname
  const [watchingId, setWatchingId] = useState(null); // live game being spectated
  const joinedRoomId = joinedRoom?.id;
  const joinedRef = useRef(null); // latest joined room id, readable from async callbacks
  joinedRef.current = joinedRoomId ?? null;
  const loadErrorRef = useRef(null); // error message from the last failed room-list refresh
  const openRooms = rooms.filter((room) => !room.isFull && room.status !== "playing");
  const liveRooms = rooms.filter((room) => room.status === "playing");
  const watchingRoom = watchingId && !joinedRoom ? rooms.find((room) => room.id === watchingId) ?? null : null;

  const loadRooms = useCallback(async () => {
    const startedIn = joinedRef.current;
    try {
      const data = await api("/api/rooms");
      setRooms(data.rooms);
      // Ignore results for a room we've since left or switched from (the request was already in flight).
      if (startedIn && joinedRef.current === startedIn) {
        setJoinedRoom(data.rooms.find((room) => room.id === startedIn) ?? null);
      }
      // Only clear the error if it came from a failed refresh, not e.g. "That game has closed."
      if (loadErrorRef.current) setError((current) => (current === loadErrorRef.current ? "" : current));
      loadErrorRef.current = null;
    } catch (requestError) {
      loadErrorRef.current = requestError.message;
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [joinedRoomId]);

  useEffect(() => {
    loadRooms();
    // Poll faster inside a room (or while watching) so changes show up quickly.
    const intervalId = window.setInterval(loadRooms, joinedRoomId || watchingId ? 2000 : 5000);
    return () => window.clearInterval(intervalId);
  }, [loadRooms, joinedRoomId, watchingId]);

  // Stop spectating if the game's room closes.
  useEffect(() => {
    if (!watchingId || loading || rooms.some((room) => room.id === watchingId)) return;
    setWatchingId(null);
    setError("That game has ended.");
  }, [rooms, watchingId, loading]);

  useEffect(() => {
    if (!joinedRoomId) return undefined;
    const sendHeartbeat = () =>
      api(`/api/rooms/${joinedRoomId}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ playerId: getPlayerId() }),
      }).catch(() => setJoinedRoom(null));
    sendHeartbeat();
    const intervalId = window.setInterval(sendHeartbeat, 15_000);
    return () => window.clearInterval(intervalId);
  }, [joinedRoomId]);

  // Keep the address bar in sync: /<game_id> while in (or watching) a game, / otherwise.
  useEffect(() => {
    const gameId = joinedRoomId ?? watchingId;
    if (gameId) setUrl(`/${gameId}`);
    else if (!pendingGameId && !inviteId && gameIdFromUrl()) setUrl("/", { replace: true });
  }, [joinedRoomId, watchingId, pendingGameId, inviteId]);

  // Browser Back/Forward: leave the game or go to the game in the URL.
  useEffect(() => {
    const handlePopState = () => {
      const gameId = gameIdFromUrl();
      if (gameId === (joinedRoomId ?? watchingId)) return;
      if (joinedRoomId) leaveRoom({ keepUrl: true });
      setWatchingId(null);
      setPendingGameId(gameId);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  });

  useEffect(() => {
    const handleClose = () => {
      if (joinedRoomId) {
        navigator.sendBeacon(
          `/api/rooms/${joinedRoomId}/leave`,
          new Blob([JSON.stringify({ playerId: getPlayerId() })], {
            type: "application/json",
          }),
        );
      }
    };
    window.addEventListener("pagehide", handleClose);
    return () => window.removeEventListener("pagehide", handleClose);
  }, [joinedRoomId]);

  function updateName(value) {
    setPlayerName(value);
    localStorage.setItem(playerNameKey, value.trim());
  }

  function requireName() {
    if (playerName.trim()) return true;
    setError("Enter a nickname first.");
    return false;
  }

  function closeDialog() {
    setDialog(null);
    setError("");
  }

  function openCreate() {
    if (!requireName()) return;
    setError("");
    setDialog({ type: "create" });
  }

  async function createRoom(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const { room } = await api("/api/rooms", {
        method: "POST",
        body: JSON.stringify({
          name: formData.get("roomName"),
          maxPlayers: Number(formData.get("maxPlayers")),
          password: formData.get("roomPassword"),
          saveReplay: formData.get("saveReplay") === "on",
          playerId: getPlayerId(),
          playerName: playerName.trim(),
        }),
      });
      setRooms((current) => [room, ...current]);
      setJoinedRoom(room);
      setDialog(null);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  /** Joins a room. For a game that's already running, rejoins if you have a seat, else watches it. */
  async function joinRoom(room, password = "") {
    try {
      const { room: joined } = await api(`/api/rooms/${room.id}/join`, {
        method: "POST",
        body: JSON.stringify({
          playerId: getPlayerId(),
          playerName: playerName.trim(),
          password,
        }),
      });
      setWatchingId(null);
      setJoinedRoom(joined);
      setRooms((current) => current.map((item) => (item.id === joined.id ? joined : item)));
      setDialog(null);
      setError("");
    } catch (requestError) {
      if (room.status === "playing") {
        watchRoom(room);
        return;
      }
      setError(requestError.message);
    }
  }

  function handleJoinClick(room) {
    if (room.status === "playing") {
      // Rejoin if we're one of its players (no nickname needed for that), otherwise spectate.
      if (playerName.trim()) joinRoom(room);
      else watchRoom(room);
      return;
    }
    if (!requireName()) return;
    setError("");
    if (room.hasPassword) setDialog({ type: "join", room });
    else joinRoom(room);
  }

  function watchRoom(room) {
    setDialog(null);
    setError("");
    setInviteId(null);
    setWatchingId(room.id);
  }

  function stopWatching() {
    setUrl("/");
    setWatchingId(null);
  }

  function submitDialog(event) {
    if (dialog.type === "create") return createRoom(event);
    event.preventDefault();
    return joinRoom(dialog.room, new FormData(event.currentTarget).get("roomPassword"));
  }

  async function leaveRoom({ keepUrl = false } = {}) {
    if (!joinedRoom) return;
    if (!keepUrl) setUrl("/");
    try {
      await api(`/api/rooms/${joinedRoom.id}/leave`, {
        method: "POST",
        body: JSON.stringify({ playerId: getPlayerId() }),
      });
    } catch {
      // Already removed server-side; leave locally regardless.
    }
    setJoinedRoom(null);
    loadRooms();
  }

  // Join the game from the URL once the room list has loaded. Without a nickname yet,
  // show an invite prompt instead of joining.
  useEffect(() => {
    if (!pendingGameId || loading) return;
    setPendingGameId(null);
    if (joinedRoomId === pendingGameId) return;
    const room = rooms.find((current) => current.id === pendingGameId);
    if (!room) {
      setError("That game doesn't exist or has closed.");
      return;
    }
    if (!playerName.trim() && room.status !== "playing") {
      setInviteId(room.id);
      return;
    }
    handleJoinClick(room);
  }, [pendingGameId, loading]);

  const inviteRoom = inviteId && !joinedRoom ? rooms.find((room) => room.id === inviteId) ?? null : null;

  function updateJoinedRoom(room) {
    setJoinedRoom(room);
    setRooms((current) => current.map((item) => (item.id === room.id ? room : item)));
  }

  if (joinedRoom && joinedRoom.status !== "playing") {
    return (
      <RoomLobby room={joinedRoom} playerId={getPlayerId()} onLeave={leaveRoom} onRoomChange={updateJoinedRoom} />
    );
  }

  if (watchingRoom) {
    return (
      <Suspense fallback={<div className="lobby">Loading...</div>}>
        <GameScreen key={watchingRoom.id} room={watchingRoom} playerId={getPlayerId()} onLeave={stopWatching} spectator />
      </Suspense>
    );
  }

  if (!joinedRoom && screen === "replays") {
    return (
      <Suspense fallback={<div className="lobby">Loading...</div>}>
        {replay ? (
          <GameScreen
            key={replay.id}
            room={{ id: replay.id, name: replay.roomName }}
            playerId={getPlayerId()}
            onLeave={() => setReplay(null)}
            replay={replay}
          />
        ) : (
          <Replays onExit={() => setScreen("lobby")} onWatch={setReplay} isAdmin={isAdmin} />
        )}
      </Suspense>
    );
  }

  if (!joinedRoom && screen === "tutorial") {
    return (
      <Suspense fallback={<div className="lobby">Loading...</div>}>
        <Tutorial onExit={() => setScreen("lobby")} />
      </Suspense>
    );
  }

  if (!joinedRoom && screen === "units") {
    return (
      <Suspense fallback={<div className="lobby">Loading...</div>}>
        <UnitEditor onExit={() => setScreen("lobby")} readOnly={!isAdmin} />
      </Suspense>
    );
  }

  if (joinedRoom || screen === "editor") {
    return (
      <Suspense fallback={<div className="lobby">Loading...</div>}>
        {joinedRoom ? (
          <GameScreen room={joinedRoom} playerId={getPlayerId()} onLeave={leaveRoom} />
        ) : (
          <MapEditor onExit={() => setScreen("lobby")} isAdmin={isAdmin} />
        )}
      </Suspense>
    );
  }

  return (
    <>
    {!watchingRoom && <LobbyBackground />}
    <main className="lobby lobby-over-replay">
      <h1 className="logo">seize<span>.io</span></h1>

      <section className="panel">
        <input
          className="nick-input"
          value={playerName}
          onChange={(event) => updateName(event.target.value)}
          placeholder="Nickname"
          maxLength="20"
          aria-label="Nickname"
          {...noAutofill}
          autoFocus
        />
        {inviteRoom && (
          <div className="invite">
            <span>Join <b>{inviteRoom.name}</b>? Enter a nickname first.</span>
            <button
              className="btn btn-green btn-small"
              onClick={() => {
                if (!requireName()) return;
                setInviteId(null);
                handleJoinClick(inviteRoom);
              }}
            >
              Join game
            </button>
            <button className="invite-dismiss" onClick={() => setInviteId(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        <button className="btn btn-green btn-wide" onClick={openCreate}>Create room</button>
        <div className="btn-row">
          <button className="btn btn-blue" onClick={() => { setError(""); setScreen("editor"); }}>Map editor</button>
          <button className="btn btn-blue" onClick={() => { setError(""); setScreen("units"); }}>Units</button>
        </div>
        <div className="btn-row">
          <button className="btn btn-gray" onClick={() => { setError(""); setScreen("tutorial"); }}>How to play</button>
          <button className="btn btn-gray" onClick={() => { setError(""); setScreen("replays"); }}>Replays</button>
        </div>

        {error && !dialog && <div className="error" role="alert">{error}</div>}

        <div className="rooms-header">
          <span>Rooms</span>
          <span>{openRooms.length} open</span>
        </div>

        <div className="room-list">
          {loading ? (
            <div className="room-empty">Loading...</div>
          ) : openRooms.length === 0 ? (
            <div className="room-empty">No rooms yet. Create one!</div>
          ) : (
            openRooms.map((room) => (
              <div className="room-row" key={room.id}>
                <span className="room-name">
                  {room.hasPassword && <span className="lock" title="Password protected">🔒</span>}
                  {room.name}
                </span>
                <span className="room-map">{room.map?.name ?? "No map yet"}</span>
                <span className="room-count">{room.playerCount}/{room.maxPlayers}</span>
                <button className="btn btn-blue btn-small" onClick={() => handleJoinClick(room)}>Join</button>
              </div>
            ))
          )}
        </div>

        {liveRooms.length > 0 && (
          <>
            <div className="rooms-header">
              <span>Live games</span>
              <span>{liveRooms.length} playing</span>
            </div>
            <div className="room-list">
              {liveRooms.map((room) => (
                <div className="room-row" key={room.id}>
                  <span className="room-name">
                    <span className="live-dot" aria-hidden="true" />
                    {room.name}
                  </span>
                  <span className="room-map">{room.map?.name ?? ""}</span>
                  <span className="room-count">{room.playerCount} playing</span>
                  <button className="btn btn-gray btn-small" onClick={() => handleJoinClick(room)}>Watch</button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <div className="admin-status">
        {isAdmin ? (
          <>
            <span className="admin-badge">Admin</span>
            <button className="text-link" onClick={adminLogout}>Log out</button>
          </>
        ) : (
          <button className="text-link" onClick={() => { setAdminError(""); setAdminDialog(true); }}>Admin login</button>
        )}
      </div>

      {adminDialog && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setAdminDialog(false);
        }}>
          <section className="panel modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
            <h2 id="admin-title">Admin login</h2>
            <form onSubmit={adminLogin}>
              <input name="adminPassword" type="password" placeholder="Admin password" required autoFocus autoComplete="current-password" />
              {adminError && <div className="error" role="alert">{adminError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-gray" onClick={() => setAdminDialog(false)}>Cancel</button>
                <button type="submit" className="btn btn-green">Log in</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {dialog && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section className="panel modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <h2 id="modal-title">{dialog.type === "create" ? "Create room" : dialog.room.name}</h2>
            <form onSubmit={submitDialog} autoComplete="off">
              {dialog.type === "create" ? (
                <>
                  <input name="roomName" placeholder="Room name" maxLength="32" required autoFocus {...noAutofill} />
                  <select name="maxPlayers" defaultValue="2" aria-label="Player limit">
                    {PLAYER_LIMITS.map((number) => <option key={number} value={number}>{number} players</option>)}
                  </select>
                  <input name="roomPassword" type="password" placeholder="Password (optional)" maxLength="64" {...noAutofill} autoComplete="new-password" />
                  <label className="modal-check">
                    <input type="checkbox" name="saveReplay" defaultChecked />
                    Save replay when the game ends
                  </label>
                </>
              ) : (
                <input name="roomPassword" type="password" placeholder="Room password" required autoFocus {...noAutofill} autoComplete="new-password" />
              )}
              {error && <div className="error" role="alert">{error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-gray" onClick={closeDialog}>Cancel</button>
                <button type="submit" className="btn btn-green">{dialog.type === "create" ? "Create" : "Join"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
    </>
  );
}

export default App;
