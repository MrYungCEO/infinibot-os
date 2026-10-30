import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import { icons } from "../icons";
import "../features/group_chat/group-chat-view";

type Persona = {
  id: string; name: string; avatarIcon: string; role: string; background: string;
  goals: string[]; pains: string[]; techLevel: string; budget: string;
  spendingAuthority: string; buyingTriggers: string[]; objections: string[];
  devices: string[]; patience: string; privateInfo: string; enabled: boolean;
};
type Flow = { id: string; label: string; instruction: string };
type Run = {
  id: string; url: string; personaIds: string[]; flows: string[]; depth: string; status: string;
  createdAt: number; groupKey?: string; workflowRunId?: string; reportPdfPath?: string;
  screenshotPaths?: string[]; error?: string;
};
type Schedule = { id: string; name: string; enabled: boolean; runAt: string; repeat: string; nextRunAt?: number; lastRunId?: string };

const state = {
  client: null as GatewayBrowserClient | null,
  loaded: false,
  loading: false,
  personas: [] as Persona[],
  flows: [] as Flow[],
  runs: [] as Run[],
  schedules: [] as Schedule[],
  selected: new Set<string>(),
  selectedFlows: new Set<string>(),
  url: "https://kinglyvault.com",
  depth: "standard",
  testEmail: "",
  telegram: true,
  starting: false,
  scheduling: false,
  scheduleAt: "",
  repeat: "none",
  activeRunId: "" as string,
  editing: "" as string,
  error: "" as string,
  update: null as (() => void) | null,
  unsub: null as (() => void) | null,
  timer: 0 as number,
};

function request() { state.update?.(); }

async function load(client: GatewayBrowserClient, force = false) {
  if (state.loading || (state.loaded && !force)) return;
  state.loading = true;
  state.error = "";
  request();
  try {
    const [library, runs, schedules] = await Promise.all([
      client.request<{ personas: Persona[]; flows: Flow[] }>("launch_panel.personas.list", {}),
      client.request<{ runs: Run[] }>("launch_panel.runs.list", { limit: 50 }),
      client.request<{ schedules: Schedule[] }>("launch_panel.schedules.list", {}),
    ]);
    state.personas = library.personas || [];
    state.flows = library.flows || [];
    state.runs = runs.runs || [];
    state.schedules = schedules.schedules || [];
    if (!state.selected.size) state.personas.filter((p) => p.enabled).slice(0, 5).forEach((p) => state.selected.add(p.id));
    if (!state.selectedFlows.size) state.flows.forEach((f) => state.selectedFlows.add(f.id));
    state.loaded = true;
    scheduleRefresh(client);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    request();
  }
}

function scheduleRefresh(client: GatewayBrowserClient) {
  if (state.timer) window.clearTimeout(state.timer);
  if (!state.runs.some((r) => ["queued", "running", "reporting"].includes(r.status))) return;
  state.timer = window.setTimeout(() => void load(client, true), 3000);
}

function bind(client: GatewayBrowserClient) {
  if (state.client === client) return;
  state.unsub?.();
  state.client = client;
  state.loaded = false;
  state.unsub = typeof client.subscribe === "function"
    ? client.subscribe((event: GatewayEventFrame) => {
        if (event.event !== "launch-panel") return;
        void load(client, true);
      })
    : null;
}

function toggle(set: Set<string>, id: string) {
  set.has(id) ? set.delete(id) : set.add(id);
  request();
}

async function startRun(client: GatewayBrowserClient) {
  if (!state.url.trim() || !state.selected.size) return;
  state.starting = true;
  state.error = "";
  request();
  try {
    const res = await client.request<{ run: Run }>("launch_panel.run", {
      url: state.url.trim(), personaIds: [...state.selected], flows: [...state.selectedFlows], depth: state.depth,
      testEmail: state.testEmail.trim() || undefined, telegram: state.telegram, telegramTarget: "",
    });
    state.activeRunId = res.run.id;
    await load(client, true);
  } catch (err) { state.error = err instanceof Error ? err.message : String(err); }
  finally { state.starting = false; request(); }
}

