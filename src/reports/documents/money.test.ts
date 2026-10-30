import { describe, expect, it } from "vitest";
import {
  balanceCents,
  currencyDecimals,
  formatMoney,
  formatQuantity,
  lineTotalCents,
  normalizeCurrency,
  roundCents,
  sumCents,
  taxFromBasisPoints,
} from "./money.js";

describe("roundCents", () => {
  it("rounds halves away from zero in both directions", () => {
    expect(roundCents(0.5)).toBe(1);
    expect(roundCents(1.5)).toBe(2);
    expect(roundCents(2.5)).toBe(3);
    // JS Math.round(-0.5) is -0 (rounds toward +Infinity); a credit note must
    // round the same magnitude as the charge it reverses.
    expect(roundCents(-0.5)).toBe(-1);
    expect(roundCents(-1.5)).toBe(-2);
    expect(roundCents(-2.5)).toBe(-3);
  });

  it("treats non-finite input as zero rather than propagating NaN", () => {
    expect(roundCents(Number.NaN)).toBe(0);
    expect(roundCents(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("lineTotalCents", () => {
  it("rounds the product exactly once", () => {
    // 37.5 h x $185.00 = $6,937.50
    expect(lineTotalCents(37.5, 18_500)).toBe(693_750);
    // 3 x $19.99 = $59.97 — the classic float trap (59.97000000000001)
    expect(lineTotalCents(3, 1_999)).toBe(5_997);
    // 0.1 + 0.2 territory: 1/3 of a cent-priced item
    expect(lineTotalCents(0.333, 1_000)).toBe(333);
  });

  it("rounds a half-cent product away from zero", () => {
    // 1.5 x 1 cent = 1.5 cents -> 2 cents
    expect(lineTotalCents(1.5, 1)).toBe(2);
    expect(lineTotalCents(1.5, -1)).toBe(-2);
  });

  it("truncates a fractional unit price instead of carrying it", () => {
    expect(lineTotalCents(2, 10.7 as number)).toBe(20);
  });

  it("is zero for missing/garbage inputs", () => {
    expect(lineTotalCents(Number.NaN, 1_000)).toBe(0);
    expect(lineTotalCents(2, Number.NaN)).toBe(0);
  });
});

describe("sumCents", () => {
  it("adds integers exactly, with no float drift over many rows", () => {
    const rows = Array.from({ length: 1_000 }, () => 1_999);
    expect(sumCents(rows)).toBe(1_999_000);
  });

  it("agrees with the sum of individually-rounded line totals", () => {
    const lines: Array<[number, number]> = [
      [37.5, 18_500],
      [1, 850_000],
      [3, 1_999],
      [0.25, 99_999],
    ];
    const totals = lines.map(([qty, unit]) => lineTotalCents(qty, unit));
    expect(totals).toEqual([693_750, 850_000, 5_997, 25_000]);
    expect(sumCents(totals)).toBe(1_574_747);
  });

  it("ignores non-finite entries instead of poisoning the total", () => {
    expect(sumCents([100, Number.NaN, 200])).toBe(300);
  });
});

describe("taxFromBasisPoints", () => {
  it("computes whole-cent tax from a basis-point rate", () => {
    // 8.72% of $31,437.50
    expect(taxFromBasisPoints(3_143_750, 872)).toBe(274_135);
    // 20% VAT of $100.00
    expect(taxFromBasisPoints(10_000, 2_000)).toBe(2_000);
  });

  it("is exactly zero for a zero rate", () => {
    expect(taxFromBasisPoints(999_999, 0)).toBe(0);
  });
});

describe("balanceCents", () => {
  it("subtracts payments", () => {
    expect(balanceCents(3_417_828, 1_000_000)).toBe(2_417_828);
  });

  it("clamps an overpayment to zero rather than showing a negative balance", () => {
    expect(balanceCents(10_000, 12_000)).toBe(0);
  });

  it("is zero when paid exactly", () => {
    expect(balanceCents(10_000, 10_000)).toBe(0);
  });
});

describe("formatMoney", () => {
  it("groups thousands and always shows two decimals", () => {
    expect(formatMoney(3_417_828, "USD")).toBe("$34,178.28");
    expect(formatMoney(5, "USD")).toBe("$0.05");
    expect(formatMoney(0, "USD")).toBe("$0.00");
    expect(formatMoney(100_000_000_00, "USD")).toBe("$100,000,000.00");
  });

  it("puts the sign before the symbol", () => {
    expect(formatMoney(-2_500, "USD")).toBe("-$25.00");
  });

  it("uses per-currency symbols and falls back to the code", () => {
    expect(formatMoney(199_900, "EUR")).toBe("€1,999.00");
    expect(formatMoney(199_900, "GBP")).toBe("£1,999.00");
    expect(formatMoney(199_900, "XPF")).toBe("XPF 1,999.00");
  });

  it("treats zero-decimal currencies as whole units", () => {
    expect(currencyDecimals("JPY")).toBe(0);
    expect(formatMoney(250_000, "JPY")).toBe("¥250,000");
  });

  it("is deterministic and locale-independent", () => {
    // No Intl involved, so ICU differences between Node builds cannot change
    // the bytes a test (or a client's PDF) sees.
    const first = formatMoney(1_234_567, "USD");
    const second = formatMoney(1_234_567, "USD");
    expect(first).toBe(second);
    expect(first).toBe("$12,345.67");
  });
});

describe("normalizeCurrency", () => {
  it("upper-cases valid codes and rejects anything else", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency("")).toBe("USD");
    expect(normalizeCurrency(null)).toBe("USD");
    expect(normalizeCurrency("dollars")).toBe("USD");
  });
});

describe("formatQuantity", () => {
  it("prints whole numbers without decimals and trims trailing zeros", () => {
    expect(formatQuantity(1)).toBe("1");
    expect(formatQuantity(37.5)).toBe("37.5");
    expect(formatQuantity(0.25)).toBe("0.25");
    expect(formatQuantity(2.5)).toBe("2.5");
  });
});
