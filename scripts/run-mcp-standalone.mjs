import { runMcpServer } from "../dist/mcp/server.js";

const port = 8889;
console.log(`Starting standalone MCP server on port ${port}...`);

runMcpServer({
    httpPort: port,
    verbose: true
}).catch(err => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
});
