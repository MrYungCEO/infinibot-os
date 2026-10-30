/**
 * Workspace CLI — Agent workspace file management
 */

import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";

export function registerWorkspaceCli(program: Command) {
  const workspace = program
    .command("workspace")
    .description("Agent workspace file management");

  workspace.command("info")
    .description("Show workspace information")
    .option("--agent <agent>", "Agent ID", "main")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const agents = config.agents as Record<string, { workspace?: string }> | undefined;
        const agentConfig = agents?.[opts.agent];
        
        if (!agentConfig?.workspace) {
          console.error(`No workspace configured for agent: ${opts.agent}`);
          process.exit(1);
        }

        const workspacePath = agentConfig.workspace;
        const exists = fs.existsSync(workspacePath);
        
        let files: string[] = [];
        if (exists) {
          files = fs.readdirSync(workspacePath).filter(f => !f.startsWith("."));
        }

        if (opts.json) {
          console.log(JSON.stringify({
            agent: opts.agent,
            path: workspacePath,
            exists,
            files,
          }, null, 2));
        } else {
          console.log("Workspace Info");
          console.log("─".repeat(50));
          console.log(`Agent:  ${opts.agent}`);
          console.log(`Path:   ${workspacePath}`);
          console.log(`Exists: ${exists ? "✓" : "✗"}`);
          
          if (files.length > 0) {
            console.log("\nFiles:");
            for (const file of files) {
              console.log(`  ${file}`);
            }
          }
        }
      } catch (err: any) {
        console.error("Failed to get workspace info:", err.message);
        process.exit(1);
      }
    });

  workspace.command("read")
    .description("Read a workspace file")
    .argument("<file>", "File path relative to workspace (e.g., MEMORY.md)")
    .option("--agent <agent>", "Agent ID", "main")
    .action(async (file, opts) => {
      try {
        const config = loadConfig();
        const agents = config.agents as Record<string, { workspace?: string }> | undefined;
        const agentConfig = agents?.[opts.agent];
        
        if (!agentConfig?.workspace) {
          console.error(`No workspace configured for agent: ${opts.agent}`);
          process.exit(1);
        }

        const filePath = path.join(agentConfig.workspace, file);
        
        if (!fs.existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exit(1);
        }

        const content = fs.readFileSync(filePath, "utf-8");
        console.log(content);
      } catch (err: any) {
        console.error("Failed to read file:", err.message);
        process.exit(1);
      }
    });

  workspace.command("write")
    .description("Write a workspace file")
    .argument("<file>", "File path relative to workspace")
    .option("--agent <agent>", "Agent ID", "main")
    .option("--content <content>", "Content to write (or use stdin)")
    .option("--append", "Append instead of overwrite", false)
    .action(async (file, opts) => {
      try {
        const config = loadConfig();
        const agents = config.agents as Record<string, { workspace?: string }> | undefined;
        const agentConfig = agents?.[opts.agent];
        
        if (!agentConfig?.workspace) {
          console.error(`No workspace configured for agent: ${opts.agent}`);
          process.exit(1);
        }

        let content = opts.content;
        
        if (!content && !process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          content = Buffer.concat(chunks).toString("utf-8");
        }

        if (!content) {
          console.error("No content provided. Use --content or pipe via stdin.");
          process.exit(1);
        }

        const filePath = path.join(agentConfig.workspace, file);
        const dir = path.dirname(filePath);
        
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        if (opts.append) {
          fs.appendFileSync(filePath, content);
          console.log(`✓ Appended to: ${filePath}`);
        } else {
          fs.writeFileSync(filePath, content);
          console.log(`✓ Written to: ${filePath}`);
        }
      } catch (err: any) {
        console.error("Failed to write file:", err.message);
        process.exit(1);
      }
    });

  workspace.command("list")
    .description("List workspace files")
    .option("--agent <agent>", "Agent ID", "main")
    .option("--dir <dir>", "Subdirectory", ".")
    .option("--recursive", "List recursively", false)
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const agents = config.agents as Record<string, { workspace?: string }> | undefined;
        const agentConfig = agents?.[opts.agent];
        
        if (!agentConfig?.workspace) {
          console.error(`No workspace configured for agent: ${opts.agent}`);
          process.exit(1);
        }

        const targetDir = path.join(agentConfig.workspace, opts.dir);
        
        if (!fs.existsSync(targetDir)) {
          console.error(`Directory not found: ${targetDir}`);
          process.exit(1);
        }

        const listFiles = (dir: string, prefix = ""): string[] => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const results: string[] = [];
          
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            
            const fullPath = path.join(prefix, entry.name);
            
            if (entry.isDirectory()) {
              results.push(fullPath + "/");
              if (opts.recursive) {
                results.push(...listFiles(path.join(dir, entry.name), fullPath));
              }
            } else {
              results.push(fullPath);
            }
          }
          
          return results;
        };

        const files = listFiles(targetDir);

        if (opts.json) {
          console.log(JSON.stringify({ path: targetDir, files }, null, 2));
        } else {
          if (files.length === 0) {
            console.log("(empty directory)");
          } else {
            for (const file of files) {
              console.log(file);
            }
          }
        }
      } catch (err: any) {
        console.error("Failed to list files:", err.message);
        process.exit(1);
      }
    });

  workspace.command("delete")
    .description("Delete a workspace file")
    .argument("<file>", "File path relative to workspace")
    .option("--agent <agent>", "Agent ID", "main")
    .option("--force", "Skip confirmation", false)
    .action(async (file, opts) => {
      try {
        const config = loadConfig();
        const agents = config.agents as Record<string, { workspace?: string }> | undefined;
        const agentConfig = agents?.[opts.agent];
        
        if (!agentConfig?.workspace) {
          console.error(`No workspace configured for agent: ${opts.agent}`);
          process.exit(1);
        }

        const filePath = path.join(agentConfig.workspace, file);
        
        if (!fs.existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exit(1);
        }

        fs.unlinkSync(filePath);
        console.log(`✓ Deleted: ${filePath}`);
      } catch (err: any) {
        console.error("Failed to delete file:", err.message);
        process.exit(1);
      }
    });

  workspace.command("init")
    .description("Initialize a new agent workspace")
    .option("--agent <agent>", "Agent ID", "main")
    .option("--path <path>", "Workspace path")
    .option("--template <template>", "Template (default/sovereign/minimal)", "default")
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const agents = config.agents as Record<string, { workspace?: string }> | undefined;
        const workspacePath = opts.path || agents?.[opts.agent]?.workspace;
        
        if (!workspacePath) {
          console.error("No workspace path provided. Use --path or configure agents.<id>.workspace");
          process.exit(1);
        }

        if (fs.existsSync(workspacePath)) {
          console.error(`Workspace already exists: ${workspacePath}`);
          console.error("Use workspace write to modify files.");
          process.exit(1);
        }

        fs.mkdirSync(workspacePath, { recursive: true });
        fs.mkdirSync(path.join(workspacePath, "memory"), { recursive: true });

        // Create minimal template files
        const today = new Date().toISOString().split("T")[0];
        
        if (opts.template === "sovereign") {
          console.log("Creating sovereign workspace...");
          console.log("Use 'infinibot ui open --onboarding' for the full sovereign onboarding experience.");
        }

        // Default files
        fs.writeFileSync(
          path.join(workspacePath, "AGENTS.md"),
          `# AGENTS.md — Workspace Guidelines\n\nThis is the agent workspace. Add your own conventions here.\n`
        );
        
        fs.writeFileSync(
          path.join(workspacePath, "MEMORY.md"),
          `# MEMORY.md — Long-Term Memory\n\nImportant things to remember across sessions.\n\n---\n`
        );

        fs.writeFileSync(
          path.join(workspacePath, `memory/${today}.md`),
          `# ${today}\n\nWorkspace initialized.\n`
        );

        console.log(`✓ Initialized workspace: ${workspacePath}`);
        console.log("\nCreated:");
        console.log("  AGENTS.md");
        console.log("  MEMORY.md");
        console.log(`  memory/${today}.md`);
      } catch (err: any) {
        console.error("Failed to initialize workspace:", err.message);
        process.exit(1);
      }
    });
}
