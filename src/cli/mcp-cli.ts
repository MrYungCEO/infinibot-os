import type { Command } from "commander";
import { runMcpServer } from "../mcp/server.js";
import { defaultRuntime } from "../runtime.js";

export function registerMcpCli(program: Command) {
    program
        .command("mcp")
        .description("Run the InfiniBot MCP server")
        .option("--url <url>", "Gateway WebSocket URL")
        .option("--token <token>", "Gateway token")
        .option("--http-port <port>", "HTTP port for MCP bridge", (val) => parseInt(val, 10))
        .option("--verbose, -v", "Verbose logging", false)
        .action(async (opts) => {
            try {
                await runMcpServer({
                    gatewayUrl: opts.url,
                    gatewayToken: opts.token,
                    httpPort: opts.httpPort,
                    verbose: opts.verbose,
                });
            } catch (err) {
                defaultRuntime.error(String(err));
                defaultRuntime.exit(1);
            }
        });
}
