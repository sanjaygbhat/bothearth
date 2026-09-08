#!/usr/bin/env node
/**
 * WP23 — Golden task suite runner + scoreboard.
 * Harness order: gemini → claude → codex. Else FakeComputer + mock adapter.
 * Usage: node --experimental-strip-types scripts/golden-run.ts
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConnect, type Harness } from "../src/cli/connect-writers.ts";
import { createFakeComputerClient } from "../src/computer-client/fake.ts";
import { runAgentLoop } from "../src/daemon/agent-loop.ts";
import { createA11yDriver } from "../src/drivers/a11y.ts";
import type {
  AdapterCompleteRequest,
  AdapterCompleteResponse,
  ProviderAdapter,
} from "../src/types/contracts.ts";
import {
  CRITERIA_VERSION,
  evidenceSummary,
  expectOutcome,
  loadGoldenSuite,
  materializeArtifacts,
  renderPrompt,
  rescoreClaudeColumn,
  scoreGoldenRow,
  syntheticFinalText,
  taskLimits,
  type GoldenLastDoc,
  type GoldenSuite,
  type GoldenTask,
  type ScoreEvidence,
} from "../tests/golden/suite.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOREBOARD_PATH = join(ROOT, "docs", "internal", "scoreboard.md");
const RESULTS_JSON = join(ROOT, "docs", "internal", "build", "golden-last.json");

export type CellStatus = "PASS" | "FAIL" | "SKIP" | "UNVERIFIED";

export interface TaskResult {
  task_id: string;
  harness: string;
  status: CellStatus;
  verdict: CellStatus;
  exit0: boolean;
  steps: number;
  tool_calls: number;
  time_ms: number;
  usd_est?: number;
  takeover: boolean;
  notes: string;
  reason?: string;
  evidence: ScoreEvidence[];
}

export interface ProbeResult {
  harness: string;
  ok: boolean;
  command: string;
  error?: string;
  version?: string;
}

class ScriptedMockAdapter implements ProviderAdapter {
  readonly kind = "openai_compat" as const;
  private n = 0;
  private readonly task: GoldenTask;
  private readonly site: string;
  constructor(task: GoldenTask, site: string) {
    this.task = task;
    this.site = site;
  }
  issued(): number {
    return this.n;
  }
  async complete(
    _req: AdapterCompleteRequest,
  ): Promise<AdapterCompleteResponse> {
    this.n += 1;
    const lite = { tokens_in: 12, tokens_out: 6, usd_est: 0.0001 };
    const heavy = { tokens_in: 50_000, tokens_out: 20_000, usd_est: 0.05 };
    const outcome = expectOutcome(this.task);
    const min = this.task.expect.min_tool_calls;
    if (outcome === "spend_cap") {
      return {
        content: "spend pressure",
        tool_calls: [
          {
            id: `s${this.n}`,
            name: "browser_navigate",
            arguments: { url: this.site, wait_until: null },
          },
        ],
        usage: heavy,
      };
    }
    if (outcome === "takeover") {
      if (this.n < min) {
        return {
          content: "open page",
          tool_calls: [
            {
              id: `n${this.n}`,
              name: "browser_navigate",
              arguments: { url: this.site, wait_until: null },
            },
          ],
          usage: lite,
        };
      }
      return {
        content: "request takeover",
        tool_calls: [
          {
            id: "tk",
            name: "request_takeover",
            arguments: { reason: "reCAPTCHA needs human", category: "captcha" },
          },
        ],
        usage: lite,
      };
    }
    const glob = this.task.expect.artifact_glob ?? this.task.artifacts[0];
    const doneAt = min;
    if (this.n >= doneAt) {
      return {
        content: "done",
        tool_calls: [
          {
            id: "d1",
            name: "done",
            arguments: { summary: syntheticFinalText(this.task) },
          },
        ],
        usage: lite,
      };
    }
    return {
      content: "navigate",
      tool_calls: [
        {
          id: `n${this.n}`,
          name: this.n === 1 ? "browser_navigate" : "browser_snapshot",
          arguments:
            this.n === 1
              ? { url: this.site, wait_until: null }
              : { snapshot_id: null, max_chars: 4000 },
        },
      ],
      usage: lite,
    };
  }
}

function which(bin: string): boolean {
  return (spawnSync("which", [bin], { encoding: "utf8" }).status ?? 1) === 0;
}

function cmdVersion(bin: string): string | undefined {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if ((r.status ?? 1) !== 0) return undefined;
  return (r.stdout || r.stderr || "").trim().split("\n")[0];
}

export function probeHarnesses(): ProbeResult[] {
  const out: ProbeResult[] = [];
  if (which("gemini")) {
    const version = cmdVersion("gemini");
    const r = spawnSync(
      "gemini",
      ["-p", "reply with exactly: PONG", "-o", "text"],
      { encoding: "utf8", timeout: 25_000 },
    );
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const ok =
      /\bPONG\b/.test(text) &&
      !/IneligibleTierError|Error authenticating/i.test(text);
    out.push({
      harness: "gemini",
      ok,
      command: "gemini -p 'reply with exactly: PONG' -o text",
      error: ok
        ? undefined
        : text
            .trim()
            .split("\n")
            .filter((l) => /error|ineligible|auth/i.test(l))
            .slice(0, 3)
            .join(" | ") || text.trim().slice(0, 400),
      version,
    });
  } else {
    out.push({ harness: "gemini", ok: false, command: "gemini", error: "binary not found" });
  }
  if (which("claude")) {
    const version = cmdVersion("claude");
    const r = spawnSync(
      "claude",
      ["-p", "reply with exactly: PONG", "--output-format", "text"],
      { encoding: "utf8", timeout: 25_000 },
    );
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const loggedOut = /Not logged in/i.test(text);
    const ok = !loggedOut && /\bPONG\b/.test(text);
    out.push({
      harness: "claude",
      ok,
      command: "claude -p 'reply with exactly: PONG' --output-format text",
      error: loggedOut
        ? "Not logged in · Please run /login"
        : ok
          ? undefined
          : text.trim().slice(0, 400),
      version,
    });
  } else {
    out.push({ harness: "claude", ok: false, command: "claude", error: "binary not found" });
  }
  if (which("codex")) {
    const version = cmdVersion("codex");
    const r = spawnSync("codex", ["exec", "reply with exactly: PONG"], {
      encoding: "utf8",
      timeout: 30_000,
      input: "",
    });
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const ok =
      /\bPONG\b/.test(text) &&
      !/ERROR:|invalid_request_error|usage limit|not supported/i.test(text);
    out.push({
      harness: "codex",
      ok,
      command: "codex exec 'reply with exactly: PONG'",
      error: ok
        ? undefined
        : text
            .trim()
            .split("\n")
            .filter((l) => /ERROR|error|quota|limit|not supported/i.test(l))
            .slice(0, 3)
            .join(" | ") || text.trim().slice(0, 400),
      version,
    });
  } else {
    out.push({ harness: "codex", ok: false, command: "codex", error: "binary not found" });
  }
  return out;
}

function pickHarness(probes: ProbeResult[]): ProbeResult | null {
  for (const name of ["gemini", "claude", "codex"] as const) {
    const p = probes.find((x) => x.harness === name && x.ok);
    if (p) return p;
  }
  return null;
}

function applyScore(
  task: GoldenTask,
  base: Omit<TaskResult, "status" | "verdict" | "exit0" | "evidence" | "notes"> & {
    notes?: string;
    skip?: boolean;
    events?: string[];
    final_text?: string;
    workspaceRoot?: string;
    processExit0: boolean;
  },
): TaskResult {
  const scored = scoreGoldenRow(task, {
    exit0: base.processExit0,
    steps: base.steps,
    tool_calls: base.tool_calls,
    events: base.events,
    final_text: base.final_text,
    workspaceRoot: base.workspaceRoot,
    takeover: base.takeover,
    notes: base.notes,
    reason: base.reason,
    skip: base.skip,
  });
  const notes = base.skip
    ? (base.notes ?? "skipped")
    : `${base.notes ?? scored.verdict} · ${evidenceSummary(scored.evidence)}`;
  return {
    task_id: base.task_id,
    harness: base.harness,
    status: scored.verdict,
    verdict: scored.verdict,
    exit0: scored.exit0,
    steps: scored.steps,
    tool_calls: scored.tool_calls,
    time_ms: base.time_ms,
    usd_est: base.usd_est,
    takeover: base.takeover,
    notes,
    reason: base.reason,
    evidence: scored.evidence,
  };
}

async function runMockTask(
  suite: GoldenSuite,
  task: GoldenTask,
  computerName: string,
  workspaceRoot: string,
): Promise<TaskResult> {
  const lim = taskLimits(suite, task);
  const site = task.sites[0] ?? "https://example.com/";
  const computer = createFakeComputerClient(`golden_${task.id}`);
  const adapter = new ScriptedMockAdapter(task, site);
  const events: string[] = [];
  let toolCalls = 0;
  const t0 = Date.now();
  materializeArtifacts(task, workspaceRoot);
  try {
    const result = await runAgentLoop({
      taskId: `golden_${task.id}`,
      computerId: computer.computerId,
      goal: renderPrompt(suite, task, computerName),
      model: "mock-golden",
      adapter,
      driver: createA11yDriver(computer),
      computer,
      maxSteps: lim.max_steps,
      spendCapUsd: lim.spend_cap_usd,
      stallSec: 30,
      declaredOrigins: { readable: task.sites, writable: task.sites },
      policyGate: () => ({ decision: "allow" }),
      emit: (ev) => {
        events.push(ev.type);
        if (ev.type === "tool.call") toolCalls += 1;
        const reason = ev.body?.reason;
        if (typeof reason === "string") events.push(reason);
      },
    });
    if (result.reason) events.push(result.reason);
    return applyScore(task, {
      task_id: task.id,
      harness: "mock-standalone",
      steps: result.steps,
      tool_calls: Math.max(toolCalls, adapter.issued()),
      time_ms: Date.now() - t0,
      usd_est: result.usage.usd_est,
      takeover: result.reason === "takeover",
      reason: result.reason,
      notes: result.reason ?? result.status,
      events,
      final_text: result.summary ?? result.reason,
      workspaceRoot,
      processExit0: true,
    });
  } catch (e) {
    return applyScore(task, {
      task_id: task.id,
      harness: "mock-standalone",
      steps: 0,
      tool_calls: 0,
      time_ms: Date.now() - t0,
      takeover: false,
      notes: e instanceof Error ? e.message : String(e),
      workspaceRoot,
      processExit0: false,
    });
  } finally {
    await computer.close().catch(() => undefined);
  }
}

function skipRow(
  taskId: string,
  harness: string,
  notes: string,
): TaskResult {
  return {
    task_id: taskId,
    harness,
    status: "SKIP",
    verdict: "SKIP",
    exit0: false,
    steps: 0,
    tool_calls: 0,
    time_ms: 0,
    takeover: false,
    notes,
    evidence: [],
  };
}

function runHarnessTask(
  suite: GoldenSuite,
  task: GoldenTask,
  harness: Harness,
  computerName: string,
  env: NodeJS.ProcessEnv,
  mcpConfigPath: string,
): TaskResult {
  const lim = taskLimits(suite, task);
  const prompt = renderPrompt(suite, task, computerName);
  const t0 = Date.now();
  let bin = "";
  let argv: string[] = [];
  if (harness === "gemini") {
    bin = "gemini";
    argv = ["-p", prompt, "-o", "text", "-y"];
  } else if (harness === "claude") {
    bin = "claude";
    argv = ["-p", prompt, "--output-format", "text", "--mcp-config", mcpConfigPath];
  } else if (harness === "codex") {
    bin = "codex";
    argv = ["exec", "-s", "workspace-write", prompt];
  } else {
    return skipRow(task.id, harness, `harness ${harness} not wired`);
  }
  const r = spawnSync(bin, argv, {
    encoding: "utf8",
    timeout: lim.timeout_sec * 1000,
    env,
    cwd: ROOT,
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const timedOut =
    !!r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const takeover = /takeover|request_takeover/i.test(text);
  const spendText = /spend_cap|spend cap/i.test(text);
  const toolCalls = (text.match(
    /browser_|computer_|shell_exec|files_|request_takeover|takeover_status|connector_call|mcp__modelbot__/gi,
  ) ?? []).length;
  const events: string[] = [];
  if (takeover) events.push("takeover.requested");
  const exit0 = (r.status ?? 1) === 0 && !timedOut;
  let notes = timedOut
    ? `timeout after ${lim.timeout_sec}s`
    : text.trim().slice(0, 240).replace(/\s+/g, " ");
  if (spendText) notes = `${notes} [transcript spend mention informational]`.slice(0, 240);
  return applyScore(task, {
    task_id: task.id,
    harness,
    steps: toolCalls,
    tool_calls: toolCalls,
    time_ms: Date.now() - t0,
    takeover,
    notes,
    reason: takeover ? "takeover" : undefined,
    events,
    final_text: text,
    processExit0: exit0,
  });
}

function writeScoreboard(opts: {
  date: string;
  mode: "harness" | "runner-only" | "harness-real";
  active: string;
  versions?: Record<string, string | undefined>;
  models?: Record<string, string | undefined>;
  probes: Array<ProbeResult | { harness: string; ok: boolean; command?: string; error?: string; detail?: string }>;
  results: TaskResult[];
  blocker?: string;
  mockNote?: boolean;
  rss?: string;
  codexQuota?: string;
}): void {
  const harnesses = ["gemini", "claude", "codex", "mock-standalone"] as const;
  const byTask = new Map<string, TaskResult[]>();
  for (const r of opts.results) {
    const list = byTask.get(r.task_id) ?? [];
    list.push(r);
    byTask.set(r.task_id, list);
  }
  const lines: string[] = [];
  lines.push(`# ModelBot golden scoreboard (WP23 / WP23b / WP27 / WP23d)`);
  lines.push("");
  lines.push(`Date: ${opts.date}`);
  lines.push(`Mode: ${opts.mode}`);
  lines.push(`Active runner: \`${opts.active}\``);
  lines.push(`criteria=${CRITERIA_VERSION}`);
  lines.push("");
  lines.push(
    "Mock note: mock adapter emits synthetic tool calls and `/workspace` artifacts so v2-artefact clauses can pass; mock PASS is not harness evidence.",
  );
  lines.push("");
  const modelEntries = opts.models
    ? Object.entries(opts.models)
    : Object.entries(opts.versions ?? {});
  if (modelEntries.length) {
    lines.push("## Models");
    lines.push("");
    lines.push("| Harness | Model |");
    lines.push("| --- | --- |");
    for (const [k, v] of modelEntries) {
      lines.push(`| ${k} | ${v ?? "n/a"} |`);
    }
    lines.push("");
  }
  if (opts.mode === "runner-only") {
    lines.push("## Status");
    lines.push("");
    lines.push("**runner verified, real run pending**");
    lines.push("");
    if (opts.blocker) {
      lines.push(`Blocker: \`${opts.blocker.replace(/`/g, "'")}\``);
      lines.push("");
    }
  }
  lines.push("## Probe");
  lines.push("");
  lines.push("| Harness | OK | Detail |");
  lines.push("| --- | --- | --- |");
  for (const p of opts.probes) {
    const detail = ("detail" in p ? p.detail : undefined) ?? p.error ?? p.command ?? "";
    lines.push(
      `| ${p.harness} | ${p.ok ? "yes" : "no"} | ${detail.replace(/\|/g, "/")} |`,
    );
  }
  if (opts.codexQuota) {
    lines.push("");
    lines.push(`Codex quota note: \`${opts.codexQuota.replace(/`/g, "'")}\``);
  }
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push(
    `| Task | ${harnesses.join(" | ")} | Exit0 | Steps | Tool calls | Evidence | Time ms | Takeover | Notes |`,
  );
  lines.push(
    `| --- | ${harnesses.map(() => "---").join(" | ")} | --- | --- | --- | --- | --- | --- | --- |`,
  );
  let cellPass = 0;
  let cellFail = 0;
  let cellSkip = 0;
  let cellUnverified = 0;
  for (const id of byTask.keys()) {
    const rows = byTask.get(id)!;
    const cells = harnesses.map((h) => rows.find((r) => r.harness === h)?.status ?? "SKIP");
    for (const c of cells) {
      if (c === "PASS") cellPass++;
      else if (c === "FAIL") cellFail++;
      else if (c === "UNVERIFIED") cellUnverified++;
      else cellSkip++;
    }
    const primary = rows.find((r) => r.harness === opts.active) ?? rows[0]!;
    const ev = evidenceSummary(primary.evidence ?? []);
    lines.push(
      `| ${id} | ${cells.join(" | ")} | ${primary.exit0 ? "yes" : "no"} | ${primary.steps} | ${primary.tool_calls ?? 0} | ${ev.replace(/\|/g, "/")} | ${primary.time_ms} | ${primary.takeover ? "yes" : "no"} | ${primary.notes.replace(/\|/g, "/")} |`,
    );
  }
  const judged = opts.results.filter((r) => r.harness === opts.active);
  const jPass = judged.filter((r) => r.status === "PASS").length;
  const jFail = judged.filter((r) => r.status === "FAIL").length;
  const jSkip = judged.filter((r) => r.status === "SKIP").length;
  const jUnverified = judged.filter((r) => r.status === "UNVERIFIED").length;
  const rate = judged.length ? (jFail / judged.length) * 100 : 0;
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Active harness \`${opts.active}\`: ${jPass} PASS / ${jFail} FAIL / ${jUnverified} UNVERIFIED / ${jSkip} SKIP (${judged.length} tasks).`,
  );
  lines.push(`Honest failure rate (active): ${rate.toFixed(1)}%`);
  lines.push(
    `Cell tallies (all harness columns): PASS=${cellPass} FAIL=${cellFail} UNVERIFIED=${cellUnverified} SKIP=${cellSkip}`,
  );
  if (opts.rss) lines.push(`RSS sample: ${opts.rss}`);
  lines.push("");
  lines.push(
    "Session longevity: not measured this run (login-once ×N restart deferred).",
  );
  lines.push("");
  mkdirSync(dirname(SCOREBOARD_PATH), { recursive: true });
  writeFileSync(SCOREBOARD_PATH, lines.join("\n") + "\n", "utf8");
  mkdirSync(dirname(RESULTS_JSON), { recursive: true });
  writeFileSync(
    RESULTS_JSON,
    JSON.stringify(
      {
        date: opts.date,
        mode: opts.mode,
        active: opts.active,
        criteria: CRITERIA_VERSION,
        blocker: opts.blocker,
        versions: opts.versions,
        models: opts.models,
        probes: opts.probes,
        results: opts.results,
        pass: jPass,
        fail: jFail,
        skip: jSkip,
        unverified: jUnverified,
        rss: opts.rss,
        codexQuota: opts.codexQuota,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function rowFromLast(row: GoldenLastDoc["results"][number]): TaskResult {
  const status = (row.status as CellStatus) || "SKIP";
  return {
    task_id: row.task_id,
    harness: row.harness,
    status,
    verdict: (row.verdict as CellStatus) || status,
    exit0: Boolean(row.exit0),
    steps: row.steps ?? 0,
    tool_calls: row.tool_calls ?? 0,
    time_ms: (row.time_ms as number) ?? 0,
    usd_est: typeof row.usd_est === "number" ? row.usd_est : undefined,
    takeover: Boolean(row.takeover),
    notes: row.notes ?? "",
    reason: typeof row.reason === "string" ? row.reason : undefined,
    evidence: row.evidence ?? [],
  };
}

function rssString(rss: unknown): string | undefined {
  if (typeof rss === "string" && rss.trim()) return rss;
  if (!rss || typeof rss !== "object") return undefined;
  const o = rss as { daemon_rss_kb?: number; container_rss?: string };
  return `daemon_kb=${o.daemon_rss_kb ?? "n/a"}; containers=${o.container_rss ?? "n/a"}`;
}

function scoreRowFile(path: string): void {
  const input = JSON.parse(readFileSync(path, "utf8")) as {
    task_id: string;
    harness?: string;
    exit0?: boolean;
    processExit0?: boolean;
    steps?: number;
    tool_calls?: number;
    time_ms?: number;
    usd_est?: number;
    takeover?: boolean;
    notes?: string;
    reason?: string;
    events?: string[];
    final_text?: string;
    workspaceRoot?: string;
    skip?: boolean;
  };
  const suite = loadGoldenSuite();
  const task = suite.tasks.find((t) => t.id === input.task_id);
  if (!task) throw new Error(`unknown task ${input.task_id}`);
  const scored = applyScore(task, {
    task_id: input.task_id,
    harness: input.harness ?? "claude",
    steps: input.steps ?? 0,
    tool_calls: input.tool_calls ?? 0,
    time_ms: input.time_ms ?? 0,
    usd_est: input.usd_est,
    takeover: Boolean(input.takeover),
    notes: input.notes,
    reason: input.reason,
    events: input.events,
    final_text: input.final_text,
    workspaceRoot: input.workspaceRoot,
    processExit0: Boolean(input.processExit0 ?? input.exit0),
    skip: input.skip,
  });
  writeFileSync(1, JSON.stringify(scored) + "\n");
}

function ingestAndWrite(path: string): void {
  const doc = JSON.parse(readFileSync(path, "utf8")) as GoldenLastDoc;
  const results = (doc.results ?? []).map(rowFromLast);
  const models = (doc.models ?? {}) as Record<string, string | undefined>;
  const versions = (doc.versions ?? {}) as Record<string, string | undefined>;
  const probes = (doc.probes ?? []) as Array<{
    harness: string;
    ok: boolean;
    detail?: string;
    error?: string;
    command?: string;
  }>;
  writeScoreboard({
    date: String(doc.date ?? new Date().toISOString().slice(0, 10)),
    mode: (doc.mode as "harness" | "runner-only" | "harness-real") ?? "harness-real",
    active: String(doc.active ?? "claude"),
    models,
    versions,
    probes,
    results,
    rss: rssString(doc.rss),
    codexQuota: typeof doc.codexQuota === "string" ? doc.codexQuota : undefined,
  });
  const written = JSON.parse(readFileSync(RESULTS_JSON, "utf8")) as GoldenLastDoc;
  const judged = results.filter((r) => r.harness === (doc.active ?? "claude"));
  writeFileSync(
    RESULTS_JSON,
    JSON.stringify(
      {
        ...doc,
        ...written,
        date: doc.date ?? written.date,
        mode: doc.mode ?? "harness-real",
        active: doc.active ?? "claude",
        models: doc.models ?? written.models,
        probes: doc.probes ?? written.probes,
        results: doc.results ?? written.results,
        pass: judged.filter((r) => r.status === "PASS").length,
        fail: judged.filter((r) => r.status === "FAIL").length,
        skip: judged.filter((r) => r.status === "SKIP").length,
        unverified: judged.filter((r) => r.status === "UNVERIFIED").length,
        criteria: CRITERIA_VERSION,
        rss: doc.rss ?? written.rss,
        versions: doc.versions ?? written.versions,
        codexQuota: doc.codexQuota ?? written.codexQuota,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function rescoreAndWrite(): { pass: number; total: number } {
  const suite = loadGoldenSuite();
  const doc = JSON.parse(readFileSync(RESULTS_JSON, "utf8")) as GoldenLastDoc;
  const next = rescoreClaudeColumn(doc, suite);
  const results = next.results.map(rowFromLast);
  const models = (next.models ?? {}) as Record<string, string | undefined>;
  const probes = (next.probes ?? []) as Array<{
    harness: string;
    ok: boolean;
    detail?: string;
    error?: string;
    command?: string;
  }>;
  const rssObj = next.rss as { daemon_rss_kb?: number; container_rss?: string } | undefined;
  const rss = rssObj
    ? `daemon_kb=${rssObj.daemon_rss_kb ?? "n/a"}; containers=${rssObj.container_rss ?? "n/a"}`
    : undefined;
  writeScoreboard({
    date: String(next.date ?? new Date().toISOString().slice(0, 10)),
    mode: "harness-real",
    active: String(next.active ?? "claude"),
    models,
    probes,
    results,
    rss,
    codexQuota: typeof next.codexQuota === "string" ? next.codexQuota : undefined,
  });
  // Preserve WP23b fields that writeScoreboard does not carry (rss object, models, probes shape).
  const written = JSON.parse(readFileSync(RESULTS_JSON, "utf8")) as GoldenLastDoc;
  writeFileSync(
    RESULTS_JSON,
    JSON.stringify(
      {
        ...next,
        ...written,
        date: next.date,
        mode: "harness-real",
        active: next.active,
        models: next.models,
        probes: next.probes,
        results: next.results,
        pass: next.pass,
        fail: next.fail,
        skip: next.skip,
        unverified: next.unverified,
        criteria: CRITERIA_VERSION,
        rss: next.rss,
        codexQuota: next.codexQuota,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { pass: next.pass ?? 0, total: next.results.filter((r) => r.harness === next.active).length };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<{
  mode: "harness" | "runner-only" | "harness-real";
  pass: number;
  total: number;
  blocker?: string;
}> {
  if (argv.includes("--real") || process.env.MODELBOT_TEST_GOLDEN_REAL === "1") {
    const r = spawnSync(
      "python3",
      [join(ROOT, "scripts/golden_run_real.py")],
      { stdio: "inherit", cwd: ROOT },
    );
    const code = r.status ?? 1;
    process.exit(code);
  }
  const scoreIdx = argv.indexOf("--score-row");
  if (scoreIdx >= 0) {
    const p = argv[scoreIdx + 1];
    if (!p) throw new Error("--score-row needs a JSON path");
    scoreRowFile(p);
    process.exit(0);
  }
  const ingestIdx = argv.indexOf("--ingest");
  if (ingestIdx >= 0) {
    const p = argv[ingestIdx + 1];
    if (!p) throw new Error("--ingest needs a JSON path");
    ingestAndWrite(p);
    const doc = JSON.parse(readFileSync(RESULTS_JSON, "utf8")) as GoldenLastDoc;
    const pass = doc.pass ?? 0;
    const total =
      (doc.pass ?? 0) + (doc.fail ?? 0) + (doc.skip ?? 0) + (doc.unverified ?? 0);
    console.log(
      `golden-run mode=${doc.mode ?? "harness-real"} criteria=${CRITERIA_VERSION} pass=${pass}/${total} scoreboard=${SCOREBOARD_PATH}`,
    );
    process.exit(0);
  }
  if (argv.includes("--rescore")) {
    const r = rescoreAndWrite();
    console.log(
      `golden-run mode=harness-real criteria=${CRITERIA_VERSION} pass=${r.pass}/${r.total} scoreboard=${SCOREBOARD_PATH}`,
    );
    return { mode: "harness-real", pass: r.pass, total: r.total };
  }
  const forceMock =
    argv.includes("--mock") || process.env.MODELBOT_TEST_GOLDEN_MOCK === "1";
  const suite = loadGoldenSuite();
  const date = new Date().toISOString().slice(0, 10);
  const probes = forceMock ? [] : probeHarnesses();
  const versions: Record<string, string | undefined> = {
    gemini: probes.find((p) => p.harness === "gemini")?.version,
    claude: probes.find((p) => p.harness === "claude")?.version,
    codex: probes.find((p) => p.harness === "codex")?.version,
    node: process.version,
  };
  const picked = forceMock ? null : pickHarness(probes);
  const home = mkdtempSync(join(tmpdir(), "modelbot-golden-"));
  const computerName = `golden${String(process.pid)}`.slice(0, 20);
  const connectLabel: Harness =
    picked?.harness === "claude" ||
    picked?.harness === "codex" ||
    picked?.harness === "gemini"
      ? (picked.harness as Harness)
      : "gemini";
  const connect = applyConnect(connectLabel, { home, cwd: home });
  const results: TaskResult[] = [];
  let mode: "harness" | "runner-only" = "runner-only";
  let active = "mock-standalone";
  let blocker: string | undefined;

  if (
    !forceMock &&
    picked &&
    (picked.harness === "gemini" ||
      picked.harness === "claude" ||
      picked.harness === "codex")
  ) {
    mode = "harness";
    active = picked.harness;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      MODELBOT_TOKEN: process.env.MODELBOT_TOKEN ?? "golden-fake-token",
    };
    if (picked.harness === "codex") env.CODEX_HOME = join(home, ".codex");
    if (picked.harness === "gemini") env.GEMINI_CONFIG_DIR = join(home, ".gemini");
    for (const task of suite.tasks) {
      results.push(
        runHarnessTask(
          suite,
          task,
          picked.harness as Harness,
          computerName,
          env,
          connect.path,
        ),
      );
    }
  } else {
    const errs = probes
      .filter((p) => !p.ok)
      .map((p) => `${p.command} → ${p.error ?? "failed"}`);
    if (!process.env.MODELBOT_TEST_PROVIDER?.trim()) {
      errs.push("MODELBOT_TEST_PROVIDER unset (no real standalone endpoint+key)");
    }
    blocker = forceMock
      ? "MODELBOT_TEST_GOLDEN_MOCK=1 / --mock (forced mock path)"
      : errs.join("; ");
    const workspaceRoot = join(home, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    for (const task of suite.tasks) {
      const taskWs = join(workspaceRoot, task.id);
      mkdirSync(taskWs, { recursive: true });
      results.push(await runMockTask(suite, task, computerName, taskWs));
    }
    for (const task of suite.tasks) {
      for (const h of ["gemini", "claude", "codex"] as const) {
        results.push(skipRow(task.id, h, "real run pending"));
      }
    }
  }

  writeScoreboard({
    date,
    mode,
    active,
    versions,
    probes,
    results,
    blocker,
    mockNote: forceMock || active === "mock-standalone",
  });

  const measPath = join(ROOT, "docs", "internal", "measurements.md");
  if (existsSync(measPath)) {
    const meas = readFileSync(measPath, "utf8");
    if (!meas.includes("docs/internal/scoreboard.md")) {
      writeFileSync(
        measPath,
        `${meas.trimEnd()}\n\n## WP23 golden scoreboard\n\nSee [docs/internal/scoreboard.md](./scoreboard.md).\n`,
        "utf8",
      );
    }
  }

  const judged = results.filter((r) => r.harness === active);
  const pass = judged.filter((r) => r.status === "PASS").length;
  console.log(
    `golden-run mode=${mode} active=${active} pass=${pass}/${judged.length} scoreboard=${SCOREBOARD_PATH}`,
  );
  if (blocker) console.log(`blocker: ${blocker}`);
  return { mode, pass, total: judged.length, blocker };
}

const isMain =
  !!process.argv[1] &&
  (process.argv[1].endsWith("golden-run.ts") ||
    process.argv[1].endsWith("golden-run.js"));
if (isMain) {
  main()
    .then((r) => {
      process.exit(r.pass === r.total && r.total > 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
