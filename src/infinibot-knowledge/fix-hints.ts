/**
 * Actionable "it's off / not connected" results for core tools, built from the
 * knowledge base so the path in the error is the path in the UI (no
 * hand-typed "Settings > Schedule"). Tools return `{ ok:false, code, error,
 * fix }`; agents relay `fix.where` and can open `fix.tab` with ui_control.
 */

import {
  formatHumanizedError,
  humanizeCoderMissing,
  isCoderMissingError,
} from "../agents/provider-error-messages.js";
import { getKnowledgeBase } from "./runtime.js";

export type FixHint = {
  where: string;
  route?: string;
  targets: string[];
  /** Tab for ui_control dispatch nav.switch_tab. */
  tab?: string;
  what: string;
};

export type ActionableError = {
  ok: false;
  success: false;
  code: string;
  error: string;
  fix: FixHint | null;
};

/** Fix hint for a knowledge entry id (falls back to `fallbackWhere` if the KB can't load). */
export function fixHintFor(entryId: string, what: string, fallbackWhere: string): FixHint {
  try {
    const e = getKnowledgeBase().byId.get(entryId);
    if (e)
      return {
        where: e.breadcrumb.join(" › "),
        route: e.route,
        targets: e.targets,
        tab: e.tab,
        what,
      };
  } catch {
    /* fall through */
  }
  return { where: fallbackWhere, targets: [entryId], what };
}

export function actionableError(code: string, error: string, fix: FixHint | null): ActionableError {
  return {
    ok: false,
    success: false,
    code,
    error: fix ? `${error} Fix: ${fix.what} (${fix.where}).` : error,
    fix,
  };
}

export const GMAIL_NOT_CONNECTED = () =>
  actionableError(
    "gmail_not_connected",
    "No Gmail account is connected to InfiniBot yet.",
    fixHintFor(
      "flow:connect-gmail",
      "Open Inbox → Manage accounts → + Add account → Gmail → Open Google consent",
      "Chat & Voice › Inbox",
    ),
  );

/**
 * Coder CLI failures: missing binary vs not signed in → Setup › Coders.
 * Returns extra fields to spread into the tool result ({} when unrelated).
 */
export function coderFailureHint(error: string | undefined): {
  code?: string;
  fix?: FixHint;
  /** Beginner-friendly line the agent should relay instead of the raw error. */
  userMessage?: string;
} {
  const e = String(error ?? "");
  if (
    isCoderMissingError(e) ||
    /ENOENT|command not found|not found in PATH|no such file|is not installed|not installed/i.test(
      e,
    )
  ) {
    return {
      code: "coder_not_installed",
      userMessage: formatHumanizedError(humanizeCoderMissing(), { icon: false }),
      fix: fixHintFor(
        "flow:install-coder",
        "Install the coding CLI (Install on its card), then Sign in",
        "Settings › Setup › Coders",
      ),
    };
  }
  if (
    /not (logged|signed) in|log ?in required|please (log|sign) in|unauthori[sz]ed|\b401\b|invalid api key|authentication|OAuth token/i.test(
      e,
    )
  ) {
    return {
      code: "coder_not_signed_in",
      fix: fixHintFor(
        "flow:install-coder",
        "Sign in on the coder's card (or Save key)",
        "Settings › Setup › Coders",
      ),
    };
  }
  return {};
}
