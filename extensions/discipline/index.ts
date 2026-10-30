/**
 * Discipline — the ADHD-friendly day planner (time blocks, routines, scores,
 * templates) and its Focus board, as a first-party InfiniBot plugin
 * (manifest v2). Formerly a core surface; see docs/plugins/DISCIPLINE-PLUGIN.md.
 *
 * Everything the plugin adds is declared in infinibot.plugin.json:
 *   - discipline.* RPCs (incl. discipline.focus.*; core forwards the legacy
 *     focus.* names here while the plugin is on)
 *   - the Day + Focus board pages (built into the control UI, plugin-gated)
 *   - the `discipline` and `focus` agent tools (core tool slots)
 *   - one service that owns every background job: agent-activity auto-log,
 *     block alerts / daily check-ins, and the Telegram block bridge
 *
 * Nothing runs at import or register time. The old core handlers armed their
 * timers as import side effects, which kept one-shot CLI commands alive.
 *
 * Core reaches the plugin only through seams handed over by the host
 * (api.runtime.host): work-completion events in, day-planner provider and
 * tool slots out. With the plugin off, core builds and runs unchanged.
 *
 * Storage: `<stateDir>/plugin-data/discipline/` (data-dir.ts moves the
 * pre-plugin files in once; disabling the plugin never deletes them).
 */

import type { InfiniBotPluginApi, InfiniBotPluginService } from "infinibot/plugin-sdk";

import { startDisciplineAlerts, stopDisciplineAlerts } from "./src/alerts.js";
import { startDisciplineAutoLog, stopDisciplineAutoLog } from "./src/auto-log.js";
import { migrateLegacyData } from "./src/data-dir.js";
import { createFocusHandlers } from "./src/focus-rpc.js";
import { setFocusStateDir } from "./src/focus-store.js";
import { createFocusTool } from "./src/focus-tool.js";
import { createDisciplineHandlers } from "./src/rpc.js";
import {
  closeDisciplineStores,
  getDisciplineStore,
  setDisciplineStoreLogger,
} from "./src/store.js";
import {
  DISCIPLINE_DEEP_LINK,
  startTelegramBridge,
  stopTelegramBridge,
} from "./src/telegram-bridge.js";
import { createDisciplineTool } from "./src/tool.js";

type DisciplineConfig = { autoLog: boolean; alerts: boolean; telegramBridge: boolean };

function readConfig(raw: Record<string, unknown> | undefined): DisciplineConfig {
  const c = raw ?? {};
  return {
    autoLog: c.autoLog !== false,
    alerts: c.alerts !== false,
    telegramBridge: c.telegramBridge !== false,
  };
}

function localDateIso(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function register(api: InfiniBotPluginApi) {
  const cfg = readConfig(api.pluginConfig);
  const host = api.runtime.host;
  const stateDir = () => api.runtime.state.resolveStateDir();
  const log = { info: (m: string) => api.logger.info(m), warn: (m: string) => api.logger.warn(m) };

  setDisciplineStoreLogger(log);
  setFocusStateDir(stateDir);

  const handlers = {
    ...createDisciplineHandlers({ stateDir, gatherBusinessSnapshot: host.gatherBusinessSnapshot }),
    ...createFocusHandlers(),
  };
  for (const [method, handler] of Object.entries(handlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Agent tools keep their long-standing names through core's tool slots
  // (src/plugins/core-tool-slots.ts); empty slots are invisible to agents.
  host.setCoreToolSlot("discipline", {
    pluginId: api.id,
    pluginName: "Discipline",
    factory: () => createDisciplineTool(stateDir),
  });
  host.setCoreToolSlot("focus", {
    pluginId: api.id,
    pluginName: "Discipline",
    factory: () => createFocusTool(log),
  });

  // Day-planner seam: the Telegram completion notifier, the agent-integration
  // test message and the CEO hourly report read these.
  host.setDayPlannerProvider({
    pluginId: api.id,
    telegramTarget: () => {
      const s = getDisciplineStore(stateDir()).getSettings();
      return { enabled: s.telegramEnabled, chatId: s.telegramChatId ?? "" };
    },
    posture: (dir, now) => {
      const store = getDisciplineStore(dir);
      const settings = store.getSettings();
      const dayStart = store.getDayStart(localDateIso(now));
      const at = new Date(now);
      const minute = at.getHours() * 60 + at.getMinutes();
      const dow = at.getDay();
      const active = store
        .getBlocks()
        .find(
          (b) =>
            b.enabled &&
            (b.days?.includes(dow) ?? false) &&
            minute >= b.startMinute &&
            minute < b.endMinute,
        );
      return {
        dayStarted: Boolean(dayStart),
        dayStartedAt: dayStart?.startedAt,
        dayStartSource: dayStart?.source,
        currentBlock: active
          ? { label: active.label, category: String(active.category), intent: active.intent }
          : undefined,
        militant: settings.militant,
      };
    },
  });

  const runtime: InfiniBotPluginService = {
    id: "discipline-runtime",
    start: () => {
      // Move pre-plugin data in now rather than on the first request.
      migrateLegacyData(stateDir(), log);
      if (cfg.autoLog) {
        startDisciplineAutoLog({
          stateDir,
          onAgentEvent: host.onAgentEvent,
          onWorkCompleted: host.onWorkCompleted,
          log,
        });
      }
      if (cfg.alerts) {
        startDisciplineAlerts({ stateDir, emitNotification: host.emitNotification, log });
      }
      if (cfg.telegramBridge) {
        startTelegramBridge({
          stateDir,
          sendMessageTelegram: (to, text) =>
            api.runtime.channel.telegram.sendMessageTelegram(to, text),
          log,
          openUrl: () => host.linkPair?.(DISCIPLINE_DEEP_LINK).webUrl ?? null,
        });
      }
    },
    stop: () => {
      stopDisciplineAutoLog();
      stopDisciplineAlerts();
      stopTelegramBridge();
      closeDisciplineStores();
      log.info("discipline runtime stopped (auto-log, alerts, telegram bridge)");
    },
  };
  api.registerService(runtime);
}
