/**
 * Golden suite loaders + v2-artefact scorer.
 */
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_ROOT = HERE;
export const TASKS_PATH = join(HERE, "tasks.json");
export const PROMPT_TEMPLATE_PATH = join(HERE, "prompt-template.md");

export const CRITERIA_VERSION = "v2-artefact";

export type TaskOutcome = "complete" | "takeover" | "spend_cap";
export type EvidenceStatus = "satisfied" | "failed" | "unverifiable";
export type GoldenVerdict = "PASS" | "FAIL" | "UNVERIFIED" | "SKIP";

export interface TaskExpectSpec {
  min_tool_calls: number;
  artifact_glob?: string;
  artifact_min_bytes?: number;
  artifact_jsonl_min_lines?: number;
  event?: string;
  final_text_regex?: string;
}

export interface GoldenTask {
  id: string;
  name: string;
  sites: string[];
  goal: string;
  acceptance: string;
  expect: TaskExpectSpec;
  tags: string[];
  max_steps?: number;
  timeout_sec?: number;
  spend_cap_usd?: number;
  artifacts: string[];
  stand_in?: {
    on: string;
    username: string;
    password: string;
    submit?: string;
  };
}

export interface GoldenSuite {
  version: number;
  defaults: {
    max_steps: number;
    timeout_sec: number;
    spend_cap_usd: number;
  };
  tasks: GoldenTask[];
}

export interface ScoreEvidence {
  clause: string;
  status: EvidenceStatus;
  detail?: string;
}

export type ScoreEvent =
  | string
  | { type: string; reason?: string; body?: { reason?: string } };

export interface ScoreInput {
  exit0: boolean;
  steps: number;
  tool_calls?: number;
  events?: ScoreEvent[];
  final_text?: string;
  workspaceRoot?: string;
  takeover?: boolean;
  notes?: string;
  reason?: string;
  skip?: boolean;
}

export interface ScoreResult {
  verdict: GoldenVerdict;
  exit0: boolean;
  steps: number;
  tool_calls: number;
  evidence: ScoreEvidence[];
}

export function loadGoldenSuite(path = TASKS_PATH): GoldenSuite {
  const raw = JSON.parse(readFileSync(path, "utf8")) as GoldenSuite;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.tasks)) {
    throw new Error(`invalid golden suite at ${path}`);
  }
  for (const task of raw.tasks) {
    const exp = task.expect;
    if (!exp || typeof exp !== "object" || typeof exp.min_tool_calls !== "number") {
      throw new Error(`task ${task.id} missing expect.min_tool_calls`);
    }
    if (exp.min_tool_calls < 1) {
      throw new Error(`task ${task.id} expect.min_tool_calls must be ≥1`);
    }
  }
  return raw;
}

export function taskLimits(suite: GoldenSuite, task: GoldenTask): {
  max_steps: number;
  timeout_sec: number;
  spend_cap_usd: number;
} {
  return {
    max_steps: task.max_steps ?? suite.defaults.max_steps,
    timeout_sec: task.timeout_sec ?? suite.defaults.timeout_sec,
    spend_cap_usd: task.spend_cap_usd ?? suite.defaults.spend_cap_usd,
  };
}

export function expectOutcome(task: GoldenTask): TaskOutcome {
  const ev = task.expect.event ?? "";
  if (ev === "takeover_request" || ev === "takeover.requested") return "takeover";
  if (ev === "spend_cap") return "spend_cap";
  return "complete";
}

export function renderPrompt(
  suite: GoldenSuite,
  task: GoldenTask,
  computerName: string,
  template = readFileSync(PROMPT_TEMPLATE_PATH, "utf8"),
): string {
  const lim = taskLimits(suite, task);
  const sites =
    task.sites.length === 0
      ? "- (none listed)"
      : task.sites.map((s) => `- ${s}`).join("\n");
  return template
    .replaceAll("{{task_id}}", task.id)
    .replaceAll("{{computer_name}}", computerName)
    .replaceAll("{{max_steps}}", String(lim.max_steps))
    .replaceAll("{{timeout_sec}}", String(lim.timeout_sec))
    .replaceAll("{{spend_cap_usd}}", String(lim.spend_cap_usd))
    .replaceAll("{{goal}}", task.goal)
    .replaceAll("{{sites}}", sites)
    .replaceAll("{{acceptance}}", task.acceptance)
    .replaceAll("{{expect}}", expectOutcome(task));
}