async function scheduleRun(client: GatewayBrowserClient) {
  if (!state.scheduleAt || !state.url.trim()) return;
  state.scheduling = true;
  state.error = "";
  request();
  try {
    await client.request("launch_panel.schedules.upsert", {
      schedule: {
        runAt: new Date(state.scheduleAt).toISOString(), repeat: state.repeat,
        input: { url: state.url.trim(), personaIds: [...state.selected], flows: [...state.selectedFlows], depth: state.depth, telegram: state.telegram, telegramTarget: "" },
      },
    });
    state.scheduleAt = "";
    await load(client, true);
  } catch (err) { state.error = err instanceof Error ? err.message : String(err); }
  finally { state.scheduling = false; request(); }
}

async function savePersona(client: GatewayBrowserClient, persona: Persona, form: HTMLFormElement) {
  const data = new FormData(form);
  const list = (name: string) => String(data.get(name) || "").split(/\n|,/).map((v) => v.trim()).filter(Boolean);
  const next = {
    ...persona,
    name: String(data.get("name") || persona.name), role: String(data.get("role") || ""),
    background: String(data.get("background") || ""), budget: String(data.get("budget") || ""),
    spendingAuthority: String(data.get("spendingAuthority") || ""), patience: String(data.get("patience") || ""),
    privateInfo: String(data.get("privateInfo") || ""), techLevel: String(data.get("techLevel") || "medium"),
    goals: list("goals"), pains: list("pains"), buyingTriggers: list("buyingTriggers"), objections: list("objections"), devices: list("devices"),
    enabled: data.get("enabled") === "on",
  };
  await client.request("launch_panel.personas.update", { persona: next });
  state.editing = "";
  await load(client, true);
}

