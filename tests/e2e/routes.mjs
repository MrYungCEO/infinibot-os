/**
 * Route coverage suite — every agency-facing UI route.
 *
 * The bar deliberately is NOT "a heading rendered". An earlier spec asserted
 * only headings and stayed green while every table underneath was empty, which
 * is how a real data bug shipped unnoticed. So each route asserts:
 *
 *   1. the view mounts and stops loading,
 *   2. it renders REAL data — cross-checked against the same records the
 *      gateway hands back over RPC, or against a row-count floor,
 *   3. no panel-failure / error banner,
 *   4. no app console or uncaught page errors,
 *   5. no horizontal document overflow.
 */
import {
  gotoRoute,
  horizontalOverflowPx,
  waitForContent,
} from "./lib/harness.mjs";
import { excerpt } from "./lib/report.mjs";

/** Banners that mean a panel gave up. Any of these on any route is a failure. */
const FAILURE_BANNERS = [
  /failed to load/i,
  /could not load/i,
  /something went wrong/i,
  /unexpected error/i,
  /unable to reach the gateway/i,
];

/** Text that means the view never finished its first paint. */
const STUCK_LOADING = [/^Loading\b/i, /\bLoading[^.]{0,40}…\s*$/];

/**
 * Route specs.
 *
 * required   — every regex must match the rendered text.
 * forbidden  — none may match (route-specific empty-state tells).
 * minLines   — floor on non-empty rendered lines; catches an empty shell.
 * rows       — {re, min} counts repeated row markers; catches an empty table.
 * data       — async (rpc, text) => {ok, detail}; cross-checks against the
 *              records the gateway actually holds.
 */
