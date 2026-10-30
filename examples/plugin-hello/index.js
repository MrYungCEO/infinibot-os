// Hello — plugin entry. Runs inside the InfiniBot gateway.
// Everything registered here must be declared in infinibot.plugin.json
// ("contributes"); the host rejects undeclared RPC methods, routes and tools.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function greet(api, who) {
  const greeting = api.pluginConfig?.greeting || "Hello";
  const name = typeof who === "string" && who.trim() ? who.trim().slice(0, 80) : "world";
  return `${greeting}, ${name}!`;
}

export default {
  id: "hello",
  name: "Hello",

  register(api) {
    // Gateway RPC — callable from the UI panel and other gateway clients.
    api.registerGatewayMethod("hello.greet", ({ params, respond }) => {
      respond(true, { message: greet(api, params?.name) });
    });

    // Agent tool — agents can call it once the plugin is on.
    api.registerTool({
      name: "hello_greet",
      label: "Hello: greet",
      description: "Return a friendly greeting for a name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Who to greet" } },
      },
      async execute(_toolCallId, params) {
        const message = greet(api, params?.name);
        return { content: [{ type: "text", text: message }], details: { message } };
      },
    });

    // UI panel module. publicAsset: the browser imports it as an ES module,
    // which can't send credentials — so serve only static code here.
    const panel = readFileSync(join(here, "ui.js"), "utf-8");
    api.registerHttpRoute({
      path: "/plugins/hello/ui.js",
      publicAsset: true,
      handler: (_req, res) => {
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(panel);
      },
    });

    api.logger.info("hello: ready");
  },
};
