/**
 * Notes CLI — Quick capture note management
 */

import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

export function registerNotesCli(program: Command) {
  const notes = program.command("notes").description("Manage quick-capture notes");

  addGatewayClientOptions(
    notes
      .command("list")
      .description("List all notes")
      .option("--category <category>", "Filter by category")
      .option("--project-id <id>", "Filter by kanban project")
      .option("--pinned", "Show only pinned notes", false)
      .option("--limit <n>", "Maximum notes to show", "20")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("notes.list", opts, {
            category: opts.category,
            projectId: opts.projectId,
            pinned: opts.pinned || undefined,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const items = (result as any).notes || [];
            if (items.length === 0) {
              console.log("No notes found.");
              return;
            }

            console.log("Notes");
            console.log("─".repeat(60));

            for (const note of items) {
              const pin = note.pinned ? "📌 " : "   ";
              const cat = note.category ? `[${note.category}]` : "";
              console.log(`${pin}${note.id.slice(0, 8)} | ${note.name} ${cat}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    notes
      .command("get")
      .description("Get a note by ID")
      .argument("<id>", "Note ID")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          const result = await callGatewayFromCli("notes.get", opts, { id });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const note = (result as any).note;
            if (!note) {
              console.log("Note not found.");
              return;
            }

            console.log(`# ${note.name}`);
            if (note.category) console.log(`Category: ${note.category}`);
            if (note.tags) console.log(`Tags: ${note.tags}`);
            console.log("─".repeat(40));
            console.log(note.body || "(empty)");
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    notes
      .command("create")
      .description("Create a new note")
      .requiredOption("--name <name>", "Note name/title")
      .option("--body <content>", "Note content (or use stdin)")
      .option("--category <category>", "Category")
      .option("--tags <tags>", "Comma-separated tags")
      .option("--project-id <id>", "Link to kanban project")
      .option("--pinned", "Pin the note", false)
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          let body = opts.body;

          // Read from stdin if no body provided
          if (!body && !process.stdin.isTTY) {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) {
              chunks.push(chunk);
            }
            body = Buffer.concat(chunks).toString("utf-8");
          }

          const result = await callGatewayFromCli("notes.create", opts, {
            name: opts.name,
            body: body || "",
            category: opts.category,
            tags: opts.tags,
            projectId: opts.projectId,
            pinned: opts.pinned,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Created note: ${(result as any).note?.id || "unknown"}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    notes
      .command("update")
      .description("Update a note")
      .argument("<id>", "Note ID")
      .option("--name <name>", "New name")
      .option("--body <content>", "New content")
      .option("--category <category>", "New category")
      .option("--tags <tags>", "New tags")
      .option("--project-id <id>", "Link to kanban project (empty string to unlink)")
      .option("--pinned <bool>", "Pin/unpin")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          const result = await callGatewayFromCli("notes.update", opts, {
            id,
            name: opts.name,
            body: opts.body,
            category: opts.category,
            tags: opts.tags,
            projectId: opts.projectId,
            pinned: opts.pinned === "true" ? true : opts.pinned === "false" ? false : undefined,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Updated note: ${id}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    notes
      .command("delete")
      .description("Delete a note")
      .argument("<id>", "Note ID")
      .option("--force", "Skip confirmation", false)
      .action(async (id, opts) => {
        try {
          await callGatewayFromCli("notes.delete", opts, { id });
          console.log(`✓ Deleted note: ${id}`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    notes
      .command("search")
      .description("Search notes")
      .argument("<query>", "Search query")
      .option("--category <category>", "Filter by category")
      .option("--tags <tags>", "Filter by tags")
      .option("--limit <n>", "Maximum results", "10")
      .option("--json", "Output as JSON", false)
      .action(async (query, opts) => {
        try {
          const result = await callGatewayFromCli("notes.search", opts, {
            query,
            category: opts.category,
            tags: opts.tags,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const items = (result as any).notes || [];
            if (items.length === 0) {
              console.log("No matching notes found.");
              return;
            }

            console.log(`Found ${items.length} notes:`);
            console.log("─".repeat(60));

            for (const note of items) {
              console.log(`${note.id.slice(0, 8)} | ${note.name}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
