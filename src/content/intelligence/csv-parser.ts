/**
 * Meta Business Suite CSV parser.
 *
 * Handles the Instagram CSV export format where columns may appear in
 * different orders depending on the date range (older exports omit
 * `Views`; the 2023–2024 file has no Views column, 2025+ files do).
 *
 * The parser is header-driven: it reads the first line, maps quoted
 * column names to an index, and then extracts values by header name.
 * This makes it resilient to column reordering.
 */

import type { ParsedMetaRow } from "./types.js";

/** Strip surrounding double quotes and trim. */
function unquote(v: string): string {
  let s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  // CSV double-escaping: "" → "
  return s.replace(/""/g, '"');
}

/**
 * Parse a single CSV line that may contain quoted fields with embedded
 * commas and newlines. This is a minimal RFC-4180-ish splitter — enough
 * for Meta's well-formed exports.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse a multi-line CSV string that may contain embedded newlines
 * inside quoted fields. Returns an array of raw row arrays (no
 * header-stripping).
 */
function parseCsvText(text: string): string[][] {
  // Normalise line endings
  const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          current += '""';
          i++;
        } else {
          inQuotes = false;
          current += ch;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        current += ch;
      } else if (ch === "\n") {
        rows.push(splitCsvLine(current));
        current = "";
      } else {
        current += ch;
      }
    }
  }
  // Last line (if non-empty)
  if (current.trim().length > 0) {
    rows.push(splitCsvLine(current));
  }

  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

/** Parse a number field, treating empty / "Lifetime" / non-numeric as null. */
function parseNum(v: string): number | null {
  if (!v) return null;
  const s = v.trim();
  if (!s || s === "Lifetime" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Map of normalised header → canonical field key. */
const HEADER_MAP: Record<string, string> = {
  "post id": "postId",
  "account id": "accountId",
  "account username": "accountUsername",
  "account name": "accountName",
  description: "description",
  "duration (sec)": "durationSec",
  "publish time": "publishTime",
  permalink: "permalink",
  "post type": "postType",
  "data comment": "dataComment",
  date: "date",
  views: "views",
  reach: "reach",
  likes: "likes",
  shares: "shares",
  follows: "follows",
  comments: "comments",
  saves: "saves",
};

/**
 * Parse a Meta CSV string into {@link ParsedMetaRow}[].
 *
 * - Strips the BOM if present.
 * - Maps columns by header name (resilient to reordering).
 * - Skips rows that are entirely blank.
 */
export function parseMetaCsv(csvText: string): ParsedMetaRow[] {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows = parseCsvText(text);
  if (rows.length < 2) return [];

  const headerRow = rows[0].map((h) => unquote(h).toLowerCase().trim());
  const colIndex: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const canonical = HEADER_MAP[headerRow[i]];
    if (canonical) colIndex[canonical] = i;
  }

  const result: ParsedMetaRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const fields = rows[r];
    if (!fields || fields.every((f) => !f.trim())) continue;

    const get = (key: string): string => {
      const idx = colIndex[key];
      if (idx === undefined) return "";
      return unquote(fields[idx] ?? "");
    };

    result.push({
      postId: get("postId"),
      accountId: get("accountId"),
      accountUsername: get("accountUsername"),
      accountName: get("accountName"),
      description: get("description"),
      durationSec: parseNum(get("durationSec")),
      publishTime: get("publishTime"),
      permalink: get("permalink"),
      postType: get("postType"),
      views: parseNum(get("views")),
      reach: parseNum(get("reach")),
      likes: parseNum(get("likes")),
      shares: parseNum(get("shares")),
      follows: parseNum(get("follows")),
      comments: parseNum(get("comments")),
      saves: parseNum(get("saves")),
    });
  }

  return result;
}

/**
 * Extract the Instagram shortcode from a permalink URL.
 *
 * Examples:
 *   https://www.instagram.com/reel/DTlDDeiCda9/ → "DTlDDeiCda9"
 *   https://www.instagram.com/p/Cabc123/         → "Cabc123"
 *   /reel/DTlDDeiCda9/                            → "DTlDDeiCda9"
 *
 * Returns `null` if no shortcode can be extracted.
 */
export function parseShortcode(permalink: string): string | null {
  if (!permalink) return null;
  const match = permalink.match(/instagram\.com\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  // Bare path
  const bare = permalink.match(/\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)/);
  return bare ? bare[1] : null;
}
