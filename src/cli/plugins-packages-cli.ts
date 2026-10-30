/**
 * `infinibot plugins` — plugin package commands: pack, validate, create,
 * install (zip / URL / marketplace), updates, update, rollback, marketplace.
 * Everything here goes through src/plugins/packages (the same code the
 * gateway RPCs use), so the CLI and Setup › Plugins behave the same.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import type { Command } from "commander";

import { loadConfig, writeConfigFile } from "../config/config.js";
import type { InfinibotConfig } from "../config/config.js";
import { isAllowedPackageUrl, PACKAGE_LIMITS } from "../plugins/packages/format.js";
import {
  commitPluginPackage,
  inspectPluginPackage,
  rollbackPluginPackage,
  type PackageInspection,
} from "../plugins/packages/install.js";
import { packPluginDir, validatePluginDir, validatePluginZip } from "../plugins/packages/pack.js";
import {
  createRegistryClient,
  fetchPackage,
  formatPrice,
  PaymentRequiredError,
} from "../plugins/packages/registry-client.js";
import { writePluginScaffold } from "../plugins/packages/scaffold.js";
import {
  checkPluginUpdates,
  isRegistryManaged,
  marketplaceRegistryUrl,
  prepareRegistryInstall,
  setAutoUpdateInConfig,
  type InstalledPluginRef,
} from "../plugins/packages/updates.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";

export type PackageInstallCliOptions = {
  sha256?: string;
  yes?: boolean;
  overrideBundled?: boolean;
  allowDowngrade?: boolean;
  reinstall?: boolean;
  /** Entitlement token from a marketplace purchase page (paid plugins). Not stored. */
  token?: string;
  marketplace?: boolean;
};

const log = (msg: string) => defaultRuntime.log(msg);

/**
 * End a package command. The plugins CLI loads every plugin to register
 * plugin-provided commands, and a loaded plugin can leave timers or sockets
 * open, so the process would otherwise idle after the work is done — which
 * breaks scripted use (`pack` in CI). Output is already flushed here.
 */
export function finish(code = 0): never {
  process.exit(code);
}

function die(message: string): never {
  defaultRuntime.error(message);
  process.exit(1);
}

function errorText(err: unknown): string {
  if (err instanceof PaymentRequiredError) {
    return err.purchaseUrl
      ? `${err.message}\n  Buy: ${err.purchaseUrl}\n  Then use "Install in InfiniBot" on your purchase page, or re-run with --token <token> from it`
      : `${err.message} (re-run with --token <token> from your purchase page)`;
  }
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Discovered plugins as update-engine refs (one per id, the active record). */
export function cliPluginRefs(config: InfinibotConfig): InstalledPluginRef[] {
  const seen = new Set<string>();
  const out: InstalledPluginRef[] = [];
  for (const p of buildPluginStatusReport({ config }).plugins) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      version: p.version,
      origin: p.origin,
      publisher: p.publisher,
      updateRegistryUrl: p.updateRegistryUrl,
      loaded: p.status === "loaded",
    });
  }
  return out;
}

const ACTION_LABEL: Record<PackageInspection["action"], string> = {
  install: "Install",
  update: "Update",
  reinstall: "Reinstall",
  downgrade: "Downgrade",
  "override-bundled": "Replace the bundled version",
  "already-installed": "Already installed",
};

