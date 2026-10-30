/**
 * Agentic Overlay System — typed records + validators.
 *
 * Shared contract for the `<agent-overlay-layer>` host (frontend) and the
 * `ui.overlay.*` gateway RPCs (backend). This module is the single source of
 * truth for the {@link OverlayRecord} shape and the set of card types the
 * system understands. It is pure (no I/O) so it can be imported from both the
 * gateway handlers and unit tests without side effects.
 *
 * See `.scratch/overlay-spec.md` §2/§3 for the full design.
 */

/** Rectangle anchor for a free-floating overlay card, in page CSS pixels. */
export interface OverlayPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One overlay card as persisted + broadcast. Matches the wire contract in
 * spec §3 exactly: `{overlayId, type, payload, position, createdAt, ttlMs}`.
 * `anchor` is an additive optional field (a CSS selector / named slot the
 * frontend may pin the card to); clients that don't understand it ignore it.
 */
export interface OverlayRecord {
  overlayId: string;
  type: string;
  payload: Record<string, unknown>;
  position: OverlayPosition;
  anchor: string | null;
  createdAt: number;
  ttlMs: number | null;
}

/**
 * The initial card-type set (spec §2). Spawning an unknown type is rejected
 * with a clear error so typos surface immediately rather than rendering an
 * empty card. `highlight` is intentionally NOT here — it is an effect driven
 * by `highlightText`/`clearHighlight`, not a spawnable card.
 */
export const OVERLAY_TYPES = [
  // Text / agent
  "note",
  "task",
  "project",
  "portfolio",
  "markdown",
  "pdf",
  "diagram",
  "code",
  "image",
  // Live system
  "running-agents",
  "workflow",
  // Business
  "revenue",
  "client",
  "clients-list",
  "credit-usage",
  "hardware",
] as const;

export type OverlayType = (typeof OVERLAY_TYPES)[number];

const OVERLAY_TYPE_SET = new Set<string>(OVERLAY_TYPES);

export function isOverlayType(t: unknown): t is OverlayType {
  return typeof t === "string" && OVERLAY_TYPE_SET.has(t);
}

/** Default card box used when the caller omits some/all position fields. */
export const DEFAULT_OVERLAY_POSITION: OverlayPosition = { x: 24, y: 24, w: 380, h: 280 };

/** Hard ceiling on a card box so a bad value can't paint off-screen forever. */
const MAX_DIMENSION = 10_000;

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Coerce an arbitrary position-ish input into a valid {@link OverlayPosition}.
 * Missing fields fall back to {@link DEFAULT_OVERLAY_POSITION}; width/height
 * are clamped to a sane positive range.
 */
export function normalizePosition(input: unknown): OverlayPosition {
  const p = (input ?? {}) as Partial<OverlayPosition>;
  return {
    x: clampNum(p.x, DEFAULT_OVERLAY_POSITION.x, -MAX_DIMENSION, MAX_DIMENSION),
    y: clampNum(p.y, DEFAULT_OVERLAY_POSITION.y, -MAX_DIMENSION, MAX_DIMENSION),
    w: clampNum(p.w, DEFAULT_OVERLAY_POSITION.w, 1, MAX_DIMENSION),
    h: clampNum(p.h, DEFAULT_OVERLAY_POSITION.h, 1, MAX_DIMENSION),
  };
}

export class OverlayValidationError extends Error {
  readonly code = "INVALID_PARAMS";
  constructor(message: string) {
    super(message);
    this.name = "OverlayValidationError";
  }
}

export interface SpawnInput {
  type: string;
  payload?: unknown;
  anchor?: unknown;
  position?: unknown;
  ttlMs?: unknown;
}

export interface NormalizedSpawn {
  type: OverlayType;
  payload: Record<string, unknown>;
  anchor: string | null;
  position: OverlayPosition;
  ttlMs: number | null;
}

function asPayload(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new OverlayValidationError("payload must be an object");
  }
  return input as Record<string, unknown>;
}

function asTtl(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new OverlayValidationError("ttlMs must be a positive number of milliseconds");
  }
  if (input <= 0) return null;
  return Math.trunc(input);
}

function asAnchor(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "string") {
    throw new OverlayValidationError("anchor must be a CSS selector / slot string");
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

/**
 * Validate + normalize a `ui.overlay.spawn` payload. Throws
 * {@link OverlayValidationError} (code `INVALID_PARAMS`) on bad input so the
 * RPC layer can map it to a clean error response.
 */
export function validateSpawn(input: SpawnInput): NormalizedSpawn {
  if (!input || typeof input !== "object") {
    throw new OverlayValidationError("spawn requires an object body");
  }
  if (!isOverlayType(input.type)) {
    throw new OverlayValidationError(
      `unknown overlay type: ${JSON.stringify(input.type)} — must be one of ${OVERLAY_TYPES.join(", ")}`,
    );
  }
  return {
    type: input.type,
    payload: asPayload(input.payload),
    anchor: asAnchor(input.anchor),
    position: normalizePosition(input.position),
    ttlMs: asTtl(input.ttlMs),
  };
}

export interface UpdateInput {
  payload?: unknown;
  position?: unknown;
}

export interface NormalizedUpdate {
  payload?: Record<string, unknown>;
  position?: OverlayPosition;
}

/**
 * Validate a `ui.overlay.update` patch. Only the provided fields are returned
 * (so the store can do a partial merge). At least one of payload/position
 * should be present, but an empty patch is tolerated as a no-op touch.
 */
export function validateUpdate(input: UpdateInput): NormalizedUpdate {
  const out: NormalizedUpdate = {};
  if (input?.payload !== undefined) out.payload = asPayload(input.payload);
  if (input?.position !== undefined) out.position = normalizePosition(input.position);
  return out;
}

/** True once a TTL'd overlay has outlived `createdAt + ttlMs`. */
export function isExpired(record: OverlayRecord, now: number): boolean {
  return record.ttlMs != null && record.createdAt + record.ttlMs <= now;
}
