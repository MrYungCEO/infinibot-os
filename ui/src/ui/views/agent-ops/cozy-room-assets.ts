/**
 * Cozy Room Assets - ToffeeCraft Pixel Art Integration
 * Handles texture loading, sprite sheet parsing, and sprite creation
 * for the isometric activity map visualization.
 */

import * as PIXI from 'pixi.js';

// ════════════════════════════════════════════════════════════════
// ASSET PATHS
// ════════════════════════════════════════════════════════════════

const ASSET_BASE = './assets/cozy-room';

export const ASSET_PATHS = {
  // Rooms
  room1: `${ASSET_BASE}/Rooms/Room1.png`,
  room2: `${ASSET_BASE}/Rooms/Room2.png`,
  
  // Furniture sprite sheets
  desks: `${ASSET_BASE}/Desks/Desks.png`,
  chairs: `${ASSET_BASE}/Chairs/Chairs.png`,
  bigSofas: `${ASSET_BASE}/Sofa/BigSofas.png`,
  sofa: `${ASSET_BASE}/Sofa/Sofa.png`,
  tables: `${ASSET_BASE}/Table/Tables.png`,
  littleTables: `${ASSET_BASE}/Table/LittleTables.png`,
  beds: `${ASSET_BASE}/Beds/Beds.png`,
  
  // Carpets
  carpet: `${ASSET_BASE}/Carpet/Carpet.png`,
  carpetBlue: `${ASSET_BASE}/Carpet/CarpetBlue.png`,
  carpetGreen: `${ASSET_BASE}/Carpet/CarpetGreen.png`,
  carpetPurple: `${ASSET_BASE}/Carpet/CarpetPurple.png`,
  carpetRed: `${ASSET_BASE}/Carpet/CarpetRed.png`,
  carpetWhite: `${ASSET_BASE}/Carpet/CarpetWhite.png`,
  carpetYellow: `${ASSET_BASE}/Carpet/CarpetYellow.png`,
  
  // Decorations
  laptops: `${ASSET_BASE}/Decorations/Laptops.png`,
  bookCase: `${ASSET_BASE}/Decorations/BookCase.png`,
  books: `${ASSET_BASE}/Decorations/Books.png`,
  lamps: `${ASSET_BASE}/Decorations/Lamps.png`,
  coffeeCups: `${ASSET_BASE}/Decorations/CoffeeCups.png`,
  television: `${ASSET_BASE}/Decorations/Television.png`,
  aquarium: `${ASSET_BASE}/Decorations/Aquavarium.png`,
  teddyBears: `${ASSET_BASE}/Decorations/TeddyBears.png`,
  dog: `${ASSET_BASE}/Decorations/Dog.png`,
  wallWatch: `${ASSET_BASE}/Decorations/WallWatch.png`,
  candle: `${ASSET_BASE}/Decorations/Candle.png`,
  decorativeLamp: `${ASSET_BASE}/Decorations/DecorativeLamp.png`,
  decorativeLight: `${ASSET_BASE}/Decorations/DecorativeLight.png`,
  littleTablesDecor: `${ASSET_BASE}/Decorations/LittleTables.png`,
  
  // Plants
  plants: `${ASSET_BASE}/Plants/Plants.png`,
  plant: `${ASSET_BASE}/Plants/Plant.png`,
  
  // Wall decorations
  wallPaintings: `${ASSET_BASE}/WallPaintings/WallPaintings.png`,
  littleWallPaintings: `${ASSET_BASE}/WallPaintings/LittleWallPaintings.png`,
  
  // Windows
  windows: `${ASSET_BASE}/Windows/Windows.png`,
  
  // Drawers
  drawers: `${ASSET_BASE}/Drawers/Drawers.png`,
  drawers2: `${ASSET_BASE}/Drawers/Drawers2.png`,
  drawersBlack: `${ASSET_BASE}/Drawers/DrawersBlack.png`,
  drawersBrown: `${ASSET_BASE}/Drawers/DrawersBrown.png`,
  drawersGreen: `${ASSET_BASE}/Drawers/DrawersGreen.png`,
  drawersPink: `${ASSET_BASE}/Drawers/DrawersPink.png`,
  drawersWhite: `${ASSET_BASE}/Drawers/DrawersWhite.png`,
  
  // Halloween room
  halloweenRoom: `${ASSET_BASE}/HalloweenRoom/SpookyDecorations.png`,

  // Master sprite sheet
  allItems: `${ASSET_BASE}/AllItems.png`,
} as const;

// ════════════════════════════════════════════════════════════════
// SPRITE SHEET FRAME DEFINITIONS
// ════════════════════════════════════════════════════════════════

// Frame coordinates: { x, y, width, height }
export interface SpriteFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Desks.png: 6 desks in 2x3 grid (measured from image: ~210x100px total)
// Each desk is approximately 70x50px
export const DESK_FRAMES: Record<string, SpriteFrame> = {
  purple: { x: 0, y: 0, width: 70, height: 50 },
  beige: { x: 70, y: 0, width: 70, height: 50 },
  pink: { x: 0, y: 50, width: 70, height: 50 },
  gray: { x: 70, y: 50, width: 70, height: 50 },
  yellow: { x: 140, y: 0, width: 70, height: 50 },
  blue: { x: 140, y: 50, width: 70, height: 50 },
};

// Chairs.png: 8 chairs in 2x4 grid (~168x56px total)
// Each chair is approximately 21x28px
export const CHAIR_FRAMES: Record<string, SpriteFrame> = {
  red: { x: 0, y: 0, width: 42, height: 28 },
  blue: { x: 42, y: 0, width: 42, height: 28 },
  brown: { x: 84, y: 0, width: 42, height: 28 },
  purple: { x: 126, y: 0, width: 42, height: 28 },
  green: { x: 0, y: 28, width: 42, height: 28 },
  black: { x: 42, y: 28, width: 42, height: 28 },
  white: { x: 84, y: 28, width: 42, height: 28 },
  olive: { x: 126, y: 28, width: 42, height: 28 },
};

// BigSofas.png: 6 sofas in 2x3 grid (~264x92px total)
// Each sofa is approximately 88x46px
export const SOFA_FRAMES: Record<string, SpriteFrame> = {
  brown: { x: 0, y: 0, width: 88, height: 46 },
  purple: { x: 88, y: 0, width: 88, height: 46 },
  gray: { x: 176, y: 0, width: 88, height: 46 },
  beige: { x: 0, y: 46, width: 88, height: 46 },
  red: { x: 88, y: 46, width: 88, height: 46 },
  teal: { x: 176, y: 46, width: 88, height: 46 },
};

// Plants.png: 8 plants in a row (~192x32px total)
// Each plant is approximately 24x32px
export const PLANT_FRAMES: Record<string, SpriteFrame> = {
  plant1: { x: 0, y: 0, width: 24, height: 32 },
  plant2: { x: 24, y: 0, width: 24, height: 32 },
  plant3: { x: 48, y: 0, width: 24, height: 32 },
  plant4: { x: 72, y: 0, width: 24, height: 32 },
  plant5: { x: 96, y: 0, width: 24, height: 32 },
  plant6: { x: 120, y: 0, width: 24, height: 32 },
  plant7: { x: 144, y: 0, width: 24, height: 32 },
  plant8: { x: 168, y: 0, width: 24, height: 32 },
};

// Laptops.png: 2 laptops in a row (~96x28px total)
// Each laptop is approximately 48x28px
export const LAPTOP_FRAMES: Record<string, SpriteFrame> = {
  silver: { x: 0, y: 0, width: 48, height: 28 },
  dark: { x: 48, y: 0, width: 48, height: 28 },
};

// CoffeeCups.png: 4 cups in 2x2 grid (~32x32px total)
// Each cup is approximately 16x16px
export const COFFEE_FRAMES: Record<string, SpriteFrame> = {
  cup1: { x: 0, y: 0, width: 16, height: 16 },
  cup2: { x: 16, y: 0, width: 16, height: 16 },
  cup3: { x: 0, y: 16, width: 16, height: 16 },
  cup4: { x: 16, y: 16, width: 16, height: 16 },
};

// LittleTables.png: 6 round tables in a row (~144x20px total)
// Each table is approximately 24x20px
export const LITTLE_TABLE_FRAMES: Record<string, SpriteFrame> = {
  purple: { x: 0, y: 0, width: 24, height: 20 },
  gray: { x: 24, y: 0, width: 24, height: 20 },
  white: { x: 48, y: 0, width: 24, height: 20 },
  brown: { x: 72, y: 0, width: 24, height: 20 },
  pink: { x: 96, y: 0, width: 24, height: 20 },
  beige: { x: 120, y: 0, width: 24, height: 20 },
};

// Windows.png: 4 windows in a row
// Each window is approximately 48x80px
export const WINDOW_FRAMES: Record<string, SpriteFrame> = {
  pink: { x: 0, y: 0, width: 48, height: 80 },
  curtain: { x: 48, y: 0, width: 48, height: 80 },
  brown: { x: 96, y: 0, width: 48, height: 80 },
  teal: { x: 144, y: 0, width: 48, height: 80 },
};

// TeddyBears.png: 3 bears + other items
export const TEDDY_FRAMES: Record<string, SpriteFrame> = {
  brown: { x: 0, y: 0, width: 16, height: 20 },
  cream: { x: 16, y: 0, width: 16, height: 20 },
  gray: { x: 32, y: 0, width: 16, height: 20 },
};

// ════════════════════════════════════════════════════════════════
// TEXTURE CACHE & LOADER
// ════════════════════════════════════════════════════════════════

export interface CozyTextures {
  // Rooms
  room1: PIXI.Texture | null;
  room2: PIXI.Texture | null;
  
  // Base textures (full sheets)
  desks: PIXI.Texture | null;
  chairs: PIXI.Texture | null;
  bigSofas: PIXI.Texture | null;
  plants: PIXI.Texture | null;
  laptops: PIXI.Texture | null;
  coffeeCups: PIXI.Texture | null;
  littleTables: PIXI.Texture | null;
  bookCase: PIXI.Texture | null;
  television: PIXI.Texture | null;
  windows: PIXI.Texture | null;
  teddyBears: PIXI.Texture | null;
  lamps: PIXI.Texture | null;
  
  // Single-item textures
  carpet: PIXI.Texture | null;
  carpetBlue: PIXI.Texture | null;
  carpetGreen: PIXI.Texture | null;
  carpetRed: PIXI.Texture | null;
  carpetPurple: PIXI.Texture | null;
  candle: PIXI.Texture | null;
  decorativeLamp: PIXI.Texture | null;
  decorativeLight: PIXI.Texture | null;
  dog: PIXI.Texture | null;
  wallPaintings: PIXI.Texture | null;
  beds: PIXI.Texture | null;
  
  // Extracted frame textures
  desk: Record<string, PIXI.Texture>;
  chair: Record<string, PIXI.Texture>;
  sofa: Record<string, PIXI.Texture>;
  plant: Record<string, PIXI.Texture>;
  laptop: Record<string, PIXI.Texture>;
  coffee: Record<string, PIXI.Texture>;
  littleTable: Record<string, PIXI.Texture>;
  window: Record<string, PIXI.Texture>;
  teddy: Record<string, PIXI.Texture>;
  
