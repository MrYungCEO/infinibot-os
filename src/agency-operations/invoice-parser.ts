import { createHash } from "node:crypto";

export type InvoiceCadence = "one_time" | "monthly" | "quarterly" | "annual";

export interface ParsedInvoiceLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  cadence: InvoiceCadence;
}

export interface ParsedInvoiceDocument {
  sourceHash: string;
  invoiceNumber: string;
  clientName: string;
  billingEmail: string | null;
  projectName: string | null;
  currency: string;
  status: "draft" | "issued" | "partially_paid" | "paid";
  issuedAt: number | null;
  dueAt: number | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  recurringMonthlyCents: number;
  lineItems: ParsedInvoiceLineItem[];
  confidence: number;
  warnings: string[];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^0-9,.-]/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function centsValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

function timeValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = textValue(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function first(source: JsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      return source[key];
    }
  }
  return undefined;
}

function match(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found?.[1]?.trim()) return found[1].trim();
  }
  return "";
}

function matchMoney(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new RegExp(
      `(?:^|\\s)${escaped}\\s*[:#-]?\\s*(?:[A-Z]{3}\\s*)?[$€£฿]?\\s*([\\d,]+(?:\\.\\d{1,2})?)`,
      "i",
    ).exec(text);
    if (found?.[1]) return centsValue(found[1]);
  }
  return null;
}

function cleanClientName(value: string): string {
  return value
    .replace(
      /\s+\d{1,6}\s+(?:[A-Z0-9.'-]+\s+){0,6}(?:street|st|avenue|ave|road|rd|parkway|pkwy|boulevard|blvd|drive|dr|lane|ln)\b.*$/i,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cadence(value: unknown, description: string): InvoiceCadence {
  const explicit = textValue(value).toLowerCase();
  if (/\b(year|yearly|annual|annually)\b/.test(explicit)) return "annual";
  if (/\b(quarter|quarterly)\b/.test(explicit)) return "quarterly";
  if (/\b(month|monthly|mrr)\b/.test(explicit)) return "monthly";
  if (/\b(one.?time|once)\b/.test(explicit)) return "one_time";
  const raw = description.toLowerCase();
  if (/\b(year|yearly|annual|annually)\b/.test(raw)) return "annual";
  if (/\b(quarter|quarterly)\b/.test(raw)) return "quarterly";
  if (/\b(month|monthly|mrr|retainer|maintenance|subscription)\b/.test(raw)) return "monthly";
  return "one_time";
}

function invoiceLineItemsFromText(text: string): ParsedInvoiceLineItem[] {
  const header = /description\s+qty\s+unit\s+price\s+total/i.exec(text);
  if (!header) return [];
  const tail = text.slice((header.index ?? 0) + header[0].length);
  const end = /\b(?:total\s+due|amount\s+due|subtotal)\b/i.exec(tail);
  const body = end ? tail.slice(0, end.index) : tail;
  const pattern =
    /(.+?)\s+(\d+(?:\.\d+)?)\s+(?:[A-Z]{3}\s*)?[$€£฿]?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:[A-Z]{3}\s*)?[$€£฿]?\s*([\d,]+(?:\.\d{1,2})?)(?=\s|$)/g;
  const items: ParsedInvoiceLineItem[] = [];
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(body))) {
    const description = found[1]!.trim().replace(/\s{2,}/g, " ");
    const quantity = numberValue(found[2]) ?? 1;
    const unitPriceCents = centsValue(found[3]) ?? 0;
    const totalCents = centsValue(found[4]) ?? Math.round(quantity * unitPriceCents);
    items.push({
      description,
      quantity,
      unitPriceCents,
      totalCents,
      cadence: cadence("", description),
    });
  }
  return items;
}

function normalizeMonthly(totalCents: number, interval: InvoiceCadence): number {
  if (interval === "monthly") return totalCents;
  if (interval === "quarterly") return Math.round(totalCents / 3);
  if (interval === "annual") return Math.round(totalCents / 12);
  return 0;
}

