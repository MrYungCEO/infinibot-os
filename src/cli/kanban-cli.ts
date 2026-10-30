/**
 * Kanban CLI — Task and project management
 */

import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

export function registerKanbanCli(program: Command) {
  const kanban = program
    .command("kanban")
    .description("Task and project management");

  // ─── Tasks ────────────────────────────────────────────────────────────────

  addGatewayClientOptions(
    kanban.command("tasks")
      .description("List tasks")
      .option("--status <status>", "Filter by status (backlog/todo/in_progress/review/done)")
      .option("--project <id>", "Filter by project ID")
      .option("--assignee <id>", "Filter by assignee")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("kanban.tasks.list", opts, {
            filter_status: opts.status,
            filter_project: opts.project,
            filter_assignee: opts.assignee,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const tasks = (result as any).tasks || [];
            if (tasks.length === 0) {
              console.log("No tasks found.");
              return;
            }

            console.log("Tasks");
            console.log("─".repeat(60));
            
            for (const task of tasks) {
              const status = task.status?.toUpperCase() || "UNKNOWN";
              const priority = task.priority ? `[${task.priority}]` : "";
              console.log(`${task.id.slice(0, 8)} | ${status.padEnd(12)} | ${priority.padEnd(10)} | ${task.title}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    kanban.command("task:create")
      .description("Create a new task")
      .requiredOption("--title <title>", "Task title")
      .option("--description <desc>", "Task description")
      .option("--project <id>", "Project ID")
      .option("--priority <level>", "Priority (low/medium/high/critical)", "medium")
      .option("--assignee <id>", "Assignee ID")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("kanban.tasks.create", opts, {
            title: opts.title,
            description: opts.description,
            project_id: opts.project,
            priority: opts.priority,
            assignee: opts.assignee,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Created task: ${(result as any).task?.id || "unknown"}`);
            console.log(`  Title: ${opts.title}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    kanban.command("task:update")
      .description("Update a task")
      .requiredOption("--id <id>", "Task ID")
      .option("--title <title>", "New title")
      .option("--status <status>", "New status (backlog/todo/in_progress/review/done)")
      .option("--priority <level>", "New priority (low/medium/high/critical)")
      .option("--description <desc>", "New description")
      .option("--assignee <id>", "New assignee")
      .option(
        "--source <source>",
        "Who is making the change: user/agent/bulk/automation (bulk + automation completions don't count toward Business HQ progress)",
      )
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("kanban.tasks.update", opts, {
            id: opts.id,
            ...(opts.source ? { source: opts.source } : {}),
            title: opts.title,
            status: opts.status,
            priority: opts.priority,
            description: opts.description,
            assignee: opts.assignee,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Updated task: ${opts.id}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  // ─── Projects ─────────────────────────────────────────────────────────────

  addGatewayClientOptions(
    kanban.command("projects")
      .description("List projects")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("kanban.projects.list", opts, {});

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const projects = (result as any).projects || [];
            if (projects.length === 0) {
              console.log("No projects found.");
              return;
            }

            console.log("Projects");
            console.log("─".repeat(60));
            
            for (const proj of projects) {
              console.log(`${proj.id.slice(0, 8)} | ${proj.name}`);
              if (proj.description) {
                console.log(`         | ${proj.description.slice(0, 50)}...`);
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
    kanban.command("project:create")
      .description("Create a new project")
      .requiredOption("--name <name>", "Project name")
      .option("--description <desc>", "Project description")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("kanban.projects.create", opts, {
            project_name: opts.name,
            project_description: opts.description,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Created project: ${(result as any).project?.id || "unknown"}`);
            console.log(`  Name: ${opts.name}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  // ─── Board View ───────────────────────────────────────────────────────────

  addGatewayClientOptions(
    kanban.command("board")
      .description("Show kanban board (grouped by status)")
      .option("--project <id>", "Filter by project ID")
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("kanban.tasks.list", opts, {
            filter_project: opts.project,
          });

          const tasks = (result as any).tasks || [];
          const columns: Record<string, any[]> = {
            backlog: [],
            todo: [],
            in_progress: [],
            review: [],
            done: [],
          };

          for (const task of tasks) {
            const status = task.status || "backlog";
            if (columns[status]) {
              columns[status].push(task);
            }
          }

          console.log("\n╔════════════╦════════════╦════════════╦════════════╦════════════╗");
          console.log("║  BACKLOG   ║    TODO    ║ IN PROGRESS║   REVIEW   ║    DONE    ║");
          console.log("╠════════════╬════════════╬════════════╬════════════╬════════════╣");

          const maxRows = Math.max(
            ...Object.values(columns).map(col => col.length),
            1
          );

          for (let i = 0; i < maxRows; i++) {
            const row = Object.keys(columns).map(status => {
              const task = columns[status][i];
              if (!task) return "          ";
              const title = task.title.slice(0, 10).padEnd(10);
              return title;
            });
            console.log(`║ ${row.join(" ║ ")} ║`);
          }

          console.log("╚════════════╩════════════╩════════════╩════════════╩════════════╝\n");

          // Summary
          console.log("Summary:");
          for (const [status, items] of Object.entries(columns)) {
            if (items.length > 0) {
              console.log(`  ${status}: ${items.length} tasks`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );
}