  loaded: boolean;
}

// Global texture cache
let textureCache: CozyTextures | null = null;
let loadingPromise: Promise<CozyTextures> | null = null;

/**
 * Extract a frame from a base texture to create an individual sprite texture
 */
function extractFrame(baseTexture: PIXI.Texture, frame: SpriteFrame): PIXI.Texture {
  return new PIXI.Texture(
    baseTexture.baseTexture,
    new PIXI.Rectangle(frame.x, frame.y, frame.width, frame.height)
  );
}

/**
 * Extract all frames from a sprite sheet
 */
function extractFrames(
  baseTexture: PIXI.Texture | null, 
  frames: Record<string, SpriteFrame>
): Record<string, PIXI.Texture> {
  const result: Record<string, PIXI.Texture> = {};
  if (!baseTexture) return result;
  
  for (const [key, frame] of Object.entries(frames)) {
    result[key] = extractFrame(baseTexture, frame);
  }
  return result;
}

/**
 * Load a texture with error handling
 */
async function loadTexture(path: string): Promise<PIXI.Texture | null> {
  try {
    const texture = await PIXI.Texture.fromURL(path);
    return texture;
  } catch (err) {
    console.warn(`[CozyRoomAssets] Failed to load texture: ${path}`, err);
    return null;
  }
}

/**
 * Load all cozy room assets
 * Call this once at startup, textures are cached globally
 */
export async function loadCozyRoomAssets(): Promise<CozyTextures> {
  // Return cached if already loaded
  if (textureCache?.loaded) {
    return textureCache;
  }
  
  // Return existing loading promise if in progress
  if (loadingPromise) {
    return loadingPromise;
  }
  
  loadingPromise = (async () => {
    console.log('[CozyRoomAssets] Loading textures...');
    
    const textures: CozyTextures = {
      room1: null,
      room2: null,
      desks: null,
      chairs: null,
      bigSofas: null,
      plants: null,
      laptops: null,
      coffeeCups: null,
      littleTables: null,
      bookCase: null,
      television: null,
      windows: null,
      teddyBears: null,
      lamps: null,
      carpet: null,
      carpetBlue: null,
      carpetGreen: null,
      carpetRed: null,
      carpetPurple: null,
      candle: null,
      decorativeLamp: null,
      decorativeLight: null,
      dog: null,
      wallPaintings: null,
      beds: null,
      desk: {},
      chair: {},
      sofa: {},
      plant: {},
      laptop: {},
      coffee: {},
      littleTable: {},
      window: {},
      teddy: {},
      loaded: false,
    };
    
    // Load all textures in parallel
    const [
      room1, room2,
      desks, chairs, bigSofas, plants, laptops, coffeeCups,
      littleTables, bookCase, television, windows, teddyBears, lamps,
      carpet, carpetBlue, carpetGreen, carpetRed, carpetPurple,
      candle, decorativeLamp, decorativeLight, dog, wallPaintings, beds,
    ] = await Promise.all([
      loadTexture(ASSET_PATHS.room1),
      loadTexture(ASSET_PATHS.room2),
      loadTexture(ASSET_PATHS.desks),
      loadTexture(ASSET_PATHS.chairs),
      loadTexture(ASSET_PATHS.bigSofas),
      loadTexture(ASSET_PATHS.plants),
      loadTexture(ASSET_PATHS.laptops),
      loadTexture(ASSET_PATHS.coffeeCups),
      loadTexture(ASSET_PATHS.littleTables),
      loadTexture(ASSET_PATHS.bookCase),
      loadTexture(ASSET_PATHS.television),
      loadTexture(ASSET_PATHS.windows),
      loadTexture(ASSET_PATHS.teddyBears),
      loadTexture(ASSET_PATHS.lamps),
      loadTexture(ASSET_PATHS.carpet),
      loadTexture(ASSET_PATHS.carpetBlue),
      loadTexture(ASSET_PATHS.carpetGreen),
      loadTexture(ASSET_PATHS.carpetRed),
      loadTexture(ASSET_PATHS.carpetPurple),
      loadTexture(ASSET_PATHS.candle),
      loadTexture(ASSET_PATHS.decorativeLamp),
      loadTexture(ASSET_PATHS.decorativeLight),
      loadTexture(ASSET_PATHS.dog),
      loadTexture(ASSET_PATHS.wallPaintings),
      loadTexture(ASSET_PATHS.beds),
    ]);
    
    // Store base textures
    textures.room1 = room1;
    textures.room2 = room2;
    textures.desks = desks;
    textures.chairs = chairs;
    textures.bigSofas = bigSofas;
    textures.plants = plants;
    textures.laptops = laptops;
    textures.coffeeCups = coffeeCups;
    textures.littleTables = littleTables;
    textures.bookCase = bookCase;
    textures.television = television;
    textures.windows = windows;
    textures.teddyBears = teddyBears;
    textures.lamps = lamps;
    textures.carpet = carpet;
    textures.carpetBlue = carpetBlue;
    textures.carpetGreen = carpetGreen;
    textures.carpetRed = carpetRed;
    textures.carpetPurple = carpetPurple;
    textures.candle = candle;
    textures.decorativeLamp = decorativeLamp;
    textures.decorativeLight = decorativeLight;
    textures.dog = dog;
    textures.wallPaintings = wallPaintings;
    textures.beds = beds;
    
    // Extract individual frames from sprite sheets
    textures.desk = extractFrames(desks, DESK_FRAMES);
    textures.chair = extractFrames(chairs, CHAIR_FRAMES);
    textures.sofa = extractFrames(bigSofas, SOFA_FRAMES);
    textures.plant = extractFrames(plants, PLANT_FRAMES);
    textures.laptop = extractFrames(laptops, LAPTOP_FRAMES);
    textures.coffee = extractFrames(coffeeCups, COFFEE_FRAMES);
    textures.littleTable = extractFrames(littleTables, LITTLE_TABLE_FRAMES);
    textures.window = extractFrames(windows, WINDOW_FRAMES);
    textures.teddy = extractFrames(teddyBears, TEDDY_FRAMES);
    
    textures.loaded = true;
    textureCache = textures;
    
    const loadedCount = Object.values(textures).filter(v => v !== null && v !== false && typeof v !== 'object').length;
    console.log(`[CozyRoomAssets] Loaded ${loadedCount} textures`);
    
    return textures;
  })();
  
  return loadingPromise;
}

/**
 * Get loaded textures (returns null if not loaded)
 */
export function getCozyTextures(): CozyTextures | null {
  return textureCache;
}

/**
 * Check if textures are loaded
 */
export function areTexturesLoaded(): boolean {
  return textureCache?.loaded ?? false;
}

// ════════════════════════════════════════════════════════════════
// SPRITE FACTORY FUNCTIONS
// ════════════════════════════════════════════════════════════════

/**
 * Create a room base sprite
 */
export function createRoomSprite(variant: 'room1' | 'room2' = 'room1'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = variant === 'room1' ? textures?.room1 : textures?.room2;
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.7); // Anchor at center-bottom for isometric positioning
  return sprite;
}

/**
 * Create a desk sprite
 */
export function createDeskSprite(color: keyof typeof DESK_FRAMES = 'beige'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.desk[color];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.8);
  return sprite;
}

/**
 * Create a chair sprite
 */
export function createChairSprite(color: keyof typeof CHAIR_FRAMES = 'black'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.chair[color];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

/**
 * Create a sofa sprite
 */
export function createSofaSprite(color: keyof typeof SOFA_FRAMES = 'brown'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.sofa[color];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

/**
 * Create a plant sprite
 */
export function createPlantSprite(variant: keyof typeof PLANT_FRAMES = 'plant1'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.plant[variant];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.9);
  return sprite;
}

/**
 * Create a laptop sprite
 */
export function createLaptopSprite(variant: keyof typeof LAPTOP_FRAMES = 'silver'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.laptop[variant];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.8);
  return sprite;
}

/**
 * Create a coffee cup sprite
 */
export function createCoffeeSprite(variant: keyof typeof COFFEE_FRAMES = 'cup1'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.coffee[variant];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.8);
  return sprite;
}

/**
 * Create a little table sprite
 */
export function createLittleTableSprite(color: keyof typeof LITTLE_TABLE_FRAMES = 'brown'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.littleTable[color];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.8);
  return sprite;
}

/**
 * Create a bookcase sprite
 */
export function createBookcaseSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!textures?.bookCase) return null;
  
  const sprite = new PIXI.Sprite(textures.bookCase);
  sprite.anchor.set(0.5, 0.95);
  return sprite;
}

/**
 * Create a television sprite
 */
export function createTelevisionSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!textures?.television) return null;
  
  const sprite = new PIXI.Sprite(textures.television);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

/**
 * Create a carpet sprite
 */
export function createCarpetSprite(
  color: 'default' | 'blue' | 'green' | 'red' | 'purple' = 'default'
): PIXI.Sprite | null {
  const textures = getCozyTextures();
  let texture: PIXI.Texture | null = null;
  
  switch (color) {
    case 'blue': texture = textures?.carpetBlue ?? null; break;
    case 'green': texture = textures?.carpetGreen ?? null; break;
    case 'red': texture = textures?.carpetRed ?? null; break;
    case 'purple': texture = textures?.carpetPurple ?? null; break;
    default: texture = textures?.carpet ?? null;
  }
  
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  return sprite;
}

/**
 * Create a window sprite
 */
export function createWindowSprite(variant: keyof typeof WINDOW_FRAMES = 'brown'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.window[variant];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.9);
  return sprite;
}

/**
 * Create a teddy bear sprite
 */
export function createTeddySprite(color: keyof typeof TEDDY_FRAMES = 'brown'): PIXI.Sprite | null {
  const textures = getCozyTextures();
  const texture = textures?.teddy[color];
  if (!texture) return null;
  
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.9);
  return sprite;
}

// ════════════════════════════════════════════════════════════════
// ADDITIONAL SINGLE-SPRITE FACTORIES
// ════════════════════════════════════════════════════════════════

export function createCandleSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!(textures as any)?.candle) return null;
  const sprite = new PIXI.Sprite((textures as any).candle);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

export function createDecorativeLampSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!(textures as any)?.decorativeLamp) return null;
  const sprite = new PIXI.Sprite((textures as any).decorativeLamp);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

export function createDecorativeLightSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!(textures as any)?.decorativeLight) return null;
  const sprite = new PIXI.Sprite((textures as any).decorativeLight);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

export function createDogSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!(textures as any)?.dog) return null;
  const sprite = new PIXI.Sprite((textures as any).dog);
  sprite.anchor.set(0.5, 0.9);
  return sprite;
}

export function createWallPaintingSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!(textures as any)?.wallPaintings) return null;
  const sprite = new PIXI.Sprite((textures as any).wallPaintings);
  sprite.anchor.set(0.5, 0.9);
  return sprite;
}

export function createLampSprite(): PIXI.Sprite | null {
  const textures = getCozyTextures();
  if (!textures?.lamps) return null;
  const sprite = new PIXI.Sprite(textures.lamps);
  sprite.anchor.set(0.5, 0.85);
  return sprite;
}

