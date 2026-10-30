import { describe, expect, it } from "vitest";

import type { JsonSchema } from "./config-form";
import { resolveChannelSchemaNode } from "./channels.config";

describe("resolveChannelSchemaNode", () => {
  it("returns the channel node when the gateway shipped a schema for it", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          additionalProperties: true,
          properties: {
            discord: {
              type: "object",
              properties: { token: { type: "string" } },
            },
          },
        },
      },
    };
    const res = resolveChannelSchemaNode(schema, ["channels", "discord"]);
    expect(res.kind).toBe("found");
    if (res.kind === "found") {
      expect(res.node.properties?.token).toBeDefined();
    }
  });

  it("returns missing-no-schema when the parent allows additional channels but this one has no entry", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          additionalProperties: true,
          properties: {},
        },
      },
    };
    const res = resolveChannelSchemaNode(schema, ["channels", "twitch"]);
    expect(res.kind).toBe("missing-no-schema");
  });

  it("returns missing-strict when the parent explicitly forbids extras", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    };
    const res = resolveChannelSchemaNode(schema, ["channels", "twitch"]);
    expect(res.kind).toBe("missing-strict");
  });

  it("returns missing-no-root when the schema is null", () => {
    const res = resolveChannelSchemaNode(null, ["channels", "discord"]);
    expect(res.kind).toBe("missing-no-root");
  });

  it("walks into additionalProperties when it's an object schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { generic: { type: "string" } },
          },
        },
      },
    };
    const res = resolveChannelSchemaNode(schema, ["channels", "anything"]);
    expect(res.kind).toBe("found");
    if (res.kind === "found") {
      expect(res.node.properties?.generic).toBeDefined();
    }
  });

  it("never confuses the missing-no-schema case with a found leaf", () => {
    // The Telegram schema, with additionalProperties: true on `channels`
    // and a `telegram` property present. Resolving `imessage` (with no
    // entry) should be missing-no-schema, not missing-strict.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          additionalProperties: true,
          properties: {
            telegram: {
              type: "object",
              properties: { botToken: { type: "string" } },
            },
          },
        },
      },
    };
    const telegram = resolveChannelSchemaNode(schema, ["channels", "telegram"]);
    expect(telegram.kind).toBe("found");
    const imessage = resolveChannelSchemaNode(schema, ["channels", "imessage"]);
    expect(imessage.kind).toBe("missing-no-schema");
  });
});
