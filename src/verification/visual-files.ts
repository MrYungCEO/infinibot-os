/**
 * Visual-change detection. A run whose diff touches any of these paths MUST
 * carry screenshots from the standard `visual_verify` tool, otherwise its
 * verdict is UNVERIFIED and it is continued with a request to verify visually.
 */

const VISUAL_EXT = /\.(css|scss|sass|less|html?|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|lit\.ts)$/i;

/** Non-visual files that live under visual folders. */
const NON_VISUAL = [
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /(^|\/)__tests__\//,
  /(^|\/)(controllers|api|services|stores?|state|utils?|lib|gateway|rpc|types?)\//i,
  /\.d\.ts$/i,
];

const VISUAL_CODE_DIRS = [
  /^ui\/src\/ui\/(views|components|styles|layouts?|pages|widgets|overlays?)\//i,
  /^ui\/src\/styles?\//i,
  /^ui\/src\/ui\/app-render/i,
  /^ui\/src\/ui\/[^/]+\.(ts|css)$/i,
  /^ui\/index\.html$/i,
  /^mobile\/src\/(screens|components|navigation|theme|styles)\//i,
  /^mobile\/App\.[jt]sx?$/i,
  /^electron\/(renderer|src\/renderer|ui)\//i,
  /^apps\/[^/]+\/(src\/)?(renderer|ui|views|components|screens)\//i,
];

const VISUAL_ASSET_DIRS = [
  /^ui\/public\//i,
  /^public\//i,
  /^mobile\/assets\//i,
  /^assets\//i,
  /^docs\/.*\.html?$/i,
];

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** True when a repo-relative path is a visual file. */
export function isVisualFile(rawPath: string): boolean {
  const p = normalize(rawPath);
  if (!p) return false;
  if (NON_VISUAL.some((re) => re.test(p))) return false;
  if (VISUAL_ASSET_DIRS.some((re) => re.test(p))) return true;
  if (VISUAL_CODE_DIRS.some((re) => re.test(p))) return CODE_EXT.test(p) || VISUAL_EXT.test(p);
  // Stylesheets / HTML anywhere except node_modules, dist, coverage, fixtures.
  if (/(^|\/)(node_modules|dist|build|coverage|fixtures?|test|tests)\//.test(p)) return false;
  return /\.(css|scss|sass|less|html?)$/i.test(p);
}

export function detectVisualChanges(files: string[]): string[] {
  return [...new Set(files.map(normalize))].filter(isVisualFile);
}