// ════════════════════════════════════════════════════════════════
// MULTI-SPRITE COMPOSITION HELPERS
// ════════════════════════════════════════════════════════════════

export function createCoffeeStation(scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  const lt = createLittleTableSprite('brown');
  if (lt) {
    lt.scale.set(scale);
    lt.position.set(0, 0);
    lt.zIndex = 20;
    container.addChild(lt);
  }
  const cup1 = createCoffeeSprite('cup1');
  if (cup1) {
    cup1.scale.set(scale);
    cup1.position.set(-6 * scale, -10 * scale);
    cup1.zIndex = 25;
    container.addChild(cup1);
  }
  const cup2 = createCoffeeSprite('cup2');
  if (cup2) {
    cup2.scale.set(scale);
    cup2.position.set(6 * scale, -10 * scale);
    cup2.zIndex = 25;
    container.addChild(cup2);
  }
  const lamp = createDecorativeLampSprite();
  if (lamp) {
    lamp.scale.set(scale * 0.7);
    lamp.position.set(10 * scale, -12 * scale);
    lamp.zIndex = 28;
    container.addChild(lamp);
  }
  return container;
}

export function createBookshelfWall(scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  const count = 3;
  const spacing = 35;
  for (let i = 0; i < count; i++) {
    const bc = createBookcaseSprite();
    if (bc) {
      bc.scale.set(scale);
      bc.position.set((i - (count - 1) / 2) * spacing * scale, 0);
      bc.zIndex = 5;
      container.addChild(bc);
    }
  }
  const plant = createPlantSprite('plant3');
  if (plant) {
    plant.scale.set(scale * 0.8);
    plant.position.set(((count - 1) / 2) * spacing * scale, -25 * scale);
    plant.zIndex = 8;
    container.addChild(plant);
  }
  return container;
}

export function createTVSetup(scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  const tv = createTelevisionSprite();
  if (tv) {
    tv.scale.set(scale);
    tv.position.set(0, 0);
    tv.zIndex = 8;
    container.addChild(tv);
  }
  const lt = createLittleTableSprite('gray');
  if (lt) {
    lt.scale.set(scale * 0.9);
    lt.position.set(0, 15 * scale);
    lt.zIndex = 12;
    container.addChild(lt);
  }
  const light = createDecorativeLightSprite();
  if (light) {
    light.scale.set(scale * 0.6);
    light.position.set(0, 22 * scale);
    light.zIndex = 15;
    container.addChild(light);
  }
  return container;
}

export function createBedCorner(scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  const textures = getCozyTextures();
  if (textures?.beds) {
    const bed = new PIXI.Sprite(textures.beds);
    bed.anchor.set(0.5, 0.9);
    bed.scale.set(scale);
    bed.position.set(0, 0);
    bed.zIndex = 10;
    container.addChild(bed);
  }
  const lt = createLittleTableSprite('white');
  if (lt) {
    lt.scale.set(scale * 0.8);
    lt.position.set(25 * scale, -5 * scale);
    lt.zIndex = 12;
    container.addChild(lt);
  }
  const lamp = createLampSprite();
  if (lamp) {
    lamp.scale.set(scale * 0.6);
    lamp.position.set(25 * scale, -15 * scale);
    lamp.zIndex = 14;
    container.addChild(lamp);
  }
  const teddy = createTeddySprite('cream');
  if (teddy) {
    teddy.scale.set(scale * 0.7);
    teddy.position.set(10 * scale, 10 * scale);
    teddy.zIndex = 18;
    container.addChild(teddy);
  }
  return container;
}

export function createDeskSetup(
  color: keyof typeof DESK_FRAMES = 'beige',
  hasDualMonitors: boolean = false,
  scale: number = 1,
): PIXI.Container {
  const container = new PIXI.Container();
  const chair = createChairSprite(color === 'gray' ? 'white' : color === 'beige' ? 'black' : 'blue');
  if (chair) {
    chair.scale.set(scale);
    chair.position.set(0, 15 * scale);
    chair.zIndex = 15;
    container.addChild(chair);
  }
  const desk = createDeskSprite(color);
  if (desk) {
    desk.scale.set(scale);
    desk.position.set(0, 0);
    desk.zIndex = 20;
    container.addChild(desk);
  }
  const laptop = createLaptopSprite('silver');
  if (laptop) {
    laptop.scale.set(scale * 0.7);
    laptop.position.set(hasDualMonitors ? -12 * scale : -5 * scale, -18 * scale);
    laptop.zIndex = 25;
    container.addChild(laptop);
  }
  if (hasDualMonitors) {
    const laptop2 = createLaptopSprite('dark');
    if (laptop2) {
      laptop2.scale.set(scale * 0.7);
      laptop2.position.set(10 * scale, -18 * scale);
      laptop2.zIndex = 25;
      container.addChild(laptop2);
    }
  }
  const coffee = createCoffeeSprite('cup1');
  if (coffee) {
    coffee.scale.set(scale);
    coffee.position.set(18 * scale, -12 * scale);
    coffee.zIndex = 26;
    container.addChild(coffee);
  }
  return container;
}

// ════════════════════════════════════════════════════════════════
// WORKSTATION BUILDER (Agent desk setup)
// ════════════════════════════════════════════════════════════════

export interface WorkstationOptions {
  deskColor?: keyof typeof DESK_FRAMES;
  chairColor?: keyof typeof CHAIR_FRAMES;
  hasLaptop?: boolean;
  hasCoffee?: boolean;
  scale?: number;
}

/**
 * Create a complete workstation (desk + chair + optional laptop + coffee)
 * Returns a container with all elements properly positioned
 */
export function createWorkstationContainer(options: WorkstationOptions = {}): PIXI.Container {
  const {
    deskColor = 'beige',
    chairColor = 'black',
    hasLaptop = true,
    hasCoffee = true,
    scale = 1.5,
  } = options;
  
  const container = new PIXI.Container();
  
  // Chair (behind desk)
  const chair = createChairSprite(chairColor);
  if (chair) {
    chair.scale.set(scale);
    chair.position.set(0, 15 * scale);
    container.addChild(chair);
  }
  
  // Desk
  const desk = createDeskSprite(deskColor);
  if (desk) {
    desk.scale.set(scale);
    desk.position.set(0, 0);
    container.addChild(desk);
  }
  
  // Laptop on desk
  if (hasLaptop) {
    const laptop = createLaptopSprite('silver');
    if (laptop) {
      laptop.scale.set(scale * 0.7);
      laptop.position.set(-10 * scale, -20 * scale);
      container.addChild(laptop);
    }
  }
  
  // Coffee on desk
  if (hasCoffee) {
    const coffee = createCoffeeSprite('cup1');
    if (coffee) {
      coffee.scale.set(scale);
      coffee.position.set(20 * scale, -15 * scale);
      container.addChild(coffee);
    }
  }
  
  return container;
}

// ════════════════════════════════════════════════════════════════
// ROOM LAYOUT BUILDER
// ════════════════════════════════════════════════════════════════

export type NodeRole = 'hub' | 'satellite' | 'local' | 'master';

export interface RoomLayoutOptions {
  role: NodeRole;
  agentCount: number;
  scale?: number;
}

/**
 * Get carpet color based on node role
 */
export function getCarpetColorForRole(role: NodeRole): 'default' | 'blue' | 'green' | 'red' | 'purple' {
  switch (role) {
    case 'hub':
    case 'master':
      return 'purple';
    case 'satellite':
      return 'blue';
    case 'local':
      return 'green';
    default:
      return 'default';
  }
}

/**
 * Get desk color based on index (for variety)
 */
export function getDeskColorByIndex(index: number): keyof typeof DESK_FRAMES {
  const colors: (keyof typeof DESK_FRAMES)[] = ['beige', 'gray', 'blue', 'yellow', 'pink', 'purple'];
  return colors[index % colors.length];
}

/**
 * Get chair color based on index (for variety)
 */
export function getChairColorByIndex(index: number): keyof typeof CHAIR_FRAMES {
  const colors: (keyof typeof CHAIR_FRAMES)[] = ['black', 'blue', 'red', 'green', 'purple', 'brown'];
  return colors[index % colors.length];
}

/**
 * Get plant variant based on index
 */
export function getPlantVariantByIndex(index: number): keyof typeof PLANT_FRAMES {
  const variants: (keyof typeof PLANT_FRAMES)[] = ['plant1', 'plant2', 'plant3', 'plant4', 'plant5', 'plant6', 'plant7', 'plant8'];
  return variants[index % variants.length];
}

/**
 * Create a fully furnished room container
 * Enhanced with richer layouts, wall decor, ambient items, and role-specific styling
 */
