/**
 * Project repos — UI entry. Importing this registers <ib-repo-badge> and
 * <ib-repo-picker>; `renderRepoDirButton` is the drop-in "Projects with
 * repos" button for any directory input.
 */

import { html } from "lit";
import { BRANCH_ICON, openRepoPicker, type RepoPickerOptions } from "./repo-picker";
import "./repo-badge";
import "./deploy-card";

export * from "./store";
export { openRepoPicker, BRANCH_ICON } from "./repo-picker";
export { openReposPage } from "./deploy-card";
export type { RepoPickerOptions, RepoPickerResult } from "./repo-picker";

/**
 * A small button for directory inputs that opens the shared picker in
 * directory mode ("Projects with repos" first) and hands back the path.
 */
export function renderRepoDirButton(
  onPick: (path: string, projectId?: string) => void,
  opts: Partial<Omit<RepoPickerOptions, "mode">> & { label?: string } = {},
) {
  const { label = "Projects with repos", ...pickerOpts } = opts;
  return html`<button
    type="button"
    class="btn btn--sm ib-repo-dir-btn"
    data-repo-dir-picker
    title="Pick a folder — projects with repos, recent repos, or browse"
    style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap;flex:none;padding:6px 10px;border-radius:8px;border:1px solid rgba(212,175,55,0.4);background:rgba(212,175,55,0.1);color:var(--g-primary,#d4af37);font:inherit;font-size:12px;cursor:pointer"
    @click=${async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await openRepoPicker({ mode: "directory", ...pickerOpts });
      if (res?.path) onPick(res.path, res.projectId);
    }}
  >
    ${BRANCH_ICON}<span>${label}</span>
  </button>`;
}
