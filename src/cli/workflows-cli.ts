/**
 * Workflows CLI — Instruction workflow management
 */

import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

export function registerWorkflowsCli(program: Command) {
  const workflows = program
    .command("workflows")
    .description("Manage instruction workflows");

  addGatewayClientOptions(
    workflows.command("list")
      .description("List all workflows")
      .option("--tags <tags>", "Filter by tags")
      .option("--limit <n>", "Maximum items to show", "20")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("workflows.list", opts, {
            tags: opts.tags,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const items = (result as any).workflows || [];
            if (items.length === 0) {
              console.log("No workflows found.");
              return;
            }

            console.log("Workflows");
            console.log("─".repeat(60));
            
            for (const wf of items) {
              const tags = wf.tags ? `[${wf.tags}]` : "";
              console.log(`${wf.id.slice(0, 8)} | ${wf.name} ${tags}`);
              if (wf.description) {
                console.log(`         | ${wf.description.slice(0, 50)}...`);
              }
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    workflows.command("get")
      .description("Get a workflow")
      .argument("<id>", "Workflow ID")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          const result = await callGatewayFromCli("workflows.get", opts, { id });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const wf = (result as any).workflow;
            if (!wf) {
              console.log("Workflow not found.");
              return;
            }

            console.log(`# ${wf.name}`);
            if (wf.description) console.log(`Description: ${wf.description}`);
            if (wf.tags) console.log(`Tags: ${wf.tags}`);
            console.log("─".repeat(40));
            console.log(wf.body || "(empty)");
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    workflows.command("create")
      .description("Create a workflow")
      .requiredOption("--name <name>", "Workflow name")
      .option("--body <content>", "Workflow body (markdown instructions)")
      .option("--description <desc>", "Description")
      .option("--tags <tags>", "Comma-separated tags")
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

          const result = await callGatewayFromCli("workflows.create", opts, {
            name: opts.name,
            body: body || "",
            description: opts.description,
            tags: opts.tags,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Created workflow: ${(result as any).workflow?.id || "unknown"}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    workflows.command("update")
      .description("Update a workflow")
      .argument("<id>", "Workflow ID")
      .option("--name <name>", "New name")
      .option("--body <content>", "New body")
      .option("--description <desc>", "New description")
      .option("--tags <tags>", "New tags")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          const result = await callGatewayFromCli("workflows.update", opts, {
            id,
            name: opts.name,
            body: opts.body,
            description: opts.description,
            tags: opts.tags,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Updated workflow: ${id}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    workflows.command("delete")
      .description("Delete a workflow")
      .argument("<id>", "Workflow ID")
      .option("--force", "Skip confirmation", false)
      .action(async (id, opts) => {
        try {
          await callGatewayFromCli("workflows.delete", opts, { id });
          console.log(`✓ Deleted workflow: ${id}`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    workflows.command("search")
      .description("Search workflows")
      .argument("<query>", "Search query")
      .option("--tags <tags>", "Filter by tags")
      .option("--limit <n>", "Maximum results", "10")
      .option("--json", "Output as JSON", false)
      .action(async (query, opts) => {
        try {
          const result = await callGatewayFromCli("workflows.search", opts, {
            query,
            tags: opts.tags,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const items = (result as any).workflows || [];
            if (items.length === 0) {
              console.log("No matching workflows found.");
              return;
            }

            console.log(`Found ${items.length} workflows:`);
            console.log("─".repeat(60));
            
            for (const wf of items) {
              console.log(`${wf.id.slice(0, 8)} | ${wf.name}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    workflows.command("run")
      .description("Run a workflow (send to agent)")
      .argument("<id>", "Workflow ID")
      .option("--agent <agent>", "Agent to run workflow", "main")
      .option("--context <context>", "Additional context")
      .option("--json", "Output as JSON", false)
      .action(async (id, opts) => {
        try {
          // Get workflow
          const wfResult = await callGatewayFromCli("workflows.get", opts, { id });
          const workflow = (wfResult as any).workflow;
          
          if (!workflow) {
            console.error("Workflow not found.");
            process.exit(1);
          }

          // Send to agent
          const message = opts.context 
            ? `Execute this workflow:\n\n${workflow.body}\n\nContext: ${opts.context}`
            : `Execute this workflow:\n\n${workflow.body}`;

          const result = await callGatewayFromCli("agent.run", opts, {
            agent: opts.agent,
            message,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Running workflow "${workflow.name}" with agent ${opts.agent}...`);
            console.log("─".repeat(40));
            console.log((result as any).response || "(no response)");
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );
}
