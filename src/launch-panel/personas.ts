import type { LaunchPersona } from "./types.js";

export const DEFAULT_LAUNCH_PERSONAS: LaunchPersona[] = [
  {
    id: "nontechnical-beginner",
    name: "Maya",
    avatarIcon: "sparkles",
    role: "Non-technical beginner and side-hustle seeker",
    background:
      "Works a full-time service job and wants a first online income stream without learning code.",
    goals: ["Earn a first $500 online", "Get a visible win in one evening"],
    pains: ["Overwhelmed by tool lists", "Afraid of breaking technical setup"],
    techLevel: "low",
    budget: "$0–$50 per month",
    spendingAuthority: "Personal card; can decide alone after seeing a concrete outcome",
    buyingTriggers: ["A guided first win", "Plain-language steps", "Low-risk trial"],
    objections: ["I will not know what to do", "This will become another unused subscription"],
    devices: ["mobile", "desktop"],
    patience: "About 90 seconds before confusion becomes a bounce",
    privateInfo:
      "Has bought two courses and completed neither; will not admit this unless the experience feels judgment-free.",
    enabled: true,
  },
  {
    id: "technical-developer",
    name: "Noah",
    avatarIcon: "terminal",
    role: "Technical developer comparing against free tools",
    background: "Builds web apps and automations, reads docs, and already uses open-source agents.",
    goals: ["Ship faster", "Avoid glue code", "Own the runtime"],
    pains: ["Vague AI claims", "Closed ecosystems", "Duplicated features"],
    techLevel: "high",
    budget: "$20–$100 per month when time savings are provable",
    spendingAuthority: "Self for tools; manager approval above $100 per month",
    buyingTriggers: ["Transparent architecture", "Exportability", "Measurable time saved"],
    objections: ["I can build this for free", "Where is the technical proof?"],
    devices: ["desktop"],
    patience: "Scans quickly but will investigate for 20 minutes if evidence is specific",
    privateInfo: "Actually wants a supported stack, but uses open source as a negotiation anchor.",
    enabled: true,
  },
  {
    id: "small-business-owner",
    name: "Priya",
    avatarIcon: "briefcase",
    role: "Time-poor small business owner",
    background:
      "Runs a five-person local business and handles sales, operations, and marketing personally.",
    goals: ["Recover five hours per week", "Generate qualified leads", "See ROI this month"],
    pains: ["Setup projects that drag on", "Tools requiring a dedicated operator"],
    techLevel: "medium",
    budget: "$50–$500 per month",
    spendingAuthority: "Owner; can purchase when payback is credible",
    buyingTriggers: ["Time-to-value", "Business outcome examples", "Done-for-you starting points"],
    objections: ["Who maintains this?", "Will my team actually use it?"],
    devices: ["mobile", "desktop"],
    patience: "Five minutes for setup, thirty seconds for the value proposition",
    privateInfo: "Will pay more for implementation help than for another dashboard.",
    enabled: true,
  },
  {
    id: "agency-owner",
    name: "Marcus",
    avatarIcon: "users",
    role: "Agency owner who resells outcomes to clients",
    background:
      "Runs a small automation and creative agency with contractors across several client accounts.",
    goals: ["Increase delivery margin", "Standardize fulfillment", "Offer white-label services"],
    pains: ["Per-seat cost creep", "No tenant separation", "Manual client reporting"],
    techLevel: "high",
    budget: "$200–$2,000 per month when it supports client revenue",
    spendingAuthority: "Owner; needs margin and scale proof",
    buyingTriggers: ["Multi-client workspaces", "White-label capability", "Reusable workflows"],
    objections: ["Does this scale past one client?", "Can clients see the vendor brand?"],
    devices: ["desktop", "mobile"],
    patience: "Ten minutes for a serious evaluation; immediately rejects toy demos",
    privateInfo:
      "Has a client asking for this now and could buy quickly if delivery risk feels low.",
    enabled: true,
  },
  {
    id: "content-creator",
    name: "Zoe",
    avatarIcon: "video",
    role: "Content creator building a repeatable publishing engine",
    background: "Publishes short-form content and sells digital products to a growing audience.",
    goals: ["Publish daily", "Repurpose one idea across channels", "Monetize without a large team"],
    pains: ["Blank-page fatigue", "Inconsistent assets", "Tool hopping"],
    techLevel: "medium",
    budget: "$30–$250 per month",
    spendingAuthority: "Self; purchases fast when output quality is visible",
    buyingTriggers: ["Real output examples", "Brand consistency", "Fast batch creation"],
    objections: ["AI content looks generic", "The workflow will be slower than editing myself"],
    devices: ["mobile", "desktop"],
    patience: "Visual verdict in five seconds; fifteen minutes if creation is hands-on",
    privateInfo: "Needs content for a launch next week and is unusually motivated right now.",
    enabled: true,
  },
  {
    id: "aspiring-trader",
    name: "Ethan",
    avatarIcon: "chartLine",
    role: "Aspiring trader evaluating Pulse",
    background: "Has learned from social media but lacks a consistent process and risk framework.",
    goals: ["Build a repeatable routine", "Understand risk", "Stop chasing signals"],
    pains: ["Conflicting advice", "Hidden upsells", "Unclear eligibility"],
    techLevel: "medium",
    budget: "$20–$150 per month for education; limited trading capital",
    spendingAuthority: "Self; must remain within disposable income",
    buyingTriggers: ["Education before signals", "Clear risk language", "A free next step"],
    objections: ["Is this just another signal group?", "Why is the real offer hidden?"],
    devices: ["mobile"],
    patience: "Three minutes if onboarding is mobile-friendly",
    privateInfo:
      "Is underfunded for premium trading services and needs the free KinglyVault education route, never a dead end.",
    enabled: true,
  },
  {
    id: "budget-student",
    name: "Lena",
    avatarIcon: "book",
    role: "Student on a tight budget",
    background: "Studies full time and wants portfolio projects that improve employability.",
    goals: ["Learn a marketable skill", "Build a portfolio", "Avoid debt"],
    pains: ["High monthly prices", "Courses without practical projects"],
    techLevel: "medium",
    budget: "$0–$20 per month",
    spendingAuthority: "Self; highly price sensitive",
    buyingTriggers: ["Useful free tier", "Student-friendly path", "Proof of employable output"],
    objections: ["I cannot justify another subscription", "Can I learn this free elsewhere?"],
    devices: ["mobile", "desktop"],
    patience: "Will explore deeply if free value is obvious",
    privateInfo:
      "Could upgrade later after freelance income, so the free path matters more than immediate conversion.",
    enabled: true,
  },
  {
    id: "mobile-only",
    name: "Andre",
    avatarIcon: "smartphone",
    role: "Mobile-only user",
    background:
      "Runs most personal and business tasks from an Android phone and rarely has laptop access.",
    goals: ["Complete onboarding on mobile", "Use core features one-handed"],
    pains: ["Desktop-only instructions", "Tiny tap targets", "Navigation that disappears"],
    techLevel: "medium",
    budget: "$20–$100 per month",
    spendingAuthority: "Self",
    buyingTriggers: ["True mobile usability", "Short forms", "Persistent progress"],
    objections: ["I need a laptop for the useful parts", "The checkout is hard to trust on mobile"],
    devices: ["mobile"],
    patience: "Two failed taps or one horizontal-scroll trap",
    privateInfo: "Will abandon permanently if the first session tells him to come back on desktop.",
    enabled: true,
  },
  {
    id: "enterprise-ops",
    name: "Helena",
    avatarIcon: "shield",
    role: "Enterprise operations buyer",
    background:
      "Evaluates software for a regulated operations team with security and procurement requirements.",
    goals: ["Govern agent access", "Audit work", "Deploy reliably across teams"],
    pains: ["Unclear data boundaries", "No admin controls", "Vendor risk"],
    techLevel: "high",
    budget: "$2,000–$20,000 per year after procurement",
    spendingAuthority: "Recommender; security, legal, and finance must approve",
    buyingTriggers: ["Security documentation", "RBAC", "Audit trail", "Support SLA"],
    objections: ["Where is enterprise governance?", "What happens to our data?"],
    devices: ["desktop"],
    patience: "Thirty minutes for due diligence, but only if trust signals are immediate",
    privateInfo:
      "A pilot budget exists this quarter; missing compliance answers will end the evaluation.",
    enabled: true,
  },
  {
    id: "refund-risk-skeptic",
    name: "Derek",
    avatarIcon: "search",
    role: "Skeptic and refund-risk buyer",
    background:
      "Has purchased several online programs and now assumes marketing claims are exaggerated.",
    goals: ["Verify the offer before paying", "Find hidden limitations", "Avoid buyer's remorse"],
    pains: ["Manufactured urgency", "Unclear cancellation", "Testimonials without proof"],
    techLevel: "medium",
    budget: "$0 until trust is earned; up to $100 per month after proof",
    spendingAuthority: "Self, but deliberately slow",
    buyingTriggers: ["Specific evidence", "Transparent terms", "Honest limitations"],
    objections: ["This is too good to be true", "What is the catch?"],
    devices: ["desktop", "mobile"],
    patience: "Actively hunts for contradictions for up to twenty minutes",
    privateInfo:
      "Will request a refund if the first-use experience differs materially from the sales page.",
    enabled: true,
  },
];