const styles = html`<style>
  .lp{--gold:#d7b46a;--gold2:#f2d691;--ink:#080a0d;--panel:rgba(18,20,25,.78);--line:rgba(215,180,106,.2);color:#f6f3ea;min-height:calc(100vh - 110px);padding:24px;background:radial-gradient(circle at 12% 0%,rgba(198,151,63,.12),transparent 32%),linear-gradient(145deg,#080a0d,#101217 60%,#090b0f)}
  .lp *{box-sizing:border-box}.lp-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:22px}.eyebrow{color:var(--gold);font-size:11px;letter-spacing:.2em;text-transform:uppercase}.lp h1{margin:5px 0 7px;font:600 clamp(26px,3vw,42px)/1.05 Georgia,serif}.sub{color:#a9adb6;max-width:760px;line-height:1.55}.status-orb{width:48px;height:48px;border:1px solid rgba(215,180,106,.45);border-radius:50%;display:grid;place-items:center;color:var(--gold);box-shadow:0 0 28px rgba(215,180,106,.15)}
  .lp-grid{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:18px}.card{border:1px solid var(--line);background:linear-gradient(155deg,rgba(25,27,33,.88),rgba(12,14,18,.9));border-radius:18px;box-shadow:0 22px 70px rgba(0,0,0,.28);overflow:hidden}.pad{padding:18px}.card-title{display:flex;align-items:center;gap:9px;font-weight:650}.card-title svg{width:18px;color:var(--gold)}.muted{color:#9297a2;font-size:12px;line-height:1.45}.field{display:grid;gap:7px;margin-top:14px}.field label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#b8ac91}.lp input,.lp select,.lp textarea{width:100%;border:1px solid rgba(255,255,255,.11);border-radius:10px;background:rgba(0,0,0,.3);color:#f7f3e8;padding:10px 12px;font:inherit;outline:none}.lp textarea{min-height:76px;resize:vertical}.lp input:focus,.lp select:focus,.lp textarea:focus{border-color:rgba(215,180,106,.65);box-shadow:0 0 0 3px rgba(215,180,106,.08)}
  .row{display:flex;gap:10px;align-items:center}.row>*{flex:1}.check{display:flex;align-items:center;gap:8px;color:#c8c4bb;font-size:13px}.check input{width:16px}.btn{border:1px solid rgba(215,180,106,.38);background:rgba(215,180,106,.08);color:#f4dfaa;border-radius:10px;padding:10px 13px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:600;cursor:pointer}.btn svg{width:16px}.btn:hover{background:rgba(215,180,106,.16)}.btn.primary{background:linear-gradient(135deg,#b78b36,#e0bd70);color:#120f09;border:0}.btn:disabled{opacity:.48;cursor:not-allowed}
  .personas{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:10px;margin-top:14px}.persona{position:relative;border:1px solid rgba(255,255,255,.09);border-radius:13px;padding:12px;background:rgba(255,255,255,.025);cursor:pointer}.persona.selected{border-color:rgba(215,180,106,.62);background:rgba(215,180,106,.07)}.persona-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.avatar{width:30px;height:30px;border:1px solid rgba(215,180,106,.35);border-radius:9px;display:grid;place-items:center;color:var(--gold)}.avatar svg{width:15px}.persona-name{font-weight:650;font-size:13px}.persona-role{font-size:11px;color:#999da6;margin-top:7px;line-height:1.35}.edit{position:absolute;right:8px;bottom:7px;border:0;background:none;color:#8e929b;cursor:pointer}.edit svg{width:14px}
  .flow-grid{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}.chip{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.025);color:#aaaeb7;border-radius:999px;padding:7px 10px;font-size:11px;cursor:pointer}.chip.on{border-color:rgba(215,180,106,.5);color:#f1d998;background:rgba(215,180,106,.09)}
  .runs{display:grid;gap:9px;margin-top:13px;max-height:360px;overflow:auto}.run{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;background:rgba(0,0,0,.18)}.run-head{display:flex;justify-content:space-between;gap:10px}.pill{font-size:10px;text-transform:uppercase;letter-spacing:.1em;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 7px}.pill.completed{color:#8ee0ae;border-color:rgba(90,210,130,.3)}.pill.failed{color:#ff9e9e;border-color:rgba(255,100,100,.3)}.pill.running,.pill.reporting,.pill.queued{color:#efce7c;border-color:rgba(215,180,106,.4)}.run-actions{display:flex;gap:7px;margin-top:10px}.run-actions .btn{padding:7px 9px;font-size:11px}.error{border:1px solid rgba(255,100,100,.28);background:rgba(255,70,70,.08);color:#ffb1b1;padding:10px 12px;border-radius:10px;margin:12px 0}
  .room{margin-top:18px;min-height:620px}.room ib-group-chat{display:block;height:720px;--gc-surface:rgba(10,12,16,.7)}.empty{min-height:420px;display:grid;place-items:center;text-align:center;color:#858a94;padding:30px}.empty svg{width:38px;color:var(--gold);opacity:.7;margin-bottom:12px}.schedule{display:grid;grid-template-columns:1.5fr .8fr auto;gap:8px;margin-top:12px}.schedule-list{display:grid;gap:7px;margin-top:10px}.schedule-item{display:flex;justify-content:space-between;gap:12px;padding:9px 11px;border:1px solid rgba(255,255,255,.07);border-radius:9px}.modal{position:fixed;inset:0;z-index:1200;background:rgba(3,4,6,.78);backdrop-filter:blur(12px);display:grid;place-items:center;padding:24px}.modal-card{width:min(720px,100%);max-height:90vh;overflow:auto;border:1px solid rgba(215,180,106,.28);background:#111319;border-radius:18px;padding:20px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wide{grid-column:1/-1}
  @media(max-width:980px){.lp-grid{grid-template-columns:1fr}.lp{padding:14px}.schedule{grid-template-columns:1fr}.room ib-group-chat{height:680px}.form-grid{grid-template-columns:1fr}.wide{grid-column:auto}}
</style>`;

function personaCard(persona: Persona) {
  const selected = state.selected.has(persona.id);
  const icon = (icons as unknown as Record<string, TemplateResult>)[persona.avatarIcon] || icons.users;
  return html`<article class="persona ${selected ? "selected" : ""}" @click=${() => toggle(state.selected, persona.id)}>
    <div class="persona-top"><div class="row" style="flex:0 1 auto"><span class="avatar">${icon}</span><span class="persona-name">${persona.name}</span></div><span class="pill">${persona.techLevel}</span></div>
    <div class="persona-role">${persona.role}</div>
    <button class="edit" title="Edit persona" @click=${(e: Event) => { e.stopPropagation(); state.editing = persona.id; request(); }}>${icons.edit}</button>
  </article>`;
}

