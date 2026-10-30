/**
 * Research CLI — Research document management
 */

import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

export function registerResearchCli(program: Command) {
  const research = program
    .command("research")
    .description("Manage research documents");

  addGatewayClientOptions(
    research.command("list")
      .description("List research documents")
      .option("--topic <topic>", "Filter by topic")
      .option("--status <status>", "Filter by status (draft/active/complete/archived)")
      .option("--limit <n>", "Maximum items to show", "20")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("research.list", opts, {
            topic: opts.topic,
            status: opts.status,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const items = (result as any).research || [];
            if (items.length === 0) {
              console.log("No research documents found.");
              return;
            }

            console.log("Research Documents");
            console.log("─".repeat(60));
            
            for (const doc of items) {
              const status = doc.status ? `[${doc.status}]` : "";
              const topic = doc.topic ? `(${doc.topic})` : "";
              console.log(`${doc.id.slice(0, 8)} | ${doc.name} ${status} ${topic}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    research.command("get")
      .description("Get a research document")
      .argument("<id>", "Research ID")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          const result = await callGatewayFromCli("research.get", opts, { id });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const doc = (result as any).research;
            if (!doc) {
              console.log("Research not found.");
              return;
            }

            console.log(`# ${doc.name}`);
            if (doc.topic) console.log(`Topic: ${doc.topic}`);
            if (doc.status) console.log(`Status: ${doc.status}`);
            if (doc.tags) console.log(`Tags: ${doc.tags}`);
            if (doc.sources) console.log(`Sources: ${doc.sources}`);
            console.log("─".repeat(40));
            console.log(doc.body || "(empty)");
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    research.command("create")
      .description("Create a research document")
      .requiredOption("--name <name>", "Document name/title")
      .option("--body <content>", "Document content")
      .option("--topic <topic>", "Research topic")
      .option("--status <status>", "Status (draft/active/complete/archived)", "draft")
      .option("--tags <tags>", "Comma-separated tags")
      .option("--sources <sources>", "Sources/references")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          let body = opts.body;
          
          if (!body && !process.stdin.isTTY) {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) {
              chunks.push(chunk);
            }
            body = Buffer.concat(chunks).toString("utf-8");
          }

          const result = await callGatewayFromCli("research.create", opts, {
            name: opts.name,
            body: body || "",
            topic: opts.topic,
            status: opts.status,
            tags: opts.tags,
            sources: opts.sources,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Created research: ${(result as any).research?.id || "unknown"}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    research.command("update")
      .description("Update a research document")
      .argument("<id>", "Research ID")
      .option("--name <name>", "New name")
      .option("--body <content>", "New content")
      .option("--topic <topic>", "New topic")
      .option("--status <status>", "New status")
      .option("--tags <tags>", "New tags")
      .option("--sources <sources>", "New sources")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          const result = await callGatewayFromCli("research.update", opts, {
            id,
            name: opts.name,
            body: opts.body,
            topic: opts.topic,
            status: opts.status,
            tags: opts.tags,
            sources: opts.sources,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Updated research: ${id}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    research.command("delete")
      .description("Delete a research document")
      .argument("<id>", "Research ID")
      .option("--force", "Skip confirmation", false)
      .action(async (id, opts) => {
        try {
          await callGatewayFromCli("research.delete", opts, { id });
          console.log(`✓ Deleted research: ${id}`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    research.command("search")
      .description("Search research documents")
      .argument("<query>", "Search query")
      .option("--topic <topic>", "Filter by topic")
      .option("--status <status>", "Filter by status")
      .option("--tags <tags>", "Filter by tags")
      .option("--limit <n>", "Maximum results", "10")
      .option("--json", "Output as JSON", false)
      .action(async (query, opts) => {
        try {
          const result = await callGatewayFromCli("research.search", opts, {
            query,
            topic: opts.topic,
            status: opts.status,
            tags: opts.tags,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const items = (result as any).research || [];
            if (items.length === 0) {
              console.log("No matching research found.");
              return;
            }

            console.log(`Found ${items.length} documents:`);
            console.log("─".repeat(60));
            
            for (const doc of items) {
              console.log(`${doc.id.slice(0, 8)} | ${doc.name}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );
}
