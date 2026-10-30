import { afterEach, describe, expect, it, vi } from "vitest";

import * as vaultDiscord from "../vault/discord.js";
import {
  emitDiscordCommunityEvent,
  hasDiscordCommunityListeners,
  onDiscordCommunityEvent,
  snowflakeToMs,
} from "./community-events.js";
import { CommunityButton, CommunitySelect } from "./monitor/community-components.js";
import {
  DiscordCommunityMemberAddListener,
  DiscordCommunityMemberRemoveListener,
} from "./monitor/listeners.js";

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});

describe("discord community event bus", () => {
  it("fans out to listeners and returns the first component reply", async () => {
    const seen: string[] = [];
    offs.push(onDiscordCommunityEvent((e) => void seen.push(`a:${e.kind}`)));
    offs.push(onDiscordCommunityEvent(() => ({ content: "first" })));
    offs.push(onDiscordCommunityEvent(() => ({ content: "second" })));
    expect(hasDiscordCommunityListeners()).toBe(true);
    const reply = await emitDiscordCommunityEvent({
      kind: "component",
      accountId: "ycs",
      guildId: "1",
      channelId: "2",
      user: { id: "3", username: "u" },
      customId: "cm:a=verify",
      values: [],
    });
    expect(reply).toEqual({ content: "first" });
    expect(seen).toEqual(["a:component"]);
  });

  it("isolates listener errors", async () => {
    const errors: unknown[] = [];
    offs.push(
      onDiscordCommunityEvent(() => {
        throw new Error("boom");
      }),
    );
    offs.push(onDiscordCommunityEvent(() => ({ content: "ok" })));
    const reply = await emitDiscordCommunityEvent(
      { kind: "member_remove", accountId: "ycs", guildId: "1", userId: "2" },
      (err) => errors.push(err),
    );
    expect(reply).toEqual({ content: "ok" });
    expect(errors).toHaveLength(1);
  });

  it("shares listeners across module instances via globalThis", async () => {
    vi.resetModules();
    const other = await import("./community-events.js");
    const got: string[] = [];
    offs.push(other.onDiscordCommunityEvent((e: { kind: string }) => void got.push(e.kind)));
    await emitDiscordCommunityEvent({
      kind: "member_remove",
      accountId: "a",
      guildId: "1",
      userId: "2",
    });
    expect(got).toEqual(["member_remove"]);
  });

  it("decodes snowflake timestamps", () => {
    // Discord's documented example id → 2016-04-30T11:18:25.796Z
    expect(new Date(snowflakeToMs("175928847299117063")!).toISOString()).toBe(
      "2016-04-30T11:18:25.796Z",
    );
    expect(snowflakeToMs("not-a-number")).toBeNull();
  });
});

