/**
 * Agency Buildings — stateless draw helpers + a road-path util for the
 * Agency World engine.
 *
 * These are pure helpers (no PIXI.Application, no module state). The engine
 * integrator calls them while building a node's shell / label / zones so
 * that buildings can be differentiated by federation role, grow with agent
 * count, surface live hardware stats on the roof sign, and so couriers can
 * route along roads instead of straight through walls.
 *
 * Palette matches the engine: gold 0xd4af37, roof 0x0e1421, wall 0x1a212d.
 * Shell metrics in the engine: BUILDING_WIDTH=760, BUILDING_HEIGHT=360,
 * the roof sign sits at y<0 above the shell, the ground road runs
 * horizontally around worldY≈965.
 */

import * as PIXI from "pixi.js";

export type NodeRole = "hub" | "satellite" | "local";

// ════════════════════════════════════════════════════════════════
// PALETTE — kept in sync with agency-world.ts COLORS
// ════════════════════════════════════════════════════════════════

const GOLD = 0xd4af37;
const GOLD_DIM = 0x8a7028;
const ROOF = 0x0e1421;
const WALL = 0x1a212d;
const WALL_TOP = 0x232b3a;
const TEXT_DIM = 0x9aa2b1;
const SHADOW = 0x000000;
const GLASS_LIT = 0xffe9a8;
const GLASS_DARK = 0x121a26;
const AMBER = 0xf5a623;
const TEAL = 0x2dd4bf;
const SOFT_RED = 0xe85d5d;
const BRICK = 0x8b4513;
const BRICK_DARK = 0x6b3410;
const PLANT_GREEN = 0x4ade80;
const PLANT_DARK = 0x22c55e;
const SKY_BLUE = 0x60a5fa;
const STONE = 0x4a5568;
const STONE_LIGHT = 0x718096;

// ════════════════════════════════════════════════════════════════
// PIXEL FONT — local subset copied from agency-world.ts (FONT map).
// Only the glyphs needed by drawHardwareSignage are included; unknown
// glyphs advance by a fixed gap, matching the reference drawText.
// ════════════════════════════════════════════════════════════════

