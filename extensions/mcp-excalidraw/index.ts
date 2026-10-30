import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";
import { emptyPluginConfigSchema } from "infinibot/plugin-sdk";
import { onGatewayBroadcasterReady } from "../../src/agents/coder-runtime/subagent-broadcast.js";
import { createAgentTools } from "./src/agent-tools.js";
import { WhiteboardStore } from "./src/board-store.js";
import { configureLocalCanvasBridge } from "./src/gateway-bridge.js";
import { createWhiteboardHandlers } from "./src/rpc.js";

export default {
  id: "whiteboard",
  name: "Whiteboard",
  description: "Local-first Excalidraw boards with an agent-drivable canvas.",
  configSchema: emptyPluginConfigSchema(),
  register(api: InfiniBotPluginApi) {
    const store = new WhiteboardStore(api.runtime.state.resolveStateDir());
    void store.initialize().catch((error) => api.logger.warn(`whiteboard migration failed: ${String(error)}`));
    onGatewayBroadcasterReady((broadcast) => configureLocalCanvasBridge({
      update: (elements) => broadcast("canvas.update", { elements }),
      view: (params) => broadcast("canvas.view", params),
      clear: () => broadcast("canvas.clear", {}),
    }));
    for (const [method, handler] of Object.entries(createWhiteboardHandlers(store))) api.registerGatewayMethod(method, handler);
    for (const tool of createAgentTools()) api.registerTool(tool, { optional: false });
  },
};