export function normalizePersona(raw: LaunchPersona): LaunchPersona {
  const ids = (v: unknown) =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  const id = String(raw.id ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  if (!id) throw new Error("Persona id is required");
  return {
    id,
    name:
      String(raw.name ?? "")
        .trim()
        .slice(0, 80) || id,
    avatarIcon:
      String(raw.avatarIcon ?? "user")
        .trim()
        .slice(0, 40) || "user",
    role: String(raw.role ?? "")
      .trim()
      .slice(0, 240),
    background: String(raw.background ?? "")
      .trim()
      .slice(0, 2000),
    goals: ids(raw.goals),
    pains: ids(raw.pains),
    techLevel: ["low", "medium", "high"].includes(raw.techLevel) ? raw.techLevel : "medium",
    budget: String(raw.budget ?? "")
      .trim()
      .slice(0, 240),
    spendingAuthority: String(raw.spendingAuthority ?? "")
      .trim()
      .slice(0, 500),
    buyingTriggers: ids(raw.buyingTriggers),
    objections: ids(raw.objections),
    devices: ids(raw.devices).filter(
      (v): v is "mobile" | "desktop" => v === "mobile" || v === "desktop",
    ),
    patience: String(raw.patience ?? "")
      .trim()
      .slice(0, 500),
    privateInfo: String(raw.privateInfo ?? "")
      .trim()
      .slice(0, 2000),
    enabled: raw.enabled !== false,
  };
}
