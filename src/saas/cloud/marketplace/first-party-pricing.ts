// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface FirstPartyPriceSeed {
  model: "free" | "paid";
  priceCents: number;
  currency: "USD";
}

export function firstPartyPriceSeed(_id: string): FirstPartyPriceSeed {
  return { model: "free", priceCents: 0, currency: "USD" };
}
