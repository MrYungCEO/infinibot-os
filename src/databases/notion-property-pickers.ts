/**
 * Smart Notion property pickers — used wherever we extract canonical
 * fields (status / price / tags / etc) from a Notion page whose schema
 * we don't control. Real Notion DBs use whatever names + types their
 * authors happened to pick — "Status" as multi_select, "Price (1)" as
 * rich_text containing "$14.99", "Product Description" instead of
 * "Description". Rigid exact-name + canonical-type pickers silently
 * drop all of that, so these helpers try in order:
 *
 *   1. explicit binding fieldMap entry
 *   2. exact lowercase name match against canonical hints
 *   3. substring match against canonical hints
 *   4. first property whose value satisfies a type predicate
 *
 * Used by: notion-bidirectional-sync.ts (per-role appliers), and
 * anywhere else that needs to coerce arbitrary Notion props into
 * structured fields.
 */

/** Extract a category-style label from select / status / multi_select. */
export function extractCategoryName(p: any): string | undefined {
  if (!p) return undefined;
  if (p.type === "status") return p.status?.name ?? undefined;
  if (p.type === "select") return p.select?.name ?? undefined;
  if (p.type === "multi_select" && Array.isArray(p.multi_select) && p.multi_select.length > 0) {
    return p.multi_select[0].name ?? undefined;
  }
  return undefined;
}

/** Extract a plain-text payload from rich_text / title / url / formula / rollup. */
export function extractPlainText(p: any): string {
  if (!p) return "";
  if (p.type === "rich_text" && Array.isArray(p.rich_text)) {
    return p.rich_text
      .map((r: any) => r?.plain_text ?? "")
      .join("")
      .trim();
  }
  if (p.type === "title" && Array.isArray(p.title)) {
    return p.title
      .map((r: any) => r?.plain_text ?? "")
      .join("")
      .trim();
  }
  if (p.type === "url" && typeof p.url === "string") return p.url;
  if (p.type === "email" && typeof p.email === "string") return p.email;
  if (p.type === "phone_number" && typeof p.phone_number === "string") return p.phone_number;
  if (p.type === "formula") {
    const f = p.formula;
    if (f?.type === "string") return f.string ?? "";
    if (f?.type === "number" && typeof f.number === "number") return String(f.number);
    if (f?.type === "boolean") return f.boolean ? "true" : "false";
    if (f?.type === "date" && f.date?.start) return f.date.start;
  }
  if (p.type === "rollup") {
    const r = p.rollup;
    if (r?.type === "number" && typeof r.number === "number") return String(r.number);
    if (r?.type === "array" && Array.isArray(r.array)) {
      return r.array
        .map((x: any) => extractPlainText(x) || extractCategoryName(x) || "")
        .filter(Boolean)
        .join(", ");
    }
  }
  return "";
}

