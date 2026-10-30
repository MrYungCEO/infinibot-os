/**
 * Integer-cent money arithmetic for generated documents.
 *
 * Every amount in the agency-operations store is an integer number of cents.
 * Floats never enter the pipeline: quantities may be fractional (e.g. 7.5
 * hours) but the *product* is rounded to whole cents immediately, once, and
 * every downstream sum is integer addition. This keeps `sum(lineTotals)`
 * exactly equal to the subtotal we print — the classic invoice rounding bug is
 * summing rounded floats and getting a total that is a cent off.
 */

/** Round to the nearest integer, halves away from zero (symmetric for refunds/credits). */
export function roundCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Whole-cent total for one line: `quantity x unitPriceCents`, rounded once. */
export function lineTotalCents(quantity: number, unitPriceCents: number): number {
  const qty = Number.isFinite(quantity) ? quantity : 0;
  const unit = Number.isFinite(unitPriceCents) ? Math.trunc(unitPriceCents) : 0;
  return roundCents(qty * unit);
}

/** Integer sum; non-finite entries are treated as zero rather than poisoning the total. */
export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) total += Math.trunc(value);
  }
  return total;
}

/** Tax from a rate in basis points (1 bp = 0.01%), rounded to whole cents. */
export function taxFromBasisPoints(subtotalCents: number, basisPoints: number): number {
  if (!Number.isFinite(basisPoints) || basisPoints === 0) return 0;
  return roundCents((Math.trunc(subtotalCents) * basisPoints) / 10_000);
}

/** Balance never goes below zero — an overpayment shows as a zero balance, not a negative one. */
export function balanceCents(totalCents: number, amountPaidCents: number): number {
  return Math.max(0, Math.trunc(totalCents) - Math.trunc(amountPaidCents));
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "CA$",
  AUD: "A$",
  NZD: "NZ$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "CN¥",
  INR: "₹",
  BRL: "R$",
  MXN: "MX$",
  CHF: "CHF ",
  SEK: "SEK ",
  NOK: "NOK ",
  DKK: "DKK ",
  PLN: "PLN ",
  ZAR: "R",
  SGD: "S$",
  HKD: "HK$",
  AED: "AED ",
  NGN: "₦",
  KES: "KSh",
};

/** Currencies with no minor unit — the stored "cents" value is already whole units. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF", "RWF", "UGX"]);

export function normalizeCurrency(currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

export function currencySymbol(currency: string | null | undefined): string {
  const code = normalizeCurrency(currency);
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

export function currencyDecimals(currency: string | null | undefined): number {
  return ZERO_DECIMAL.has(normalizeCurrency(currency)) ? 0 : 2;
}

/**
 * Deterministic money formatting. Intentionally *not* `Intl.NumberFormat`:
 * ICU data differs between Node builds and would make golden-file tests flaky
 * across machines. Documents must render byte-identically for the same input.
 */
export function formatMoney(
  cents: number,
  currency: string | null | undefined,
  options: { signed?: boolean; withCode?: boolean } = {},
): string {
  const code = normalizeCurrency(currency);
  const decimals = currencyDecimals(code);
  const amount = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  const divisor = decimals === 0 ? 1 : 100;
  const whole = Math.floor(magnitude / divisor);
  const fraction = magnitude % divisor;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = decimals === 0 ? grouped : `${grouped}.${String(fraction).padStart(decimals, "0")}`;
  const sign = negative ? "-" : options.signed && amount > 0 ? "+" : "";
  const suffix = options.withCode ? ` ${code}` : "";
  return `${sign}${currencySymbol(code)}${body}${suffix}`;
}

/** Quantities print as integers when whole, otherwise up to 2 decimals, trailing zeros trimmed. */
export function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) return "0";
  if (Number.isInteger(quantity)) return String(quantity);
  return quantity.toFixed(2).replace(/\.?0+$/, "");
}