const FONT: Record<string, number[][]> = {
  C: [[0,1,1,1],[1,0,0,0],[1,0,0,0],[1,0,0,0],[0,1,1,1]],
  E: [[1,1,1,1],[1,0,0,0],[1,1,1,0],[1,0,0,0],[1,1,1,1]],
  G: [[0,1,1,1],[1,0,0,0],[1,0,1,1],[1,0,0,1],[0,1,1,0]],
  M: [[1,0,0,0,1],[1,1,0,1,1],[1,0,1,0,1],[1,0,0,0,1],[1,0,0,0,1]],
  P: [[1,1,1,0],[1,0,0,1],[1,1,1,0],[1,0,0,0],[1,0,0,0]],
  U: [[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,0,0,1],[0,1,1,0]],
  "0": [[0,1,1,0],[1,0,0,1],[1,0,0,1],[1,0,0,1],[0,1,1,0]],
  "1": [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
  "2": [[1,1,1,0],[0,0,0,1],[0,1,1,0],[1,0,0,0],[1,1,1,1]],
  "3": [[1,1,1,0],[0,0,0,1],[0,1,1,0],[0,0,0,1],[1,1,1,0]],
  "4": [[1,0,0,1],[1,0,0,1],[1,1,1,1],[0,0,0,1],[0,0,0,1]],
  "5": [[1,1,1,1],[1,0,0,0],[1,1,1,0],[0,0,0,1],[1,1,1,0]],
  "6": [[0,1,1,0],[1,0,0,0],[1,1,1,0],[1,0,0,1],[0,1,1,0]],
  "7": [[1,1,1,1],[0,0,0,1],[0,0,1,0],[0,1,0,0],[0,1,0,0]],
  "8": [[0,1,1,0],[1,0,0,1],[0,1,1,0],[1,0,0,1],[0,1,1,0]],
  "9": [[0,1,1,0],[1,0,0,1],[0,1,1,1],[0,0,0,1],[0,1,1,0]],
  " ": [[0,0],[0,0],[0,0],[0,0],[0,0]],
  ".": [[0],[0],[0],[0],[1]],
  "%": [[1,0,0,1],[0,0,1,0],[0,1,0,0],[1,0,0,1],[0,0,0,0]],
};

function drawText(
  g: PIXI.Graphics,
  text: string,
  x: number,
  y: number,
  color: number,
  scale = 1,
): number {
  let cx = x;
  for (const ch of text.toUpperCase().split("")) {
    const p = FONT[ch];
    if (!p) {
      cx += 4 * scale;
      continue;
    }
    for (let r = 0; r < p.length; r++) {
      for (let c = 0; c < p[r].length; c++) {
        if (p[r][c]) {
          g.beginFill(color);
          g.drawRect(cx + c * scale, y + r * scale, scale, scale);
          g.endFill();
        }
      }
    }
    cx += (p[0].length + 1) * scale;
  }
  return cx - x;
}

function measureText(text: string, scale = 1): number {
  let w = 0;
  for (const ch of text.toUpperCase().split("")) {
    const p = FONT[ch];
    if (!p) {
      w += 4 * scale;
      continue;
    }
    w += (p[0].length + 1) * scale;
  }
  return w - scale;
}

// ════════════════════════════════════════════════════════════════
// ROOF FEATURES — differentiate buildings by federation role
// ════════════════════════════════════════════════════════════════

/**
 * Draw role-specific roof features into `g`, relative to a shell of size
 * w x h (origin top-left). Features sit above the shell (y<0), tucked
 * behind/over the roof sign:
 *   hub       → majestic multi-tiered tower with beacon + radar
 *   satellite → high-tech comms array with lattice tower + solar panels
 *   local     → cozy rooftop with brick chimneys, garden + skylight
 */
export function drawRoofFeatures(
  g: PIXI.Graphics,
  role: NodeRole,
  w: number,
  h: number,
): void {
  void h;
  const top = -32;
  switch (role) {
    case "hub": {
      // ── Multi-tiered art-deco tower on the left third ──
      const towerX = w * 0.15;
      const tier1W = 40;
      const tier1H = 20;
      const tier2W = 30;
      const tier2H = 16;
      const tier3W = 20;
      const tier3H = 14;

      // Tier 1 (base, widest)
      const t1Top = top - tier1H;
      g.beginFill(ROOF);
      g.drawRect(towerX, t1Top, tier1W, tier1H);
      g.endFill();
      g.lineStyle(1, GOLD, 0.8);
      g.drawRect(towerX, t1Top, tier1W, tier1H);
      g.lineStyle(0);
      // Gold trim along tier 1 top edge
      g.beginFill(GOLD, 0.9);
      g.drawRect(towerX - 1, t1Top, tier1W + 2, 2);
      g.endFill();
      // Stepped ledge
      g.beginFill(WALL_TOP);
      g.drawRect(towerX - 2, t1Top + tier1H - 2, tier1W + 4, 2);
      g.endFill();

      // Tier 2 (middle, stepped in)
      const t2X = towerX + (tier1W - tier2W) / 2;
      const t2Top = t1Top - tier2H;
      g.beginFill(ROOF);
      g.drawRect(t2X, t2Top, tier2W, tier2H);
      g.endFill();
      g.lineStyle(1, GOLD, 0.8);
      g.drawRect(t2X, t2Top, tier2W, tier2H);
      g.lineStyle(0);
      g.beginFill(GOLD, 0.9);
      g.drawRect(t2X - 1, t2Top, tier2W + 2, 2);
      g.endFill();
      g.beginFill(WALL_TOP);
      g.drawRect(t2X - 2, t2Top + tier2H - 2, tier2W + 4, 2);
      g.endFill();

      // Tier 3 (top, narrowest)
      const t3X = towerX + (tier1W - tier3W) / 2;
      const t3Top = t2Top - tier3H;
      g.beginFill(ROOF);
      g.drawRect(t3X, t3Top, tier3W, tier3H);
      g.endFill();
      g.lineStyle(1, GOLD, 0.8);
      g.drawRect(t3X, t3Top, tier3W, tier3H);
      g.lineStyle(0);
      g.beginFill(GOLD, 0.9);
      g.drawRect(t3X - 1, t3Top, tier3W + 2, 2);
      g.endFill();

      // ── Arched windows on tower (3 per visible side) ──
      const drawArchWindow = (ax: number, ay: number, aw: number, ah: number) => {
        g.beginFill(GLASS_DARK);
        g.drawRect(ax, ay + 3, aw, ah - 3);
        g.endFill();
        g.beginFill(GLASS_DARK);
        g.drawEllipse(ax + aw / 2, ay + 3, aw / 2, 4);
        g.endFill();
        g.lineStyle(1, GOLD_DIM, 0.7);
        g.drawRect(ax, ay + 3, aw, ah - 3);
        g.drawEllipse(ax + aw / 2, ay + 3, aw / 2, 4);
        g.moveTo(ax + aw / 2, ay);
        g.lineTo(ax + aw / 2, ay + ah);
        g.lineStyle(0);
      };
      // Tier 1 windows
      for (let i = 0; i < 3; i++) {
        drawArchWindow(towerX + 4 + i * 12, t1Top + 5, 6, 10);
      }
      // Tier 2 windows
      for (let i = 0; i < 2; i++) {
        drawArchWindow(t2X + 4 + i * 12, t2Top + 4, 5, 8);
      }

      // ── Spire with glowing gold beacon ──
      const spireBase = t3Top;
      const spireH = 28;
      const spireTop = spireBase - spireH;
      const spireCX = t3X + tier3W / 2;
      // Spire body (narrow tapering)
      g.beginFill(ROOF);
      g.drawPolygon([
        t3X + 4, spireBase,
        t3X + tier3W - 4, spireBase,
        spireCX, spireTop + 6,
      ]);
      g.endFill();
      g.lineStyle(1, GOLD, 0.6);
      g.drawPolygon([
        t3X + 4, spireBase,
        t3X + tier3W - 4, spireBase,
        spireCX, spireTop + 6,
      ]);
      g.lineStyle(0);

      // Gold beacon at spire tip
      g.beginFill(GOLD, 0.95);
      g.drawCircle(spireCX, spireTop + 3, 4);
      g.endFill();
      // Halo ring around beacon
      g.beginFill(GOLD, 0.15);
      g.drawCircle(spireCX, spireTop + 3, 8);
      g.endFill();
      g.lineStyle(1, GOLD, 0.4);
      g.drawCircle(spireCX, spireTop + 3, 6);
      g.lineStyle(0);
      // Bright center
      g.beginFill(0xffffff, 0.9);
      g.drawCircle(spireCX, spireTop + 3, 2);
      g.endFill();

      // ── Rotating radar dish on top of spire ──
      const dishCX = spireCX;
      const dishCY = spireBase - 8;
      // Mast segment above tier 3
      g.lineStyle(2, GOLD, 0.8);
      g.moveTo(dishCX, t3Top);
      g.lineTo(dishCX, dishCY);
      g.lineStyle(0);
      // Rotating dish arm (line with dot — caller animates rotation via transform)
      g.lineStyle(1, TEAL, 0.9);
      g.moveTo(dishCX - 8, dishCY - 2);
      g.lineTo(dishCX + 8, dishCY - 2);
      g.lineStyle(0);
      g.beginFill(TEAL, 0.9);
      g.drawCircle(dishCX - 8, dishCY - 2, 2);
      g.drawCircle(dishCX + 8, dishCY - 2, 2);
      g.endFill();
      g.beginFill(GOLD, 0.9);
      g.drawCircle(dishCX, dishCY - 2, 2);
      g.endFill();

      // ── Antenna array on the right (retained, enhanced) ──
      const baseX = w * 0.72;
      const baseY = top;
      g.beginFill(WALL_TOP);
      g.drawRect(baseX - 26, baseY - 6, 52, 6);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.5);
      g.drawRect(baseX - 26, baseY - 6, 52, 6);
      g.lineStyle(0);
      for (let i = 0; i < 3; i++) {
        const mx = baseX - 16 + i * 16;
        const mastH = 26 + i * 6;
        g.lineStyle(2, GOLD, 0.9);
        g.moveTo(mx, baseY - 6);
        g.lineTo(mx, baseY - 6 - mastH);
        g.lineStyle(0);
        g.lineStyle(1, GOLD_DIM, 0.9);
        g.moveTo(mx - 5, baseY - 6 - mastH + 6);
        g.lineTo(mx + 5, baseY - 6 - mastH + 6);
        g.moveTo(mx - 4, baseY - 6 - mastH + 12);
        g.lineTo(mx + 4, baseY - 6 - mastH + 12);
        g.lineStyle(0);
        g.beginFill(SOFT_RED, 0.95);
        g.drawCircle(mx, baseY - 6 - mastH, 2);
        g.endFill();
      }

      // ── Ventilation grilles on main building top ──
      for (let i = 0; i < 4; i++) {
        const vx = w * 0.38 + i * 20;
        const vy = top + 2;
        g.beginFill(WALL_TOP);
        g.drawRect(vx, vy, 10, 4);
        g.endFill();
        g.lineStyle(1, GOLD_DIM, 0.4);
        for (let s = 0; s < 4; s++) {
          g.moveTo(vx + 1, vy + s);
          g.lineTo(vx + 9, vy + s);
        }
        g.lineStyle(0);
      }
      break;
    }
    case "satellite": {
      // ── Lattice tower structure (cross-braced) ──
      const cx = w * 0.6;
      const towerBase = top;
      const towerH = 56;
      const towerTop = towerBase - towerH;
      const legSpread = 8;
      // Main vertical rails
      g.lineStyle(2, WALL_TOP, 1);
      g.moveTo(cx - legSpread, towerBase);
      g.lineTo(cx - 3, towerTop);
      g.moveTo(cx + legSpread, towerBase);
      g.lineTo(cx + 3, towerTop);
      g.lineStyle(0);
      // Cross-bracing (X patterns every 8px)
      for (let by = 0; by < towerH; by += 8) {
        const yy = towerBase - by;
        const yTop2 = yy - 8;
        const spreadBot = legSpread - (by / towerH) * (legSpread - 3);
        const spreadTop = legSpread - ((by + 8) / towerH) * (legSpread - 3);
        g.lineStyle(1, GOLD_DIM, 0.7);
        g.moveTo(cx - spreadBot, yy);
        g.lineTo(cx + spreadTop, yTop2);
        g.moveTo(cx + spreadBot, yy);
        g.lineTo(cx - spreadTop, yTop2);
        g.lineStyle(0);
        // Horizontal brace
        g.lineStyle(1, WALL_TOP, 0.6);
        g.moveTo(cx - spreadBot, yy);
        g.lineTo(cx + spreadBot, yy);
        g.lineStyle(0);
      }

      // ── Multiple dishes at different angles ──
      // Dish 1 — upper right
      const d1x = cx + 6;
      const d1y = towerTop + 8;
      g.beginFill(GOLD, 0.9);
      g.drawEllipse(d1x, d1y, 10, 7);
      g.endFill();
      g.beginFill(ROOF, 1);
      g.drawEllipse(d1x + 2, d1y, 7, 5);
      g.endFill();
      g.lineStyle(2, GOLD, 1);
      g.moveTo(d1x + 2, d1y);
      g.lineTo(d1x + 10, d1y - 5);
      g.lineStyle(0);
      g.beginFill(AMBER, 0.9);
      g.drawCircle(d1x + 10, d1y - 5, 1);
      g.endFill();

      // Dish 2 — left cross-arm
      const d2x = cx - 14;
      const d2y = towerTop + 20;
      g.lineStyle(2, WALL_TOP, 0.9);
      g.moveTo(cx - 3, d2y);
      g.lineTo(d2x, d2y);
      g.lineStyle(0);
      g.beginFill(GOLD, 0.85);
      g.drawEllipse(d2x, d2y, 8, 5);
      g.endFill();
      g.beginFill(ROOF, 1);
      g.drawEllipse(d2x - 1, d2y, 5, 3);
      g.endFill();

      // Dish 3 — right cross-arm (small)
      const d3x = cx + 16;
      const d3y = towerTop + 30;
      g.lineStyle(2, WALL_TOP, 0.9);
      g.moveTo(cx + 3, d3y);
      g.lineTo(d3x, d3y);
      g.lineStyle(0);
      g.beginFill(GOLD, 0.8);
      g.drawEllipse(d3x, d3y, 6, 4);
      g.endFill();
      g.beginFill(ROOF, 1);
      g.drawEllipse(d3x + 1, d3y, 4, 3);
      g.endFill();

      // ── Blinking status LEDs at structural joints ──
      const ledPositions = [
        [cx - legSpread + 1, towerBase - 4, SOFT_RED, 0.9],
        [cx + legSpread - 1, towerBase - 4, TEAL, 0.9],
        [cx - 4, towerTop + 16, TEAL, 0.8],
        [cx + 4, towerTop + 16, SOFT_RED, 0.7],
        [cx, towerTop + 4, TEAL, 1],
        [cx - 6, towerTop + 28, AMBER, 0.8],
        [cx + 6, towerTop + 28, TEAL, 0.7],
      ] as const;
      for (const [lx, ly, lc, la] of ledPositions) {
        g.beginFill(lc, la);
        g.drawCircle(lx, ly, 1);
        g.endFill();
      }

      // ── Solar panel array on roof ──
      const panelX = w * 0.28;
      const panelY = top - 3;
      for (let i = 0; i < 3; i++) {
        const px = panelX + i * 22;
        // Angled blue panel
        g.beginFill(SKY_BLUE, 0.7);
        g.drawPolygon([
          px, panelY,
          px + 16, panelY - 6,
          px + 18, panelY - 6,
          px + 2, panelY,
        ]);
        g.endFill();
        g.lineStyle(1, WALL_TOP, 0.8);
        g.drawPolygon([
          px, panelY,
          px + 16, panelY - 6,
          px + 18, panelY - 6,
          px + 2, panelY,
        ]);
        g.lineStyle(0);
        // Grid lines on panel
        g.lineStyle(1, 0x1e3a5f, 0.5);
        g.moveTo(px + 4, panelY - 1);
        g.lineTo(px + 14, panelY - 5);
        g.moveTo(px + 9, panelY - 3);
        g.lineTo(px + 16, panelY - 6);
        g.moveTo(px + 9, panelY - 3);
        g.lineTo(px + 2, panelY);
        g.lineStyle(0);
        // Panel support leg
        g.lineStyle(1, GOLD_DIM, 0.6);
        g.moveTo(px + 1, panelY);
        g.lineTo(px + 1, panelY + 3);
        g.moveTo(px + 15, panelY - 5);
        g.lineTo(px + 15, panelY - 2);
        g.lineStyle(0);
      }

      // ── Cabling/conduit from dishes down to building ──
      g.lineStyle(1, GOLD_DIM, 0.5);
      g.moveTo(cx, towerTop + 40);
      g.lineTo(cx + 3, towerBase - 4);
      g.lineTo(cx + 6, towerBase);
      g.moveTo(cx - 4, towerTop + 20);
      g.lineTo(cx - 2, towerBase);
      g.lineStyle(0);
      // Conduit clips
      for (let ci = 0; ci < 3; ci++) {
        const clipY = towerBase - 8 - ci * 14;
        g.beginFill(WALL_TOP);
        g.drawRect(cx + 2, clipY, 4, 2);
        g.endFill();
      }

      // ── Equipment hut at base of tower ──
      const hutX = cx - legSpread - 12;
      const hutY = top - 14;
      const hutW = 12;
      const hutH = 14;
      g.beginFill(WALL);
      g.drawRect(hutX, hutY, hutW, hutH);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.6);
      g.drawRect(hutX, hutY, hutW, hutH);
      g.lineStyle(0);
      // Door
      g.beginFill(ROOF);
      g.drawRect(hutX + 4, hutY + hutH - 8, 4, 8);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.4);
      g.drawRect(hutX + 4, hutY + hutH - 8, 4, 8);
      g.lineStyle(0);
      // Hut roof
      g.beginFill(WALL_TOP);
      g.drawRect(hutX - 1, hutY, hutW + 2, 2);
      g.endFill();
      // Vent on hut
      g.beginFill(ROOF);
      g.drawRect(hutX + 1, hutY + 3, 3, 2);
      g.endFill();
      break;
    }
    case "local":
    default: {
      // ── Two brick chimneys ──
      const chim1X = w * 0.22;
      const chim2X = w * 0.76;
      const chimW = 14;
      const chimH = 24;
      const chimTop = top - chimH;

      const drawBrickChimney = (cx: number) => {
        // Main chimney body
        g.beginFill(BRICK);
        g.drawRect(cx, chimTop, chimW, chimH);
        g.endFill();
        // Brick pattern — alternating offset rectangles
        for (let row = 0; row < chimH; row += 3) {
          const offset = (Math.floor(row / 3) % 2) * 4;
          g.lineStyle(0);
          g.beginFill(BRICK_DARK, 0.3);
          g.drawRect(cx + offset, chimTop + row, chimW - offset, 1);
          g.endFill();
          // Vertical mortar lines
          g.lineStyle(1, BRICK_DARK, 0.4);
          for (let col = offset; col < chimW; col += 6) {
            g.moveTo(cx + col, chimTop + row);
            g.lineTo(cx + col, chimTop + row + 2);
          }
          g.lineStyle(0);
        }
        // Chimney cap
        g.beginFill(WALL_TOP);
        g.drawRect(cx - 2, chimTop - 3, chimW + 4, 4);
        g.endFill();
        g.lineStyle(1, GOLD_DIM, 0.5);
        g.drawRect(cx - 2, chimTop - 3, chimW + 4, 4);
        g.lineStyle(0);
        // Cap rim
        g.beginFill(STONE);
        g.drawRect(cx - 1, chimTop - 2, chimW + 2, 1);
        g.endFill();
      };

      drawBrickChimney(chim1X);
      drawBrickChimney(chim2X);

      // ── Smoke wisps from chimney 1 ──
      const smokeX = chim1X + chimW / 2;
      const smokeBaseY = chimTop - 5;
      for (let s = 0; s < 4; s++) {
        const r = 3 + s;
        const alpha = 0.25 - s * 0.05;
        g.beginFill(0x9aa2b1, alpha);
        g.drawCircle(smokeX + s * 2 - 2, smokeBaseY - s * 5, r);
        g.endFill();
      }
      for (let s = 0; s < 3; s++) {
        const r = 2 + s;
        const alpha = 0.2 - s * 0.06;
        g.beginFill(0x9aa2b1, alpha);
        g.drawCircle(smokeX + 4 + s * 2, smokeBaseY - 3 - s * 5, r);
        g.endFill();
      }

      // ── Weathervane on chimney 2 ──
      const wvCX = chim2X + chimW / 2;
      const wvBaseY = chimTop - 6;
      // Pole
      g.lineStyle(1, GOLD, 0.8);
      g.moveTo(wvCX, chimTop - 3);
      g.lineTo(wvCX, wvBaseY - 8);
      g.lineStyle(0);
      // Arrow (pointing right)
      g.beginFill(GOLD, 0.9);
      g.drawPolygon([
        wvCX + 7, wvBaseY - 8,
        wvCX + 3, wvBaseY - 10,
        wvCX + 3, wvBaseY - 6,
      ]);
      g.endFill();
      // Tail feathers (pointing left)
      g.beginFill(SOFT_RED, 0.8);
      g.drawPolygon([
        wvCX - 5, wvBaseY - 8,
        wvCX - 2, wvBaseY - 10,
        wvCX - 2, wvBaseY - 6,
      ]);
      g.endFill();
      // Shaft
      g.lineStyle(1, GOLD, 0.8);
      g.moveTo(wvCX - 5, wvBaseY - 8);
      g.lineTo(wvCX + 7, wvBaseY - 8);
      g.lineStyle(0);
      // N/S/E/W markers
      g.beginFill(TEXT_DIM, 0.7);
      g.drawRect(wvCX, wvBaseY - 12, 1, 2); // N
      g.drawRect(wvCX, wvBaseY - 4, 1, 2); // S
      g.drawRect(wvCX + 4, wvBaseY - 9, 2, 1); // E
      g.drawRect(wvCX - 6, wvBaseY - 9, 2, 1); // W
      g.endFill();

      // ── Rooftop garden / planter boxes ──
      const gardenX = w * 0.4;
      const gardenY = top - 6;
      for (let p = 0; p < 3; p++) {
        const px = gardenX + p * 16;
        // Planter box
        g.beginFill(STONE);
        g.drawRect(px, gardenY, 12, 6);
        g.endFill();
        g.lineStyle(1, STONE_LIGHT, 0.5);
        g.drawRect(px, gardenY, 12, 6);
        g.lineStyle(0);
        // Soil
        g.beginFill(BRICK_DARK, 0.6);
        g.drawRect(px + 1, gardenY + 1, 10, 2);
        g.endFill();
        // Plants — small green dots/stems
        const plantColors = [PLANT_GREEN, PLANT_DARK, PLANT_GREEN];
        for (let pl = 0; pl < 3; pl++) {
          const plx = px + 2 + pl * 3;
          g.lineStyle(1, PLANT_DARK, 0.7);
          g.moveTo(plx, gardenY + 1);
          g.lineTo(plx, gardenY - 3);
          g.lineStyle(0);
          g.beginFill(plantColors[pl], 0.9);
          g.drawCircle(plx, gardenY - 3, 2);
          g.endFill();
        }
      }

      // ── AC unit ──
      const acX = w * 0.62;
      const acY = top - 10;
      g.beginFill(STONE_LIGHT);
      g.drawRect(acX, acY, 20, 10);
      g.endFill();
      g.lineStyle(1, STONE, 0.7);
      g.drawRect(acX, acY, 20, 10);
      g.lineStyle(0);
      // Fan grille lines
      for (let fl = 0; fl < 4; fl++) {
        g.lineStyle(1, STONE, 0.5);
        g.moveTo(acX + 2 + fl * 5, acY + 3);
        g.lineTo(acX + 2 + fl * 5, acY + 8);
        g.lineStyle(0);
      }
      // Top vent slots
      for (let vs = 0; vs < 6; vs++) {
        g.beginFill(ROOF, 0.5);
        g.drawRect(acX + 2 + vs * 3, acY + 1, 2, 1);
        g.endFill();
      }

      // ── Skylight dome ──
      const skX = w * 0.48;
      const skY = top - 5;
      g.beginFill(GLASS_LIT, 0.35);
      g.drawEllipse(skX, skY, 8, 5);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.6);
      g.drawEllipse(skX, skY, 8, 5);
      g.lineStyle(0);
      // Glass reflection line
      g.lineStyle(1, 0xffffff, 0.3);
      g.moveTo(skX - 3, skY - 2);
      g.lineTo(skX - 1, skY - 4);
      g.lineStyle(0);
      // Base of dome
      g.lineStyle(1, WALL_TOP, 0.7);
      g.moveTo(skX - 8, skY);
      g.lineTo(skX + 8, skY);
      g.lineStyle(0);
      break;
    }
  }
}

