import { useEffect, useRef } from "react";
import { fromSaved } from "./mapModel.js";
import { drawMap, getSheet } from "./renderMap.js";
import { TILE } from "./tiles.js";

/** Static thumbnail of a saved map (2D canvas, no Babylon). */
function MapPreview({ map, className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getSheet()
      .then((sheet) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        canvas.width = map.width * TILE;
        canvas.height = map.height * TILE;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        drawMap(ctx, sheet, fromSaved(map), { scale: 1 });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [map]);

  return (
    <canvas
      ref={canvasRef}
      className={`map-preview ${className}`}
      style={{ aspectRatio: `${map.width} / ${map.height}` }}
      aria-label={`Preview of ${map.name}`}
      role="img"
    />
  );
}

export default MapPreview;