export function createFurnishedRoomContainer(options: RoomLayoutOptions): PIXI.Container {
  const { role, agentCount, scale = 1 } = options;
  const container = new PIXI.Container();
  container.sortableChildren = true;

  const room = createRoomSprite('room1');
  if (room) {
    room.scale.set(scale * 1.2);
    room.position.set(0, 0);
    room.zIndex = 0;
    container.addChild(room);
  }

  const carpet = createCarpetSprite(getCarpetColorForRole(role));
  if (carpet) {
    carpet.scale.set(scale * 1.3);
    carpet.position.set(0, 20 * scale);
    carpet.zIndex = 1;
    container.addChild(carpet);
  }

  // Wall decorations — window at the back
  const win = createWindowSprite('brown');
  if (win) {
    win.scale.set(scale * 1.1);
    win.position.set(0, -45 * scale);
    win.zIndex = 3;
    container.addChild(win);
  }

  // Wall painting
  const painting = createWallPaintingSprite();
  if (painting) {
    painting.scale.set(scale * 0.8);
    painting.position.set(45 * scale, -40 * scale);
    painting.zIndex = 3;
    container.addChild(painting);
  }

  if (role === 'hub' || role === 'master') {
    // Grand hub/master rooms: reception, multiple sofas, carpet layer, many plants

    // Second carpet layer for grandeur
    const carpet2 = createCarpetSprite('purple');
    if (carpet2) {
      carpet2.scale.set(scale * 1.5);
      carpet2.alpha = 0.5;
      carpet2.position.set(0, 25 * scale);
      carpet2.zIndex = 2;
      container.addChild(carpet2);
    }

    // Reception desk near entry
    const reception = createDeskSetup('purple', false, scale * 1.0);
    reception.position.set(0, 55 * scale);
    reception.zIndex = 55;
    container.addChild(reception);

    // L-shaped workstation arrangement
    const lPositions = [
      { x: -60, y: 10, desk: 'beige' as keyof typeof DESK_FRAMES },
      { x: -30, y: 10, desk: 'gray' as keyof typeof DESK_FRAMES },
      { x: -60, y: 35, desk: 'blue' as keyof typeof DESK_FRAMES },
    ];
    for (const pos of lPositions) {
      const ws = createDeskSetup(pos.desk, true, scale * 1.1);
      ws.position.set(pos.x * scale, pos.y * scale);
      ws.zIndex = 20 + Math.floor(pos.y);
      container.addChild(ws);
    }

    // Sofa area
    const sofa = createSofaSprite('brown');
    if (sofa) {
      sofa.scale.set(scale * 1.5);
      sofa.position.set(50 * scale, 25 * scale);
      sofa.zIndex = 30;
      container.addChild(sofa);
    }

    const sofa2 = createSofaSprite('beige');
    if (sofa2) {
      sofa2.scale.set(scale * 1.3);
      sofa2.position.set(50 * scale, 0 * scale);
      sofa2.zIndex = 28;
      container.addChild(sofa2);
    }

    // Coffee table between sofas
    const table = createLittleTableSprite('brown');
    if (table) {
      table.scale.set(scale * 1.5);
      table.position.set(50 * scale, 40 * scale);
      table.zIndex = 25;
      container.addChild(table);
    }

    // TV setup
    const tvSetup = createTVSetup(scale * 1.1);
    tvSetup.position.set(70 * scale, -30 * scale);
    tvSetup.zIndex = 8;
    container.addChild(tvSetup);

    // Bookshelf wall
    const bsw = createBookshelfWall(scale * 0.9);
    bsw.position.set(-75 * scale, -20 * scale);
    bsw.zIndex = 5;
    container.addChild(bsw);

    // Plants (4 for hub)
    for (let i = 0; i < 4; i++) {
      const plant = createPlantSprite(getPlantVariantByIndex(i + 3));
      if (plant) {
        plant.scale.set(scale * 1.2);
        const px = [(80), (-85), (80), (-85)][i];
        const py = [(20), (-5), (50), (30)][i];
        plant.position.set(px * scale, py * scale);
        plant.zIndex = 35 + i;
        container.addChild(plant);
      }
    }

    // Decorative lamp
    const dLamp = createDecorativeLampSprite();
    if (dLamp) {
      dLamp.scale.set(scale * 0.8);
      dLamp.position.set(85 * scale, 10 * scale);
      dLamp.zIndex = 36;
      container.addChild(dLamp);
    }

    // Teddy bear
    const teddy = createTeddySprite('brown');
    if (teddy) {
      teddy.scale.set(scale * 1.3);
      teddy.position.set(60 * scale, 50 * scale);
      teddy.zIndex = 40;
      container.addChild(teddy);
    }

    // Candle on reception
    const candle = createCandleSprite();
    if (candle) {
      candle.scale.set(scale * 0.8);
      candle.position.set(15 * scale, 45 * scale);
      candle.zIndex = 56;
      container.addChild(candle);
    }
  } else if (role === 'satellite') {
    // Satellite: efficient compact row with shared resources

    // Desks in a row
    const deskCount = Math.min(agentCount + 1, 4);
    for (let i = 0; i < deskCount; i++) {
      const ws = createDeskSetup(getDeskColorByIndex(i), false, scale * 1.1);
      const xOffset = (i - (deskCount - 1) / 2) * 55;
      ws.position.set(xOffset * scale, 15 * scale);
      ws.zIndex = 20 + i;
      container.addChild(ws);
    }

    // Shared bookcase
    const bookcase = createBookcaseSprite();
    if (bookcase) {
      bookcase.scale.set(scale * 1.1);
      bookcase.position.set(-70 * scale, -20 * scale);
      bookcase.zIndex = 5;
      container.addChild(bookcase);
    }

    // Shared coffee station
    const coffeeStation = createCoffeeStation(scale * 0.9);
    coffeeStation.position.set(70 * scale, -10 * scale);
    coffeeStation.zIndex = 10;
    container.addChild(coffeeStation);

    // Two plants
    for (let i = 0; i < 2; i++) {
      const plant = createPlantSprite(getPlantVariantByIndex(i));
      if (plant) {
        plant.scale.set(scale * 1.2);
        plant.position.set(
          (i === 0 ? 80 : -80) * scale,
          (i === 0 ? 25 : -5) * scale
        );
        plant.zIndex = 35 + i;
        container.addChild(plant);
      }
    }
  } else {
    // Local: personal and cozy

    // Single desk with plant
    const ws = createDeskSetup('pink', false, scale * 1.2);
    ws.position.set(0, 15 * scale);
    ws.zIndex = 20;
    container.addChild(ws);

    // Small sofa
    const sofa = createSofaSprite('red');
    if (sofa) {
      sofa.scale.set(scale * 1.0);
      sofa.position.set(50 * scale, 10 * scale);
      sofa.zIndex = 18;
      container.addChild(sofa);
    }

    // Teddy at feet
    const teddy = createTeddySprite('cream');
    if (teddy) {
      teddy.scale.set(scale * 1.0);
      teddy.position.set(60 * scale, 40 * scale);
      teddy.zIndex = 35;
      container.addChild(teddy);
    }

    // Candle on desk area
    const candle = createCandleSprite();
    if (candle) {
      candle.scale.set(scale * 0.7);
      candle.position.set(-20 * scale, 5 * scale);
      candle.zIndex = 26;
      container.addChild(candle);
    }

    // Plant
    const plant = createPlantSprite('plant2');
    if (plant) {
      plant.scale.set(scale * 1.3);
      plant.position.set(-55 * scale, 25 * scale);
      plant.zIndex = 30;
      container.addChild(plant);
    }

    // Bookcase
    const bookcase = createBookcaseSprite();
    if (bookcase) {
      bookcase.scale.set(scale * 0.9);
      bookcase.position.set(-65 * scale, -15 * scale);
      bookcase.zIndex = 5;
      container.addChild(bookcase);
    }

    // Decorative lamp
    const dLamp = createDecorativeLampSprite();
    if (dLamp) {
      dLamp.scale.set(scale * 0.7);
      dLamp.position.set(70 * scale, 25 * scale);
      dLamp.zIndex = 36;
      container.addChild(dLamp);
    }
  }

  return container;
}

// ════════════════════════════════════════════════════════════════
// THEMED ROOM BUILDERS
// ════════════════════════════════════════════════════════════════

export function createOfficeRoomContainer(role: NodeRole, agentCount: number, scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  const room = createRoomSprite('room1');
  if (room) {
    room.scale.set(scale * 1.2);
    room.position.set(0, 0);
    room.zIndex = 0;
    container.addChild(room);
  }

  const carpet = createCarpetSprite('blue');
  if (carpet) {
    carpet.scale.set(scale * 1.3);
    carpet.position.set(0, 20 * scale);
    carpet.zIndex = 1;
    container.addChild(carpet);
  }

  // Window on back wall
  const win = createWindowSprite('brown');
  if (win) {
    win.scale.set(scale * 1.1);
    win.position.set(30 * scale, -45 * scale);
    win.zIndex = 3;
    container.addChild(win);
  }

  // Wall painting
  const painting = createWallPaintingSprite();
  if (painting) {
    painting.scale.set(scale * 0.7);
    painting.position.set(-30 * scale, -42 * scale);
    painting.zIndex = 3;
    container.addChild(painting);
  }

  // L-shaped workstation arrangement
  const lDesks = [
    { x: -50, y: 10, color: 'beige' as keyof typeof DESK_FRAMES, dual: true },
    { x: -20, y: 10, color: 'gray' as keyof typeof DESK_FRAMES, dual: true },
    { x: -50, y: 40, color: 'blue' as keyof typeof DESK_FRAMES, dual: false },
  ];
  for (const d of lDesks) {
    const ws = createDeskSetup(d.color, d.dual, scale * 1.1);
    ws.position.set(d.x * scale, d.y * scale);
    ws.zIndex = 20 + Math.floor(d.y);
    container.addChild(ws);
  }

  // Whiteboard area (TV as stand-in)
  const tv = createTelevisionSprite();
  if (tv) {
    tv.scale.set(scale * 1.3);
    tv.position.set(40 * scale, -35 * scale);
    tv.zIndex = 6;
    container.addChild(tv);
  }

  // Coffee station
  const coffeeStation = createCoffeeStation(scale * 1.0);
  coffeeStation.position.set(65 * scale, -10 * scale);
  coffeeStation.zIndex = 10;
  container.addChild(coffeeStation);

  // Bookshelf wall on both sides
  const bsw1 = createBookshelfWall(scale * 0.8);
  bsw1.position.set(-75 * scale, -20 * scale);
  bsw1.zIndex = 5;
  container.addChild(bsw1);

  const bsw2 = createBookshelfWall(scale * 0.8);
  bsw2.position.set(75 * scale, 20 * scale);
  bsw2.zIndex = 5;
  container.addChild(bsw2);

  // Reception desk
  const reception = createDeskSetup('purple', false, scale * 0.9);
  reception.position.set(20 * scale, 55 * scale);
  reception.zIndex = 55;
  container.addChild(reception);

  // Certificate (wall painting as stand-in)
  const cert = createWallPaintingSprite();
  if (cert) {
    cert.scale.set(scale * 0.5);
    cert.position.set(60 * scale, -40 * scale);
    cert.zIndex = 3;
    cert.tint = 0xffd700;
    container.addChild(cert);
  }

  // Plants
  for (let i = 0; i < 3; i++) {
    const plant = createPlantSprite(getPlantVariantByIndex(i + 2));
    if (plant) {
      plant.scale.set(scale * 1.1);
      plant.position.set(
        [(80), (-85), (80)][i] * scale,
        [(15), (-5), (40)][i] * scale
      );
      plant.zIndex = 35 + i;
      container.addChild(plant);
    }
  }

  // Decorative lamp
  const lamp = createDecorativeLampSprite();
  if (lamp) {
    lamp.scale.set(scale * 0.7);
    lamp.position.set(75 * scale, 5 * scale);
    lamp.zIndex = 36;
    container.addChild(lamp);
  }

  return container;
}