/** Extract a number from number / rich_text ("$1,299.00") / formula / rollup. */
export function extractNumber(p: any): number | undefined {
  if (!p) return undefined;
  if (p.type === "number" && typeof p.number === "number") return p.number;
  if (
    p.type === "formula" &&
    p.formula?.type === "number" &&
    typeof p.formula.number === "number"
  ) {
    return p.formula.number;
  }
  if (p.type === "rollup" && p.rollup?.type === "number" && typeof p.rollup.number === "number") {
    return p.rollup.number;
  }
  const text = extractPlainText(p);
  if (text) {
    // Match the first numeric token; tolerate $, €, ¥, £, %, commas.
    const m = text.match(/-?\d+(?:[,\d]*)(?:\.\d+)?/);
    if (m) {
      const n = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** Extract a boolean from checkbox / formula(boolean) / coerced strings. */
export function extractBoolean(p: any): boolean | undefined {
  if (!p) return undefined;
  if (p.type === "checkbox") return Boolean(p.checkbox);
  if (p.type === "formula" && p.formula?.type === "boolean") return Boolean(p.formula.boolean);
  const text = extractPlainText(p).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return undefined;
}

/** Extract an ISO date from date / formula(date) / created_time / last_edited_time. */
export function extractDate(p: any): string | undefined {
  if (!p) return undefined;
  if (p.type === "date" && p.date?.start) return p.date.start;
  if (p.type === "formula" && p.formula?.type === "date" && p.formula.date?.start)
    return p.formula.date.start;
  if (p.type === "created_time" && typeof p.created_time === "string") return p.created_time;
  if (p.type === "last_edited_time" && typeof p.last_edited_time === "string")
    return p.last_edited_time;
  return undefined;
}

/** Extract file URLs from a files property. */
export function extractFileUrls(p: any): string[] {
  if (!p || p.type !== "files" || !Array.isArray(p.files)) return [];
  return p.files
    .map((f: any) => f?.external?.url ?? f?.file?.url)
    .filter((u: any): u is string => typeof u === "string" && u.length > 0);
}

/** Extract relation page ids. */
export function extractRelationIds(p: any): string[] {
  if (!p || p.type !== "relation" || !Array.isArray(p.relation)) return [];
  return p.relation
    .map((r: any) => r?.id)
    .filter((id: any): id is string => typeof id === "string" && id.length > 0);
}

/** Extract multi-select option names. */
export function extractMultiSelectNames(p: any): string[] {
  if (!p || p.type !== "multi_select" || !Array.isArray(p.multi_select)) return [];
  return p.multi_select
    .map((o: any) => o?.name)
    .filter((s: any): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Find the first property whose name matches any hint substring
 * (case-insensitive) and optionally satisfies a value predicate.
 * Search order: exact lowercase match → substring match (preferring
 * earlier hints). Returns null if no match.
 */
export function findPropByHints(
  props: Record<string, any>,
  hints: readonly string[],
  predicate?: (p: any) => boolean,
): { name: string; prop: any } | null {
  const lowerHints = hints.map((h) => h.toLowerCase());
  for (const [name, p] of Object.entries(props)) {
    const lname = name.toLowerCase().trim();
    if (lowerHints.includes(lname) && (!predicate || predicate(p))) {
      return { name, prop: p };
    }
  }
  for (const hint of lowerHints) {
    for (const [name, p] of Object.entries(props)) {
      const lname = name.toLowerCase();
      if (lname.includes(hint) && (!predicate || predicate(p))) {
        return { name, prop: p };
      }
    }
  }
  return null;
}

// ── Smart pickers — canonical-field extractors ──────────────────────────

const STATUS_HINTS = ["status", "stage", "state", "pipeline"] as const;
const TYPE_HINTS = ["type", "kind", "format"] as const;
const TAGS_HINTS = ["tags", "labels", "keywords", "categories"] as const;
const DESCRIPTION_HINTS = ["description", "details", "summary", "notes", "about", "bio"] as const;
const VENDOR_HINTS = ["vendor", "brand", "publisher", "seller", "creator", "manufacturer"] as const;
const CATEGORY_HINTS = ["category", "section", "department", "profession", "industry"] as const;
const SKU_HINTS = ["sku", "code", "product code", "barcode", "isbn", "model"] as const;
const PRIORITY_HINTS = ["priority", "importance", "urgency"] as const;
const ASSIGNEE_HINTS = ["assignee", "owner", "assigned to", "responsible"] as const;
const COMPANY_HINTS = ["company", "organization", "account", "client"] as const;
const EMAIL_HINTS = ["email", "e-mail"] as const;
const PHONE_HINTS = ["phone", "mobile", "tel", "telephone", "contact"] as const;
const DUE_DATE_HINTS = ["due", "deadline", "target date"] as const;
const START_DATE_HINTS = ["start", "begin", "kickoff"] as const;
const END_DATE_HINTS = ["end", "finish", "complete"] as const;
const EXTERNAL_URL_HINTS = [
  "url",
  "link",
  "website",
  "site",
  "page",
  "gumroad",
  "shopify",
  "store",
] as const;

export function smartPickStatus(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    STATUS_HINTS,
    (p) => p?.type === "status" || p?.type === "select" || p?.type === "multi_select",
  );
  return hit ? extractCategoryName(hit.prop) : undefined;
}

export function smartPickType(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(props, TYPE_HINTS, (p) => {
    if (p?.type === "select" && p.select?.name) return true;
    if (p?.type === "status" && p.status?.name) return true;
    if (p?.type === "multi_select" && Array.isArray(p.multi_select) && p.multi_select.length > 0)
      return true;
    return false;
  });
  return hit ? extractCategoryName(hit.prop) : undefined;
}

export function smartPickPriority(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    PRIORITY_HINTS,
    (p) => p?.type === "select" || p?.type === "status" || p?.type === "multi_select",
  );
  return hit ? extractCategoryName(hit.prop) : undefined;
}

export function smartPickNumber(
  props: Record<string, any>,
  hints: readonly string[],
): number | undefined {
  const hit = findPropByHints(props, hints, (p) => extractNumber(p) !== undefined);
  return hit ? extractNumber(hit.prop) : undefined;
}

export function smartPickTags(props: Record<string, any>): string[] {
  const multiHit = findPropByHints(
    props,
    TAGS_HINTS,
    (p) => p?.type === "multi_select" && Array.isArray(p.multi_select) && p.multi_select.length > 0,
  );
  if (multiHit) return extractMultiSelectNames(multiHit.prop);
  const textHit = findPropByHints(
    props,
    TAGS_HINTS,
    (p) => p?.type === "rich_text" && Boolean(extractPlainText(p)),
  );
  if (textHit) {
    const text = extractPlainText(textHit.prop);
    return Array.from(
      new Set(
        text
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    );
  }
  return [];
}

export function smartPickDescription(props: Record<string, any>): string {
  const hit = findPropByHints(props, DESCRIPTION_HINTS, (p) => p?.type === "rich_text");
  return hit ? extractPlainText(hit.prop) : "";
}

export function smartPickVendor(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    VENDOR_HINTS,
    (p) => p?.type === "rich_text" || p?.type === "select",
  );
  if (!hit) return undefined;
  return hit.prop.type === "rich_text"
    ? extractPlainText(hit.prop) || undefined
    : extractCategoryName(hit.prop);
}

export function smartPickCategory(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    CATEGORY_HINTS,
    (p) => p?.type === "select" || p?.type === "status" || p?.type === "multi_select",
  );
  return hit ? extractCategoryName(hit.prop) : undefined;
}

export function smartPickSku(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    SKU_HINTS,
    (p) => p?.type === "rich_text" || p?.type === "title",
  );
  return hit ? extractPlainText(hit.prop) || undefined : undefined;
}

export function smartPickInventory(props: Record<string, any>): number | undefined {
  return smartPickNumber(props, ["inventory", "stock", "quantity", "qty", "on hand"]);
}

export function smartPickEmail(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    EMAIL_HINTS,
    (p) => p?.type === "email" || (p?.type === "rich_text" && /@/.test(extractPlainText(p))),
  );
  if (!hit) return undefined;
  if (hit.prop.type === "email") return hit.prop.email;
  return extractPlainText(hit.prop);
}

