/**
 * The plan a visitor picked on /pricing (or infinibotos.com / KinglyVault)
 * before signing in: `/app/?checkout=<plan>`. Pure, so the sign-in gate can
 * name the plan without importing the checkout hand-off (checkout-resume.ts).
 *
 * Names and prices mirror site/content/plans.mjs (checkout-intent.test.ts keeps
 * them in sync).
 */
export const CHECKOUT_PLAN_LABELS = {
  starter: { name: "Starter", price: 19 },
  pro: { name: "Pro", price: 49 },
  business: { name: "Business", price: 99 },
  scale: { name: "Scale", price: 199 },
} as const;

export type CheckoutIntent = { id: keyof typeof CHECKOUT_PLAN_LABELS; name: string; price: number };

export function checkoutIntent(search: string): CheckoutIntent | null {
  const id = new URLSearchParams(search).get("checkout")?.trim().toLowerCase() ?? "";
  if (!Object.hasOwn(CHECKOUT_PLAN_LABELS, id)) return null;
  const plan = CHECKOUT_PLAN_LABELS[id as CheckoutIntent["id"]];
  return { id: id as CheckoutIntent["id"], name: plan.name, price: plan.price };
}