export const REQUIRED_TASK_IDS = [
  "saucedemo-login-cart",
  "the-internet-auth-download",
  "demoqa-forms-upload",
  "books-toscrape-csv",
  "quotes-toscrape-pagination",
  "recaptcha-takeover",
  "multi-tab-compare",
  "spa-click-flow",
  "table-sort-read",
  "search-summarize",
  "dropdown-datepicker",
  "spend-cap-negative",
] as const;

export function artifactRelPath(globPat: string): string {
  return globPat.replace(/^\/workspace\/?/, "").replace(/\*/g, "sample");
}

export function syntheticArtifactBody(task: GoldenTask): string {
  switch (task.id) {
    case "books-toscrape-csv":
      return (
        "title,price\n" +
        Array.from({ length: 12 }, (_, i) => `Book ${i},£${10 + i}.00`).join("\n") +
        "\n"
      );
    case "quotes-toscrape-pagination":
      return (
        Array.from({ length: 16 }, (_, i) =>
          JSON.stringify({ text: `quote ${i} about life and work`, author: `Author${i}` }),
        ).join("\n") + "\n"
      );
    case "the-internet-auth-download":
      return "downloaded from the-internet\n";
    case "multi-tab-compare":
      return [
        "# compare",
        "A Light in the Attic £51.77",
        "Tipping the Velvet £53.74",
        "cheaper: A Light in the Attic",
        "",
      ].join("\n");
    case "table-sort-read":
      return `${JSON.stringify({ lastName: "Smith", firstName: "John", due: "$50.00" })}\n`;
    case "search-summarize":
      return "Humor quotes: one, two, and three. Austen and others joke about life. Three humor-tagged quotes summarised.\n";
    default:
      return `# ${task.id}\n`;
  }
}

export function syntheticFinalText(task: GoldenTask): string {
  switch (task.id) {
    case "saucedemo-login-cart":
      return "Sauce Labs Backpack is in the cart after login.";
    case "demoqa-forms-upload":
      return "Submitted Alice Smith alice@example.com via the modal.";
    case "quotes-toscrape-pagination":
      return "collected 16 unique quotes across 2 pages";
    case "multi-tab-compare":
      return "A Light in the Attic is cheaper";
    case "spa-click-flow":
      return "double-click success message seen";
    case "table-sort-read":
      return "top row after Due sort: Smith John $50.00";
    case "dropdown-datepicker":
      return "date input shows 03/15/2030";
    default:
      return `mock complete: ${task.id}`;
  }
}