export function createHomeRoomContainer(role: NodeRole, agentCount: number, scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  const room = createRoomSprite('room2');
  if (room) {
    room.scale.set(scale * 1.2);
    room.position.set(0, 0);
    room.zIndex = 0;
    container.addChild(room);
  }

  const carpet = createCarpetSprite('red');
  if (carpet) {
    carpet.scale.set(scale * 1.3);
    carpet.position.set(0, 20 * scale);
    carpet.zIndex = 1;
    container.addChild(carpet);
  }

  // Window with curtain
  const win = createWindowSprite('curtain');
  if (win) {
    win.scale.set(scale * 1.1);
    win.position.set(0, -45 * scale);
    win.zIndex = 3;
    container.addChild(win);
  }

  // Wall painting
  const painting = createWallPaintingSprite();
  if (painting) {
    painting.scale.set(scale * 0.7);
    painting.position.set(50 * scale, -40 * scale);
    painting.zIndex = 3;
    container.addChild(painting);
  }

  // Corner desk setup
  const desk = createDeskSetup('pink', false, scale * 1.2);
  desk.position.set(-35 * scale, 15 * scale);
  desk.zIndex = 20;
  container.addChild(desk);

  // Sofa area with coffee table
  const sofa = createSofaSprite('brown');
  if (sofa) {
    sofa.scale.set(scale * 1.3);
    sofa.position.set(40 * scale, 15 * scale);
    sofa.zIndex = 18;
    container.addChild(sofa);
  }

  const coffeeTable = createLittleTableSprite('brown');
  if (coffeeTable) {
    coffeeTable.scale.set(scale * 1.2);
    coffeeTable.position.set(40 * scale, 30 * scale);
    coffeeTable.zIndex = 22;
    container.addChild(coffeeTable);
  }

  // Coffee on table
  const coffee = createCoffeeSprite('cup2');
  if (coffee) {
    coffee.scale.set(scale * 1.0);
    coffee.position.set(45 * scale, 25 * scale);
    coffee.zIndex = 26;
    container.addChild(coffee);
  }

  // TV on stand
  const tv = createTelevisionSprite();
  if (tv) {
    tv.scale.set(scale * 1.0);
    tv.position.set(60 * scale, -25 * scale);
    tv.zIndex = 8;
    container.addChild(tv);
  }

  // Bed corner
  const bedCorner = createBedCorner(scale * 0.9);
  bedCorner.position.set(-55 * scale, -20 * scale);
  bedCorner.zIndex = 10;
  container.addChild(bedCorner);

  // Bookshelf
  const bookcase = createBookcaseSprite();
  if (bookcase) {
    bookcase.scale.set(scale * 0.9);
    bookcase.position.set(75 * scale, -15 * scale);
    bookcase.zIndex = 5;
    container.addChild(bookcase);
  }

  // Potted plants
  for (let i = 0; i < 3; i++) {
    const plant = createPlantSprite(getPlantVariantByIndex(i + 4));
    if (plant) {
      plant.scale.set(scale * 1.2);
      plant.position.set(
        [(80), (-75), (80)][i] * scale,
        [(30), (-10), (50)][i] * scale
      );
      plant.zIndex = 35 + i;
      container.addChild(plant);
    }
  }

  // Rug (extra carpet layer)
  const rug = createCarpetSprite('purple');
  if (rug) {
    rug.scale.set(scale * 0.8);
    rug.alpha = 0.4;
    rug.position.set(40 * scale, 25 * scale);
    rug.zIndex = 2;
    container.addChild(rug);
  }

  // Dog companion
  const dog = createDogSprite();
  if (dog) {
    dog.scale.set(scale * 1.0);
    dog.position.set(20 * scale, 45 * scale);
    dog.zIndex = 42;
    container.addChild(dog);
  }

  // Candle on bookshelf
  const candle = createCandleSprite();
  if (candle) {
    candle.scale.set(scale * 0.6);
    candle.position.set(75 * scale, -20 * scale);
    candle.zIndex = 6;
    container.addChild(candle);
  }

  // Decorative lamp
  const dLamp = createDecorativeLampSprite();
  if (dLamp) {
    dLamp.scale.set(scale * 0.7);
    dLamp.position.set(-70 * scale, 25 * scale);
    dLamp.zIndex = 36;
    container.addChild(dLamp);
  }

  return container;
}

export function createTechHubRoomContainer(role: NodeRole, agentCount: number, scale: number = 1): PIXI.Container {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  const room = createRoomSprite('room2');
  if (room) {
    room.scale.set(scale * 1.2);
    room.position.set(0, 0);
    room.zIndex = 0;
    container.addChild(room);
  }

  const carpet = createCarpetSprite('green');
  if (carpet) {
    carpet.scale.set(scale * 1.3);
    carpet.position.set(0, 20 * scale);
    carpet.zIndex = 1;
    container.addChild(carpet);
  }

  // Multi-color carpet grid
  const carpetColors: ('blue' | 'green' | 'purple' | 'red')[] = ['blue', 'green', 'purple'];
  for (let i = 0; i < carpetColors.length; i++) {
    const gridCarpet = createCarpetSprite(carpetColors[i]);
    if (gridCarpet) {
      gridCarpet.scale.set(scale * 0.5);
      gridCarpet.alpha = 0.3;
      gridCarpet.position.set(
        ((i - 1) * 50) * scale,
        (25 + (i % 2) * 15) * scale
      );
      gridCarpet.zIndex = 2;
      container.addChild(gridCarpet);
    }
  }

  // Triple-monitor desk setups
  const deskPositions = [
    { x: -50, y: 15, color: 'blue' as keyof typeof DESK_FRAMES },
    { x: 0, y: 15, color: 'purple' as keyof typeof DESK_FRAMES },
    { x: 50, y: 15, color: 'yellow' as keyof typeof DESK_FRAMES },
  ];
  for (const pos of deskPositions) {
    const ws = createDeskSetup(pos.color, true, scale * 1.1);
    ws.position.set(pos.x * scale, pos.y * scale);
    ws.zIndex = 20 + Math.floor(pos.y);
    container.addChild(ws);

    // Third laptop for triple-monitor feel
    const laptop3 = createLaptopSprite('dark');
    if (laptop3) {
      laptop3.scale.set(scale * 0.7);
      laptop3.position.set((pos.x + 22) * scale, (pos.y - 18) * scale);
      laptop3.zIndex = 28;
      container.addChild(laptop3);
    }
  }

  // Large wall-mounted display
  const tvSetup = createTVSetup(scale * 1.4);
  tvSetup.position.set(0, -35 * scale);
  tvSetup.zIndex = 6;
  container.addChild(tvSetup);

  // Server racks (stacked bookcases)
  const serverRack1 = createBookshelfWall(scale * 0.9);
  serverRack1.position.set(-75 * scale, -15 * scale);
  serverRack1.zIndex = 5;
  container.addChild(serverRack1);

  const serverRack2 = createBookshelfWall(scale * 0.9);
  serverRack2.position.set(75 * scale, -15 * scale);
  serverRack2.zIndex = 5;
  container.addChild(serverRack2);

  // Status indicator plants
  for (let i = 0; i < 4; i++) {
    const plant = createPlantSprite(getPlantVariantByIndex(i + 6));
    if (plant) {
      plant.scale.set(scale * 1.0);
      plant.position.set(
        [(80), (-80), (80), (-80)][i] * scale,
        [(20), (20), (45), (45)][i] * scale
      );
      plant.zIndex = 35 + i;
      container.addChild(plant);
    }
  }

  // Decorative lights as indicator LEDs
  for (let i = 0; i < 3; i++) {
    const light = createDecorativeLightSprite();
    if (light) {
      light.scale.set(scale * 0.5);
      light.position.set(
        ((i - 1) * 25) * scale,
        -10 * scale
      );
      light.zIndex = 8;
      container.addChild(light);
    }
  }

  return container;
}

// ════════════════════════════════════════════════════════════════
// FRAME TYPES RE-EXPORT
// ════════════════════════════════════════════════════════════════

// Frame constants are already exported above as `export const`
// These type aliases make them easier to use for typing
export type DeskColor = keyof typeof DESK_FRAMES;
export type ChairColor = keyof typeof CHAIR_FRAMES;
export type SofaColor = keyof typeof SOFA_FRAMES;
export type PlantVariant = keyof typeof PLANT_FRAMES;
export type LaptopVariant = keyof typeof LAPTOP_FRAMES;
export type CoffeeVariant = keyof typeof COFFEE_FRAMES;
export type LittleTableColor = keyof typeof LITTLE_TABLE_FRAMES;
export type WindowVariant = keyof typeof WINDOW_FRAMES;
export type TeddyColor = keyof typeof TEDDY_FRAMES;

// ════════════════════════════════════════════════════════════════
// PROCEDURAL ROOM DRAWING - Palettes
// ════════════════════════════════════════════════════════════════

export const PALETTE = {
  gold: 0xd4af37,
  amber: 0xf5a623,
  teal: 0x2dd4bf,
  warmWhite: 0xfaf3e0,
  darkBase: 0x1a212d,
  darkAlt: 0x0e1421,
  lightWood: 0xc4a574,
  midWood: 0x8b6914,
  darkWood: 0x5c4033,
  mahogany: 0x420d09,
  marbleWhite: 0xf0ece2,
  marbleVein: 0xd5cfc0,
  concrete: 0x8a8a8a,
  concreteCrack: 0x6b6b6b,
  concreteGrate: 0x4a4a4a,
  carpetNavy: 0x1b2a4a,
  carpetGold: 0xc9a84c,
  brick: 0x8b4513,
  brickDark: 0x6b3410,
  mortar: 0xc8b89a,
  glass: 0xa8d8ea,
  glassFrame: 0x4a5568,
  neonCyan: 0x00f0ff,
  neonMagenta: 0xff00ff,
  metalLight: 0xb0bec5,
  metalDark: 0x37474f,
  shojiWhite: 0xf5f0e8,
  bamboo: 0x7ab648,
  tatamiGreen: 0x9ab973,
  tatamiBorder: 0x6b8e4e,
  persianRed: 0x8b1a1a,
  persianBlue: 0x1a3a6b,
  persianGold: 0xc9a84c,
  brass: 0xb5a642,
  leather: 0x6b3a2a,
  starWhite: 0xffffff,
  spaceDark: 0x0a0a1a,
  spacePanel: 0x2a3a4a,
  emergencyRed: 0xff3333,
  emergencyAmber: 0xffaa33,
  leatherDark: 0x3d2216,
} as const;

// ════════════════════════════════════════════════════════════════
// PROCEDURAL FLOOR DRAWING
// ════════════════════════════════════════════════════════════════

export type FloorStyle = 'parquet' | 'marble' | 'concrete' | 'carpet-diamond' | 'carpet-chevron' | 'carpet-artdeco' | 'tatami' | 'metal-grate';

export function drawStylishFloor(g: PIXI.Graphics, width: number, height: number, style: FloorStyle): void {
  switch (style) {
    case 'parquet':
      drawParquetFloor(g, width, height);
      break;
    case 'marble':
      drawMarbleFloor(g, width, height);
      break;
    case 'concrete':
      drawConcreteFloor(g, width, height);
      break;
    case 'carpet-diamond':
      drawCarpetDiamond(g, width, height);
      break;
    case 'carpet-chevron':
      drawCarpetChevron(g, width, height);
      break;
    case 'carpet-artdeco':
      drawCarpetArtDeco(g, width, height);
      break;
    case 'tatami':
      drawTatamiFloor(g, width, height);
      break;
    case 'metal-grate':
      drawMetalGrateFloor(g, width, height);
      break;
  }
}

function drawParquetFloor(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.lightWood);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const tileSize = 16;
  for (let row = 0; row < Math.ceil(h / tileSize); row++) {
    for (let col = 0; col < Math.ceil(w / tileSize); col++) {
      const x = col * tileSize;
      const y = row * tileSize;
      const isAlt = (row + col) % 2 === 0;
      const base = isAlt ? PALETTE.midWood : PALETTE.darkWood;
      g.beginFill(base, 0.45);
      if (isAlt) {
        g.moveTo(x, y + tileSize);
        g.lineTo(x + tileSize, y + tileSize);
        g.lineTo(x + tileSize * 2, y);
        g.lineTo(x + tileSize, y);
        g.closePath();
      } else {
        g.moveTo(x, y + tileSize);
        g.lineTo(x + tileSize, y);
        g.lineTo(x + tileSize, y + tileSize * 2);
        g.lineTo(x, y + tileSize);
        g.closePath();
      }
      g.endFill();
    }
  }
  g.lineStyle(0.5, PALETTE.darkWood, 0.2);
  for (let row = 0; row <= Math.ceil(h / tileSize); row++) {
    g.moveTo(0, row * tileSize);
    g.lineTo(w, row * tileSize);
  }
  for (let col = 0; col <= Math.ceil(w / tileSize); col++) {
    g.moveTo(col * tileSize, 0);
    g.lineTo(col * tileSize, h);
  }
  g.lineStyle(0);
}

