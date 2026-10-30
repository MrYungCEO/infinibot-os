import { z } from "zod";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { getTransferEngine } from "../../federation/file-transfer/transfer-engine.js";
import { listInboxFiles } from "../../federation/file-transfer/storage.js";
import { getFederationHub } from "../../federation/index.js";
import { existsSync } from "node:fs";

export const fileTransferHandlers: GatewayRequestHandlers = {
  "fileTransfer.list": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const parsed = z
        .object({ status: z.string().optional(), direction: z.string().optional() })
        .parse(opts.params ?? {});
      const transfers = getTransferEngine().listTransfers({
        status: parsed.status,
        direction: parsed.direction,
      });
      opts.respond(true, { transfers });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "LIST_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.get": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(opts.params);
      const transfer = getTransferEngine().getTransfer(id);
      opts.respond(true, { transfer });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "GET_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.send": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const parsed = z
        .object({
          filePath: z.string(),
          toNodes: z.array(z.string()).min(1),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(opts.params);

      if (!existsSync(parsed.filePath)) {
        opts.respond(false, undefined, {
          code: "SEND_ERROR",
          message: `File not found: ${parsed.filePath}`,
        });
        return;
      }

      const transferId = await getTransferEngine().sendFile({
        filePath: parsed.filePath,
        toNodes: parsed.toNodes,
        metadata: parsed.metadata,
      });
      opts.respond(true, { transferId });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "SEND_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.pause": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(opts.params);
      getTransferEngine().pauseTransfer(id);
      opts.respond(true, { ok: true });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "PAUSE_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.resume": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(opts.params);
      getTransferEngine().resumeTransfer(id);
      opts.respond(true, { ok: true });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "RESUME_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.cancel": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(opts.params);
      getTransferEngine().cancelTransfer(id);
      opts.respond(true, { ok: true });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "CANCEL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.inbox.list": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const files = listInboxFiles();
      opts.respond(true, { files });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INBOX_LIST_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "fileTransfer.peers.list": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const hub = getFederationHub();
      if (!hub) {
        opts.respond(true, { peers: [] });
        return;
      }

      const nodes = hub.getConnectedNodes?.() ?? [];
      const peers = nodes.map((n) => ({
        id: n.id,
        name: n.manifest?.name ?? n.id,
        online: n.state === "registered",
        capability: { fileTransfer: true },
        lastSeen: n.lastHeartbeat ?? n.connectedAt ?? Date.now(),
      }));

      opts.respond(true, { peers });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "PEERS_LIST_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