// ════════════════════════════════════════════════════════════════
// HARDWARE SIGNAGE — live HW stats near the roof sign
// ════════════════════════════════════════════════════════════════

function clampPct(v: number | undefined): number | null {
  if (v === undefined || v === null || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function fmtPct(v: number): string {
  // One decimal when fractional, integer otherwise — keeps the sign tidy.
  return Number.isInteger(v) ? `${v}%` : `${v.toFixed(1)}%`;
}

/**
 * Draw a small live hardware readout (e.g. "CPU 42.0%  MEM 61%  GPU 12%")
 * tucked just under the roof sign. Missing metrics are omitted. When no
 * metrics are present nothing is drawn. Pure draw — caller clears `g`.
 */
export function drawHardwareSignage(
  g: PIXI.Graphics,
  w: number,
  hardware: { cpu?: number; mem?: number; gpu?: number } | undefined,
): void {
  if (!hardware) return;
  const parts: string[] = [];
  const cpu = clampPct(hardware.cpu);
  const mem = clampPct(hardware.mem);
  const gpu = clampPct(hardware.gpu);
  if (cpu !== null) parts.push(`CPU ${fmtPct(cpu)}`);
  if (mem !== null) parts.push(`MEM ${fmtPct(mem)}`);
  if (gpu !== null) parts.push(`GPU ${fmtPct(gpu)}`);
  if (parts.length === 0) return;

  const text = parts.join("  ");
  const scale = 1;
  const tw = measureText(text, scale);
  const padX = 5;
  const padY = 2;
  const boxW = tw + padX * 2;
  const boxH = 5 * scale + padY * 2;
  // Sit under the roof sign band (sign band ≈ [-30, -2]); place at y≈-13.
  const boxX = (w - boxW) / 2;
  const boxY = -14;

  // Backing plate
  g.beginFill(0x000000, 0.55);
  g.drawRoundedRect(boxX, boxY, boxW, boxH, 2);
  g.endFill();
  g.lineStyle(1, GOLD, 0.5);
  g.drawRoundedRect(boxX, boxY, boxW, boxH, 2);
  g.lineStyle(0);

  drawText(g, text, boxX + padX, boxY + padY, GOLD, scale);
}

// ════════════════════════════════════════════════════════════════
// SECOND FLOOR — lit windows for a building grown by agent count
// ════════════════════════════════════════════════════════════════

/**
 * Draw a row of `total` windows across the top of the shell, with the
 * first `lit` glowing (others dark). Used to visually "grow" a building
 * a second storey as its agent count climbs. Enhanced with arched tops,
 * flower boxes, balcony railing, bay window + circular porthole.
 * Pure draw — caller clears `g`.
 */
export function drawSecondFloor(
  g: PIXI.Graphics,
  w: number,
  lit: number,
  total: number,
): void {
  const n = Math.max(0, Math.floor(total));
  if (n === 0) return;
  const litN = Math.max(0, Math.min(n, Math.floor(lit)));

  const floorTop = -52;
  const floorH = 22;
  const marginX = 24;
  const innerW = w - marginX * 2;

  // Floor slab + facade
  g.beginFill(WALL);
  g.drawRect(marginX, floorTop, innerW, floorH);
  g.endFill();
  g.beginFill(WALL_TOP);
  g.drawRect(marginX, floorTop, innerW, 3);
  g.endFill();
  // Belt course
  g.beginFill(GOLD, 0.35);
  g.drawRect(marginX, floorTop + floorH - 3, innerW, 1);
  g.endFill();
  g.lineStyle(1, GOLD, 0.45);
  g.drawRect(marginX, floorTop, innerW, floorH);
  g.lineStyle(0);

  const gap = 6;
  const archExtra = 3;
  const winH = 12;
  const winY = floorTop + (floorH - winH - archExtra) / 2 + 1;
  const totalGap = gap * (n + 1);
  const winW = Math.max(4, (innerW - totalGap) / n);

  // If >=5 windows, designate special window types at fixed positions
  const bayIdx = n >= 5 ? Math.floor(n / 2) : -1;
  const portholeIdx = n >= 6 ? n - 1 : -1;

  for (let i = 0; i < n; i++) {
    const wx = marginX + gap + i * (winW + gap);
    const on = i < litN;

    if (i === portholeIdx && portholeIdx >= 0) {
      // ── Circular porthole window ──
      const pcx = wx + winW / 2;
      const pcy = winY + winH / 2;
      const prad = Math.min(winW / 2, 5);
      g.beginFill(on ? GLASS_LIT : GLASS_DARK);
      g.drawCircle(pcx, pcy, prad);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.8);
      g.drawCircle(pcx, pcy, prad);
      g.lineStyle(0);
      if (on) {
        g.beginFill(GLASS_LIT, 0.2);
        g.drawCircle(pcx, pcy, prad + 2);
        g.endFill();
        g.lineStyle(1, 0xffffff, 0.3);
        g.moveTo(pcx - 2, pcy - 2);
        g.lineTo(pcx, pcy - 3);
        g.lineStyle(0);
      }
      continue;
    }

    const isBay = i === bayIdx;
    const bw = isBay ? winW + 2 : winW;
    const bx = isBay ? wx - 1 : wx;

    // ── Arched window top ──
    g.beginFill(on ? GLASS_LIT : GLASS_DARK);
    g.drawRect(bx, winY + archExtra, bw, winH);
    g.endFill();
    g.beginFill(on ? GLASS_LIT : GLASS_DARK);
    g.drawEllipse(bx + bw / 2, winY + archExtra, bw / 2, archExtra + 1);
    g.endFill();

    if (on) {
      g.beginFill(GLASS_LIT, 0.25);
      g.drawRect(bx - 1, winY - 1, bw + 2, winH + archExtra + 2);
      g.endFill();
    }

    // Frame + mullion
    g.lineStyle(1, on ? GOLD_DIM : 0x000000, on ? 0.8 : 0.5);
    g.drawRect(bx, winY + archExtra, bw, winH);
    g.drawEllipse(bx + bw / 2, winY + archExtra, bw / 2, archExtra + 1);
    g.moveTo(bx + bw / 2, winY);
    g.lineTo(bx + bw / 2, winY + archExtra + winH);
    g.lineStyle(0);

    // ── Flower box under lit windows ──
    if (on && i !== bayIdx) {
      const fbY = winY + archExtra + winH + 1;
      g.beginFill(STONE);
      g.drawRect(bx, fbY, bw, 3);
      g.endFill();
      g.lineStyle(1, STONE_LIGHT, 0.4);
      g.drawRect(bx, fbY, bw, 3);
      g.lineStyle(0);
      // Flowers — small colored dots
      const flowerColors = [0xf472b6, AMBER, 0xa78bfa, PLANT_GREEN];
      for (let f = 0; f < Math.floor(bw / 3); f++) {
        g.beginFill(flowerColors[f % flowerColors.length], 0.85);
        g.drawCircle(bx + 2 + f * 3, fbY - 1, 1);
        g.endFill();
      }
    }

    // ── Balcony railing on bay window ──
    if (isBay) {
      const railY = winY + archExtra + winH + 1;
      // Railing bar
      g.lineStyle(1, GOLD, 0.8);
      g.moveTo(bx - 2, railY);
      g.lineTo(bx + bw + 2, railY);
      g.lineStyle(0);
      // Balusters
      for (let b = 0; b <= Math.min(bw + 2, 12); b += 3) {
        g.lineStyle(1, GOLD_DIM, 0.7);
        g.moveTo(bx - 2 + b, railY);
        g.lineTo(bx - 2 + b, railY + 4);
        g.lineStyle(0);
      }
      // Bottom rail
      g.lineStyle(1, GOLD, 0.6);
      g.moveTo(bx - 2, railY + 4);
      g.lineTo(bx + bw + 2, railY + 4);
      g.lineStyle(0);
      // Bay window depth markers
      g.lineStyle(1, WALL_TOP, 0.5);
      g.moveTo(bx - 2, railY - 1);
      g.lineTo(bx - 2, railY + 5);
      g.moveTo(bx + bw + 2, railY - 1);
      g.lineTo(bx + bw + 2, railY + 5);
      g.lineStyle(0);
    }

    if (!on) {
      // Dark window reflection highlight
      g.lineStyle(1, 0xffffff, 0.08);
      g.moveTo(bx + 2, winY + 3);
      g.lineTo(bx + 2, winY + winH - 2);
      g.lineStyle(0);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// ROAD PATH — orthogonal (L-shaped) waypoints for couriers
// ════════════════════════════════════════════════════════════════

/**
 * Orthogonal (L-shaped) waypoints between two WORLD points: drop from
 * `from` straight down to `roadY`, travel horizontally along the road,
 * then rise up to `to`. This keeps couriers on roads instead of cutting
 * straight through building walls.
 *
 * Returns [from, {from.x, roadY}, {to.x, roadY}, to], with collinear /
 * duplicate points removed so segment-by-segment lerping is clean.
 */
export function getRoadPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  roadY = 965,
): Array<{ x: number; y: number }> {
  const raw: Array<{ x: number; y: number }> = [
    { x: from.x, y: from.y },
    { x: from.x, y: roadY },
    { x: to.x, y: roadY },
    { x: to.x, y: to.y },
  ];
  return dedupePath(raw);
}

/** Remove duplicate and collinear interior points from an orthogonal path. */
function dedupePath(
  pts: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue; // duplicate
    out.push({ x: p.x, y: p.y });
  }
  // Strip collinear middles (a-b-c where b lies on segment a→c, axis-aligned).
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const sameX = a.x === b.x && b.x === c.x;
    const sameY = a.y === b.y && b.y === c.y;
    if (sameX || sameY) {
      out.splice(i, 1);
    } else {
      i++;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// BUILDING ENTRANCE — role-specific entryways (bottom of shell)
// ════════════════════════════════════════════════════════════════

/**
 * Draw a role-specific building entrance at the bottom of a shell of
 * size w x h. Origin is top-left of shell; the entrance sits at y ≈ h.
 *   hub       → grand double doors with gold frames, awning + steps
 *   satellite → single door with side panels + small awning
 *   local     → simple door, porch light + welcome mat
 */
export function drawBuildingEntrance(
  g: PIXI.Graphics,
  role: NodeRole,
  w: number,
  h: number,
): void {
  const baseY = h - 2;
  const centerX = w / 2;

  switch (role) {
    case "hub": {
      // ── Steps ──
      for (let s = 0; s < 3; s++) {
        const stepW = 52 - s * 4;
        const stepY = baseY + s * 2;
        g.beginFill(STONE);
        g.drawRect(centerX - stepW / 2, stepY, stepW, 2);
        g.endFill();
        g.lineStyle(1, STONE_LIGHT, 0.4);
        g.drawRect(centerX - stepW / 2, stepY, stepW, 2);
        g.lineStyle(0);
      }

      // ── Double doors ──
      const doorW = 10;
      const doorH = 18;
      const doorY = baseY - doorH;
      // Left door
      g.beginFill(ROOF);
      g.drawRect(centerX - doorW - 1, doorY, doorW, doorH);
      g.endFill();
      // Right door
      g.beginFill(ROOF);
      g.drawRect(centerX + 1, doorY, doorW, doorH);
      g.endFill();

      // Gold door frames
      g.lineStyle(1, GOLD, 0.85);
      g.drawRect(centerX - doorW - 1, doorY, doorW, doorH);
      g.drawRect(centerX + 1, doorY, doorW, doorH);
      g.lineStyle(0);

      // Frame pillars
      g.beginFill(GOLD, 0.7);
      g.drawRect(centerX - doorW - 3, doorY, 2, doorH);
      g.drawRect(centerX + doorW + 1, doorY, 2, doorH);
      g.endFill();
      // Top crossbar
      g.beginFill(GOLD, 0.7);
      g.drawRect(centerX - doorW - 3, doorY, doorW * 2 + 6, 2);
      g.endFill();

      // Door panels (recessed rectangles)
      g.lineStyle(1, GOLD_DIM, 0.5);
      g.drawRect(centerX - doorW, doorY + 3, doorW - 2, 5);
      g.drawRect(centerX - doorW, doorY + 10, doorW - 2, 5);
      g.drawRect(centerX + 2, doorY + 3, doorW - 2, 5);
      g.drawRect(centerX + 2, doorY + 10, doorW - 2, 5);
      g.lineStyle(0);

      // Door handles
      g.beginFill(GOLD, 0.9);
      g.drawRect(centerX - 2, doorY + 8, 2, 2);
      g.drawRect(centerX, doorY + 8, 2, 2);
      g.endFill();

      // ── Awning/canopy ──
      const awnY = doorY - 5;
      const awnW = doorW * 2 + 12;
      g.beginFill(GOLD, 0.6);
      g.drawPolygon([
        centerX - awnW / 2 - 4, awnY,
        centerX + awnW / 2 + 4, awnY,
        centerX + awnW / 2, awnY + 4,
        centerX - awnW / 2, awnY + 4,
      ]);
      g.endFill();
      g.lineStyle(1, GOLD, 0.7);
      g.drawPolygon([
        centerX - awnW / 2 - 4, awnY,
        centerX + awnW / 2 + 4, awnY,
        centerX + awnW / 2, awnY + 4,
        centerX - awnW / 2, awnY + 4,
      ]);
      g.lineStyle(0);
      // Awning support brackets
      g.lineStyle(1, GOLD_DIM, 0.6);
      g.moveTo(centerX - awnW / 2 + 2, awnY + 4);
      g.lineTo(centerX - awnW / 2 + 2, doorY);
      g.moveTo(centerX + awnW / 2 - 2, awnY + 4);
      g.lineTo(centerX + awnW / 2 - 2, doorY);
      g.lineStyle(0);

      // ── Transom window above doors ──
      g.beginFill(GLASS_LIT, 0.3);
      g.drawRect(centerX - doorW, doorY + 1, doorW * 2, 2);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.4);
      g.moveTo(centerX, doorY + 1);
      g.lineTo(centerX, doorY + 3);
      g.lineStyle(0);
      break;
    }
    case "satellite": {
      // ── Single door with side panels ──
      const doorW = 10;
      const doorH = 16;
      const doorY = baseY - doorH;
      g.beginFill(ROOF);
      g.drawRect(centerX - doorW / 2, doorY, doorW, doorH);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.7);
      g.drawRect(centerX - doorW / 2, doorY, doorW, doorH);
      g.lineStyle(0);
      // Door panel
      g.lineStyle(1, GOLD_DIM, 0.4);
      g.drawRect(centerX - doorW / 2 + 2, doorY + 3, doorW - 4, 4);
      g.lineStyle(0);
      // Handle
      g.beginFill(TEAL, 0.7);
      g.drawRect(centerX + 2, doorY + 7, 2, 2);
      g.endFill();

      // Side panels
      g.beginFill(ROOF, 0.6);
      g.drawRect(centerX - doorW / 2 - 8, doorY + 4, 7, doorH - 4);
      g.endFill();
      g.drawRect(centerX + doorW / 2 + 1, doorY + 4, 7, doorH - 4);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.3);
      g.drawRect(centerX - doorW / 2 - 8, doorY + 4, 7, doorH - 4);
      g.drawRect(centerX + doorW / 2 + 1, doorY + 4, 7, doorH - 4);
      g.lineStyle(0);
      // Side panel glass
      g.beginFill(GLASS_DARK, 0.4);
      g.drawRect(centerX - doorW / 2 - 7, doorY + 5, 5, 5);
      g.endFill();
      g.beginFill(GLASS_DARK, 0.4);
      g.drawRect(centerX + doorW / 2 + 2, doorY + 5, 5, 5);
      g.endFill();

      // ── Small awning ──
      const awnW = doorW + 10;
      const awnY = doorY - 3;
      g.beginFill(TEAL, 0.35);
      g.drawPolygon([
        centerX - awnW / 2 - 2, awnY,
        centerX + awnW / 2 + 2, awnY,
        centerX + awnW / 2, awnY + 3,
        centerX - awnW / 2, awnY + 3,
      ]);
      g.endFill();
      g.lineStyle(1, TEAL, 0.5);
      g.drawPolygon([
        centerX - awnW / 2 - 2, awnY,
        centerX + awnW / 2 + 2, awnY,
        centerX + awnW / 2, awnY + 3,
        centerX - awnW / 2, awnY + 3,
      ]);
      g.lineStyle(0);
      break;
    }
    case "local":
    default: {
      // ── Simple single door ──
      const doorW = 8;
      const doorH = 14;
      const doorY = baseY - doorH;
      g.beginFill(ROOF);
      g.drawRect(centerX - doorW / 2, doorY, doorW, doorH);
      g.endFill();
      g.lineStyle(1, GOLD_DIM, 0.5);
      g.drawRect(centerX - doorW / 2, doorY, doorW, doorH);
      g.lineStyle(0);
      // Handle
      g.beginFill(GOLD, 0.7);
      g.drawRect(centerX + 1, doorY + 5, 2, 2);
      g.endFill();

      // ── Porch light ──
      const lightX = centerX + doorW / 2 + 3;
      const lightY = doorY + 2;
      // Light fixture bracket
      g.lineStyle(1, STONE, 0.6);
      g.moveTo(centerX + doorW / 2, doorY + 2);
      g.lineTo(lightX, lightY);
      g.lineStyle(0);
      // Light globe
      g.beginFill(AMBER, 0.35);
      g.drawCircle(lightX + 1, lightY, 4);
      g.endFill();
      g.beginFill(AMBER, 0.8);
      g.drawCircle(lightX + 1, lightY, 2);
      g.endFill();
      g.beginFill(0xffffff, 0.5);
      g.drawCircle(lightX + 1, lightY, 1);
      g.endFill();

      // ── Welcome mat indicator ──
      g.beginFill(BRICK_DARK, 0.4);
      g.drawRect(centerX - 6, baseY - 1, 12, 2);
      g.endFill();
      g.lineStyle(1, BRICK, 0.25);
      g.drawRect(centerX - 6, baseY - 1, 12, 2);
      g.lineStyle(0);
      break;
    }
  }
}

// ════════════════════════════════════════════════════════════════
// BUILDING ACCENTS — corner quoins, belt courses, foundation, plaque
// ════════════════════════════════════════════════════════════════

/**
 * Draw decorative architectural accents on a building shell of size w x h.
 * Includes corner quoins, horizontal belt course lines, a foundation strip,
 * and a small address plaque. Pure draw — caller clears `g`.
 */
export function drawBuildingAccents(
  g: PIXI.Graphics,
  role: NodeRole,
  w: number,
  h: number,
): void {
  const marginX = 24;
  const innerW = w - marginX * 2;

  // ── Foundation line (darker strip at base) ──
  g.beginFill(ROOF, 0.8);
  g.drawRect(marginX, h - 4, innerW, 4);
  g.endFill();
  g.lineStyle(1, STONE, 0.5);
  g.moveTo(marginX, h - 4);
  g.lineTo(marginX + innerW, h - 4);
  g.lineStyle(0);
  // Foundation texture
  for (let fx = marginX + 4; fx < marginX + innerW - 4; fx += 8) {
    g.beginFill(STONE, 0.15);
    g.drawRect(fx, h - 3, 4, 2);
    g.endFill();
  }

  // ── Corner quoins ──
  const quoinW = 4;
  const quoinH = 6;
  const quoinGap = 8;
  for (let qy = 0; qy < h - 4; qy += quoinH + quoinGap) {
    const qh = Math.min(quoinH, h - 4 - qy);
    // Left quoins
    g.beginFill(STONE_LIGHT, 0.5);
    g.drawRect(marginX, qy, quoinW, qh);
    g.endFill();
    g.lineStyle(1, STONE, 0.3);
    g.drawRect(marginX, qy, quoinW, qh);
    g.lineStyle(0);
    // Alternate offset for alternating bond pattern
    if (Math.floor(qy / (quoinH + quoinGap)) % 2 === 1) {
      g.beginFill(STONE, 0.2);
      g.drawRect(marginX, qy, quoinW / 2, qh);
      g.endFill();
    }
    // Right quoins
    g.beginFill(STONE_LIGHT, 0.5);
    g.drawRect(marginX + innerW - quoinW, qy, quoinW, qh);
    g.endFill();
    g.lineStyle(1, STONE, 0.3);
    g.drawRect(marginX + innerW - quoinW, qy, quoinW, qh);
    g.lineStyle(0);
    if (Math.floor(qy / (quoinH + quoinGap)) % 2 === 0) {
      g.beginFill(STONE, 0.2);
      g.drawRect(marginX + innerW - quoinW / 2, qy, quoinW / 2, qh);
      g.endFill();
    }
  }

  // ── Horizontal belt course lines ──
  const floors = role === "hub" ? 3 : role === "satellite" ? 2 : 2;
  const floorH = (h - 4) / floors;
  for (let f = 1; f < floors; f++) {
    const beltY = f * floorH;
    g.beginFill(GOLD, 0.3);
    g.drawRect(marginX, beltY, innerW, 1);
    g.endFill();
    // Subtle shadow below belt
    g.beginFill(SHADOW, 0.08);
    g.drawRect(marginX, beltY + 1, innerW, 1);
    g.endFill();
  }

  // ── Address plaque ──
  const plaqueW = role === "hub" ? 14 : role === "satellite" ? 12 : 10;
  const plaqueH = 5;
  const plaqueX = marginX + innerW / 2 - plaqueW / 2;
  const plaqueY = h - 3 - plaqueH;
  g.beginFill(STONE_LIGHT, 0.7);
  g.drawRect(plaqueX, plaqueY, plaqueW, plaqueH);
  g.endFill();
  g.lineStyle(1, GOLD_DIM, 0.5);
  g.drawRect(plaqueX, plaqueY, plaqueW, plaqueH);
  g.lineStyle(0);
  // Address number pixels
  const addrNum = role === "hub" ? "1" : role === "satellite" ? "2" : "3";
  drawText(g, addrNum, plaqueX + plaqueW / 2 - 2, plaqueY + 1, GOLD, 1);
}

// ════════════════════════════════════════════════════════════════
// RECEPTIONIST — small greeter figure at the entryway
// ════════════════════════════════════════════════════════════════

/**
 * Draw a small receptionist figure standing at (x,y) (feet at y). The
 * figure faces the camera; `waveFrame` (0..3) raises one arm in a wave
 * cycle: 0 down, 1 mid, 2 up, 3 mid. Pure draw — caller clears `g` and
 * positions/scales as desired (drawn at ~1px units like drawCharacter).
 */
export function drawReceptionist(
  g: PIXI.Graphics,
  x: number,
  y: number,
  waveFrame: number,
): void {
  const skin = 0xf5d0a9;
  const hair = 0x3a2a1a;
  const shirt = 0xd4af37; // gold blazer — front-desk staff
  const accent = 0x8a7028;

  const px = (dx: number, dy: number, c: number, a = 1) => {
    g.beginFill(c, a);
    g.drawRect(x + dx, y + dy, 1, 1);
    g.endFill();
  };

  // Shadow under feet
  g.beginFill(SHADOW, 0.3);
  g.drawEllipse(x, y + 7, 3, 1);
  g.endFill();

  // Head (4x4)
  const headY = -6;
  for (let yy = 0; yy < 4; yy++)
    for (let xx = 0; xx < 4; xx++) px(-2 + xx, headY + yy, skin);
  // Hair (top + side fringe)
  for (let xx = 0; xx < 4; xx++) px(-2 + xx, headY, hair);
  px(-2, headY + 1, hair);
  px(1, headY + 1, hair);
  // Eyes (facing camera)
  px(-1, headY + 2, SHADOW);
  px(0, headY + 2, SHADOW);

  // Torso (4w x 4h)
  const torsoY = -2;
  for (let yy = 0; yy < 4; yy++)
    for (let xx = 0; xx < 4; xx++) px(-2 + xx, torsoY + yy, shirt);
  // Lapel / collar accent
  for (let xx = 0; xx < 4; xx++) px(-2 + xx, torsoY + 3, accent);

  // Legs
  const legY = 2;
  px(-1, legY, shirt);
  px(-1, legY + 1, SHADOW);
  px(-1, legY + 2, SHADOW);
  px(0, legY, shirt);
  px(0, legY + 1, SHADOW);
  px(0, legY + 2, SHADOW);

  // Resting arm (left side, down)
  px(-3, torsoY, shirt);
  px(-3, torsoY + 1, shirt);

  // Waving arm (right side) — height tracks the wave cycle.
  // frame 0 down, 1 mid, 2 up, 3 mid → lift = [0,1,2,1]
  const f = ((Math.floor(waveFrame) % 4) + 4) % 4;
  const lift = f === 0 ? 0 : f === 2 ? 2 : 1;
  const armBaseY = torsoY;
  px(2, armBaseY - lift, shirt);
  px(2, armBaseY + 1 - lift, shirt);
  // Raised hand
  px(3, armBaseY - lift - (lift > 0 ? 1 : 0), skin);
}
