/**
 * Setup-status registry types (single source of truth for "does this page
 * still need setup?"). Evaluated server-side by `setup.status`; the control
 * UI turns non-ready results into sidebar glows + page banners.
 * Design: docs/gateway/setup-status.md.
 */

export type SetupState = "ready" | "needs-setup" | "optional" | "error";

export type SetupAction = {
  /** Button label ("Connect email"). */
  label: string;
  /** Control-UI page (Tab id); retired ids land on their host page. */
  tab?: string;
  /** Host sub-view, e.g. `coders` → /setup?view=coders. */
  view?: string;
  /** Setup page section to open (`infinibot:setup-section`), e.g. "voice". */
  section?: string;
  /** External link instead of a page. */
  href?: string;
};

/** What a check's `evaluate()` returns. */
export type SetupCheckOutcome = {
  state: SetupState;
  /** One short sentence describing what's missing (empty when ready). */
  reason?: string;
  /** Overrides the check's default action for this outcome. */
  action?: SetupAction;
};

export type SetupCheckContext = {
  /** True when the gateway serves hosted multi-tenant (SaaS/cloud) mode. */
  cloud: boolean;
};

export type SetupCheckDefinition = {
  /** Unique id: `core.<name>` for core, `<pluginId>.<name>` for plugins. */
  id: string;
  /** Short name of what is being set up ("Email account"). */
  title: string;
  /** Pages (Tab ids) that glow while this check isn't ready. */
  tabs: string[];
  /** Default action button. */
  action?: SetupAction;
  /** Sort weight — higher surfaces first (model credentials = 100). */
  priority?: number;
  /** Skip in hosted cloud mode (the feature doesn't exist there). */
  localOnly?: boolean;
  /** Must be cheap: read config/stores, never spawn or hit the network. */
  evaluate: (ctx: SetupCheckContext) => SetupCheckOutcome | Promise<SetupCheckOutcome>;
};

/** One evaluated check as sent to clients. */
export type SetupCheckResult = {
  id: string;
  /** "core" or the contributing plugin id. */
  source: string;
  title: string;
  tabs: string[];
  state: SetupState;
  reason: string;
  action?: SetupAction;
  priority?: number;
};

export type SetupStatusSnapshot = {
  checks: SetupCheckResult[];
  cloud: boolean;
  evaluatedAt: number;
};