function drawMarbleFloor(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.marbleWhite);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const tileSize = 48;
  for (let row = 0; row < Math.ceil(h / tileSize); row++) {
    for (let col = 0; col < Math.ceil(w / tileSize); col++) {
      const x = col * tileSize;
      const y = row * tileSize;
      g.beginFill(PALETTE.marbleWhite, 0.9);
      g.drawRect(x, y, tileSize, tileSize);
      g.endFill();
      g.lineStyle(1, PALETTE.marbleVein, 0.35);
      const seed = (row * 7 + col * 13) % 5;
      g.moveTo(x + 5 + seed * 4, y + 3);
      g.bezierCurveTo(
        x + tileSize * 0.3, y + tileSize * 0.2 + seed,
        x + tileSize * 0.6, y + tileSize * 0.5 - seed * 2,
        x + tileSize - 8 + seed, y + tileSize - 5
      );
      g.moveTo(x + tileSize * 0.5 + seed, y + 10);
      g.bezierCurveTo(
        x + tileSize * 0.7, y + tileSize * 0.4,
        x + tileSize * 0.3, y + tileSize * 0.7,
        x + tileSize * 0.8 - seed, y + tileSize - 10
      );
      g.lineStyle(0);
      g.beginFill(0xffffff, 0.12);
      g.drawRect(x + 2, y + 2, tileSize * 0.4, tileSize * 0.15);
      g.endFill();
      g.lineStyle(0.5, PALETTE.marbleVein, 0.5);
      g.drawRect(x, y, tileSize, tileSize);
      g.lineStyle(0);
    }
  }
}

function drawConcreteFloor(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.concrete);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const patchSize = 64;
  for (let row = 0; row < Math.ceil(h / patchSize); row++) {
    for (let col = 0; col < Math.ceil(w / patchSize); col++) {
      const x = col * patchSize;
      const y = row * patchSize;
      const shade = row % 2 === col % 2 ? 0.03 : 0;
      g.beginFill(PALETTE.concrete, 1 - shade);
      g.drawRect(x, y, patchSize, patchSize);
      g.endFill();
      g.lineStyle(0.5, PALETTE.concreteCrack, 0.3);
      g.drawRect(x, y, patchSize, patchSize);
      g.lineStyle(0);
    }
  }
  g.lineStyle(0.8, PALETTE.concreteCrack, 0.4);
  g.moveTo(w * 0.15, 0);
  g.lineTo(w * 0.18, h * 0.3);
  g.lineTo(w * 0.14, h * 0.6);
  g.lineTo(w * 0.16, h);
  g.moveTo(w * 0.7, 0);
  g.lineTo(w * 0.72, h * 0.15);
  g.lineTo(w * 0.68, h * 0.45);
  g.lineStyle(0);
  const grateX = w * 0.5 - 12;
  const grateY = h * 0.85;
  g.beginFill(PALETTE.concreteGrate);
  g.drawRect(grateX, grateY, 24, 24);
  g.endFill();
  g.lineStyle(1.5, PALETTE.concreteCrack, 0.6);
  for (let i = 0; i < 5; i++) {
    g.moveTo(grateX + 3 + i * 5, grateY + 2);
    g.lineTo(grateX + 3 + i * 5, grateY + 22);
  }
  for (let j = 0; j < 5; j++) {
    g.moveTo(grateX + 2, grateY + 3 + j * 5);
    g.lineTo(grateX + 22, grateY + 3 + j * 5);
  }
  g.lineStyle(0);
}

function drawCarpetDiamond(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.carpetNavy);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const tileSize = 20;
  for (let row = 0; row < Math.ceil(h / tileSize); row++) {
    for (let col = 0; col < Math.ceil(w / tileSize); col++) {
      const cx = col * tileSize + tileSize / 2;
      const cy = row * tileSize + tileSize / 2;
      const isCenter = (row + col) % 3 === 0;
      if (isCenter) {
        g.beginFill(PALETTE.carpetGold, 0.35);
        g.moveTo(cx, cy - tileSize * 0.35);
        g.lineTo(cx + tileSize * 0.35, cy);
        g.lineTo(cx, cy + tileSize * 0.35);
        g.lineTo(cx - tileSize * 0.35, cy);
        g.closePath();
        g.endFill();
      }
    }
  }
  drawCarpetBorder(g, w, h, PALETTE.carpetGold);
}

function drawCarpetChevron(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.carpetNavy);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const vSpace = 14;
  const hSpace = 20;
  for (let row = 0; row < Math.ceil(h / vSpace); row++) {
    for (let col = -1; col < Math.ceil(w / hSpace) + 1; col++) {
      const x = col * hSpace + (row % 2 ? hSpace / 2 : 0);
      const y = row * vSpace;
      g.beginFill(PALETTE.carpetGold, 0.25);
      g.moveTo(x, y);
      g.lineTo(x + hSpace / 2, y + vSpace / 2);
      g.lineTo(x + hSpace, y);
      g.lineTo(x + hSpace - hSpace / 4, y - vSpace * 0.1);
      g.lineTo(x + hSpace / 2, y + vSpace * 0.3);
      g.lineTo(x + hSpace / 4, y - vSpace * 0.1);
      g.closePath();
      g.endFill();
    }
  }
  drawCarpetBorder(g, w, h, PALETTE.carpetGold);
}

function drawCarpetArtDeco(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.darkBase);
  g.drawRect(0, 0, w, h);
  g.endFill();
  g.beginFill(PALETTE.darkAlt, 0.7);
  g.drawRect(8, 8, w - 16, h - 16);
  g.endFill();
  const borderW = 14;
  g.beginFill(PALETTE.gold, 0.25);
  g.drawRect(borderW, borderW, w - borderW * 2, borderW);
  g.drawRect(borderW, h - borderW * 2, w - borderW * 2, borderW);
  g.drawRect(borderW, borderW, borderW, h - borderW * 2);
  g.drawRect(w - borderW * 2, borderW, borderW, h - borderW * 2);
  g.endFill();
  g.lineStyle(1, PALETTE.gold, 0.4);
  g.drawRect(borderW + 2, borderW + 2, w - borderW * 2 - 4, h - borderW * 2 - 4);
  g.lineStyle(0);
  const innerMargin = borderW + 6;
  const centerX = w / 2;
  const centerY = h / 2;
  g.lineStyle(1, PALETTE.gold, 0.3);
  g.moveTo(innerMargin, innerMargin);
  g.lineTo(centerX, centerY);
  g.lineTo(w - innerMargin, innerMargin);
  g.moveTo(innerMargin, h - innerMargin);
  g.lineTo(centerX, centerY);
  g.lineTo(w - innerMargin, h - innerMargin);
  g.moveTo(centerX - 8, innerMargin);
  g.lineTo(centerX - 8, h - innerMargin);
  g.moveTo(centerX + 8, innerMargin);
  g.lineTo(centerX + 8, h - innerMargin);
  g.lineStyle(0);
  g.beginFill(PALETTE.gold, 0.15);
  g.drawCircle(centerX, centerY, 12);
  g.endFill();
}

function drawTatamiFloor(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.tatamiGreen);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const matW = 60;
  const matH = 30;
  for (let row = 0; row < Math.ceil(h / matH); row++) {
    for (let col = 0; col < Math.ceil(w / matW); col++) {
      const x = col * matW + (row % 2 ? matW / 2 : 0);
      const y = row * matH;
      if (x > w || y > h) continue;
      const mw = Math.min(matW, w - x);
      const mh = Math.min(matH, h - y);
      g.beginFill(PALETTE.tatamiGreen, row % 2 === 0 ? 1 : 0.92);
      g.drawRect(x + 1, y + 1, mw - 2, mh - 2);
      g.endFill();
      g.lineStyle(0.8, PALETTE.tatamiBorder, 0.6);
      g.drawRect(x, y, mw, mh);
      g.lineStyle(0.3, PALETTE.tatamiBorder, 0.2);
      for (let li = 0; li < 3; li++) {
        const lx = x + 6 + li * (mw / 4);
        g.moveTo(lx, y + 2);
        g.lineTo(lx, y + mh - 2);
      }
      g.lineStyle(0);
    }
  }
}

function drawMetalGrateFloor(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.metalDark);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const plateW = 48;
  const plateH = 48;
  for (let row = 0; row < Math.ceil(h / plateH); row++) {
    for (let col = 0; col < Math.ceil(w / plateW); col++) {
      const x = col * plateW;
      const y = row * plateH;
      g.beginFill(PALETTE.metalLight, 0.15);
      g.drawRect(x + 1, y + 1, plateW - 2, plateH - 2);
      g.endFill();
      g.lineStyle(0.5, PALETTE.metalLight, 0.3);
      g.drawRect(x, y, plateW, plateH);
      g.moveTo(x + plateW * 0.3, y);
      g.lineTo(x + plateW * 0.3, y + plateH);
      g.moveTo(x + plateW * 0.7, y);
      g.lineTo(x + plateW * 0.7, y + plateH);
      g.moveTo(x, y + plateH * 0.5);
      g.lineTo(x + plateW, y + plateH * 0.5);
      g.lineStyle(0);
      g.beginFill(PALETTE.metalDark, 0.4);
      g.drawCircle(x + plateW / 2, y + 4, 2);
      g.drawCircle(x + plateW / 2, y + plateH - 4, 2);
      g.endFill();
    }
  }
  const drainX = w * 0.8;
  const drainY = h * 0.9;
  g.beginFill(PALETTE.concreteGrate);
  g.drawRoundedRect(drainX - 10, drainY - 10, 20, 20, 2);
  g.endFill();
  g.lineStyle(1, PALETTE.metalLight, 0.4);
  for (let i = 0; i < 4; i++) {
    g.moveTo(drainX - 8 + i * 5, drainY - 8);
    g.lineTo(drainX - 8 + i * 5, drainY + 8);
  }
  g.lineStyle(0);
}

function drawCarpetBorder(g: PIXI.Graphics, w: number, h: number, color: number): void {
  const bw = 6;
  g.beginFill(color, 0.2);
  g.drawRect(0, 0, w, bw);
  g.drawRect(0, h - bw, w, bw);
  g.drawRect(0, 0, bw, h);
  g.drawRect(w - bw, 0, bw, h);
  g.endFill();
  g.lineStyle(0.5, color, 0.3);
  g.drawRect(bw, bw, w - bw * 2, h - bw * 2);
  g.lineStyle(0);
}

// ════════════════════════════════════════════════════════════════
// PROCEDURAL WALL DRAWING
// ════════════════════════════════════════════════════════════════

export type WallStyle =
  | 'wainscoting' | 'crown-molding' | 'chair-rail'
  | 'accent-stripes' | 'exposed-brick' | 'glass-partition'
  | 'shoji' | 'dark-paneling' | 'space-panel';

