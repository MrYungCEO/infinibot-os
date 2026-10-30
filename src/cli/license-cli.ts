import fs from "node:fs";
import type { Command } from "commander";
import {
  activateCommercialLicense,
  commercialLicenseStatus,
} from "../commercial-licensing/local.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

type OutputOpts = { json?: boolean };

function printStatus(status: ReturnType<typeof commercialLicenseStatus>, json = false) {
  if (json) {
    defaultRuntime.log(JSON.stringify(status, null, 2));
    return;
  }
  if (!status.installed || !status.payload) {
    defaultRuntime.log(`${theme.heading("Commercial license")} ${theme.muted("not activated")}`);
    defaultRuntime.log(
      theme.muted("FSL-1.1-permitted use remains available; no license is required for that use."),
    );
    return;
  }
  const p = status.payload;
  const tone =
    status.state === "active" ? theme.success : status.state === "grace" ? theme.warn : theme.error;
  defaultRuntime.log(`${theme.heading("Commercial license")} ${tone(status.state)}`);
  defaultRuntime.log(`  Licensee: ${p.licensee}`);
  defaultRuntime.log(`  Tier: ${p.tier}`);
  defaultRuntime.log(`  Seats / organizations: ${p.seats} / ${p.organizations}`);
  if (p.revenueCapUsd !== undefined)
    defaultRuntime.log(
      `  Revenue limit: ${p.revenueCapUsd == null ? "no standard limit" : `$${p.revenueCapUsd.toLocaleString("en-US")}/year`}`,
    );
  if (p.term)
    defaultRuntime.log(
      `  Term: ${p.term.termDays} days${p.term.autoRenew ? ", renews automatically until cancelled" : ""}`,
    );
  if (p.licensor) defaultRuntime.log(`  Licensor: ${p.licensor}`);
  defaultRuntime.log(`  Agreement: v${p.agreementVersion}`);
  defaultRuntime.log(`  Expires: ${new Date(p.exp * 1000).toISOString()}`);
  defaultRuntime.log(`  License id: ${p.jti}`);
}

export function registerLicenseCli(program: Command) {
  const license = program
    .command("license")
    .description("Activate or inspect an InfiniBot commercial-use license");
  license
    .command("activate")
    .description("Verify and save a signed commercial license key")
    .argument("[key]", "Signed license key (omit when using --file)")
    .option("--file <path>", "Read the key from a file")
    .option("--json", "Print JSON")
    .action((key: string | undefined, opts: OutputOpts & { file?: string }) => {
      const raw = opts.file ? fs.readFileSync(opts.file, "utf8").trim() : key?.trim();
      if (!raw) throw new Error("Pass a license key or --file <path>.");
      const result = activateCommercialLicense(raw);
      if (!result.valid) {
        defaultRuntime.error(`License rejected: ${result.reason ?? "invalid"}`);
        defaultRuntime.exit(1);
        return;
      }
      printStatus(commercialLicenseStatus(), Boolean(opts.json));
      defaultRuntime.exit(0);
    });
  license
    .command("status")
    .description("Verify the activated commercial license offline")
    .option("--json", "Print JSON")
    .action((opts: OutputOpts) => {
      printStatus(commercialLicenseStatus(), Boolean(opts.json));
      defaultRuntime.exit(0);
    });
}