/** The permission review, as text. Exported for tests. */
export function renderReview(i: PackageInspection): string {
  const lines: string[] = [];
  const from = i.currentVersion ? ` (currently ${i.currentVersion})` : "";
  lines.push(
    theme.heading(`${ACTION_LABEL[i.action]}: ${i.manifest.name} ${i.manifest.version}${from}`),
  );
  lines.push(
    `${theme.muted("id:")} ${i.manifest.id}   ${theme.muted("publisher:")} ${i.manifest.publisher}`,
  );
  lines.push(
    `${theme.muted("package:")} ${formatBytes(i.sizeBytes)}, ${i.files} files, ${formatBytes(i.unpackedBytes)} unpacked`,
  );
  lines.push(`${theme.muted("sha256:")} ${i.sha256}`);
  lines.push("");
  if (i.permissions.length === 0) {
    lines.push("Permissions: none requested.");
  } else {
    lines.push("Permissions it asks for:");
    for (const p of i.permissions) {
      const flags = [
        i.newPermissions.includes(p.key) && i.action !== "install" ? theme.warn("NEW") : "",
        p.category === "gated" ? theme.warn("off until you grant it") : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`  - ${p.consent} ${theme.muted(`[${p.key}]`)}${flags ? ` (${flags})` : ""}`);
    }
  }
  for (const w of i.warnings) lines.push(theme.warn(`! ${w}`));
  lines.push("");
  lines.push(theme.muted("Installing does not turn the plugin on."));
  return lines.join("\n");
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function reviewAndCommit(
  inspection: PackageInspection,
  config: InfinibotConfig,
  opts: PackageInstallCliOptions,
): Promise<void> {
  if (inspection.action === "already-installed") {
    const where =
      inspection.existingOrigin === "package"
        ? "is already installed"
        : "is already included with InfiniBot";
    log(
      theme.success(
        `${inspection.manifest.name} ${inspection.currentVersion ?? inspection.manifest.version} ${where}; nothing to install.`,
      ),
    );
    log(`Turn it on with \`infinibot plugins enable ${inspection.manifest.id}\`.`);
    return;
  }
  log(renderReview(inspection));
  const needsAnswer =
    inspection.newPermissions.length > 0 ||
    inspection.needsOverrideConfirmation ||
    inspection.action === "install";
  if (needsAnswer && !opts.yes) {
    if (!process.stdin.isTTY) {
      die("Review the permissions above, then re-run with --yes to accept them.");
    }
    if (!(await confirm("Continue?"))) die("Cancelled.");
  }
  if (inspection.needsOverrideConfirmation && !opts.overrideBundled) {
    die(
      `${inspection.manifest.name} ships with InfiniBot. Re-run with --override-bundled to replace it with this package.`,
    );
  }
  let result;
  try {
    result = await commitPluginPackage(inspection, {
      config,
      acceptedPermissions: inspection.permissionKeys,
      overrideBundled: opts.overrideBundled === true,
      allowDowngrade: opts.allowDowngrade === true,
      allowReinstall: opts.reinstall === true,
    });
  } catch (err) {
    die(errorText(err));
  }
  try {
    await writeConfigFile(result.config);
  } catch (err) {
    result.undo();
    die(`could not save config (${errorText(err)}); the install was rolled back`);
  }
  const enabled = result.config.plugins?.entries?.[result.id]?.enabled === true;
  log(
    theme.success(
      `${result.action === "install" ? "Installed" : "Updated"} ${result.id} ${result.version}` +
        (result.previousVersion
          ? ` (was ${result.previousVersion}; \`infinibot plugins rollback ${result.id}\` undoes this)`
          : ""),
    ),
  );
  log(
    enabled
      ? "Restart the gateway to load the new version."
      : `It is off. Turn it on with \`infinibot plugins enable ${result.id}\`, then restart the gateway.`,
  );
}

/**
 * Handle `plugins install <arg>` when the argument is a package zip, a URL or
 * (with --marketplace) a marketplace id. Returns false when it is none of
 * those, so the legacy path/npm installer runs.
 */
export async function tryInstallPackage(
  raw: string,
  opts: PackageInstallCliOptions,
): Promise<boolean> {
  const config = loadConfig();
  try {
    if (opts.marketplace) {
      const [id, version] = raw.split("@");
      const { inspection } = await prepareRegistryInstall(
        { id: id as string, version, token: opts.token },
        { config },
      );
      await reviewAndCommit(inspection, config, opts);
      return true;
    }
    if (/^https?:\/\//i.test(raw)) {
      if (!isAllowedPackageUrl(raw)) die("The URL must be https (http only for localhost).");
      log(`Downloading ${raw}…`);
      const dl = await fetchPackage(raw);
      const inspection = await inspectPluginPackage({
        buffer: dl.buffer,
        source: { kind: "url", url: dl.url },
        config,
        expectedSha256: opts.sha256,
      });
      await reviewAndCommit(inspection, config, opts);
      return true;
    }
    const resolved = resolveUserPath(raw);
    if (!resolved.toLowerCase().endsWith(".zip") || !fs.existsSync(resolved)) return false;
    if (!fs.statSync(resolved).isFile()) return false;
    if (fs.statSync(resolved).size > PACKAGE_LIMITS.maxZipBytes) {
      die(
        `${shortenHomePath(resolved)} is larger than the ${formatBytes(PACKAGE_LIMITS.maxZipBytes)} package limit.`,
      );
    }
    // A `<file>.sha256` sidecar next to the zip is verified automatically.
    let expected = opts.sha256;
    const sidecar = `${resolved}.sha256`;
    if (!expected && fs.existsSync(sidecar)) {
      expected = fs.readFileSync(sidecar, "utf-8").trim().split(/\s+/)[0];
    }
    const inspection = await inspectPluginPackage({
      buffer: fs.readFileSync(resolved),
      source: { kind: "zip", fileName: path.basename(resolved), path: resolved },
      config,
      expectedSha256: expected,
    });
    await reviewAndCommit(inspection, config, opts);
    return true;
  } catch (err) {
    die(errorText(err));
  }
}

/** Registry updates for `plugins update`. Returns ids it handled. */
export async function updateRegistryPlugins(params: {
  ids: string[];
  all: boolean;
  dryRun: boolean;
  yes: boolean;
  token?: string;
}): Promise<Set<string>> {
  const config = loadConfig();
  const refs = cliPluginRefs(config).filter((r) => isRegistryManaged(r, config));
  const targets = params.all ? refs : refs.filter((r) => params.ids.includes(r.id));
  const handled = new Set(targets.map((t) => t.id));
  if (targets.length === 0) return handled;
  const state = await checkPluginUpdates(targets, { config });
  if (state.error) log(theme.warn(`Registry: ${state.error}`));
  let current = config;
  for (const ref of targets) {
    const info = state.plugins[ref.id];
    if (info?.error) {
      log(theme.warn(`${ref.id}: ${info.error}`));
      continue;
    }
    if (!info?.updateAvailable || !info.latestVersion) {
      log(
        `${ref.id} is up to date (${ref.version ?? "unknown"})${info?.blocked ? ` — ${info.blocked}` : ""}.`,
      );
      continue;
    }
    if (params.dryRun) {
      log(`Would update ${ref.id}: ${ref.version ?? "unknown"} -> ${info.latestVersion}.`);
      continue;
    }
    try {
      const { inspection } = await prepareRegistryInstall(
        {
          id: ref.id,
          version: info.latestVersion,
          token: params.token,
          registryUrl: info.registryUrl,
        },
        { config: current },
      );
      for (const entry of info.changelog) {
        if (entry.notes) log(theme.muted(`  ${entry.version}: ${entry.notes.split("\n")[0]}`));
      }
      if (inspection.newPermissions.length && !params.yes) {
        log(renderReview(inspection));
        if (
          !(await confirm(
            `${ref.id} ${info.latestVersion} asks for new permissions. Accept and update?`,
          ))
        ) {
          log(
            theme.warn(
              `Skipped ${ref.id} (new permissions not accepted; re-run with --yes to accept).`,
            ),
          );
          continue;
        }
      }
      const result = await commitPluginPackage(inspection, {
        config: current,
        acceptedPermissions: inspection.permissionKeys,
      });
      try {
        await writeConfigFile(result.config);
      } catch (err) {
        result.undo();
        throw err;
      }
      current = result.config;
      log(
        theme.success(
          `Updated ${ref.id}: ${result.previousVersion ?? "unknown"} -> ${result.version}.`,
        ),
      );
    } catch (err) {
      log(theme.error(`Failed to update ${ref.id}: ${errorText(err)}`));
    }
  }
  if (!params.dryRun) log("Restart the gateway to load updated plugins.");
  return handled;
}

/** Run a command action, then end the process (see `finish`). */
function run<A extends unknown[]>(fn: (...args: A) => void | Promise<void>) {
  return async (...args: A) => {
    await fn(...args);
    finish(0);
  };
}

export function registerPluginPackageCommands(plugins: Command) {
  plugins
    .command("create")
    .description("Scaffold a minimal working plugin")
    .argument("<id>", "Plugin id (lowercase letters, digits, dashes)")
    .option("--dir <path>", "Folder to create (default: ./<id>)")
    .option("--name <name>", "Display name")
    .option("--publisher <id>", "Your publisher id")
    .action(
      run((id: string, opts: { dir?: string; name?: string; publisher?: string }) => {
        const dir = path.resolve(opts.dir ?? id);
        try {
          const files = writePluginScaffold(dir, {
            id,
            name: opts.name,
            publisher: opts.publisher,
          });
          log(theme.success(`Created ${shortenHomePath(dir)} (${files.length} files)`));
          log(
            `Next:\n  infinibot plugins validate ${shortenHomePath(dir)}\n  infinibot plugins pack ${shortenHomePath(dir)}`,
          );
        } catch (err) {
          die(errorText(err));
        }
      }),
    );

  plugins
    .command("validate")
    .description("Check a plugin folder or package zip against the package format")
    .argument("<dir-or-zip>", "Plugin folder or .zip")
    .option("--include-node-modules", "Count node_modules as part of the package", false)
    .option("--json", "Print JSON")
    .action(
      run(async (target: string, opts: { json?: boolean; includeNodeModules?: boolean }) => {
        const resolved = resolveUserPath(target);
        if (!fs.existsSync(resolved)) die(`Not found: ${resolved}`);
        const report = fs.statSync(resolved).isDirectory()
          ? validatePluginDir(resolved, { includeNodeModules: opts.includeNodeModules })
          : await validatePluginZip(resolved);
        if (opts.json) {
          log(JSON.stringify(report, null, 2));
        } else {
          for (const e of report.errors) log(theme.error(`error: ${e}`));
          for (const w of report.warnings) log(theme.warn(`warning: ${w}`));
          if (report.ok && report.manifest) {
            log(
              theme.success(
                `${report.manifest.id} ${report.manifest.version} is a valid plugin package (${report.files} files, ${formatBytes(report.unpackedBytes)})`,
              ),
            );
            if (report.sha256) log(`${theme.muted("sha256:")} ${report.sha256}`);
          }
        }
        if (!report.ok) process.exit(1);
      }),
    );

  plugins
    .command("pack")
    .description("Validate a plugin folder and build a deterministic package zip + sha256")
    .argument("<dir>", "Plugin folder")
    .option("-o, --out <path>", "Output file or folder (default: ./<id>-<version>.ibplugin.zip)")
    .option("--include-node-modules", "Pack node_modules too", false)
    .option("--json", "Print JSON")
    .action(
      run(
        async (
          dir: string,
          opts: { out?: string; json?: boolean; includeNodeModules?: boolean },
        ) => {
          const result = await packPluginDir(resolveUserPath(dir), {
            out: opts.out,
            includeNodeModules: opts.includeNodeModules,
          });
          if (opts.json) {
            log(JSON.stringify(result, null, 2));
            if (!result.ok) process.exit(1);
            return;
          }
          if (!result.ok) {
            for (const e of result.errors) log(theme.error(`error: ${e}`));
            for (const w of result.warnings) log(theme.warn(`warning: ${w}`));
            process.exit(1);
          }
          for (const w of result.warnings) log(theme.warn(`warning: ${w}`));
          log(theme.success(`Packed ${result.manifest.id} ${result.manifest.version}`));
          log(
            `${theme.muted("file:")}   ${shortenHomePath(result.file)} (${formatBytes(result.sizeBytes)}, ${result.files} files)`,
          );
          log(`${theme.muted("sha256:")} ${result.sha256}`);
        },
      ),
    );

  plugins
    .command("updates")
    .alias("outdated")
    .description("Check the registry for plugin updates")
    .option("--json", "Print JSON")
    .action(
      run(async (opts: { json?: boolean }) => {
        const config = loadConfig();
        try {
          const state = await checkPluginUpdates(cliPluginRefs(config), { config });
          if (opts.json) return log(JSON.stringify(state, null, 2));
          if (state.error) log(theme.warn(`Registry (${state.registryUrl}): ${state.error}`));
          const rows = Object.values(state.plugins)
            .filter((p) => p.updateAvailable || p.blocked || p.error)
            .map((p) => ({
              Plugin: p.id,
              Installed: p.currentVersion ?? "",
              Latest: p.latestVersion ?? "",
              Note: p.error ?? p.blocked ?? (p.paid ? "paid" : ""),
            }));
          if (rows.length === 0) return log("All registry-managed plugins are up to date.");
          log(
            renderTable({
              width: Math.max(60, (process.stdout.columns ?? 120) - 1),
              columns: [
                { key: "Plugin", header: "Plugin", minWidth: 14, flex: true },
                { key: "Installed", header: "Installed", minWidth: 10 },
                { key: "Latest", header: "Latest", minWidth: 10 },
                { key: "Note", header: "Note", minWidth: 10, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
          log(theme.muted("Update with `infinibot plugins update <id>` or `--all`."));
        } catch (err) {
          die(errorText(err));
        }
      }),
    );

  plugins
    .command("rollback")
    .description("Go back to the previous version of an installed plugin package")
    .argument("<id>", "Plugin id")
    .action(
      run(async (id: string) => {
        const config = loadConfig();
        try {
          const result = rollbackPluginPackage({ id, config });
          try {
            await writeConfigFile(result.config);
          } catch (err) {
            result.undo();
            throw err;
          }
          log(
            theme.success(
              result.restored === "bundled"
                ? `Rolled ${id} back to the version that ships with InfiniBot (${result.version}).`
                : `Rolled ${id} back: ${result.from} -> ${result.version}.`,
            ),
          );
          log("Restart the gateway to apply.");
        } catch (err) {
          die(errorText(err));
        }
      }),
    );

  plugins
    .command("auto-update")
    .description("Turn automatic updates on or off for one plugin (default off)")
    .argument("<id>", "Plugin id")
    .argument("<on|off>", "on or off")
    .action(
      run(async (id: string, value: string) => {
        const auto = value === "on" ? true : value === "off" ? false : die("Use `on` or `off`.");
        const config = loadConfig();
        if (!cliPluginRefs(config).some((r) => r.id === id)) die(`Plugin not found: ${id}`);
        await writeConfigFile(setAutoUpdateInConfig(config, id, auto));
        log(`Auto-update for ${id}: ${auto ? "on" : "off"}.`);
      }),
    );

  plugins
    .command("marketplace")
    .alias("search")
    .description("List plugins in the marketplace registry")
    .argument("[query]", "Filter by name, id or tag")
    .option("--json", "Print JSON")
    .action(
      run(async (query: string | undefined, opts: { json?: boolean }) => {
        const config = loadConfig();
        try {
          const registryUrl = marketplaceRegistryUrl({ config });
          const index = await createRegistryClient({ registryUrl }).index();
          const q = query?.trim().toLowerCase();
          const list = index.plugins.filter(
            (p) =>
              !q ||
              p.id.includes(q) ||
              p.name.toLowerCase().includes(q) ||
              p.tags.some((t) => t.toLowerCase().includes(q)),
          );
          if (opts.json) return log(JSON.stringify({ registryUrl, plugins: list }, null, 2));
          if (list.length === 0) return log(theme.muted(`No plugins found in ${registryUrl}.`));
          log(theme.muted(`Registry: ${registryUrl}`));
          log(
            renderTable({
              width: Math.max(60, (process.stdout.columns ?? 120) - 1),
              columns: [
                { key: "ID", header: "ID", minWidth: 12, flex: true },
                { key: "Name", header: "Name", minWidth: 12, flex: true },
                { key: "Version", header: "Version", minWidth: 8 },
                { key: "Publisher", header: "Publisher", minWidth: 10 },
                { key: "Price", header: "Price", minWidth: 6 },
              ],
              rows: list.map((p) => ({
                ID: p.id,
                Name: p.name,
                Version: p.version,
                Publisher: `${p.publisher.name}${p.publisher.verified ? " ✓" : ""}`,
                Price: formatPrice(p.pricing),
              })),
            }).trimEnd(),
          );
          log(theme.muted("Install with `infinibot plugins install <id> --marketplace`."));
        } catch (err) {
          die(errorText(err));
        }
      }),
    );
}
