/**
 * Shared read/convert path for a project attachment's extracted markdown.
 *
 * At UPLOAD time (`kanban.projects.content.uploadAttachment`) each file is
 * converted to markdown and the `.md` is written under
 * `<state-dir>/files/<markdownPath>` with the relative path stored on the
 * attachment row. This helper resolves + reads that markdown, and — for older
 * attachments or a failed initial conversion — lazily re-converts from the
 * original bytes and persists the new `markdownPath` back to the store.
 *
 * Consumers:
 *   - the agent kanban tool `get_file` action (native + CLI-via-MCP),
 *   - the `kanban.files.getMarkdown` RPC (remote / satellite callers),
 *   - the project-summary context gatherer.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { getKanbanStore, type ProjectAttachment } from "../tasks/store.js";
import { convertToMarkdown } from "./convert.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("attachment-markdown");

/** Default hard cap on returned markdown length (chars). */
export const ATTACHMENT_MARKDOWN_CAP = 200_000;

export interface AttachmentMarkdownResult {
  markdown: string;
  name: string;
  mimeType?: string;
  /** Length (chars) of the returned (possibly-truncated) markdown. */
  charCount: number;
  /** True when the markdown was capped. */
  truncated: boolean;
  /** Where the markdown came from. */
  source: "cached" | "converted" | "empty";
}

/** Root of the per-profile file store (`<state-dir>/files`). */
function filesRoot(): string {
  return path.join(resolveStateDir(), "files");
}

function applyCap(markdown: string, cap: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= cap) return { markdown, truncated: false };
  return {
    markdown: `${markdown.slice(0, cap)}\n\n_…truncated: ${markdown.length} chars total, capped at ${cap}._`,
    truncated: true,
  };
}

/**
 * Resolve the extracted markdown for a single attachment.
 *
 * Order: (1) read the cached `markdownPath`; (2) if missing/empty, read the
 * original bytes and run `convertToMarkdown`, persisting the fresh markdown +
 * `markdownPath` back to the store; (3) apply the char cap.
 */
export async function readAttachmentMarkdown(
  att: ProjectAttachment,
  opts: { cap?: number; persist?: boolean } = {},
): Promise<AttachmentMarkdownResult> {
  const cap = opts.cap ?? ATTACHMENT_MARKDOWN_CAP;
  const root = filesRoot();
  let markdown = "";
  let source: AttachmentMarkdownResult["source"] = "empty";

  // 1. Cached markdown from upload-time conversion.
  if (att.markdownPath) {
    try {
      markdown = await fsp.readFile(path.join(root, att.markdownPath), "utf8");
      if (markdown.trim()) source = "cached";
    } catch {
      markdown = "";
    }
  }

  // 2. On-demand conversion fallback (older attachment or failed conversion).
  if (!markdown.trim() && att.path) {
    try {
      const buf = await fsp.readFile(path.join(root, att.path));
      const res = await convertToMarkdown(att.name, buf, att.mimeType);
      markdown = res.markdown ?? "";
      if (markdown.trim()) {
        source = "converted";
        // Persist the fresh markdown + path back to the store (best-effort).
        if (opts.persist !== false) {
          try {
            const base = att.sha256 || att.id;
            const mdRel = `projects/${att.projectId}/${base}.md`;
            const mdAbs = path.join(root, mdRel);
            await fsp.mkdir(path.dirname(mdAbs), { recursive: true });
            await fsp.writeFile(mdAbs, markdown, "utf8");
            getKanbanStore().updateProjectAttachmentMarkdownPath(att.id, mdRel);
          } catch (persistErr) {
            log.warn(`could not persist converted markdown for ${att.id}: ${String(persistErr)}`);
          }
        }
      }
    } catch (convErr) {
      log.warn(`on-demand conversion failed for ${att.id} (${att.name}): ${String(convErr)}`);
    }
  }

  const capped = applyCap(markdown, cap);
  return {
    markdown: capped.markdown,
    name: att.name,
    mimeType: att.mimeType,
    charCount: capped.markdown.length,
    truncated: capped.truncated,
    source,
  };
}