function personaEditor(client: GatewayBrowserClient, persona: Persona) {
  const join = (v: string[]) => v.join(", ");
  return html`<div class="modal" @click=${(e: Event) => { if (e.target === e.currentTarget) { state.editing = ""; request(); } }}><form class="modal-card" @submit=${(e: SubmitEvent) => { e.preventDefault(); void savePersona(client, persona, e.currentTarget as HTMLFormElement); }}>
    <div class="lp-head"><div><div class="eyebrow">Persona library</div><h2 style="margin:5px 0">Edit ${persona.name}</h2></div><button type="button" class="btn" @click=${() => { state.editing = ""; request(); }}>${icons.x}</button></div>
    <div class="form-grid">
      <div class="field"><label>Name</label><input name="name" .value=${persona.name}></div>
      <div class="field"><label>Tech level</label><select name="techLevel" .value=${persona.techLevel}><option>low</option><option>medium</option><option>high</option></select></div>
      <div class="field wide"><label>Role</label><input name="role" .value=${persona.role}></div>
      <div class="field wide"><label>Background</label><textarea name="background" .value=${persona.background}></textarea></div>
      <div class="field"><label>Goals</label><textarea name="goals" .value=${join(persona.goals)}></textarea></div>
      <div class="field"><label>Pains</label><textarea name="pains" .value=${join(persona.pains)}></textarea></div>
      <div class="field"><label>Budget</label><input name="budget" .value=${persona.budget}></div>
      <div class="field"><label>Spending authority</label><input name="spendingAuthority" .value=${persona.spendingAuthority}></div>
      <div class="field"><label>Buying triggers</label><textarea name="buyingTriggers" .value=${join(persona.buyingTriggers)}></textarea></div>
      <div class="field"><label>Objections</label><textarea name="objections" .value=${join(persona.objections)}></textarea></div>
      <div class="field"><label>Devices</label><input name="devices" .value=${join(persona.devices)} placeholder="mobile, desktop"></div>
      <div class="field"><label>Patience / attention</label><input name="patience" .value=${persona.patience}></div>
      <div class="field wide"><label>Private information only this persona knows</label><textarea name="privateInfo" .value=${persona.privateInfo}></textarea></div>
      <label class="check wide"><input name="enabled" type="checkbox" .checked=${persona.enabled}> Enabled for panel runs</label>
    </div><div class="row" style="justify-content:flex-end;margin-top:18px"><span></span><button class="btn primary" type="submit">${icons.check} Save persona</button></div>
  </form></div>`;
}