function parseJsonInvoice(raw: JsonObject): Omit<ParsedInvoiceDocument, "sourceHash"> {
  const client = object(first(raw, ["client", "customer", "billTo", "bill_to"]));
  const rawItems = first(raw, ["lineItems", "line_items", "items"]);
  const items = Array.isArray(rawItems) ? rawItems : [];
  const lineItems = items.map((entry, index): ParsedInvoiceLineItem => {
    const item = object(entry);
    const description =
      textValue(first(item, ["description", "name", "title"])) || `Line item ${index + 1}`;
    const quantity = numberValue(first(item, ["quantity", "qty"])) ?? 1;
    const explicitTotal = centsValue(first(item, ["total", "amount", "lineTotal", "line_total"]));
    const unitPriceCents =
      centsValue(first(item, ["unitPrice", "unit_price", "rate", "price"])) ??
      (explicitTotal === null ? 0 : Math.round(explicitTotal / Math.max(quantity, 1)));
    const totalCents = explicitTotal ?? Math.round(quantity * unitPriceCents);
    return {
      description,
      quantity,
      unitPriceCents,
      totalCents,
      cadence: cadence(first(item, ["cadence", "interval", "billingInterval"]), description),
    };
  });
  const subtotalCents =
    centsValue(first(raw, ["subtotal", "subtotalAmount", "subtotal_amount"])) ??
    lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  const taxCents = centsValue(first(raw, ["tax", "taxAmount", "tax_amount"])) ?? 0;
  const totalCents =
    centsValue(first(raw, ["total", "totalAmount", "total_amount", "amountDue", "amount_due"])) ??
    subtotalCents + taxCents;
  const amountPaidCents = Math.min(
    totalCents,
    centsValue(first(raw, ["amountPaid", "amount_paid", "paid", "paymentAmount"])) ?? 0,
  );
  const rawStatus = textValue(
    first(raw, ["status", "paymentStatus", "payment_status"]),
  ).toLowerCase();
  const status =
    amountPaidCents >= totalCents && totalCents > 0
      ? "paid"
      : amountPaidCents > 0
        ? "partially_paid"
        : rawStatus === "draft"
          ? "draft"
          : "issued";
  const warnings: string[] = [];
  const invoiceNumber = textValue(first(raw, ["invoiceNumber", "invoice_number", "number", "id"]));
  const clientName =
    textValue(first(client, ["name", "company", "legalName"])) ||
    textValue(first(raw, ["clientName", "client_name", "customerName", "customer_name"]));
  if (!invoiceNumber) warnings.push("Invoice number was not found.");
  if (!clientName) warnings.push("Client name was not found.");
  if (totalCents <= 0) warnings.push("Invoice total was not found or is zero.");
  return {
    invoiceNumber,
    clientName,
    billingEmail:
      textValue(first(client, ["email", "billingEmail"])) ||
      textValue(first(raw, ["billingEmail", "billing_email", "email"])) ||
      null,
    projectName:
      textValue(first(raw, ["projectName", "project_name", "project", "engagementName"])) || null,
    currency:
      textValue(first(raw, ["currency", "currencyCode", "currency_code"])).toUpperCase() || "USD",
    status,
    issuedAt: timeValue(
      first(raw, ["issuedAt", "issued_at", "invoiceDate", "invoice_date", "date"]),
    ),
    dueAt: timeValue(first(raw, ["dueAt", "due_at", "dueDate", "due_date"])),
    subtotalCents,
    taxCents,
    totalCents,
    amountPaidCents,
    recurringMonthlyCents: lineItems.reduce(
      (sum, item) => sum + normalizeMonthly(item.totalCents, item.cadence),
      0,
    ),
    lineItems:
      lineItems.length > 0
        ? lineItems
        : [
            {
              description: "Invoice total",
              quantity: 1,
              unitPriceCents: subtotalCents,
              totalCents: subtotalCents,
              cadence: cadence(first(raw, ["cadence", "interval", "billingInterval"]), ""),
            },
          ],
    confidence: Math.max(0.25, 1 - warnings.length * 0.2),
    warnings,
  };
}

