/**
 * 2:1 dimetric (isometric) projection helpers, ported from the Isometric
 * world generator project. Grid cells are addressed as (c, r) — column and
 * row — and project onto screen-space diamonds of TILE_W × TILE_H pixels.
 *
 * Convention: cellToScreen returns the TOP VERTEX of the cell's diamond.
 * The diamond's bounding box is therefore (x - TILE_W/2, y, TILE_W, TILE_H).
 */

export const TILE_W = 64;
export const TILE_H = 32;

/** Pixels of vertical lift per elevation level (half a tile, as in the generator). */
export const ELEV_STEP = TILE_H / 2;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Cell {
  c: number;
  r: number;
}

/** Project a grid cell to the screen position of its diamond's top vertex. */
export function cellToScreen(c: number, r: number, ox = 0, oy = 0): ScreenPoint {
  return {
    x: ox + (c - r) * (TILE_W / 2),
    y: oy + (c + r) * (TILE_H / 2),
  };
}

/** Inverse projection: screen point → fractional grid cell. */
export function screenToCell(x: number, y: number, ox = 0, oy = 0): Cell {
  const dx = (x - ox) / (TILE_W / 2);
  const dy = (y - oy) / (TILE_H / 2);
  return {
    c: (dy + dx) / 2,
    r: (dy - dx) / 2,
  };
}

/**
 * Painter's-algorithm depth key: items further "down" the diagonal render
 * on top. Feed this to zIndex inside a sortableChildren container.
 */
export function depthKey(c: number, r: number, elev = 0): number {
  return (c + r) * 10 + elev;
}

/**
 * Polygon points (flat array, clockwise from top vertex) for a diamond
 * whose top vertex sits at (x, y).
 */
export function diamondPoints(x: number, y: number, w = TILE_W, h = TILE_H): number[] {
  return [
    x, y,
    x + w / 2, y + h / 2,
    x, y + h,
    x - w / 2, y + h / 2,
  ];
}
