import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_LAUNCH_PERSONAS, normalizePersona } from "./personas.js";
import type {
  LaunchPanelRun,
  LaunchPanelSchedule,
  LaunchPanelState,
  LaunchPanelTestAccount,
  LaunchPersona,
} from "./types.js";

export function launchPanelStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".infinibot");
}

export class LaunchPanelStore {
  readonly filePath: string;

  constructor(private readonly stateDir = launchPanelStateDir()) {
    this.filePath = path.join(stateDir, "launch-panel", "state.json");
  }

  private initial(): LaunchPanelState {
    return {
      version: 1,
      personas: structuredClone(DEFAULT_LAUNCH_PERSONAS),
      runs: [],
      schedules: [],
    };
  }

  read(): LaunchPanelState {
    if (!fs.existsSync(this.filePath)) return this.initial();
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<LaunchPanelState>;
      return {
        version: 1,
        personas:
          Array.isArray(parsed.personas) && parsed.personas.length
            ? parsed.personas.map((p) => normalizePersona(p))
            : structuredClone(DEFAULT_LAUNCH_PERSONAS),
        runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-100) : [],
        schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
      };
    } catch {
      const corrupt = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, corrupt);
      } catch {
        /* best effort */
      }
      return this.initial();
    }
  }

  write(state: LaunchPanelState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  listPersonas(): LaunchPersona[] {
    return this.read().personas;
  }

  savePersona(persona: LaunchPersona): LaunchPersona {
    const next = normalizePersona(persona);
    const state = this.read();
    state.personas = [...state.personas.filter((p) => p.id !== next.id), next];
    this.write(state);
    return next;
  }

  resetPersonas(): LaunchPersona[] {
    const state = this.read();
    state.personas = structuredClone(DEFAULT_LAUNCH_PERSONAS);
    this.write(state);
    return state.personas;
  }

  saveRun(run: LaunchPanelRun): LaunchPanelRun {
    const state = this.read();
    state.runs = [...state.runs.filter((r) => r.id !== run.id), structuredClone(run)].slice(-100);
    this.write(state);
    return run;
  }

  getRun(id: string): LaunchPanelRun | null {
    return this.read().runs.find((r) => r.id === id) ?? null;
  }

  listRuns(): LaunchPanelRun[] {
    return this.read().runs.sort((a, b) => b.createdAt - a.createdAt);
  }

  saveSchedule(schedule: LaunchPanelSchedule): LaunchPanelSchedule {
    const state = this.read();
    state.schedules = [
      ...state.schedules.filter((s) => s.id !== schedule.id),
      structuredClone(schedule),
    ];
    this.write(state);
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    const state = this.read();
    const before = state.schedules.length;
    state.schedules = state.schedules.filter((s) => s.id !== id);
    if (state.schedules.length !== before) this.write(state);
    return state.schedules.length !== before;
  }

  credentialsPath(): string {
    return path.join(this.stateDir, "secrets", "launch-panel.json");
  }

  getTestAccount(runId: string, personaId: string): LaunchPanelTestAccount | null {
    try {
      const all = JSON.parse(fs.readFileSync(this.credentialsPath(), "utf8")) as Record<
        string,
        LaunchPanelTestAccount[]
      >;
      return all[runId]?.find((account) => account.personaId === personaId) ?? null;
    } catch {
      return null;
    }
  }

  ensureTestAccounts(
    runId: string,
    personas: LaunchPersona[],
    baseEmail?: string,
  ): LaunchPanelTestAccount[] {
    const file = this.credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let existing: Record<string, LaunchPanelTestAccount[]> = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* first run */
    }
    if (existing[runId]) return existing[runId]!;
    const configured = (
      baseEmail ||
      process.env.LAUNCH_PANEL_TEST_EMAIL ||
      "launchpanel@example.com"
    ).trim();
    const [local, domain = "example.com"] = configured.split("@");
    const root = local.replace(/\+.*/, "") || "launchpanel";
    const accounts = personas.map((persona) => ({
      personaId: persona.id,
      email: `${root}+kvpanel-${runId.slice(-6)}-${persona.id}@${domain}`,
      password: randomUUID().replace(/-/g, "").slice(0, 20) + "!Lp9",
      createdAt: new Date().toISOString(),
      cleanup: `Delete or disable the account tagged kvpanel-${runId.slice(-6)} after the report is accepted.`,
    }));
    existing[runId] = accounts;
    fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(file, 0o600);
    return accounts;
  }
}