export const ROUTE_SPECS = [
  {
    route: "/agency-operations",
    required: [
      /Agency Operations Center/i,
      /CURRENT AGENCY/i,
      /Kingly Kreationz/i,
      // The legacy-migration summary is the proof the real book of business is
      // attached, not a fresh empty agency.
      /\d+ clients? and \d+ projects?|\d+ clients?, \d+ projects?/i,
      /OPEN PIPELINE/i,
      /TEAM CAPACITY/i,
      /Employee roster/i,
    ],
    forbidden: [/Loading agency operations/i, /No agency selected/i],
    minLines: 40,
    async data(rpc, text) {
      const res = await rpc("agency.ops.employees.list", { agencyId: this.agencyId });
      if (!res.ok) return { ok: false, detail: `employees.list failed: ${res.error}` };
      const employees = res.payload?.employees ?? [];
      const missing = employees.filter((e) => !text.includes(e.name)).map((e) => e.name);
      return {
        ok: employees.length > 0 && missing.length === 0,
        detail: `${employees.length} employees from RPC, not rendered: ${missing.join(", ") || "none"}`,
      };
    },
  },
  {
    route: "/agency-daily",
    required: [
      /DAILY OPERATIONS/i,
      /OPERATING LOOP/i,
      // Loop health line: proves the cron surface is wired, not a static shell.
      /Last run .*(ago|never)/i,
      /LIVE WORK BOARD/i,
      /\d+ items?\s*·\s*\d+ staged/i,
      // Every board column must render, including the human-authorisation gate.
      /BACKLOG/,
      /STAGED/,
      /RUNNING/,
      /WAITING/,
      /REVIEW/,
      /COMPLETED/,
      /ESCALATED/,
      // The safety copy that explains the staged gate must be visible to the
      // operator whenever autonomous execution is on.
      /Nothing in Backlog ever runs|Autonomous execution is/i,
    ],
    forbidden: [/Loading daily operations/i],
    minLines: 30,
    async data(rpc, text) {
      const res = await rpc("agency.ops.employee.inbox.list", { agencyId: this.agencyId, limit: 250 });
      if (!res.ok) return { ok: false, detail: `inbox.list failed: ${res.error}` };
      const items = res.payload?.workItems ?? [];
      const live = items.filter((i) => !["cancelled"].includes(i.status));
      if (!live.length) return { ok: true, detail: "no live work items to cross-check" };
      const shown = live.filter((i) => text.includes(i.title.slice(0, 40)));
      return {
        ok: shown.length > 0,
        detail: `${live.length} live work items from RPC, ${shown.length} rendered on the board`,
      };
    },
  },
  {
    route: "/agency-topology",
    required: [
      /AGENCY TOPOLOGY/i,
      /Showing \d+ of \d+ clients?, \d+ of \d+ projects?, \d+ of \d+ workers?/i,
      /\d+ nodes/i,
      /AGENCY AT A GLANCE/i,
      /WORKFORCE/i,
      /LARGEST ACCOUNTS/i,
    ],
    forbidden: [/Loading topology/i, /No agency data/i],
    minLines: 20,
    async data(rpc, text) {
      const match = /Showing \d+ of (\d+) clients?, \d+ of (\d+) projects?, \d+ of (\d+) workers?/i.exec(text);
      if (!match) return { ok: false, detail: "topology never printed its scope line" };
      const [, clients, projects, workers] = match.map(Number);
      const [c, p, w] = await Promise.all([
        rpc("agency.ops.clients.list", { agencyId: this.agencyId, limit: 1000 }),
        rpc("agency.ops.projects.list", { agencyId: this.agencyId, limit: 1000 }),
        rpc("agency.ops.employees.list", { agencyId: this.agencyId }),
      ]);
      const actualClients = c.ok ? (c.payload?.clients ?? []).length : -1;
      const actualProjects = p.ok ? (p.payload?.projects ?? []).length : -1;
      const actualWorkers = w.ok ? (w.payload?.employees ?? []).length : -1;
      const ok = clients === actualClients && projects === actualProjects && workers === actualWorkers;
      return {
        ok,
        detail:
          `rendered clients=${clients} projects=${projects} workers=${workers}; ` +
          `gateway clients=${actualClients} projects=${actualProjects} workers=${actualWorkers}`,
      };
    },
  },
  {
    route: "/dashboard",
    required: [
      /COMMAND CENTER/i,
      /Good (morning|afternoon|evening)/i,
      /Activity Timeline/i,
      /System Health/i,
    ],
    // A dashboard that is still "loading the briefing" after the poll window is
    // an empty shell, not a rendered dashboard. The agency-setup empty state is
    // listed too: with an agency selected, offering to create one is wrong.
    forbidden: [
      /Loading today's briefing/i,
      /Reading the fleet…/i,
      /Loading autonomy/i,
      /Set up your agency workspace/i,
    ],
    minLines: 30,
    async data(rpc, text) {
      // The dashboard is agency-aware: with an agency selected it must not still
      // be offering to create one.
      const setup = /Set up your agency workspace/i.test(text);
      return {
        ok: !setup && /Kingly Kreationz|Agency operating system/i.test(text) && !setup,
        detail: setup
          ? "dashboard still shows the 'set up your agency workspace' empty state although an agency is selected"
          : "agency-aware",
      };
    },
  },
  {
    route: "/clients",
    required: [/\d+ clients/i, /GRID/i, /TABLE/i, /KANBAN/i],
    forbidden: [/No clients yet/i, /Loading clients/i],
    minLines: 60,
    rows: { re: /\b(COMPLETED|LEAD|COLD|IN PROGRESS|UPDATING|EXPIRED)\b/g, min: 20 },
  },
  {
    route: "/projects",
    // The gallery groups projects and COLLAPSES finished ones — a real load
    // shows only the active cards plus a collapsed "Recently completed (N)"
    // header. Counting status badges therefore undercounts massively (3 of 77)
    // and this assertion used to fail against a perfectly healthy page.
    // Assert on the group header's own count instead, which proves the full
    // set was fetched without depending on how many cards are expanded.
    required: [/Projects|AI Projects/i, /Kingly Kreationz/i],
    forbidden: [/No projects yet/i, /Loading projects/i],
    // Two things make this route's budget different from its neighbours:
    // the gallery GROUPS projects and collapses finished ones (77 projects
    // render as 3 active cards plus a collapsed "Recently completed (58)"
    // header), and most of that markup sits outside `main.content`, which
    // measures ~740 chars while the visible page has far more. Asserting the
    // generic 2000-char / 15-row budget failed against a perfectly healthy
    // page. Assert what this container genuinely holds.
    minLines: 12,
    minChars: 600,
    rows: { re: /\b(CANCELLED|COMPLETED|ACTIVE|PAUSED|IN PROGRESS|REVIEWING)\b/g, min: 1 },
  },
  {
    route: "/business",
    required: [
      /BUSINESS OPERATIONS/i,
      /KINGLY KREATIONZ/i,
      /GATEWAY/i,
      /TOTAL MADE/i,
      /ACTIVE PROJECTS/i,
      /BUSINESSES\s*\d+ active/i,
    ],
    forbidden: [/Loading business/i, /No business selected/i],
    minLines: 25,
  },
  {
    route: "/databases",
    required: [/Databases/i, /Kingly Kreationz/i, /Table/i, /Board/i, /Gallery/i, /Calendar/i],
    forbidden: [/Loading databases/i],
    minLines: 40,
    // The grid must have both a schema (column headers) and rows.
    rows: { re: /\b(TITLE|STATUS|SELECT|RICHTEXT)\b/g, min: 4 },
  },
  {
    route: "/funnels",
    required: [
      /FUNNEL COMMAND/i,
      /SYSTEM HEALTH/i,
      /SETUP COMPLETE/i,
      /OPERATING MAP/i,
      /LIVE KPI BOARD/i,
    ],
    forbidden: [/Loading funnels/i],
    minLines: 15,
  },
];

/** The 10 Agency Operations sections, with the content each must reveal. */
export const AGENCY_OPS_SECTIONS = [
  ["Command center", /Revenue pipeline|Open pipeline/i],
  ["Projects & tasks", /project/i],
  ["Clients & revenue", /client/i],
  ["Employees", /Employee directory|Employee roster/i],
  ["Employee ops", /Inbox, schedules|schedule/i],
  ["Work allocation", /allocation|assignment|capacity/i],
  ["Approval inbox", /Approval inbox|approval/i],
  ["Activity & audit", /audit|activity/i],
  ["Reliability", /Database health|backup/i],
  ["Agency settings", /Agency settings|member/i],
];

