import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const projectsDir = path.join(os.homedir(), ".claude", "projects");
const storePath = path.join(os.homedir(), ".infinibot", "agents", "main", "sessions", "sessions.json");

function isTopLevelTranscript(filePath, projectsDir) {
  if (!filePath.endsWith(".jsonl")) return false;
  const rel = path.relative(projectsDir, filePath);
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  return parts.length === 2;
}

const s = JSON.parse(fs.readFileSync(storePath, "utf-8"));
const cc = Object.entries(s).filter(([k]) => k.startsWith("claude-code:"));
let keep = 0, pruneSubagent = 0, pruneMissing = 0, pruneNoFile = 0;
const sample = [];
for (const [k, e] of cc) {
  const f = e?.sessionFile;
  if (!f) { pruneNoFile++; continue; }
  if (!fs.existsSync(f)) { pruneMissing++; continue; }
  if (!isTopLevelTranscript(f, projectsDir)) {
    pruneSubagent++;
    if (sample.length < 3) {
      const rel = path.relative(projectsDir, f);
      sample.push({ key: k, file: f, rel, parts: rel.split(/[\\/]+/).filter(Boolean) });
    }
    continue;
  }
  keep++;
}
console.log(`claude-code: rows: ${cc.length}`);
console.log(`  will keep:           ${keep}`);
console.log(`  will prune subagent: ${pruneSubagent}`);
console.log(`  will prune missing:  ${pruneMissing}`);
console.log(`  will prune no-file:  ${pruneNoFile}`);
console.log("\nFirst 3 'subagent' samples:");
for (const s of sample) {
  console.log("  key:", s.key);
  console.log("    file:", s.file);
  console.log("    rel: ", s.rel);
  console.log("    parts.length:", s.parts.length, "→", s.parts);
}