function parseTextInvoice(text: string): Omit<ParsedInvoiceDocument, "sourceHash"> {
  const invoiceNumber = match(text, [
    /invoice\s*(?:number|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
    /\binv[-\s]?([A-Z0-9][A-Z0-9._/-]*)/i,
  ]);
  const clientName = cleanClientName(
    match(text, [
      /(?:bill\s*to|client|customer)\s*[:#-]?\s*(.+?)(?=\s+(?:description|invoice\s*date|due\s*date|qty|subtotal|total\s+due)\b|[\r\n]|$)/i,
      /(?:company)\s*[:#-]?\s*(.+?)(?=\s+(?:description|invoice\s*date|due\s*date|qty|subtotal|total\s+due)\b|[\r\n]|$)/i,
    ]),
  );
  const billingEmail =
    match(text, [/(?:billing\s*email|email)\s*[:#-]?\s*([^\s,;]+@[^\s,;]+)/i]) || null;
  const currency =
    match(text, [/\bcurrency\s*[:#-]?\s*([A-Z]{3})\b/i]).toUpperCase() ||
    (text.includes("€") ? "EUR" : text.includes("£") ? "GBP" : text.includes("฿") ? "THB" : "USD");
  const lineItems = invoiceLineItemsFromText(text);
  const subtotalCents =
    matchMoney(text, ["subtotal"]) ?? lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  const taxCents = matchMoney(text, ["tax", "vat"]) ?? 0;
  const totalCents =
    matchMoney(text, ["total due", "amount due", "invoice total"]) || subtotalCents + taxCents;
  const amountPaidCents = Math.min(totalCents, matchMoney(text, ["amount paid", "paid"]) ?? 0);
  const issueDate = match(text, [
    /(?:invoice\s*date|issued\s*(?:at|on)?|date)\s*[:#-]?\s*([^\r\n]+)/i,
  ]);
  const dueDate = match(text, [/(?:due\s*date|payment\s*due)\s*[:#-]?\s*([^\r\n]+)/i]);
  const interval = cadence(
    match(text, [/(?:billing\s*(?:cadence|interval)|frequency)\s*[:#-]?\s*([^\r\n]+)/i]),
    text,
  );
  const recurringMonthlyCents = lineItems.length
    ? lineItems.reduce((sum, item) => sum + normalizeMonthly(item.totalCents, item.cadence), 0)
    : normalizeMonthly(subtotalCents || totalCents - taxCents, interval);
  const warnings: string[] = [];
  if (!invoiceNumber) warnings.push("Invoice number was not found.");
  if (!clientName) warnings.push("Client name was not found.");
  if (totalCents <= 0) warnings.push("Invoice total was not found or is zero.");
  return {
    invoiceNumber,
    clientName,
    billingEmail,
    projectName:
      match(text, [
        /(?:project|engagement)\s*[:#-]?\s*(.+?)(?=\s+(?:description|invoice\s*date|due\s*date|subtotal|total\s+due)\b|[\r\n]|$)/i,
      ]) || null,
    currency,
    status:
      amountPaidCents >= totalCents && totalCents > 0
        ? "paid"
        : amountPaidCents > 0
          ? "partially_paid"
          : /\bdraft\b/i.test(text)
            ? "draft"
            : "issued",
    issuedAt: timeValue(issueDate),
    dueAt: timeValue(dueDate),
    subtotalCents: subtotalCents || Math.max(0, totalCents - taxCents),
    taxCents,
    totalCents,
    amountPaidCents,
    recurringMonthlyCents,
    lineItems:
      lineItems.length > 0
        ? lineItems
        : [
            {
              description:
                interval === "one_time"
                  ? "Invoice services"
                  : `${interval.replace("_", " ")} services`,
              quantity: 1,
              unitPriceCents: subtotalCents || Math.max(0, totalCents - taxCents),
              totalCents: subtotalCents || Math.max(0, totalCents - taxCents),
              cadence: interval,
            },
          ],
    confidence: Math.max(0.2, 1 - warnings.length * 0.22),
    warnings,
  };
}

export function parseInvoice(input: {
  text?: string;
  structured?: unknown;
}): ParsedInvoiceDocument {
  const source = input.structured ?? input.text ?? "";
  const sourceHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  let structured = input.structured;
  if (structured === undefined && input.text?.trim().startsWith("{")) {
    try {
      structured = JSON.parse(input.text);
    } catch {
      structured = undefined;
    }
  }
  const parsed =
    structured === undefined
      ? parseTextInvoice(input.text ?? "")
      : parseJsonInvoice(object(structured));
  return { sourceHash, ...parsed };
}

export async function extractInvoiceText(input: {
  sourceText?: string;
  sourceBase64?: string;
  mediaType?: string;
}): Promise<string> {
  if (input.sourceText?.trim()) return input.sourceText;
  if (!input.sourceBase64) return "";
  const bytes = Buffer.from(input.sourceBase64, "base64");
  if (input.mediaType === "application/pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true })
      .promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const rows = new Map<number, Array<{ x: number; text: string }>>();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const transform = "transform" in item ? item.transform : undefined;
        const x = Array.isArray(transform) ? Number(transform[4] ?? 0) : 0;
        const y = Array.isArray(transform) ? Number(transform[5] ?? 0) : 0;
        const rowKey = Math.round(y / 2) * 2;
        const row = rows.get(rowKey) ?? [];
        row.push({ x, text: item.str.trim() });
        rows.set(rowKey, row);
      }
      pages.push(
        [...rows.entries()]
          .sort(([a], [b]) => b - a)
          .map(([, row]) =>
            row
              .sort((a, b) => a.x - b.x)
              .map((item) => item.text)
              .join(" "),
          )
          .join("\n"),
      );
    }
    return pages.join("\n");
  }
  return bytes.toString("utf8");
}