export interface WallDrawOptions {
  baseColor?: number;
  accentColor?: number;
  trimColor?: number;
}

export function drawStylishWalls(
  g: PIXI.Graphics,
  width: number,
  height: number,
  style: WallStyle,
  opts: WallDrawOptions = {}
): void {
  const base = opts.baseColor ?? PALETTE.warmWhite;
  const accent = opts.accentColor ?? PALETTE.gold;
  const trim = opts.trimColor ?? PALETTE.darkWood;

  switch (style) {
    case 'wainscoting':
      drawWainscoting(g, width, height, base, trim);
      break;
    case 'crown-molding':
      drawCrownMolding(g, width, height, base, trim);
      break;
    case 'chair-rail':
      drawChairRail(g, width, height, base, trim);
      break;
    case 'accent-stripes':
      drawAccentStripes(g, width, height, base, accent);
      break;
    case 'exposed-brick':
      drawExposedBrick(g, width, height);
      break;
    case 'glass-partition':
      drawGlassPartition(g, width, height);
      break;
    case 'shoji':
      drawShojiWalls(g, width, height);
      break;
    case 'dark-paneling':
      drawDarkPaneling(g, width, height, base, trim);
      break;
    case 'space-panel':
      drawSpacePanelWalls(g, width, height);
      break;
  }
}

function drawWainscoting(g: PIXI.Graphics, w: number, h: number, base: number, trim: number): void {
  g.beginFill(base);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const panelH = h * 0.35;
  g.beginFill(trim, 0.15);
  g.drawRect(0, h - panelH, w, panelH);
  g.endFill();
  g.lineStyle(1, trim, 0.5);
  const panelW = 40;
  for (let x = 0; x < w; x += panelW) {
    g.drawRect(x + 2, h - panelH + 4, panelW - 4, panelH - 8);
  }
  g.lineStyle(2, trim, 0.6);
  g.moveTo(0, h - panelH);
  g.lineTo(w, h - panelH);
  g.lineStyle(0);
  g.beginFill(trim, 0.35);
  g.drawRect(0, h - 4, w, 4);
  g.endFill();
  g.beginFill(trim, 0.2);
  g.drawRect(0, 0, w, 3);
  g.endFill();
}

function drawCrownMolding(g: PIXI.Graphics, w: number, h: number, base: number, trim: number): void {
  g.beginFill(base);
  g.drawRect(0, 0, w, h);
  g.endFill();
  g.beginFill(trim, 0.4);
  g.drawRect(0, 0, w, 6);
  g.endFill();
  g.beginFill(trim, 0.25);
  g.drawPolygon([0, 6, w, 6, w, 10, 0, 10]);
  g.endFill();
  g.beginFill(trim, 0.3);
  g.drawRect(0, h - 5, w, 5);
  g.endFill();
  g.lineStyle(0.5, trim, 0.2);
  g.moveTo(0, 6);
  g.lineTo(w, 6);
  g.moveTo(0, 10);
  g.lineTo(w, 10);
  g.moveTo(0, h - 5);
  g.lineTo(w, h - 5);
  g.lineStyle(0);
}

function drawChairRail(g: PIXI.Graphics, w: number, h: number, base: number, trim: number): void {
  g.beginFill(base);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const railY = h * 0.33;
  g.beginFill(trim, 0.3);
  g.drawRect(0, railY - 3, w, 6);
  g.endFill();
  g.beginFill(0x000000, 0.08);
  g.drawRect(0, railY + 3, w, 2);
  g.endFill();
  g.beginFill(trim, 0.15);
  g.drawRect(0, 0, w, railY - 3);
  g.endFill();
  g.beginFill(trim, 0.35);
  g.drawRect(0, h - 4, w, 4);
  g.endFill();
}

function drawAccentStripes(g: PIXI.Graphics, w: number, h: number, base: number, accent: number): void {
  g.beginFill(base);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const stripeW = 30;
  for (let x = 0; x < w; x += stripeW * 2) {
    g.beginFill(accent, 0.12);
    g.drawRect(x, 0, stripeW, h);
    g.endFill();
  }
  g.beginFill(accent, 0.2);
  g.drawRect(0, 0, w, 3);
  g.drawRect(0, h - 4, w, 4);
  g.endFill();
}

function drawExposedBrick(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.mortar);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const brickW = 22;
  const brickH = 10;
  for (let row = 0; row < Math.ceil(h / brickH); row++) {
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let col = -1; col < Math.ceil(w / brickW) + 1; col++) {
      const x = col * brickW + offset;
      const y = row * brickH;
      const shade = (row * 3 + col * 7) % 5;
      const brickColor = shade < 2 ? PALETTE.brick : shade < 4 ? PALETTE.brickDark : PALETTE.brick;
      g.beginFill(brickColor, 0.85 + shade * 0.03);
      g.drawRect(x + 0.5, y + 0.5, brickW - 1, brickH - 1);
      g.endFill();
    }
  }
  g.beginFill(0x000000, 0.2);
  g.drawRect(0, 0, w, 2);
  g.endFill();
}

function drawGlassPartition(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.glass, 0.12);
  g.drawRect(0, 0, w, h);
  g.endFill();
  g.lineStyle(2, PALETTE.glassFrame, 0.8);
  g.drawRect(1, 1, w - 2, h - 2);
  const paneH = h / 3;
  for (let i = 1; i < 3; i++) {
    g.moveTo(0, paneH * i);
    g.lineTo(w, paneH * i);
  }
  g.lineStyle(1, PALETTE.glassFrame, 0.3);
  g.moveTo(w / 2, 0);
  g.lineTo(w / 2, h);
  g.lineStyle(0);
  g.beginFill(0xffffff, 0.06);
  g.drawPolygon([w * 0.6, 0, w * 0.8, 0, w * 0.3, h, w * 0.1, h]);
  g.endFill();
}

function drawShojiWalls(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.shojiWhite);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const panelW = 36;
  const panelH = h;
  for (let col = 0; col < Math.ceil(w / panelW); col++) {
    const x = col * panelW;
    g.lineStyle(1.5, PALETTE.bamboo, 0.5);
    g.drawRect(x, 0, panelW, panelH);
    g.moveTo(x + panelW / 2, 0);
    g.lineTo(x + panelW / 2, panelH);
    g.lineStyle(0);
    for (let ry = 0; ry < panelH; ry += panelW / 2) {
      g.lineStyle(0.3, PALETTE.bamboo, 0.2);
      g.moveTo(x, ry);
      g.lineTo(x + panelW, ry);
      g.lineStyle(0);
    }
  }
  g.beginFill(PALETTE.bamboo, 0.15);
  g.drawRect(0, 0, w, 4);
  g.drawRect(0, h - 4, w, 4);
  g.endFill();
}

function drawDarkPaneling(g: PIXI.Graphics, w: number, h: number, base: number, trim: number): void {
  g.beginFill(PALETTE.mahogany, 0.7);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const panelW = 50;
  for (let col = 0; col < Math.ceil(w / panelW); col++) {
    const x = col * panelW;
    g.beginFill(PALETTE.darkWood, 0.6);
    g.drawRect(x + 3, 8, panelW - 6, h - 16);
    g.endFill();
    g.lineStyle(1, PALETTE.mahogany, 0.5);
    g.drawRect(x + 3, 8, panelW - 6, h - 16);
    g.lineStyle(0);
  }
  g.beginFill(trim, 0.4);
  g.drawRect(0, 0, w, 8);
  g.drawRect(0, h - 8, w, 8);
  g.endFill();
  g.lineStyle(0.5, PALETTE.gold, 0.3);
  g.moveTo(0, 8);
  g.lineTo(w, 8);
  g.moveTo(0, h - 8);
  g.lineTo(w, h - 8);
  g.lineStyle(0);
}

function drawSpacePanelWalls(g: PIXI.Graphics, w: number, h: number): void {
  g.beginFill(PALETTE.spaceDark);
  g.drawRect(0, 0, w, h);
  g.endFill();
  const panelH = 24;
  for (let row = 0; row < Math.ceil(h / panelH); row++) {
    const y = row * panelH;
    g.beginFill(PALETTE.spacePanel, 0.4);
    g.drawRect(0, y, w, panelH - 1);
    g.endFill();
    g.lineStyle(0.5, PALETTE.metalLight, 0.25);
    g.moveTo(0, y + panelH - 1);
    g.lineTo(w, y + panelH - 1);
    g.lineStyle(0);
    for (let led = 0; led < 3; led++) {
      const lx = w * 0.2 + led * w * 0.25;
      g.beginFill(PALETTE.neonCyan, 0.08);
      g.drawRect(lx - 1, y + 2, 2, panelH - 6);
      g.endFill();
    }
  }
  g.lineStyle(1, PALETTE.metalLight, 0.3);
  g.drawRect(0, 0, w, h);
  g.lineStyle(0);
}

// ════════════════════════════════════════════════════════════════
// PROCEDURAL FURNITURE DETAIL OVERLAYS
// ════════════════════════════════════════════════════════════════

export function drawDeskOverlay(g: PIXI.Graphics, x: number, y: number, w: number, h: number): void {
  const keyW = 3;
  const keyH = 3;
  const kbX = x + w * 0.15;
  const kbY = y + h * 0.2;
  g.beginFill(0x333333);
  g.drawRoundedRect(kbX, kbY, w * 0.4, h * 0.35, 1);
  g.endFill();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 8; col++) {
      g.beginFill(0x555555);
      g.drawRect(kbX + 2 + col * (keyW + 1), kbY + 2 + row * (keyH + 1), keyW, keyH);
      g.endFill();
    }
  }
  const mouseX = x + w * 0.65;
  const mouseY = y + h * 0.25;
  g.beginFill(0x444444);
  g.drawEllipse(mouseX, mouseY, w * 0.06, h * 0.12);
  g.endFill();
  g.lineStyle(0.5, 0x666666);
  g.moveTo(mouseX, mouseY - h * 0.1);
  g.lineTo(mouseX, mouseY + h * 0.08);
  g.lineStyle(0);
  const noteX = x + w * 0.1;
  const noteY = y + h * 0.65;
  g.beginFill(0xffffff, 0.9);
  g.drawRect(noteX, noteY, w * 0.18, h * 0.25);
  g.endFill();
  g.lineStyle(0.4, 0xcccccc);
  for (let li = 0; li < 4; li++) {
    g.moveTo(noteX + 2, noteY + 3 + li * 4);
    g.lineTo(noteX + w * 0.18 - 2, noteY + 3 + li * 4);
  }
  g.lineStyle(0);
  const phX = x + w * 0.82;
  const phY = y + h * 0.3;
  g.beginFill(0x777777);
  g.drawRect(phX - 3, phY, 6, h * 0.35);
  g.endFill();
  g.beginFill(0x999999);
  g.drawEllipse(phX, phY, 4, 3);
  g.endFill();
  g.beginFill(0xcc3333, 0.8);
  g.drawRect(phX - 1, phY + h * 0.15, 2, h * 0.05);
  g.endFill();
  g.beginFill(0x3366cc, 0.8);
  g.drawRect(phX, phY + h * 0.22, 2, h * 0.05);
  g.endFill();
  const glowX = x + w * 0.3;
  const glowY = y - h * 0.05;
  g.beginFill(PALETTE.teal, 0.08);
  g.drawRoundedRect(glowX, glowY, w * 0.25, h * 0.4, 3);
  g.endFill();
  g.beginFill(PALETTE.teal, 0.04);
  g.drawRoundedRect(glowX - 3, glowY - 3, w * 0.25 + 6, h * 0.4 + 6, 4);
  g.endFill();
}

