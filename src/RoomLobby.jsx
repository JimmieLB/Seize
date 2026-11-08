import { useEffect, useState } from "react";
import { api } from "./api.js";
import MapPreview from "./map/MapPreview.jsx";
import { PLAYERS } from "./map/mapModel.js";

/** Waiting room: players gather, the host picks a map and starts the game. */
function RoomLobby({ room, playerId, onLeave, onRoomChange }) {
  const isHost = room.hostId === playerId;
  const [maps, setMaps] = useState(null);
  const [selectedMap, setSelectedMap] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Host: maps that fit at least the room's player limit.
  useEffect(() => {
    if (!isHost) return undefined;
    let cancelled = false;
    api("/api/maps?full=1")
      .then(({ maps: all }) => {
        if (!cancelled) setMaps(all.filter((map) => map.players >= room.maxPlayers));
      })
      .catch((requestError) => !cancelled && setError(requestError.message));
    return () => {
      cancelled = true;
    };
  }, [isHost, room.maxPlayers]);

  // Everyone: full data for the chosen map's preview.
  const mapKey = room.map ? `${room.map.id}:${room.map.updatedAt}` : null;
  useEffect(() => {
    if (!mapKey) {
      setSelectedMap(null);
      return undefined;
    }
    let cancelled = false;
    api(`/api/rooms/${room.id}/map`)
      .then(({ map }) => !cancelled && setSelectedMap(map))
      .catch(() => !cancelled && setSelectedMap(null));
    return () => {
      cancelled = true;
    };
  }, [mapKey, room.id]);

  async function roomAction(action, body = {}) {
    setBusy(true);
    try {
      const { room: updated } = await api(`/api/rooms/${room.id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ playerId, ...body }),
      });
      setError("");
      onRoomChange(updated);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const slots = Array.from({ length: room.maxPlayers }, (_, index) => room.players[index] ?? null);
  const canStart = Boolean(room.map) && room.playerCount >= 2;

  return (
    <div className="room-screen">
      <header className="room-bar">
        <button className="btn btn-red btn-small" onClick={onLeave}>Leave room</button>
        <h1>{room.name}</h1>
        <span className="room-status">Waiting for players · {room.playerCount}/{room.maxPlayers}</span>
      </header>

      <div className="room-layout">
        <section className="panel room-side">
          <h3>Players</h3>
          <ul className="slot-list">
            {slots.map((player, index) => (
              <li key={player?.id ?? `empty-${index}`} className={player ? "" : "slot-empty"}>
                <i style={{ background: PLAYERS[index + 1].color }} />
                <span className="slot-name">{player ? player.name : "Waiting..."}</span>
                {player?.id === room.hostId && <span className="slot-tag">Host</span>}
                {player?.id === playerId && <span className="slot-tag slot-you">You</span>}
              </li>
            ))}
          </ul>

          <h3>Map</h3>
          {room.map ? (
            <div className="chosen-map">
              {selectedMap ? <MapPreview map={selectedMap} /> : <div className="map-preview map-preview-empty" />}
              <strong>{room.map.name}</strong>
              <span>{room.map.width}×{room.map.height} · {room.map.players} players</span>
            </div>
          ) : (
            <p className="room-note">{isHost ? "Pick a map from the list." : "The host hasn't picked a map yet."}</p>
          )}

          {error && <div className="error" role="alert">{error}</div>}

          {isHost ? (
            <button className="btn btn-green btn-wide" disabled={!canStart || busy} onClick={() => roomAction("start")}>
              Start game
            </button>
          ) : (
            <p className="room-note">Waiting for the host to start the game.</p>
          )}
          {isHost && !canStart && (
            <p className="room-note">
              {!room.map ? "Choose a map to start." : "Wait for at least one more player to start."}
            </p>
          )}
        </section>

        {isHost && (
          <section className="panel room-maps">
            <h3>Choose a map <span>({room.maxPlayers}+ players)</span></h3>
            {maps === null ? (
              <div className="room-empty">Loading maps...</div>
            ) : maps.length === 0 ? (
              <div className="room-empty">
                No maps for {room.maxPlayers}+ players yet. Make one in the Map editor.
              </div>
            ) : (
              <div className="map-grid">
                {maps.map((map) => (
                  <button
                    key={map.id}
                    className={`map-card${room.map?.id === map.id ? " map-card-active" : ""}`}
                    onClick={() => roomAction("map", { mapId: map.id })}
                    disabled={busy}
                  >
                    <MapPreview map={map} />
                    <strong>{map.name}</strong>
                    <span>{map.width}×{map.height} · {map.players}P</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default RoomLobby;
