/**
 * Onboarding step: "Import your notes" (Obsidian vault / Notion export).
 *
 * Optional and non-blocking: it queues a background import job
 * (src/documents/import-jobs.ts) that starts right away in this process and
 * keeps going while the rest of onboarding runs. Whatever hasn't finished
 * when the CLI exits is picked up by the gateway on its next boot
 * (resumeImportJobs), so a big vault never holds onboarding up.
 */
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "./prompts.js";

type ImportChoice = "obsidian-folder" | "obsidian-zip" | "obsidian-git" | "notion-zip" | "skip";

export interface NotesImportResult {
  started: boolean;
  jobId?: string;
  kind?: ImportChoice;
}

export async function setupNotesImport(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<NotesImportResult> {
  const { prompter } = params;
  const choice = await prompter.select<ImportChoice>({
    message: "Import your notes? (optional — runs in the background)",
    options: [
      { value: "skip", label: "Not now", hint: "Documents → Import any time" },
      {
        value: "obsidian-folder",
        label: "Obsidian vault folder",
        hint: "wikilinks, tags, attachments",
      },
      { value: "obsidian-zip", label: "Obsidian vault .zip" },
      { value: "obsidian-git", label: "Obsidian vault from a git URL", hint: "public https repo" },
      {
        value: "notion-zip",
        label: "Notion export .zip",
        hint: "Settings → Export → Markdown & CSV",
      },
    ],
    initialValue: "skip",
  });
  if (choice === "skip") return { started: false };

  let source = "";
  for (;;) {
    source = String(
      await prompter.text({
        message:
          choice === "obsidian-git"
            ? "Git URL (https://…)"
            : choice === "obsidian-folder"
              ? "Path to the vault folder"
              : "Path to the .zip file",
        placeholder:
          choice === "obsidian-git"
            ? "https://github.com/you/notes.git"
            : choice === "obsidian-folder"
              ? "~/Documents/My Vault"
              : "~/Downloads/export.zip",
      }),
    ).trim();
    if (!source) return { started: false };
    const problem = checkSource(choice, source);
    if (!problem) break;
    await prompter.note(problem, "Import your notes");
  }

  let createTasks = false;
  if (choice.startsWith("obsidian")) {
    createTasks = await prompter.confirm({
      message: "Also turn “- [ ]” checklist items into kanban tasks?",
      initialValue: false,
    });
  }

  const { importJobs } = await import("../documents/import-jobs.js");
  const jobs = await importJobs();
  let jobId: string;
  if (choice === "obsidian-folder") {
    jobId = jobs.startObsidian({
      source: "folder",
      origin: resolveUserPath(source),
      parentId: null,
      createTasks,
    }).job.id;
  } else if (choice === "obsidian-git") {
    jobId = jobs.startObsidian({ source: "git", origin: source, parentId: null, createTasks }).job
      .id;
  } else {
    const file = resolveUserPath(source);
    const data = fs.readFileSync(file);
    jobId =
      choice === "notion-zip"
        ? jobs.startZip({ data, name: path.basename(file), parentId: null }).id
        : jobs.startObsidian({
            source: "zip",
            origin: path.basename(file),
            data,
            parentId: null,
            createTasks,
          }).job.id;
  }
  await prompter.note(
    [
      "Your notes are importing in the background — setup continues now.",
      "They appear under Documents (and in the knowledge graph) as they land.",
      "If setup finishes first, InfiniBot picks the import up again when it starts.",
      "Undo it any time from Documents → Import.",
    ].join("\n"),
    "Import your notes",
  );
  return { started: true, jobId, kind: choice };
}

/** User-facing problem with the chosen source, or null when it looks usable. */
export function checkSource(choice: ImportChoice, raw: string): string | null {
  if (choice === "obsidian-git") {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:") return "Only https:// git URLs are supported.";
      if (u.username || u.password) return "Leave credentials out of the URL (public repos only).";
      return null;
    } catch {
      return "That isn't a URL — it should look like https://github.com/you/notes.git";
    }
  }
  const p = resolveUserPath(raw);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return `Not found: ${p}`;
  }
  if (choice === "obsidian-folder")
    return st.isDirectory() ? null : "That's a file — pick the vault folder.";
  if (!st.isFile() || !/\.zip$/i.test(p)) return "Pick a .zip file.";
  return null;
}