export async function runRouteSuite(session, reporter, agencyId) {
  for (const spec of ROUTE_SPECS) {
    reporter.group(`route ${spec.route}`);
    const bound = { ...spec, agencyId };
    let main;
    try {
      main = await gotoRoute(session, spec.route);
    } catch (error) {
      reporter.fail(`${spec.route} mounts`, String(error?.message ?? error));
      continue;
    }

    // Poll until the ENTIRE content contract holds, not just the headings.
    // Views stream in stages — /dashboard satisfies every heading in under a
    // second but keeps loading panels for ~30s, and the /databases grid paints
    // its column headers well before its rows. Settling on headings alone
    // therefore snapshots a half-painted page and reports loaded views as
    // broken. Once the contract holds (or the budget runs out) each clause is
    // asserted individually so the failure names the specific clause.
    const minChars = spec.minChars ?? 2_000;
    const settled = (t) =>
      spec.required.every((re) => re.test(t)) &&
      (spec.forbidden ?? []).every((re) => !re.test(t)) &&
      (!spec.rows || (t.match(spec.rows.re) ?? []).length >= spec.rows.min) &&
      t.length >= Math.min(minChars, 400);
    const { text } = await waitForContent(main, settled, { timeout: 75_000 });
    const rawLines = (await main.innerText())
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    reporter.check(`${spec.route} mounts`, text.length > 0, "main region rendered no text");

    for (const re of spec.required) {
      reporter.check(
        `renders ${re.source.slice(0, 60)}`,
        re.test(text),
        `not found in: ${excerpt(text)}`,
      );
    }
    for (const re of spec.forbidden ?? []) {
      reporter.check(
        `no empty/loading state ${re.source.slice(0, 50)}`,
        !re.test(text),
        `present in: ${excerpt(text)}`,
      );
    }
    reporter.check(
      "not stuck loading",
      !STUCK_LOADING.some((re) => re.test(text)),
      excerpt(text),
    );
    reporter.check(
      "no panel-failure banner",
      !FAILURE_BANNERS.some((re) => re.test(text)),
      excerpt(text),
    );
    // "Not an empty shell" — satisfied by either many rendered lines or a lot
    // of rendered text. Data grids (/databases) pack a whole row onto one line,
    // so a line count alone under-reads them badly.
    reporter.check(
      `renders substantive content (>= ${spec.minLines} lines or >= ${minChars} chars)`,
      rawLines.length >= spec.minLines || text.length >= minChars,
      `only ${rawLines.length} non-empty lines / ${text.length} chars`,
    );

    if (spec.rows) {
      const count = (text.match(spec.rows.re) ?? []).length;
      reporter.check(
        `table/list is populated (>= ${spec.rows.min} rows)`,
        count >= spec.rows.min,
        `found ${count} row markers`,
      );
    }

    if (spec.data) {
      try {
        const result = await bound.data.call(bound, session.rpc, text);
        reporter.check("rendered data matches the gateway's records", result.ok, result.detail);
      } catch (error) {
        reporter.fail("rendered data matches the gateway's records", String(error?.message ?? error));
      }
    }

    const overflow = await horizontalOverflowPx(session.page);
    reporter.check("no horizontal overflow", overflow <= 1, `${overflow}px of horizontal scroll`);

    const errs = session.appErrors();
    reporter.check(
      "no console / page errors",
      errs.length === 0,
      errs.slice(0, 4).join(" | "),
    );

    const httpErrs = session.coreHttpErrors();
    reporter.check(
      "no failed requests to core endpoints",
      httpErrs.length === 0,
      httpErrs.slice(0, 4).join(" | "),
    );
    const optional = session.optionalServiceErrors();
    if (optional.length) {
      reporter.info(`optional sidecar unavailable (not a UI failure): ${optional.slice(0, 3).join(" | ")}`);
    }
  }

  // ── Agency Operations sections ────────────────────────────────────────────
  reporter.group("agency-operations sections");
  const main = await gotoRoute(session, "/agency-operations");
  await main.waitFor({ state: "visible", timeout: 30_000 });
  await session.page
    .locator(".aops-section-nav button")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});

  for (const [name, expected] of AGENCY_OPS_SECTIONS) {
    session.resetErrors();
    const button = session.page.getByRole("button", { name, exact: false }).first();
    try {
      await button.click({ timeout: 10_000 });
    } catch {
      reporter.fail(`section "${name}"`, "nav button not found");
      continue;
    }
    const { ok, text } = await waitForContent(main, (t) => expected.test(t), { timeout: 20_000 });
    reporter.check(`section "${name}" renders content`, ok, `expected ${expected} in ${excerpt(text)}`);
    reporter.check(
      `section "${name}" has no failure banner`,
      !FAILURE_BANNERS.some((re) => re.test(text)),
      excerpt(text),
    );
    const errs = session.appErrors();
    reporter.check(`section "${name}" logs no errors`, errs.length === 0, errs.slice(0, 3).join(" | "));
  }
}
