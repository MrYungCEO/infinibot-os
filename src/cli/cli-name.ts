import path from "node:path";

export const DEFAULT_CLI_NAME = "infinibot";

const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(infinibot)\b/;

export function resolveCliName(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const override = env.INFINIBOT_CLI_NAME?.trim();
  if (override) return override;
  const argv1 = argv[1];
  if (!argv1) return DEFAULT_CLI_NAME;
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) return base;
  return DEFAULT_CLI_NAME;
}

export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) return command;
  if (!CLI_PREFIX_RE.test(command)) return command;
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}

export function resolveDisplayName(cliName = resolveCliName()): string {
  const name = cliName.toLowerCase();
  if (name === "infinibot") return "InfiniBot";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