export function materializeArtifacts(task: GoldenTask, workspaceRoot: string): void {
  const globPat = task.expect.artifact_glob;
  if (!globPat) return;
  const rel = artifactRelPath(globPat);
  const full = join(workspaceRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  let body = syntheticArtifactBody(task);
  const min = task.expect.artifact_min_bytes ?? 1;
  const bytes = Buffer.byteLength(body);
  if (bytes < min) body += "x".repeat(min - bytes);
  writeFileSync(full, body);
}

function matchArtifacts(workspaceRoot: string, globPat: string): string[] {
  const rel = globPat.replace(/^\/workspace\/?/, "");
  const target = join(workspaceRoot, rel);
  if (!rel.includes("*") && !rel.includes("?")) {
    return existsSync(target) ? [target] : [];
  }
  try {
    return globSync(target);
  } catch {
    return [];
  }
}

function eventAliases(want: string): string[] {
  const w = want.toLowerCase();
  if (w === "takeover_request" || w === "takeover.requested") {
    return ["takeover_request", "takeover.requested", "takeover"];
  }
  if (w === "spend_cap") {
    return ["spend_cap", "audit_spend"];
  }
  return [want];
}

function eventName(e: ScoreEvent): string {
  return typeof e === "string" ? e : String(e.type ?? "");
}

function eventReason(e: ScoreEvent): string {
  if (typeof e === "string") return "";
  if (typeof e.reason === "string" && e.reason) return e.reason;
  const body = e.body;
  if (body && typeof body.reason === "string") return body.reason;
  return "";
}

function isSpendCapEvidence(e: ScoreEvent): boolean {
  const n = eventName(e).toLowerCase();
  if (n === "spend_cap" || n === "audit_spend") return true;
  return n === "policy.denied" && eventReason(e) === "spend_cap";
}

function clauseMinToolCalls(min: number, input: ScoreInput): ScoreEvidence {
  if (typeof input.tool_calls !== "number") {
    return { clause: "min_tool_calls", status: "unverifiable", detail: "tool_calls not recorded" };
  }
  const ok = input.tool_calls >= min;
  return {
    clause: "min_tool_calls",
    status: ok ? "satisfied" : "failed",
    detail: `${input.tool_calls}≥${min}`,
  };
}

function clauseArtifactGlob(globPat: string, input: ScoreInput): ScoreEvidence {
  if (!input.workspaceRoot) {
    return { clause: "artifact_glob", status: "unverifiable", detail: "workspace not recorded" };
  }
  const hits = matchArtifacts(input.workspaceRoot, globPat).filter((p) => {
    try {
      return statSync(p).isFile() && statSync(p).size > 0;
    } catch {
      return false;
    }
  });
  return {
    clause: "artifact_glob",
    status: hits.length > 0 ? "satisfied" : "failed",
    detail: hits[0] ?? globPat,
  };
}

function clauseArtifactMinBytes(min: number, globPat: string | undefined, input: ScoreInput): ScoreEvidence {
  if (!input.workspaceRoot) {
    return { clause: "artifact_min_bytes", status: "unverifiable", detail: "workspace not recorded" };
  }
  const hits = globPat ? matchArtifacts(input.workspaceRoot, globPat) : [];
  let best = 0;
  for (const p of hits) {
    try {
      best = Math.max(best, statSync(p).size);
    } catch {
      /* skip */
    }
  }
  const ok = best >= min;
  return {
    clause: "artifact_min_bytes",
    status: ok ? "satisfied" : "failed",
    detail: `${best}≥${min}`,
  };
}

function clauseArtifactJsonlMinLines(
  min: number,
  globPat: string | undefined,
  input: ScoreInput,
): ScoreEvidence {
  if (!input.workspaceRoot) {
    return {
      clause: "artifact_jsonl_min_lines",
      status: "unverifiable",
      detail: "workspace not recorded",
    };
  }
  const hits = globPat ? matchArtifacts(input.workspaceRoot, globPat) : [];
  let best = 0;
  for (const path of hits) {
    try {
      const parseable = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => {
        if (!line.trim()) return false;
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }).length;
      best = Math.max(best, parseable);
    } catch {
      /* skip */
    }
  }
  return {
    clause: "artifact_jsonl_min_lines",
    status: best >= min ? "satisfied" : "failed",
    detail: `${best}≥${min} parseable JSON lines`,
  };
}

function clauseEvent(want: string, input: ScoreInput): ScoreEvidence {
  const aliases = eventAliases(want);
  const names = input.events;
  if (want === "spend_cap") {
    if (names?.some(isSpendCapEvidence)) {
      return { clause: "event", status: "satisfied", detail: want };
    }
    if (names !== undefined || input.reason !== undefined || input.notes !== undefined) {
      const textHit = Boolean(input.notes && /spend_cap|max-budget|budget/i.test(input.notes));
      return {
        clause: "event",
        status: "failed",
        detail: textHit ? "text-only, no audit spend_cap" : want,
      };
    }
    return { clause: "event", status: "unverifiable", detail: want };
  }
  const hitName = names?.some((e) =>
    aliases.some((a) => {
      const n = eventName(e);
      return n === a || n.toLowerCase() === a.toLowerCase();
    }),
  );
  if (hitName) return { clause: "event", status: "satisfied", detail: want };

  const takeoverLike =
    aliases.includes("takeover") ||
    aliases.includes("takeover_request") ||
    aliases.includes("takeover.requested");
  if (takeoverLike) {
    if (input.takeover === true || input.reason === "takeover") {
      return { clause: "event", status: "satisfied", detail: "takeover flag/reason" };
    }
    if (input.notes && /takeover/i.test(input.notes)) {
      return { clause: "event", status: "satisfied", detail: "notes" };
    }
    if (input.takeover === false || input.reason !== undefined || names !== undefined) {
      return { clause: "event", status: "failed", detail: want };
    }
    return { clause: "event", status: "unverifiable", detail: want };
  }

  if (names === undefined) {
    return { clause: "event", status: "unverifiable", detail: want };
  }
  return { clause: "event", status: "failed", detail: want };
}