export function smartPickPhone(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    PHONE_HINTS,
    (p) => p?.type === "phone_number" || p?.type === "rich_text",
  );
  if (!hit) return undefined;
  if (hit.prop.type === "phone_number") return hit.prop.phone_number ?? undefined;
  return extractPlainText(hit.prop) || undefined;
}

export function smartPickAssignee(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    ASSIGNEE_HINTS,
    (p) => p?.type === "people" || p?.type === "select" || p?.type === "rich_text",
  );
  if (!hit) return undefined;
  if (hit.prop.type === "people" && Array.isArray(hit.prop.people) && hit.prop.people.length > 0) {
    return hit.prop.people[0].name ?? hit.prop.people[0].id ?? undefined;
  }
  if (hit.prop.type === "select") return extractCategoryName(hit.prop);
  return extractPlainText(hit.prop) || undefined;
}

export function smartPickCompany(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    COMPANY_HINTS,
    (p) => p?.type === "rich_text" || p?.type === "select" || p?.type === "title",
  );
  if (!hit) return undefined;
  if (hit.prop.type === "select") return extractCategoryName(hit.prop);
  return extractPlainText(hit.prop) || undefined;
}

export function smartPickDueDate(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(props, DUE_DATE_HINTS, (p) => extractDate(p) !== undefined);
  return hit ? extractDate(hit.prop) : undefined;
}

export function smartPickStartDate(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(props, START_DATE_HINTS, (p) => extractDate(p) !== undefined);
  return hit ? extractDate(hit.prop) : undefined;
}

export function smartPickEndDate(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(props, END_DATE_HINTS, (p) => extractDate(p) !== undefined);
  return hit ? extractDate(hit.prop) : undefined;
}

export function smartPickExternalUrl(props: Record<string, any>): string | undefined {
  const hit = findPropByHints(
    props,
    EXTERNAL_URL_HINTS,
    (p) => p?.type === "url" && typeof p.url === "string" && p.url,
  );
  return hit ? hit.prop.url : undefined;
}

/**
 * Image candidate names — every property whose name contains image-y
 * words plus any explicit binding mapping. Pass this list to
 * pageImageUrl() / similar to find a thumbnail.
 */
export function collectImagePropNames(
  props: Record<string, any>,
  explicitName?: string | null,
): string[] {
  const names: string[] = [];
  if (explicitName) names.push(explicitName);
  for (const propName of Object.keys(props)) {
    const lname = propName.toLowerCase();
    if (
      lname.includes("photo") ||
      lname.includes("image") ||
      lname.includes("cover") ||
      lname.includes("thumbnail") ||
      lname.includes("screenshot") ||
      lname.includes("media")
    ) {
      names.push(propName);
    }
  }
  return names;
}

/**
 * Collect every file URL from every files-typed property on a page.
 * Returns deduplicated URLs. Used to seed the Gallery array alongside
 * URLs collected from page blocks.
 */
export function collectFileUrlsFromProps(props: Record<string, any>): string[] {
  const out: string[] = [];
  for (const [, p] of Object.entries(props)) {
    out.push(...extractFileUrls(p));
  }
  return Array.from(new Set(out));
}
