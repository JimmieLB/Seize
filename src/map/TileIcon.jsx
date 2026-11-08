import { SHEET_COLUMNS, SHEET_SIZE, TILE } from "./tiles.js";

/** A single tile from the sprite sheet, scaled up crisply via CSS. */
function TileIcon({ tile, size = 32, className = "" }) {
  const scale = size / TILE;
  return (
    <span
      className={`tile-icon ${className}`}
      style={{
        width: size,
        height: size,
        backgroundSize: `${SHEET_SIZE.width * scale}px ${SHEET_SIZE.height * scale}px`,
        backgroundPosition: `-${(tile % SHEET_COLUMNS) * size}px -${Math.floor(tile / SHEET_COLUMNS) * size}px`,
      }}
    />
  );
}

export default TileIcon;