function clauseFinalText(regex: string, input: ScoreInput): ScoreEvidence {
  if (input.final_text === undefined) {
    return { clause: "final_text_regex", status: "unverifiable", detail: "final text not recorded" };
  }
  let ok = false;
  try {
    ok = new RegExp(regex, "i").test(input.final_text);
  } catch {
    ok = false;
  }
  return {
    clause: "final_text_regex",
    status: ok ? "satisfied" : "failed",
    detail: regex,
  };
}

export function scoreGoldenRow(task: GoldenTask, input: ScoreInput): ScoreResult {
  const tool_calls = input.tool_calls ?? 0;
  if (input.skip) {
    return { verdict: "SKIP", exit0: input.exit0, steps: input.steps, tool_calls, evidence: [] };
  }
  const exp = task.expect;
  const evidence: ScoreEvidence[] = [];
  evidence.push(clauseMinToolCalls(exp.min_tool_calls, input));
  if (exp.artifact_glob) evidence.push(clauseArtifactGlob(exp.artifact_glob, input));
  if (typeof exp.artifact_min_bytes === "number") {
    evidence.push(clauseArtifactMinBytes(exp.artifact_min_bytes, exp.artifact_glob, input));
  }
  if (typeof exp.artifact_jsonl_min_lines === "number") {
    evidence.push(clauseArtifactJsonlMinLines(exp.artifact_jsonl_min_lines, exp.artifact_glob, input));
  }
  if (exp.event) evidence.push(clauseEvent(exp.event, input));
  if (exp.final_text_regex) evidence.push(clauseFinalText(exp.final_text_regex, input));

  let verdict: GoldenVerdict = "PASS";
  if (evidence.some((e) => e.status === "failed")) verdict = "FAIL";
  else if (evidence.some((e) => e.status === "unverifiable")) verdict = "UNVERIFIED";

  return {
    verdict,
    exit0: input.exit0,
    steps: input.steps,
    tool_calls,
    evidence,
  };
}

export function evidenceSummary(evidence: ScoreEvidence[]): string {
  if (evidence.length === 0) return "";
  return evidence.map((e) => `${e.clause}:${e.status}`).join("; ");
}

export interface GoldenLastRow {
  task_id: string;
  harness: string;
  status: string;
  steps?: number;
  tool_calls?: number;
  time_ms?: number;
  takeover?: boolean;
  notes?: string;
  reason?: string;
  exit0?: boolean;
  evidence?: ScoreEvidence[];
  verdict?: string;
  [key: string]: unknown;
}

export interface GoldenLastDoc {
  date?: string;
  mode?: string;
  active?: string;
  models?: Record<string, string>;
  probes?: unknown[];
  results: GoldenLastRow[];
  pass?: number;
  fail?: number;
  skip?: number;
  unverified?: number;
  criteria?: string;
  [key: string]: unknown;
}

export function rescoreClaudeColumn(doc: GoldenLastDoc, suite: GoldenSuite): GoldenLastDoc {
  const byId = new Map(suite.tasks.map((t) => [t.id, t]));
  const results = doc.results.map((row) => {
    if (row.harness !== "claude") return row;
    const task = byId.get(row.task_id);
    if (!task) return row;
    const exit0 =
      typeof row.exit0 === "boolean"
        ? row.exit0
        : row.status === "PASS" ||
          /exit 0|signal observed/i.test(row.notes ?? "");
    const scored = scoreGoldenRow(task, {
      exit0,
      steps: row.steps ?? 0,
      tool_calls: row.tool_calls ?? 0,
      events: Array.isArray(row.events)
        ? row.events.filter((e): e is string => typeof e === "string")
        : undefined,
      takeover: row.takeover,
      notes: row.notes,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    });
    return {
      ...row,
      exit0: scored.exit0,
      evidence: scored.evidence,
      verdict: scored.verdict,
      status: scored.verdict,
    };
  });
  const judged = results.filter((r) => r.harness === (doc.active ?? "claude"));
  const pass = judged.filter((r) => r.status === "PASS").length;
  const fail = judged.filter((r) => r.status === "FAIL").length;
  const skip = judged.filter((r) => r.status === "SKIP").length;
  const unverified = judged.filter((r) => r.status === "UNVERIFIED").length;
  return {
    ...doc,
    criteria: CRITERIA_VERSION,
    results,
    pass,
    fail,
    skip,
    unverified,
  };
}