export function drawShelfDetail(g: PIXI.Graphics, x: number, y: number, w: number, h: number): void {
  const shelfCount = 3;
  const shelfH = h / shelfCount;
  const spineW = 3;
  const bookColors = [0xc0392b, 0x2980b9, 0x27ae60, 0x8e44ad, 0xd4af37, 0xe67e22];
  for (let s = 0; s < shelfCount; s++) {
    const sy = y + s * shelfH;
    const bookCount = 4 + (s % 3);
    for (let b = 0; b < bookCount; b++) {
      const bx = x + 3 + b * (spineW + 1);
      const bookH = shelfH * (0.5 + (b % 3) * 0.12);
      g.beginFill(bookColors[(s * 3 + b) % bookColors.length], 0.85);
      g.drawRect(bx, sy + shelfH - bookH - 2, spineW, bookH);
      g.endFill();
    }
    if (s === 1) {
      g.beginFill(PALETTE.gold, 0.4);
      g.drawCircle(x + w * 0.75, sy + shelfH * 0.6, 2);
      g.endFill();
    }
    if (s === 0) {
      g.beginFill(0xffffff, 0.7);
      g.drawRect(x + w * 0.6, sy + 3, w * 0.12, h * 0.08);
      g.endFill();
      g.lineStyle(0.3, PALETTE.darkWood, 0.5);
      g.drawRect(x + w * 0.6, sy + 3, w * 0.12, h * 0.08);
      g.lineStyle(0);
    }
  }
  g.beginFill(0x333333, 0.3);
  g.drawRect(x + 2, y + h - 3, w - 4, 2);
  g.endFill();
}

export function drawPlantDetail(g: PIXI.Graphics, x: number, y: number, w: number, h: number): void {
  const potTop = y + h * 0.65;
  const potBottom = y + h;
  g.beginFill(PALETTE.darkWood, 0.7);
  g.drawPolygon([
    x + w * 0.2, potTop,
    x + w * 0.8, potTop,
    x + w * 0.7, potBottom,
    x + w * 0.3, potBottom,
  ]);
  g.endFill();
  g.beginFill(PALETTE.darkWood, 0.5);
  g.drawRect(x + w * 0.15, potTop - 2, w * 0.7, 3);
  g.endFill();
  g.beginFill(PALETTE.darkWood, 0.3);
  g.drawRect(x + w * 0.25, potBottom - 3, w * 0.5, 3);
  g.endFill();
  g.beginFill(0x3d2b1f, 0.6);
  g.drawRect(x + w * 0.22, potTop, w * 0.56, 3);
  g.endFill();
  g.beginFill(0x88ccff, 0.25);
  g.drawEllipse(x + w * 0.55, potTop + 3, 2, 1.5);
  g.endFill();
  g.beginFill(0xffffff, 0.2);
  g.drawEllipse(x + w * 0.45, potTop + 2, 1.5, 1);
  g.endFill();
}

export function drawCoffeeStationDetail(g: PIXI.Graphics, x: number, y: number): void {
  const mw = 30;
  const mh = 25;
  g.beginFill(0x444444);
  g.drawRect(x, y, mw, mh);
  g.endFill();
  g.beginFill(0x222222);
  g.drawRect(x + 2, y + 2, mw - 4, mh * 0.35);
  g.endFill();
  g.beginFill(PALETTE.neonCyan, 0.4);
  g.drawCircle(x + mw * 0.25, y + mh * 0.22, 1.5);
  g.endFill();
  g.beginFill(PALETTE.emergencyRed, 0.4);
  g.drawCircle(x + mw * 0.55, y + mh * 0.22, 1.5);
  g.endFill();
  g.beginFill(0x666666);
  g.drawRect(x + mw * 0.7, y + mh * 0.5, mw * 0.2, mh * 0.35);
  g.endFill();
  g.beginFill(0xeeeeee);
  g.drawRect(x + mw * 0.72, y + mh * 0.55, mw * 0.16, mh * 0.08);
  g.endFill();
  const mugX = x + mw + 5;
  const mugW = 6;
  const mugH = 7;
  for (let i = 0; i < 3; i++) {
    const my = y + mh - 2 - i * (mugH - 1);
    g.beginFill(0xffffff);
    g.drawRect(mugX, my, mugW, mugH);
    g.endFill();
    g.lineStyle(0.4, PALETTE.metalLight, 0.5);
    g.drawRect(mugX, my, mugW, mugH);
    g.lineStyle(0);
  }
  const plateX = mugX + mugW + 4;
  g.beginFill(0xdddddd);
  g.drawEllipse(plateX + 5, y + mh - 2, 7, 3);
  g.endFill();
  g.beginFill(0xd4a56a, 0.7);
  g.drawCircle(plateX + 3, y + mh - 4, 2);
  g.drawCircle(plateX + 6, y + mh - 4, 2.2);
  g.drawCircle(plateX + 4.5, y + mh - 5, 1.8);
  g.endFill();
}

// ════════════════════════════════════════════════════════════════
// PROCEDURAL ROOM AMBIANCE
// ════════════════════════════════════════════════════════════════

export interface DustParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

export interface AmbianceState {
  dustParticles: DustParticle[];
}

export function drawRoomAmbiance(
  g: PIXI.Graphics,
  width: number,
  height: number,
  options: {
    windowX?: number;
    windowY?: number;
    windowW?: number;
    furnitureShadows?: Array<{ x: number; y: number; w: number; h: number }>;
    dustParticles?: DustParticle[];
  } = {}
): AmbianceState {
  const winX = options.windowX ?? width * 0.7;
  const winY = options.windowY ?? 0;
  const winW = options.windowW ?? 40;

  g.beginFill(0xffffcc, 0.04);
  g.moveTo(winX, winY);
  g.lineTo(winX + winW, winY);
  g.lineTo(winX + winW + 30, height);
  g.lineTo(winX - 30, height);
  g.closePath();
  g.endFill();
  g.beginFill(0xffffcc, 0.02);
  g.moveTo(winX - 10, winY);
  g.lineTo(winX + winW + 10, winY);
  g.lineTo(winX + winW + 50, height);
  g.lineTo(winX - 50, height);
  g.closePath();
  g.endFill();

  const shadows = options.furnitureShadows ?? [
    { x: width * 0.3, y: height * 0.6, w: 50, h: 15 },
    { x: width * 0.6, y: height * 0.4, w: 30, h: 10 },
  ];
  for (const shadow of shadows) {
    g.beginFill(0x000000, 0.08);
    g.drawEllipse(shadow.x + shadow.w / 2, shadow.y + shadow.h, shadow.w / 2, shadow.h / 2);
    g.endFill();
  }

  const particles = options.dustParticles ?? generateDustParticles(width, height, 12);
  for (const p of particles) {
    g.beginFill(0xffffff, p.alpha);
    g.drawCircle(p.x, p.y, p.size);
    g.endFill();
  }

  g.lineStyle(0.8, 0xffffcc, 0.06);
  g.moveTo(winX, winY + 10);
  g.lineTo(winX + 8, height * 0.5);
  g.moveTo(winX + winW, winY + 10);
  g.lineTo(winX + winW - 8, height * 0.5);
  g.lineStyle(0);

  return { dustParticles: particles };
}

export function generateDustParticles(w: number, h: number, count: number): DustParticle[] {
  const particles: DustParticle[] = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.15 - 0.05,
      size: 0.5 + Math.random() * 1,
      alpha: 0.1 + Math.random() * 0.2,
    });
  }
  return particles;
}

export function updateDustParticles(particles: DustParticle[], w: number, h: number): DustParticle[] {
  return particles.map(p => {
    let nx = p.x + p.vx;
    let ny = p.y + p.vy;
    if (nx < 0) nx = w;
    if (nx > w) nx = 0;
    if (ny < 0) ny = h;
    if (ny > h) ny = 0;
    return { ...p, x: nx, y: ny };
  });
}

// ════════════════════════════════════════════════════════════════
// PROCEDURAL ROOM COMPOSITOR
// ════════════════════════════════════════════════════════════════

export interface ProceduralRoomConfig {
  floorStyle: FloorStyle;
  wallStyle: WallStyle;
  wallOpts?: WallDrawOptions;
  ambiance?: boolean;
}

export function createProceduralRoomContainer(
  width: number,
  height: number,
  config: ProceduralRoomConfig,
  renderer?: PIXI.Renderer
): PIXI.Container {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  const floorG = new PIXI.Graphics();
  drawStylishFloor(floorG, width, height, config.floorStyle);
  if (renderer) {
    const floorTex = renderer.generateTexture(floorG);
    const floorSprite = new PIXI.Sprite(floorTex);
    floorSprite.zIndex = 0;
    container.addChild(floorSprite);
  } else {
    floorG.zIndex = 0;
    container.addChild(floorG);
  }

  const wallG = new PIXI.Graphics();
  drawStylishWalls(wallG, width, height * 0.4, config.wallStyle, config.wallOpts);
  if (renderer) {
    const wallTex = renderer.generateTexture(wallG);
    const wallSprite = new PIXI.Sprite(wallTex);
    wallSprite.position.set(0, 0);
    wallSprite.zIndex = -1;
    container.addChild(wallSprite);
    wallG.destroy();
  } else {
    wallG.zIndex = -1;
    container.addChild(wallG);
  }

  if (config.ambiance) {
    const ambG = new PIXI.Graphics();
    drawRoomAmbiance(ambG, width, height);
    if (renderer) {
      const ambTex = renderer.generateTexture(ambG);
      const ambSprite = new PIXI.Sprite(ambTex);
      ambSprite.zIndex = 50;
      container.addChild(ambSprite);
      ambG.destroy();
    } else {
      ambG.zIndex = 50;
      container.addChild(ambG);
    }
  }

  return container;
}

export function createProceduralRoomGraphics(
  width: number,
  height: number,
  config: ProceduralRoomConfig
): PIXI.Container {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  const floorLayer = new PIXI.Graphics();
  drawStylishFloor(floorLayer, width, height, config.floorStyle);
  floorLayer.zIndex = 0;
  container.addChild(floorLayer);

  const wallLayer = new PIXI.Graphics();
  drawStylishWalls(wallLayer, width, height * 0.4, config.wallStyle, config.wallOpts);
  wallLayer.zIndex = -1;
  container.addChild(wallLayer);

  if (config.ambiance) {
    const ambLayer = new PIXI.Graphics();
    drawRoomAmbiance(ambLayer, width, height);
    ambLayer.zIndex = 50;
    container.addChild(ambLayer);
  }

  return container;
}
