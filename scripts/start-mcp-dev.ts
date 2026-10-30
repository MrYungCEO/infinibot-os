
import { runMcpServer } from "../src/mcp/server.js";

console.log("Starting MCP Server via TSX...");
runMcpServer({
    httpPort: 8889,
    verbose: true
}).catch(err => {
    console.error("MCP Server crashed:", err);
    process.exit(1);
});
