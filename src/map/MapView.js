// Babylon.js view of a tile map: a textured plane under an orthographic camera.
// Map cell (x, y) covers world x in [x, x + 1] and world y in [-y - 1, -y].
// Behind the map sits an endless ocean; the map texture includes a ring of ocean tiles around
// the map so its edges get proper shorelines and blend into that ocean. The camera can't be
// moved off the map.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { drawCell, drawMap, drawTile } from "./renderMap.js";
import { TILE, WATER } from "./tiles.js";

const TEXTURE_SCALE = 2; // texture pixels per sheet pixel (keeps grid lines thin)
const MARGIN = 1; // ring of ocean tiles drawn around the map, in tiles
const OCEAN_SIZE = 512; // the background ocean plane, in tiles (far bigger than any view)
const MIN_ZOOM = 2; // half the visible height, in tiles
const MAX_ZOOM = 40;

export class MapView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLImageElement} sheet
   * @param {{ onPaintStart?, onPaint?(x, y), onPaintEnd?, onHover?(cell | null), onCellClick?(cell) }} handlers
   */
  constructor(canvas, sheet, handlers = {}) {
    this.canvas = canvas;
    this.sheet = sheet;
    this.handlers = handlers;
    this.map = null;
    this.grid = true;
    this.dirty = new Set();
    this.dirtyAll = false;
    this.zoom = 10;
    this.painting = false;
    this.panFrom = null;
    this.spaceHeld = false;
    this.panWithLeftButton = false; // when true, left-drag pans instead of painting (view-only)
    this.showBorder = true; // outline around the map (see setBorderVisible)

    this.engine = new Engine(canvas, false, { stencil: false, preserveDrawingBuffer: false }, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = Color4.FromHexString("#71d5f5ff"); // ocean blue, never really visible

    this.camera = new FreeCamera("camera", new Vector3(0, 0, -10), this.scene);
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 100;
    this.updateOrtho();

    this.hoverMaterial = new StandardMaterial("hover", this.scene);
    this.hoverMaterial.disableLighting = true;
    this.hoverMaterial.emissiveColor = Color3.White();
    this.hoverMaterial.alpha = 0.35;
    this.hoverMeshes = [];
    this.hoverCell = null;
    this.mirror = null;

    this.engine.runRenderLoop(() => {
      this.flush();
      this.scene.render();
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.engine.resize();
      this.updateOrtho();
    });
    this.resizeObserver.observe(canvas);

    this.listeners = [
      [canvas, "pointerdown", (event) => this.onPointerDown(event)],
      [canvas, "pointermove", (event) => this.onPointerMove(event)],
      [canvas, "pointerup", (event) => this.onPointerUp(event)],
      [canvas, "pointercancel", (event) => this.onPointerUp(event)],
      [canvas, "pointerleave", () => this.setHover(null)],
      [canvas, "wheel", (event) => this.onWheel(event), { passive: false }],
      [canvas, "contextmenu", (event) => event.preventDefault()],
      [window, "keydown", (event) => this.onKey(event, true)],
      [window, "keyup", (event) => this.onKey(event, false)],
      [window, "blur", () => { this.spaceHeld = false; this.updateCursor(); }],
    ];
    for (const [target, type, listener, options] of this.listeners) target.addEventListener(type, listener, options);
    this.updateCursor();
  }

  // ---- Map / texture ----

  /** Shows a map. Rebuilds the texture when dimensions change; `fit` recenters the camera. */
  setMap(map, { fit = false } = {}) {
    const resized = !this.map || this.map.width !== map.width || this.map.height !== map.height;
    this.map = map;
    if (resized || !this.texture) this.buildMesh();
    this.dirtyAll = true;
    if (fit || resized) this.fit();
  }

  buildMesh() {
    this.mapMesh?.dispose(false, true);
    const { width, height } = this.map;
    const paddedWidth = width + 2 * MARGIN;
    const paddedHeight = height + 2 * MARGIN;
    this.texture = new DynamicTexture(
      "map",
      { width: paddedWidth * TILE * TEXTURE_SCALE, height: paddedHeight * TILE * TEXTURE_SCALE },
      this.scene,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    const material = new StandardMaterial("map", this.scene);
    material.disableLighting = true;
    material.emissiveTexture = this.texture;
    this.mapMesh = CreatePlane("map", { width: paddedWidth, height: paddedHeight }, this.scene);
    this.mapMesh.material = material;
    this.mapMesh.position.set(width / 2, -height / 2, 0);
    this.mapMesh.isPickable = false;
    this.buildOcean();
  }

  /** A huge plane tiled with open water, behind the map, lined up with the map's grid. */
  buildOcean() {
    if (!this.ocean) {
      const size = TILE * TEXTURE_SCALE;
      const texture = new DynamicTexture("ocean", { width: size, height: size }, this.scene, false, Texture.NEAREST_SAMPLINGMODE);
      const ctx = texture.getContext();
      ctx.imageSmoothingEnabled = false;
      drawTile(ctx, this.sheet, WATER.center, 0, 0, size);
      texture.update();
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.uScale = OCEAN_SIZE;
      texture.vScale = OCEAN_SIZE;
      const material = new StandardMaterial("ocean", this.scene);
      material.disableLighting = true;
      material.emissiveTexture = texture;
      this.ocean = CreatePlane("ocean", { size: OCEAN_SIZE }, this.scene);
      this.ocean.material = material;
      this.ocean.isPickable = false;
    }
    // Integer edges (OCEAN_SIZE is even) keep the repeating water tiles on the map's grid.
    this.ocean.position.set(Math.round(this.map.width / 2), -Math.round(this.map.height / 2), 0.05);
  }

  /**
   * Marks a cell (and its neighbours, whose autotiles depend on it) for redraw. Neighbours can be
   * in the ocean ring around the map, so dirty cells are keyed on the padded grid.
   */
  markDirty(x, y) {
    const paddedWidth = this.map.width + 2 * MARGIN;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx >= -MARGIN && cy >= -MARGIN && cx < this.map.width + MARGIN && cy < this.map.height + MARGIN) {
          this.dirty.add((cy + MARGIN) * paddedWidth + (cx + MARGIN));
        }
      }
    }
  }

  redrawAll() {
    this.dirtyAll = true;
  }

  /** Shows or hides the outline around the map (redraws just the ocean ring it's drawn in). */
  setBorderVisible(visible) {
    if (this.showBorder === visible) return;
    this.showBorder = visible;
    if (!this.map) return;
    const { width, height } = this.map;
    const paddedWidth = width + 2 * MARGIN;
    const ring = (x, y) => this.dirty.add((y + MARGIN) * paddedWidth + (x + MARGIN));
    for (let x = -MARGIN; x < width + MARGIN; x += 1) {
      ring(x, -1);
      ring(x, height);
    }
    for (let y = 0; y < height; y += 1) {
      ring(-1, y);
      ring(width, y);
    }
  }

  setGrid(grid) {
    this.grid = grid;
    this.dirtyAll = true;
  }

  /** Replaces a per-cell layer (Map index -> value), redrawing only cells whose value changed. */
  replaceLayer(name, entries) {
    const next = new Map(entries.map(({ x, y, ...value }) => [y * this.map.width + x, value]));
    const previous = this[name] ?? new Map();
    const key = (value) => (value ? JSON.stringify(value) : "");
    for (const index of new Set([...previous.keys(), ...next.keys()])) {
      if (key(previous.get(index)) !== key(next.get(index))) this.markDirty(index % this.map.width, Math.floor(index / this.map.width));
    }
    this[name] = next;
  }

  /**
   * Units drawn on top of the map: [{ x, y, tile, dim?, badges?, health? }]. `dim` greys the sprite
   * out; badges: [{ tile, corner }]; health (0-100) draws a health bar. `{ x, y, stack: [top, bottom] }`
   * draws two units sharing a tile.
   */
  setUnits(units) {
    this.replaceLayer("units", units);
  }

  /** Drawn above units: [{ x, y, tint?, tile? }] — e.g. movement range tints and path arrows. */
  setOverlay(cells) {
    this.replaceLayer("overlay", cells);
  }

  /**
   * Outlines the map's edge (white with a dark outer edge), drawn in the ocean ring just outside
   * the map so it never covers tiles or units. Redrawn after every update.
   */
  drawBorder(ctx) {
    const size = TILE * TEXTURE_SCALE;
    const x = MARGIN * size;
    const y = MARGIN * size;
    const width = this.map.width * size;
    const height = this.map.height * size;
    const line = TEXTURE_SCALE; // one sheet pixel
    const frame = (inset, thickness, color) => {
      const left = x - inset - thickness;
      const top = y - inset - thickness;
      const outerWidth = width + 2 * (inset + thickness);
      const outerHeight = height + 2 * (inset + thickness);
      ctx.fillStyle = color;
      ctx.fillRect(left, top, outerWidth, thickness);
      ctx.fillRect(left, top + outerHeight - thickness, outerWidth, thickness);
      ctx.fillRect(left, top, thickness, outerHeight);
      ctx.fillRect(left + outerWidth - thickness, top, thickness, outerHeight);
    };
    frame(0, line, "rgba(255, 255, 255, 0.95)");
    frame(line, line, "rgba(20, 50, 80, 0.45)");
  }

  /** Health bar along the bottom of a tile: green above 60%, yellow above 30%, red below. */
  drawHealthBar(ctx, health, px, py, size) {
    const unit = size / TILE; // one sheet pixel
    const x = px + 2 * unit;
    const y = py + size - 3 * unit;
    const width = size - 4 * unit;
    const height = 2 * unit;
    ctx.fillStyle = "rgba(20, 20, 20, 0.8)";
    ctx.fillRect(x - unit / 2, y - unit / 2, width + unit, height + unit);
    ctx.fillStyle = health > 60 ? "#4cd964" : health > 30 ? "#f0c419" : "#e5534b";
    ctx.fillRect(x, y, Math.max(unit / 2, (width * health) / 100), height);
  }

  /** One unit entry (sprite, badges, health bar) drawn into a square of `size` at (px, py). */
  drawUnitEntry(ctx, unit, px, py, size) {
    if (unit.dim) ctx.drawImage(this.dimmedSprite(unit.tile), px, py, size, size);
    else if (unit.tile !== undefined) drawTile(ctx, this.sheet, unit.tile, px, py, size); // health-only entries have no sprite
    // Half-size badges in a corner ("tl", "br", ...), e.g. the capture flag.
    for (const badge of unit.badges ?? []) {
      const half = size / 2;
      drawTile(ctx, this.sheet, badge.tile, badge.corner.includes("r") ? px + half : px, badge.corner.includes("b") ? py + half : py, half);
    }
    if (unit.health !== undefined) this.drawHealthBar(ctx, unit.health, px, py, size);
  }

  /** A greyed-out copy of a sprite, cached per tile. */
  dimmedSprite(tile) {
    this.dimmed ??= new Map();
    if (!this.dimmed.has(tile)) {
      const canvas = document.createElement("canvas");
      canvas.width = TILE;
      canvas.height = TILE;
      const ctx = canvas.getContext("2d");
      drawTile(ctx, this.sheet, tile, 0, 0, TILE);
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(30, 30, 30, 0.5)";
      ctx.fillRect(0, 0, TILE, TILE);
      this.dimmed.set(tile, canvas);
    }
    return this.dimmed.get(tile);
  }

  flush() {
    if (!this.map || !this.texture || (!this.dirtyAll && this.dirty.size === 0)) return;
    const ctx = this.texture.getContext();
    ctx.imageSmoothingEnabled = false;
    const options = { scale: TEXTURE_SCALE, grid: this.grid, margin: MARGIN };
    const size = TILE * TEXTURE_SCALE;
    const drawLayers = (index) => {
      const px = ((index % this.map.width) + MARGIN) * size;
      const py = (Math.floor(index / this.map.width) + MARGIN) * size;
      const unit = this.units?.get(index);
      if (unit?.stack) {
        // Two units on one tile (a boat under a bridge + a unit on top): the first is drawn smaller
        // in the top-left, the second (the boat) smaller in the bottom-right, overlapping slightly.
        const small = Math.round(size * 0.6);
        const [top, bottom] = unit.stack;
        this.drawUnitEntry(ctx, bottom, px + size - small, py + size - small, small);
        this.drawUnitEntry(ctx, top, px, py, small);
      } else if (unit) {
        this.drawUnitEntry(ctx, unit, px, py, size);
      }
      const overlay = this.overlay?.get(index);
      if (overlay?.tint) {
        ctx.fillStyle = overlay.tint;
        ctx.fillRect(px, py, size, size);
      }
      if (overlay?.tile !== undefined) drawTile(ctx, this.sheet, overlay.tile, px, py, size);
    };
    if (this.dirtyAll) {
      drawMap(ctx, this.sheet, this.map, options);
      for (const index of new Set([...(this.units?.keys() ?? []), ...(this.overlay?.keys() ?? [])])) drawLayers(index);
    } else {
      const paddedWidth = this.map.width + 2 * MARGIN;
      for (const key of this.dirty) {
        const x = (key % paddedWidth) - MARGIN;
        const y = Math.floor(key / paddedWidth) - MARGIN;
        drawCell(ctx, this.sheet, this.map, x, y, options);
        if (this.inside({ x, y })) drawLayers(y * this.map.width + x);
      }
    }
    if (this.showBorder) this.drawBorder(ctx);
    this.dirty.clear();
    this.dirtyAll = false;
    this.texture.update();
  }

  // ---- Camera ----

  aspect() {
    return this.engine.getRenderWidth() / Math.max(1, this.engine.getRenderHeight());
  }

  updateOrtho() {
    const halfHeight = this.zoom;
    const halfWidth = this.zoom * this.aspect();
    this.camera.orthoTop = halfHeight;
    this.camera.orthoBottom = -halfHeight;
    this.camera.orthoLeft = -halfWidth;
    this.camera.orthoRight = halfWidth;
  }

  fit() {
    if (!this.map) return;
    const { width, height } = this.map;
    this.camera.position.x = width / 2;
    this.camera.position.y = -height / 2;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.max(height / 2, width / 2 / this.aspect()) * 1.08));
    this.updateOrtho();
  }

  /** Keeps the centre of the view over the map, so it can never be scrolled away. */
  clampCamera() {
    if (!this.map) return;
    const { position } = this.camera;
    position.x = Math.min(this.map.width, Math.max(0, position.x));
    position.y = Math.min(0, Math.max(-this.map.height, position.y));
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    return {
      x: this.camera.position.x + this.camera.orthoLeft + nx * (this.camera.orthoRight - this.camera.orthoLeft),
      y: this.camera.position.y + this.camera.orthoTop - ny * (this.camera.orthoTop - this.camera.orthoBottom),
    };
  }

  /** Horizontal centre of a cell, as a fraction of the canvas width (0 = left edge, 1 = right edge). */
  cellScreenX(x) {
    const left = this.camera.position.x + this.camera.orthoLeft;
    return (x + 0.5 - left) / (this.camera.orthoRight - this.camera.orthoLeft);
  }

  /** A cell's box in page (client) pixels: { left, top, right, bottom }. */
  cellClientRect(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const left = this.camera.position.x + this.camera.orthoLeft;
    const top = this.camera.position.y + this.camera.orthoTop;
    const sx = rect.width / (this.camera.orthoRight - this.camera.orthoLeft);
    const sy = rect.height / (this.camera.orthoTop - this.camera.orthoBottom);
    return {
      left: rect.left + (x - left) * sx,
      right: rect.left + (x + 1 - left) * sx,
      top: rect.top + (top + y) * sy,
      bottom: rect.top + (top + y + 1) * sy,
    };
  }

  cellAt(event) {
    const world = this.screenToWorld(event.clientX, event.clientY);
    return { x: Math.floor(world.x), y: Math.floor(-world.y) };
  }

  inside({ x, y }) {
    return this.map && x >= 0 && y >= 0 && x < this.map.width && y < this.map.height;
  }

  // ---- Input ----

  updateCursor() {
    this.canvas.style.cursor = this.panFrom ? "grabbing" : this.spaceHeld || this.panWithLeftButton ? "grab" : "crosshair";
  }

  onKey(event, down) {
    if (event.code !== "Space") return;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (typing) return;
    event.preventDefault();
    this.spaceHeld = down;
    this.updateCursor();
  }

  onPointerDown(event) {
    this.canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || event.button === 2 || (event.button === 0 && (this.spaceHeld || this.panWithLeftButton))) {
      this.panFrom = { x: event.clientX, y: event.clientY };
      this.updateCursor();
      return;
    }
    if (event.button !== 0 || !this.map) return;
    this.painting = true;
    this.lastCell = this.cellAt(event);
    this.handlers.onPaintStart?.();
    if (this.inside(this.lastCell)) {
      this.handlers.onCellClick?.(this.lastCell);
      this.handlers.onPaint?.(this.lastCell.x, this.lastCell.y);
    }
  }

  onPointerMove(event) {
    if (this.panFrom) {
      const worldPerPixel = (2 * this.zoom) / this.canvas.getBoundingClientRect().height;
      this.camera.position.x -= (event.clientX - this.panFrom.x) * worldPerPixel;
      this.camera.position.y += (event.clientY - this.panFrom.y) * worldPerPixel;
      this.clampCamera();
      this.panFrom = { x: event.clientX, y: event.clientY };
      return;
    }
    const cell = this.cellAt(event);
    this.setHover(this.inside(cell) ? cell : null);
    if (!this.painting) return;
    // Fill the gap between pointer events so fast strokes stay continuous.
    for (const step of lineCells(this.lastCell, cell)) {
      if (this.inside(step)) this.handlers.onPaint?.(step.x, step.y);
    }
    this.lastCell = cell;
  }

  onPointerUp(event) {
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (this.panFrom) {
      this.panFrom = null;
      this.updateCursor();
    }
    if (this.painting) {
      this.painting = false;
      this.handlers.onPaintEnd?.();
    }
  }

  onWheel(event) {
    event.preventDefault();
    const before = this.screenToWorld(event.clientX, event.clientY);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * Math.exp(event.deltaY * 0.0015)));
    this.updateOrtho();
    const after = this.screenToWorld(event.clientX, event.clientY);
    this.camera.position.x += before.x - after.x;
    this.camera.position.y += before.y - after.y;
    this.clampCamera();
  }

  /** Optional cell -> cells function; hover highlights every cell a paint would affect. */
  setMirror(mirror) {
    this.mirror = mirror;
    this.hoverKey = undefined;
    this.setHover(this.hoverCell);
  }

  setHover(cell) {
    const key = cell ? `${cell.x},${cell.y}` : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.hoverCell = cell;
    const cells = cell ? (this.mirror?.(cell) ?? [cell]) : [];
    while (this.hoverMeshes.length < cells.length) {
      const mesh = CreatePlane("hover", { size: 1 }, this.scene);
      mesh.material = this.hoverMaterial;
      mesh.isPickable = false;
      this.hoverMeshes.push(mesh);
    }
    this.hoverMeshes.forEach((mesh, index) => {
      const target = cells[index];
      mesh.isVisible = Boolean(target);
      if (target) mesh.position.set(target.x + 0.5, -target.y - 0.5, -0.01);
    });
    this.handlers.onHover?.(cell);
  }

  dispose() {
    for (const [target, type, listener, options] of this.listeners) target.removeEventListener(type, listener, options);
    this.resizeObserver.disconnect();
    this.scene.dispose();
    this.engine.dispose();
  }
}

/**
 * Cells on the line from a to b, excluding a (Bresenham), stepping only horizontally or
 * vertically so every cell shares an edge with the previous one (needed for movement paths).
 */
function lineCells(a, b) {
  const cells = [];
  let { x, y } = a;
  const dx = Math.abs(b.x - x);
  const dy = -Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1;
  const sy = y < b.y ? 1 : -1;
  let error = dx + dy;
  while (x !== b.x || y !== b.y) {
    const doubled = 2 * error;
    const stepX = doubled >= dy;
    const stepY = doubled <= dx;
    if (stepX) { error += dy; x += sx; }
    if (stepY) { error += dx; y += sy; }
    if (stepX && stepY) cells.push({ x, y: y - sy }); // fill the corner of a diagonal step
    cells.push({ x, y });
  }
  return cells;
}
