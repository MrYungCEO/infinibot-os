/**
 * Light post-check for group-chat member replies: flags sentences that claim
 * an action happened (created / pushed / committed / enabled / done / tests
 * passed) when the speaker's turn has no matching SUCCESSFUL tool result, plus
 * invented git remote URLs. Flags are stamped on the group message as
 * `unverified` and shown to the other members and in the UI.
 *
 * Deliberately conservative: future / conditional / negative sentences ("I'll
 * push", "the push failed", "once it's done") are never flagged, and only
 * past-tense completion wording is checked.
 */
import { activityFacts, type ToolActivity } from "./activity.js";

export type ClaimKind =
  | "push"
  | "commit"
  | "task"
  | "tests"
  | "done"
  | "organize"
  | "spawn-not-done"
  | "url";

export type UnverifiedClaim = {
  kind: ClaimKind;
  /** The sentence (clipped) that made the claim. */
  claim: string;
  reason: string;
};

const NON_ASSERTIVE =
  /\b(will|i'll|we'll|you'll|it'll|going to|plan to|planning to|about to|once|if|should|could|would|can you|could you|please|let me|let's|waiting|wait for|ready to|need to|needs to|want to|try to|haven't|have not|has not|hasn't|not yet|didn't|did not|isn't|is not|aren't|are not|wasn't|weren't|no longer|failed|fails|couldn't|cannot|can't|unable|unverified|not verified|pending|started run|started a run|kicked off|in progress|queued)\b/i;

const FIRST_PERSON = /\b(i|i've|i'm|i've|we|we've|my|our)\b/i;

const PATTERNS: Array<{ kind: Exclude<ClaimKind, "url" | "spawn-not-done">; re: RegExp }> = [
  {
    kind: "push",
    re: /\b(pushed|push(?:ed)? (?:it |them |this |the (?:changes|commit|branch) )?to|(?:is|are) (?:now )?(?:on|in) (?:the )?(?:origin|remote|github|gitlab))\b/i,
  },
  { kind: "commit", re: /\bcommitted\b/i },
  {
    kind: "organize",
    re: /\b(renamed|re-named|moved|grouped|organi[sz]ed|re-?organi[sz]ed|filed|tagged|sorted|relabell?ed|put (?:them|it|all|the files?)[^.!\n]{0,40}\b(?:in|into)\b)\b/i,
  },
  {
    kind: "task",
    re: /\b(created|opened|added|filed|logged|assigned)\b[^.!\n]{0,60}\b(kanban|task|ticket|card|issue)\b/i,
  },
  {
    kind: "tests",
    re: /\b(tests? (?:all )?(?:pass(?:ed|es)?|are passing|are green|succeeded)|all (?:the )?tests pass(?:ed)?|ran the tests)\b/i,
  },
  {
    kind: "done",
    re: /\b(implemented|created|wrote|added|fixed|updated|modified|deployed|merged|installed|configured|enabled|completed|finished|shipped|set up|(?:is|are) (?:now )?(?:enabled|active|live|deployed|done|complete|in place|working)|all set|done)\b/i,
  },
];

const GIT_URL_RE =
  /\b(https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.(?:com|org)\/[^\s)`'"<>\]]+|git@[\w.-]+:[^\s`'"<>)]+)/gi;
const PLACEHOLDER_RE = /\b(your[-_]?org|your[-_]?user(name)?|YOUR_[A-Z_]+|example\.com|<[^>]+>)\b/i;

function sentences(text: string): string[] {
  const noCode = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, (m) => m);
  return noCode
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function clip(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * @param reply        the member's reply text
 * @param own          this turn's tool activity
 * @param groupActivity activity other members recorded recently (evidence for relayed, third-person claims)
 * @param knownText    text the speaker legitimately saw (tool outputs, group context, transcript) — URLs found here are not "invented"
 */
export function checkReplyClaims(params: {
  reply: string;
  own: ToolActivity[] | undefined;
  groupActivity?: ToolActivity[];
  knownText?: string;
}): UnverifiedClaim[] {
  const reply = params.reply ?? "";
  if (!reply.trim()) return [];
  const own = activityFacts(params.own);
  const shared = activityFacts([...(params.own ?? []), ...(params.groupActivity ?? [])]);
  const flags: UnverifiedClaim[] = [];
  const seen = new Set<string>();
  const add = (f: UnverifiedClaim) => {
    const k = `${f.kind}:${f.claim}`;
    if (seen.has(k)) return;
    seen.add(k);
    flags.push(f);
  };

  for (const s of sentences(reply)) {
    if (NON_ASSERTIVE.test(s) || s.endsWith("?")) continue;
    const firstPerson = FIRST_PERSON.test(s);
    const ev = firstPerson ? own : shared;
    for (const { kind, re } of PATTERNS) {
      if (!re.test(s)) continue;
      // "moved the task to Done" / "filed a ticket" are board claims, not file claims.
      if (
        kind === "organize" &&
        /\b(tasks?|tickets?|cards?|issues?|kanban)\b/i.test(s) &&
        !/\b(files?|documents?|videos?|images?|photos?|pdfs?)\b/i.test(s)
      )
        continue;
      if (kind === "push" && !ev.pushOk) {
        add({
          kind,
          claim: clip(s),
          reason: ev.pushFailed
            ? "the git push in the recorded tool results FAILED"
            : "no successful git push in the recorded tool results",
        });
      } else if (kind === "commit" && !ev.commitOk) {
        add({
          kind,
          claim: clip(s),
          reason: "no successful git commit in the recorded tool results",
        });
      } else if (kind === "organize" && !ev.organizeOk) {
        add({
          kind,
          claim: clip(s),
          reason: ev.organizeTried
            ? "the rename/move tool calls changed no file (failed or 0 changed)"
            : "no rename/move/tag tool call changed any file",
        });
      } else if (kind === "task" && !ev.kanbanWrite) {
        add({ kind, claim: clip(s), reason: "no kanban/task tool call succeeded" });
      } else if (kind === "tests" && !ev.testsOk) {
        add({
          kind,
          claim: clip(s),
          reason: "no successful test command in the recorded tool results",
        });
      } else if (kind === "done" && !ev.mutatingOk) {
        if (ev.spawned.length) {
          add({
            kind: "spawn-not-done",
            claim: clip(s),
            reason: `only started run ${ev.spawned.join(", ")} — it has not reported a verified result`,
          });
        } else {
          add({
            kind,
            claim: clip(s),
            reason: own.any
              ? "no successful tool call that changes anything backs this"
              : "no tool call was made in this turn",
          });
        }
      }
      // One flag per sentence is enough.
      if (flags.length && flags[flags.length - 1].claim === clip(s)) break;
    }
  }

  const known = params.knownText ?? "";
  for (const m of reply.matchAll(GIT_URL_RE)) {
    const url = m[1].replace(/[.,;:]+$/, "");
    const bare = url.replace(/\.git$/, "");
    if (PLACEHOLDER_RE.test(url)) {
      add({ kind: "url", claim: url, reason: "placeholder repo URL — no such remote exists" });
    } else if (!known.includes(bare)) {
      add({
        kind: "url",
        claim: url,
        reason: "this URL appears in no tool output or group context",
      });
    }
  }
  return flags;
}

/** Annotation other members (and the transcript) see under a flagged message. */
export function formatUnverified(flags: UnverifiedClaim[] | undefined): string {
  if (!flags?.length) return "";
  return [
    "[⚠ Gateway check — UNVERIFIED claim(s); treat as NOT done:]",
    ...flags.map((f) => `- "${f.claim}" — ${f.reason}`),
  ].join("\n");
}