export function renderLaunchPanel(app: AppViewState, client: GatewayBrowserClient, update?: () => void) {
  state.update = update || app.requestUpdate || null;
  bind(client);
  void load(client);
  const active = state.runs.find((r) => r.id === state.activeRunId) || state.runs.find((r) => ["queued", "running", "reporting"].includes(r.status)) || state.runs[0];
  return html`${styles}<main class="lp">
    <header class="lp-head"><div><div class="eyebrow">Customer-avatar launch intelligence</div><h1>Launch Panel</h1><div class="sub">A room of real customer perspectives that clicks through the product, challenges the offer, and leaves screenshot-backed launch decisions.</div></div><div class="status-orb">${icons.target}</div></header>
    ${state.error ? html`<div class="error">${state.error}</div>` : nothing}
    <section class="lp-grid">
      <div>
        <article class="card pad"><div class="card-title">${icons.play}<span>Run a launch test</span></div>
          <div class="field"><label>Website</label><input type="url" .value=${state.url} @input=${(e: Event) => state.url = (e.target as HTMLInputElement).value}></div>
          <div class="row"><div class="field"><label>Depth</label><select .value=${state.depth} @change=${(e: Event) => state.depth = (e.target as HTMLSelectElement).value}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select></div><div class="field"><label>Test inbox (optional)</label><input type="email" placeholder="owner+tests@domain.com" .value=${state.testEmail} @input=${(e: Event) => state.testEmail = (e.target as HTMLInputElement).value}></div></div>
          <label class="check" style="margin-top:12px"><input type="checkbox" .checked=${state.telegram} @change=${(e: Event) => state.telegram = (e.target as HTMLInputElement).checked}> Send final report and evidence to Telegram</label>
          <div class="field"><label>Clickable flows</label><div class="flow-grid">${state.flows.map((f) => html`<button type="button" class="chip ${state.selectedFlows.has(f.id) ? "on" : ""}" title=${f.instruction} @click=${() => toggle(state.selectedFlows, f.id)}>${f.label}</button>`)}</div></div>
          <button class="btn primary" style="width:100%;margin-top:16px" ?disabled=${state.starting || !state.selected.size} @click=${() => void startRun(client)}>${state.starting ? icons.loader : icons.play}<span>${state.starting ? "Opening room…" : `Start with ${state.selected.size} personas`}</span></button>
        </article>
        <article class="card pad" style="margin-top:18px"><div class="card-title">${icons.clock}<span>Schedule a pre-launch rerun</span></div><div class="schedule"><input type="datetime-local" .value=${state.scheduleAt} @input=${(e: Event) => state.scheduleAt = (e.target as HTMLInputElement).value}><select .value=${state.repeat} @change=${(e: Event) => state.repeat = (e.target as HTMLSelectElement).value}><option value="none">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select><button class="btn" ?disabled=${state.scheduling || !state.scheduleAt} @click=${() => void scheduleRun(client)}>${icons.plus} Schedule</button></div><div class="schedule-list">${state.schedules.slice(0, 4).map((s) => html`<div class="schedule-item"><div><b>${s.name}</b><div class="muted">${new Date(s.nextRunAt || s.runAt).toLocaleString()} · ${s.repeat}</div></div><span class="pill ${s.enabled ? "running" : ""}">${s.enabled ? "active" : "paused"}</span></div>`)}</div></article>
      </div>
      <div>
        <article class="card pad"><div class="card-title">${icons.users}<span>Customer avatars</span><span class="muted" style="margin-left:auto">${state.selected.size} selected</span></div><div class="personas">${state.personas.map(personaCard)}</div></article>
        <article class="card pad" style="margin-top:18px"><div class="card-title">${icons.activity}<span>Runs</span><button class="btn" style="margin-left:auto;padding:6px 9px" @click=${() => void load(client, true)}>${icons.refresh}</button></div><div class="runs">${state.runs.length ? state.runs.map((run) => html`<div class="run"><div class="run-head"><div><b>${new URL(run.url).hostname}</b><div class="muted">${new Date(run.createdAt).toLocaleString()} · ${run.personaIds.length} personas</div></div><span class="pill ${run.status}">${run.status}</span></div>${run.error ? html`<div class="error">${run.error}</div>` : nothing}<div class="run-actions"><button class="btn" ?disabled=${!run.groupKey} @click=${() => { state.activeRunId = run.id; request(); }}>${icons.messageSquare} Open room</button>${run.reportPdfPath ? html`<button class="btn" @click=${() => app.setTab?.("reports" as never)}>${icons.fileText} Open report</button>` : nothing}<span class="muted" style="align-self:center;margin-left:auto">${run.screenshotPaths?.length || 0} shots</span></div></div>`) : html`<div class="empty" style="min-height:150px">No panel runs yet.</div>`}</div></article>
      </div>
    </section>
    <section class="card room">${active?.groupKey ? html`<ib-group-chat .client=${client} .connected=${(app as any).connected === true} .sessionKey=${active.groupKey} .agents=${(app as any).agents || []} viewControls="full"></ib-group-chat>` : html`<div class="empty"><div><div>${icons.messageSquare}</div><h3>Launch Room</h3><p>Start a run to watch the panel work live and jump into the conversation.</p></div></div>`}</section>
    ${state.editing ? personaEditor(client, state.personas.find((p) => p.id === state.editing)!) : nothing}
  </main>`;
}
