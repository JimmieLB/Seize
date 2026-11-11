import { useEffect, useState } from "react";
import { api } from "./api.js";
import { PLAYERS } from "./map/mapModel.js";

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const formatDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function duration(start, end) {
  const minutes = Math.round((new Date(end) - new Date(start)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  return minutes < 60 ? `${Math.max(1, minutes)} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Saved replays, newest first. Watching one loads it and hands it to `onWatch`. */
function Replays({ onExit, onWatch, isAdmin }) {
  const [data, setData] = useState(null); // { replays, usedBytes, limitBytes }
  const [error, setError] = useState("");
  const [loadingId, setLoadingId] = useState(null);

  const load = () =>
    api("/api/replays")
      .then(setData)
      .catch((requestError) => setError(requestError.message));
  useEffect(() => {
    load();
  }, []);

  async function watch(summary) {
    setLoadingId(summary.id);
    setError("");
    try {
      onWatch(await api(`/api/replays/${summary.id}`));
    } catch (requestError) {
      setError(requestError.message);
      setLoadingId(null);
    }
  }

  async function remove(summary) {
    if (!window.confirm(`Delete the replay of "${summary.roomName}"? This can't be undone.`)) return;
    try {
      await api(`/api/replays/${summary.id}`, { method: "DELETE" });
      load();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return (
    <div className="units-screen">
      <header className="room-bar">
        <button className="btn btn-gray btn-small" onClick={onExit}>← Back</button>
        <h1>Replays</h1>
        {data && (
          <span className="room-status" title="Oldest replays are deleted automatically when space runs out">
            {formatSize(data.usedBytes)} of {formatSize(data.limitBytes)} used
          </span>
        )}
      </header>
      {error && <div className="error replays-error" role="alert">{error}</div>}
      <div className="replay-list">
        {!data ? (
          <div className="room-empty">Loading...</div>
        ) : data.replays.length === 0 ? (
          <div className="panel room-empty">No replays yet. Finished games are saved here unless the room turned replays off.</div>
        ) : (
          data.replays.map((summary) => (
            <section className="panel replay-card" key={summary.id}>
              <div className="replay-main">
                <strong>{summary.roomName}</strong>
                <span className="replay-meta">
                  {summary.mapName} · {summary.width}×{summary.height} · {summary.turns} turns · {duration(summary.startedAt, summary.endedAt)}
                </span>
                <span className="replay-players">
                  {summary.players.map((player) => (
                    <span key={player.owner} className={summary.winner?.owner === player.owner ? "replay-winner" : ""}>
                      <i style={{ background: PLAYERS[player.owner].color }} />
                      {player.name}
                      {summary.winner?.owner === player.owner && " (winner)"}
                    </span>
                  ))}
                </span>
                <span className="replay-meta">{formatDate(summary.endedAt)} · {formatSize(summary.bytes)}</span>
              </div>
              <div className="replay-actions">
                <button className="btn btn-green btn-small" disabled={Boolean(loadingId)} onClick={() => watch(summary)}>
                  {loadingId === summary.id ? "Loading..." : "Watch"}
                </button>
                {isAdmin && (
                  <button className="btn btn-red btn-small" onClick={() => remove(summary)}>Delete</button>
                )}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export default Replays;