describe("discord monitor → community bus", () => {
  it("member add/remove listeners publish typed events", async () => {
    const events: unknown[] = [];
    offs.push(onDiscordCommunityEvent((e) => void events.push(e)));
    await new DiscordCommunityMemberAddListener({ accountId: "ycs" }).handle({
      guild_id: "10",
      joined_at: "2026-10-22T00:00:00.000Z",
      user: { id: "20", username: "maya", global_name: "Maya", avatar: null },
    } as never);
    await new DiscordCommunityMemberRemoveListener({ accountId: "ycs" }).handle({
      guild_id: "10",
      rawUser: { id: "20", username: "maya" },
    } as never);
    expect(events).toEqual([
      {
        kind: "member_add",
        accountId: "ycs",
        guildId: "10",
        user: { id: "20", username: "maya", globalName: "Maya", avatar: null, bot: false },
        joinedAt: "2026-10-22T00:00:00.000Z",
      },
      { kind: "member_remove", accountId: "ycs", guildId: "10", userId: "20" },
    ]);
  });

  it("cm: buttons and cmsel: selects dispatch to the bus and reply ephemerally", async () => {
    offs.push(
      onDiscordCommunityEvent((e) =>
        e.kind === "component" ? { content: `got ${e.customId} ${e.values.join(",")}` } : null,
      ),
    );
    const posts: Array<{ route: string; body: any }> = [];
    const fakeInteraction = (data: Record<string, unknown>, values?: string[]) => ({
      rawData: {
        id: "i1",
        token: "interaction-token",
        guild_id: "10",
        channel_id: "11",
        member: { user: { id: "20", username: "maya" } },
        data,
      },
      values,
      client: {
        rest: {
          post: async (route: string, opts: { body: unknown }) =>
            void posts.push({ route, body: opts.body }),
        },
      },
    });
    await new CommunityButton("ycs").run(
      fakeInteraction({ custom_id: "cm:a=verify" }) as never,
      {},
    );
    await new CommunitySelect("ycs").run(
      fakeInteraction({ custom_id: "cmsel:q=intent", values: ["trading"] }, ["trading"]) as never,
      {},
    );
    expect(posts.map((p) => p.body.data.content)).toEqual([
      "got cm:a=verify ",
      "got cmsel:q=intent trading",
    ]);
    expect(posts[0]!.body.data.flags).toBe(64); // ephemeral
    expect(posts[0]!.body.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("with no subscriber the member gets a 'not active' notice, not a failure", async () => {
    const posts: any[] = [];
    await new CommunityButton("ycs").run(
      {
        rawData: {
          id: "i1",
          token: "t",
          member: { user: { id: "1", username: "x" } },
          data: { custom_id: "cm:a=verify" },
        },
        client: {
          rest: { post: async (_r: string, o: { body: unknown }) => void posts.push(o.body) },
        },
      } as never,
      {},
    );
    expect(posts[0].data.content).toMatch(/isn't active/);
  });
});

describe("vault Discord REST (reused by community-manager)", () => {
  it("204 responses (role add, delete) no longer throw on the empty body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      vaultDiscord.assignRole({ botToken: "t", guildId: "1" }, "2", "3"),
    ).resolves.toBeUndefined();
    await expect(
      vaultDiscord.deleteMessage({ botToken: "t", guildId: "1" }, "2", "3"),
    ).resolves.toBeUndefined();
  });

  it("reads the bot, application flags and guild list with Bot auth", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      const u = String(url);
      const body = u.endsWith("/users/@me")
        ? { id: "1", username: "Infini", bot: true, avatar: "a" }
        : u.endsWith("/applications/@me")
          ? { id: "1", name: "Infini", flags: 16384 | 262144, bot_public: false }
          : [
              {
                id: "9",
                name: "YCS",
                icon: null,
                permissions: "8",
                approximate_member_count: 15000,
              },
            ];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    expect((await vaultDiscord.getCurrentUser("tok")).username).toBe("Infini");
    expect((await vaultDiscord.getCurrentApplication("tok")).flags).toBe(16384 | 262144);
    expect(await vaultDiscord.listBotGuilds("tok")).toEqual([
      { id: "9", name: "YCS", icon: null, owner: false, permissions: "8", memberCount: 15000 },
    ]);
    expect(seen.map((s) => s.url)).toEqual([
      "https://discord.com/api/v10/users/@me",
      "https://discord.com/api/v10/applications/@me",
      "https://discord.com/api/v10/users/@me/guilds?with_counts=true",
    ]);
    expect(seen.every((s) => s.auth === "Bot tok")).toBe(true);
  });

  it("sendMessage passes components and allowed_mentions through", async () => {
    let body: any = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    await vaultDiscord.sendMessage({ botToken: "t", guildId: "1" }, "c", "hi", {
      components: [{ type: 1, components: [] }],
      allowedMentions: { parse: [] },
    });
    expect(body).toEqual({
      content: "hi",
      components: [{ type: 1, components: [] }],
      allowed_mentions: { parse: [] },
    });
  });
});

describe("vault Discord API base override", () => {
  it("only honours loopback URLs", () => {
    expect(vaultDiscord.discordApiBase({})).toBe("https://discord.com/api/v10");
    expect(
      vaultDiscord.discordApiBase({ INFINIBOT_DISCORD_API_BASE: "http://127.0.0.1:9999/api/" }),
    ).toBe("http://127.0.0.1:9999/api");
    expect(
      vaultDiscord.discordApiBase({ INFINIBOT_DISCORD_API_BASE: "https://evil.example/api" }),
    ).toBe("https://discord.com/api/v10");
    expect(
      vaultDiscord.discordApiBase({ INFINIBOT_DISCORD_API_BASE: "http://127.0.0.1.evil.example/" }),
    ).toBe("https://discord.com/api/v10");
  });
});
