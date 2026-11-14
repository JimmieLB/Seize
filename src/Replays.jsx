import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { PLAYERS } from "./map/mapModel.js";

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const formatDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function duration(start, end) {
  if (!start || !end) return "";
  const minutes = Math.round((new Date(end) - new Date(start)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  return minutes < 60 ? `${Math.max(1, minutes)} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Saved replays, newest first. Watching one loads it and hands it to `onWatch`. */
function Replays({ onExit, onWatch, isAdmin }) {
  const [data, setData] = useState(null); // { replays, usedBytes, limitBytes }
  const [error, setError] = useState("");
  const [loadingId, setLoadingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const fileRef = useRef(null);

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

  /** Uploads a replay file; MetaFinder result files are converted by the server. */
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = ""; // so picking the same file again still uploads
    if (!file) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const { replay, format } = await api("/api/replays", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      setNotice(
        format !== "original"
          ? `Converted "${file.name}" from MetaFinder format and saved it.${replay.note ? ` ${replay.note}` : ""}`
          : `Saved "${file.name}".`,
      );
      load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setUploading(false);
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
        {isAdmin && (
          <>
            <input ref={fileRef} type="file" accept=".json,.gz,application/json,application/gzip" hidden onChange={upload} />
            <button
              className="btn btn-blue btn-small"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              title="Upload a Seize replay or a MetaFinder result file (converted automatically)"
            >
              {uploading ? "Uploading..." : "Upload replay"}
            </button>
          </>
        )}
      </header>
      {error && <div className="error replays-error" role="alert">{error}</div>}
      {notice && <div className="panel replays-error" role="status">{notice}</div>}
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
                  {[
                    summary.mapName,
                    `${summary.width}×${summary.height}`,
                    `${summary.turns} turns`,
                    duration(summary.startedAt, summary.endedAt),
                    summary.source === "metafinder" && "from MetaFinder",
                  ].filter(Boolean).join(" · ")}
                </span>
                {summary.note && <span className="replay-meta">{summary.note}</span>}
                <span className="replay-players">
                  {summary.players.map((player) => (
                    <span key={player.owner} className={summary.winner?.owner === player.owner ? "replay-winner" : ""}>
                      <i style={{ background: PLAYERS[player.owner].color }} />
                      {player.name}
                      {summary.winner?.owner === player.owner && " (winner)"}
                    </span>
                  ))}
                </span>
                <span className="replay-meta">
                  {summary.endedAt ? `${formatDate(summary.endedAt)} · ` : ""}{formatSize(summary.bytes)}
                </span>
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
