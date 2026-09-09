import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mintToken, SESSION_MAX_LIFETIME_MS, SESSION_TTL_MS } from "./auth.ts";
import type {
  AdapterMessage,
  ApprovalDecision,
  ApprovalStatus,
  ComputerCapability,
  DriverKind,
  TakeoverState,
  TaskSummary,
  UsageEventBody,
} from "../types/contracts.ts";

export interface ComputerRow {
  id: string;
  name: string;
  capabilities: string;
  persistent: number;
  status: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  computer_id: string;
  goal: string;
  adapter: string | null;
  driver: string | null;
  capabilities: string | null;
  max_steps: number;
  status: string;
  created_at: string;
  cancelled_at: string | null;
  /** First tool call or model event. Null until the task does anything. */
  started_at: string | null;
  /** Terminal clock, written once and never moved backwards. */
  finished_at: string | null;
  /** finished_at − (started_at ?? created_at), in milliseconds. */
  duration_ms: number | null;
  /** Frozen once when the task first reads back terminal; null while running. */
  summary: TaskSummary | null;
  /** Cap this task was created with; null falls back to the daemon's. */
  spend_cap_usd: number | null;
  /** Runtime ceiling raised for this task by a resume; null falls back to the daemon's. */
  max_runtime_sec: number | null;
}

/** Every task column the API returns, in one place so the four reads agree. */
const TASK_COLUMNS =
  "id, computer_id, goal, adapter, driver, capabilities, max_steps, status, " +
  "created_at, cancelled_at, started_at, finished_at, duration_ms, summary_json, spend_cap_usd, " +
  "max_runtime_sec";

const SESSION_COLUMNS = "id, csrf, created_at, expires_at, origin, label";

const COMPUTER_COLUMNS = "id, name, capabilities, persistent, status, created_at";

const APPROVAL_COLUMNS =
  "id, task_id, tool, args_json, gate, bind_json, status, decision, created_at, decided_at";

const TAKEOVER_COLUMNS =
  "id, computer_id, task_id, state, expires_at, created_at, epoch, declined, granted_to";

const BINDING_COLUMNS =
  "task_id, computer_id, execution, spend_cap_usd, max_steps, proxy_usd_per_tool_call, " +
  "observed_tool_calls, denied, denial_audit_reserved, created_at";

const TERMINAL_TASK_STATUS = ["completed", "failed", "cancelled"];
const TERMINAL_TASK_STATUS_SQL = `(${TERMINAL_TASK_STATUS.map((s) => `'${s}'`).join(", ")})`;

/**
 * Ceiling on origins one task may hold. Each grant comes from a 120-second
 * approval but is trusted for the task's whole life, so an unbounded list is a
 * quietly growing allowlist nobody reviews.
 */
export const MAX_TASK_ORIGIN_GRANTS = 32;

/**
 * `PRAGMA user_version` this build expects. 1 recomputes every frozen
 * `files_saved` (`repairFrozenFileLists`).
 */
export const RECEIPT_REPAIR_VERSION = 1;

/** 2 closes takeover rows left open by tasks that ended (`closeStaleTakeovers`). */
export const STALE_TAKEOVER_VERSION = 2;

/** A takeover row still holding a computer, whatever the person has answered so far. */
const OPEN_TAKEOVER_STATES = "('takeover_requested','human','resume_validating','paused')";

/** True while the row's task is still running, or the row names no task at all. */
const TAKEOVER_TASK_ALIVE =
  `(takeovers.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = takeovers.task_id
      AND tasks.status NOT IN ${TERMINAL_TASK_STATUS_SQL}))`;

interface TaskDbRow extends Omit<TaskRow, "summary"> {
  summary_json: string | null;
}

export interface HarnessTaskBindingRow {
  task_id: string;
  computer_id: string;
  execution: "harness";
  spend_cap_usd: number;
  max_steps: number;
  proxy_usd_per_tool_call: number;
  observed_tool_calls: number;
  denied: number;
  denial_audit_reserved: number;
  created_at: string;
}

export interface HarnessToolCallAttempt {
  binding: HarnessTaskBindingRow;
  denied: boolean;
  emit_denial_audit: boolean;
  proxy_estimate_usd: number;
  /** False once the budget is spent: the call was refused, not charged for. */
  counted: boolean;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  tool: string;
  args_json: string;
  gate: string;
  bind_json: string;
  status: ApprovalStatus;
  decision: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface TakeoverRow {
  id: string;
  computer_id: string;
  task_id: string | null;
  state: TakeoverState;
  /** Null while the question is unanswered: only a granted lease has a deadline. */
  expires_at: string | null;
  created_at: string;
  /** computer-server takeover epoch; 0 = unknown (fail closed for live relay). */
  epoch: number;
  /** 1 when the person looked and said control was not needed. */
  declined: number;
  /** Device id of the session that acquired the grant. Only it may relay input. */
  granted_to: string | null;
}

/** The proxy price of a bound harness task's calls, rounded once so the meter and the cap agree. */
export function harnessSpendUsd(calls: number, perCallUsd: number): number {
  return Number((calls * perCallUsd).toFixed(12));
}

/**
 * Which budget has refused this binding's calls, or null while it still has
 * room. Both budgets are measured in the only unit a harness run exposes — MCP
 * tool calls — so the reason a task stopped follows from the counter and never
 * needs a column of its own.
 */
export function harnessCapReason(binding: {
  observed_tool_calls: number;
  proxy_usd_per_tool_call: number;
  spend_cap_usd: number;
  max_steps: number;
}): "spend_cap" | "max_steps" | null {
  if (harnessSpendUsd(binding.observed_tool_calls, binding.proxy_usd_per_tool_call) >= binding.spend_cap_usd)
    return "spend_cap";
  return binding.observed_tool_calls >= binding.max_steps ? "max_steps" : null;
}

/** Positive finite epoch from a computer-server takeover payload; else 0. */
export function takeoverEpochFromData(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const n = Number((data as { epoch?: unknown }).epoch);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Still holding a person's attention: asked and not yet answered, or granted
 * and not yet lapsed. `false` once the TTL runs out (state flips to `paused`)
 * or nothing is asking at all — the shared answer for "is a human still
 * expected here", so idle-pause, the harness wait and the standalone loop
 * agree on when to stop waiting.
 */
export function isTakeoverPending(row: TakeoverRow | undefined): boolean {
  if (!row) return false;
  if (row.state !== "takeover_requested" && row.state !== "human" && row.state !== "resume_validating") return false;
  return !row.expires_at || Date.parse(row.expires_at) > Date.now();
}

export interface SessionRow {
  id: string;
  csrf: string;
  created_at: string;
  expires_at: string;
  origin: string | null;
  label: string;
}

export interface AuditRefRow {
  seq: number;
  type: string;
  ts: string;
  task_id: string | null;
  computer_id: string | null;
  body_json: string;
  hash: string;
}

function now(): string {
  return new Date().toISOString();
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

/** Later of two ISO instants; `b` may be absent. */
function maxIso(a: string, b?: string): string {
  return b && b > a ? b : a;
}

function hostnameOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build a task's receipt from its whole durable event log. This is the only
 * place the numbers on a finished task are decided, so the API, the UI and the
 * audit trail cannot disagree about how many steps it took or where it went.
 */
export function taskSummaryFromEvents(
  events: Array<{ type: string; body_json: string }>,
): TaskSummary {
  const sites: string[] = [];
  const files: string[] = [];
  let steps = 0;
  let asks = 0;
  let costUsd: number | null = null;
  for (const event of events) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const args = (body.arguments ?? {}) as Record<string, unknown>;
    if (event.type === "approval.requested") asks += 1;
    if (event.type === "task.step") steps = Math.max(steps, readNumber(body, "step") ?? steps + 1);
    if (event.type === "usage") {
      steps = Math.max(steps, readNumber(body, "steps") ?? 0);
      costUsd = readNumber(body, "usd_est") ?? costUsd;
    }
    if (event.type.startsWith("task.")) steps = Math.max(steps, readNumber(body, "steps") ?? 0);
    // Read from `tool.result`, never `tool.call`: a receipt may only describe
    // what actually happened, so nothing is collected until the call comes
    // back `ok`. Reading requests listed rejected writes as saved files.
    if (event.type === "tool.result") {
      const name = String(body.name ?? "");
      if (name === "browser_navigate" || name === "browser_tabs") {
        const host = hostnameOf(args.url);
        if (host && !sites.includes(host)) sites.push(host);
      }
      // `write_file` is announced by `download.promoted` below, carrying the
      // path and byte count the computer reported rather than the ones the
      // model asked for. `files_write` (shell) has no promotion event.
      if (name === "files_write") {
        const path = args.path ?? args.filename;
        if (typeof path === "string" && path && !files.includes(path)) files.push(path);
      }
    }
    if (event.type === "download.promoted") {
      const path = body.path ?? body.workspace_path ?? body.name;
      if (typeof path === "string" && path && !files.includes(path)) files.push(path);
    }
  }
  return { steps, sites, asks, files_saved: files, cost_usd: costUsd };
}

/** Last path segment, whichever way the path was written. */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function row<T>(value: unknown): T | undefined {
  return (value as T | undefined) ?? undefined;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly harnessDenialAuditsInFlight = new Set<string>();
  /** Tasks whose start clock this process has already written. */
  private readonly startedTasks = new Set<string>();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        csrf TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bootstrap_tokens (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS computers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        persistent INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        home TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_default (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        computer_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        computer_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        adapter TEXT,
        driver TEXT,
        capabilities TEXT,
        max_steps INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS harness_task_bindings (
        task_id TEXT PRIMARY KEY,
        computer_id TEXT NOT NULL UNIQUE,
        execution TEXT NOT NULL CHECK (execution = 'harness'),
        spend_cap_usd REAL NOT NULL,
        max_steps INTEGER NOT NULL,
        proxy_usd_per_tool_call REAL NOT NULL,
        observed_tool_calls INTEGER NOT NULL DEFAULT 0,
        denied INTEGER NOT NULL DEFAULT 0,
        denial_audit_reserved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        gate TEXT NOT NULL,
        bind_json TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS takeovers (
        id TEXT PRIMARY KEY,
        computer_id TEXT NOT NULL,
        task_id TEXT,
        state TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        declined INTEGER NOT NULL DEFAULT 0,
        granted_to TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_refs (
        seq INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        task_id TEXT,
        computer_id TEXT,
        body_json TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      -- Origins the operator granted for the lifetime of one task. Deleting the
      -- task's row set is the only way a grant ends; nothing here outlives it.
      CREATE TABLE IF NOT EXISTS task_origin_grants (
        task_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approval_id TEXT,
        PRIMARY KEY (task_id, origin)
      );
    `);
    if (!(this.db.prepare("PRAGMA table_info(codex_connection)").all() as { name: string }[]).some(c => c.name === "provider"))
      this.db.exec("ALTER TABLE codex_connection ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'");
    const sessionColumns = rows<{ name: string }>(
      this.db.prepare("PRAGMA table_info(sessions)").all(),
    );
    if (!sessionColumns.some((column) => column.name === "expires_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
      this.db.prepare("UPDATE sessions SET expires_at = ? WHERE expires_at IS NULL").run(
        new Date(0).toISOString(),
      );
    }
    // Older harness bindings predate durable task lifecycle tracking.
    this.db.exec(`INSERT OR IGNORE INTO tasks
      (id, computer_id, goal, adapter, max_steps, status, created_at)
      SELECT task_id, computer_id, 'External harness task', 'harness', max_steps, 'running', created_at
      FROM harness_task_bindings`);
    for (const [table, column, type] of [
      ["sessions", "origin", "TEXT"], ["sessions", "label", "TEXT NOT NULL DEFAULT 'Browser'"],
      ["bootstrap_tokens", "origin", "TEXT"], ["bootstrap_tokens", "issuer_session", "TEXT"],
      // Durable task lifecycle. Older rows keep NULLs — a task that finished
      // before this migration has no honest duration to report.
      ["tasks", "started_at", "TEXT"], ["tasks", "finished_at", "TEXT"],
      ["tasks", "duration_ms", "INTEGER"], ["tasks", "summary_json", "TEXT"],
      // Per-task budget: the cap the request asked for, so a resume and a
      // daemon restart spend against the same number the operator chose.
      ["tasks", "spend_cap_usd", "REAL"],
      // Runtime ceiling a resume raised for this one task, so the raise
      // survives the restart the resume starts.
      ["tasks", "max_runtime_sec", "INTEGER"],
      // Which approval bought each origin, so a grant can be traced back to
      // the answer the operator actually gave.
      ["task_origin_grants", "approval_id", "TEXT"],
      // "Not needed, continue" is a different answer from "here, carry on":
      // the model has to be told the field it stopped on is not a secret.
      ["takeovers", "declined", "INTEGER NOT NULL DEFAULT 0"],
      // Which device is driving. A second tab could relay pointer and keys into
      // a computer another device had taken control of.
      ["takeovers", "granted_to", "TEXT"],
    ]) {
      if (!rows<{ name: string }>(this.db.prepare(`PRAGMA table_info(${table})`).all()).some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    const takeoverColumns = rows<{ name: string; notnull: number }>(
      this.db.prepare("PRAGMA table_info(takeovers)").all(),
    );
    if (!takeoverColumns.some((column) => column.name === "epoch")) {
      this.db.exec("ALTER TABLE takeovers ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
    }
    // A takeover nobody has granted yet has no deadline, so the column has to
    // hold NULL. SQLite can only drop a NOT NULL by rebuilding the table.
    if (takeoverColumns.some((column) => column.name === "expires_at" && column.notnull)) {
      this.db.exec(`
        ALTER TABLE takeovers RENAME TO takeovers_notnull;
        CREATE TABLE takeovers (
          id TEXT PRIMARY KEY,
          computer_id TEXT NOT NULL,
          task_id TEXT,
          state TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          epoch INTEGER NOT NULL DEFAULT 0,
          declined INTEGER NOT NULL DEFAULT 0,
          granted_to TEXT
        );
        INSERT INTO takeovers (id, computer_id, task_id, state, expires_at, created_at, epoch, declined, granted_to)
          SELECT id, computer_id, task_id, state, expires_at, created_at, epoch, declined, granted_to FROM takeovers_notnull;
        DROP TABLE takeovers_notnull;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  registerBootstrapToken(tokenHash: string, expiresAt: string, origin: string | null = null, issuerSession: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO bootstrap_tokens (token_hash, expires_at, used_at, origin, issuer_session) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(token_hash) DO NOTHING`,
      )
      .run(tokenHash, expiresAt, origin, issuerSession);
  }

  consumeBootstrapToken(tokenHash: string, at = now(), origin: string | null = null): boolean {
    const result = this.db
      .prepare(
        `UPDATE bootstrap_tokens SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND (origin = ? OR (origin IS NULL AND (? IS NULL OR ? LIKE 'http://%')))
         AND (issuer_session IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE sessions.id = bootstrap_tokens.issuer_session AND sessions.expires_at > ?))`,
      )
      .run(at, tokenHash, at, origin, origin, origin, at);
    return Number(result.changes) === 1;
  }

  createPairing(origin: string, issuerSession: string | null = null): { url: string; expires_at: string } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const at = now();
      if (issuerSession !== null && !this.getSession(issuerSession)) return null;
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM bootstrap_tokens WHERE used_at IS NULL AND expires_at > ?").get(at) as { n: number };
      if (count.n >= 20) return null;
      const token = mintToken();
      const expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
      this.registerBootstrapToken(createHash("sha256").update(token).digest("hex"), expires_at, origin, issuerSession);
      return { url: `${origin}/#bootstrap=${token}`, expires_at };
    } finally { this.db.exec("COMMIT"); }
  }

  createSession(ttlMs = SESSION_TTL_MS, origin: string | null = null, label = "Browser"): SessionRow {
    const createdAt = now();
    const rec: SessionRow = {
      id: mintToken(24),
      csrf: mintToken(24),
      origin, label,
      created_at: createdAt,
      expires_at: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    };
    this.db
      .prepare("INSERT INTO sessions (id, csrf, created_at, expires_at, origin, label) VALUES (?, ?, ?, ?, ?, ?)")
      .run(rec.id, rec.csrf, rec.created_at, rec.expires_at, origin, label);
    return rec;
  }

  getSession(id: string): SessionRow | undefined {
    return row(
      this.db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ? AND expires_at > ?`)
        .get(id, now()),
    );
  }

  /**
   * Slide the idle window forward on activity, never past the absolute cap.
   * Without this an 8-hour clock started at the pairing logged a person out
   * mid-task and sent them back to `modelbot pair`.
   */
  touchSession(id: string, at = now()): SessionRow | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;
    const cap = Date.parse(session.created_at) + SESSION_MAX_LIFETIME_MS;
    const next = Math.min(Date.parse(at) + SESSION_TTL_MS, cap);
    const current = Date.parse(session.expires_at);
    // A polling UI authenticates every couple of seconds; one write a minute is enough.
    if (next - current < 60_000) return session;
    const expires_at = new Date(next).toISOString();
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expires_at, id);
    return { ...session, expires_at };
  }

  listSessions(): SessionRow[] {
    return rows(this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1000`).all(now()));
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  insertComputer(input: {
    id: string;
    name: string;
    capabilities: ComputerCapability[];
    persistent: boolean;
    status: string;
  }): ComputerRow {
    const rec: ComputerRow = {
      id: input.id,
      name: input.name,
      capabilities: JSON.stringify(input.capabilities),
      persistent: input.persistent ? 1 : 0,
      status: input.status,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO computers (id, name, capabilities, persistent, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.name, rec.capabilities, rec.persistent, rec.status, rec.created_at);
    return rec;
  }

  getCodexConnection(): { home: string; model: string; provider: "codex" | "claude" } | undefined {
    return this.db.prepare("SELECT home, model, provider FROM codex_connection WHERE id = 1").get() as { home: string; model: string; provider: "codex" | "claude" } | undefined;
  }

  setCodexConnection(home: string, model: string, provider: "codex" | "claude" = "codex"): void {
    this.db.prepare("INSERT INTO codex_connection (id, home, model, provider) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET home = excluded.home, model = excluded.model, provider = excluded.provider").run(home, model, provider);
  }

  getDefaultComputerId(): string | undefined {
    return (this.db.prepare("SELECT computer_id FROM workspace_default WHERE id = 1").get() as { computer_id: string } | undefined)?.computer_id;
  }

  setDefaultComputerId(id: string): void {
    this.db.prepare("INSERT INTO workspace_default (id, computer_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET computer_id = excluded.computer_id").run(id);
  }

  listComputers(): ComputerRow[] {
    return rows(
      this.db
        .prepare(
          `SELECT ${COMPUTER_COLUMNS} FROM computers ORDER BY created_at DESC`,
        )
        .all(),
    );
  }

  getComputer(id: string): ComputerRow | undefined {
    return row(
      this.db
        .prepare(
          `SELECT ${COMPUTER_COLUMNS} FROM computers WHERE id = ?`,
        )
        .get(id),
    );
  }

  setComputerStatus(id: string, status: string): void {
    this.db.prepare("UPDATE computers SET status = ? WHERE id = ?").run(status, id);
  }

  deleteComputer(id: string): void {
    this.db.prepare("UPDATE takeovers SET state = 'terminated' WHERE computer_id = ? AND state NOT IN ('agent', 'terminated')").run(id);
    this.db.prepare("DELETE FROM harness_task_bindings WHERE computer_id = ?").run(id);
    this.db.prepare("DELETE FROM computers WHERE id = ?").run(id);
  }

  insertTask(input: {
    id?: string;
    computer_id: string;
    goal: string;
    adapter?: string;
    driver?: DriverKind;
    capabilities?: ComputerCapability[];
    max_steps: number;
    spend_cap_usd?: number;
  }): TaskRow {
    const rec: TaskRow = {
      id: input.id ?? `task_${mintToken(12)}`,
      computer_id: input.computer_id,
      goal: input.goal,
      adapter: input.adapter ?? null,
      driver: input.driver ?? null,
      capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null,
      max_steps: input.max_steps,
      status: "running",
      created_at: now(),
      cancelled_at: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      summary: null,
      spend_cap_usd: input.spend_cap_usd ?? null,
      max_runtime_sec: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, computer_id, goal, adapter, driver, capabilities, max_steps, status, created_at, cancelled_at, spend_cap_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.computer_id,
        rec.goal,
        rec.adapter,
        rec.driver,
        rec.capabilities,
        rec.max_steps,
        rec.status,
        rec.created_at,
        rec.cancelled_at,
        rec.spend_cap_usd,
      );
    return rec;
  }

  listTasks(): TaskRow[] {
    return rows<TaskDbRow>(
      this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at DESC`).all(),
    ).map((r) => this.hydrateTask(r));
  }

  private taskDbRow(id: string): TaskDbRow | undefined {
    return row<TaskDbRow>(
      this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id),
    );
  }

  getTask(id: string): TaskRow | undefined {
    const found = this.taskDbRow(id);
    return found && this.hydrateTask(found);
  }

  cancelTask(id: string): TaskRow | undefined {
    const t = this.getTask(id);
    if (!t) return undefined;
    this.finishTask(id, "cancelled", now());
    return this.getTask(id);
  }

  /** paused → running. False when the task was not paused, so two resumes race safely. */
  resumeTask(id: string): boolean {
    return Number(
      this.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'paused'")
        .run(id).changes,
    ) === 1;
  }

  /** running → paused. False once the task is terminal, so a stop wins the race. */
  pauseTask(id: string): boolean {
    return Number(
      this.db.prepare(
        `UPDATE tasks SET status = 'paused' WHERE id = ? AND status NOT IN ${TERMINAL_TASK_STATUS_SQL}`,
      ).run(id).changes,
    ) === 1;
  }

  /** Raise or lower the cap this task spends against; a resume may only raise it. */
  setTaskSpendCap(id: string, usd: number): void {
    this.db.prepare("UPDATE tasks SET spend_cap_usd = ? WHERE id = ?").run(usd, id);
    this.db.prepare("UPDATE harness_task_bindings SET spend_cap_usd = ? WHERE task_id = ?").run(usd, id);
    this.repriceHarnessBinding(id);
  }

  /** Raise or lower the step budget this task runs against. */
  setTaskMaxSteps(id: string, steps: number): void {
    this.db.prepare("UPDATE tasks SET max_steps = ? WHERE id = ?").run(steps, id);
    this.db.prepare("UPDATE harness_task_bindings SET max_steps = ? WHERE task_id = ?").run(steps, id);
    this.repriceHarnessBinding(id);
  }

  /** Raise the wall clock this task's runs may take. 0 removes the ceiling. */
  setTaskMaxRuntimeSec(id: string, sec: number): void {
    this.db.prepare("UPDATE tasks SET max_runtime_sec = ? WHERE id = ?").run(sec, id);
  }

  /**
   * A raised budget un-refuses the calls the old one refused. `denied` is
   * sticky so a run cannot spend past its cap by restarting; recompute it
   * against the budget the task now has, and let the next denial audit itself.
   */
  private repriceHarnessBinding(taskId: string): void {
    const live = row<HarnessTaskBindingRow>(
      this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM harness_task_bindings WHERE task_id = ?`).get(taskId),
    );
    if (!live) return;
    this.db.prepare(
      "UPDATE harness_task_bindings SET denied = ?, denial_audit_reserved = 0 WHERE task_id = ?",
    ).run(harnessCapReason(live) ? 1 : 0, taskId);
  }

  /** Tool calls this task has made, counted from the durable log. */
  countToolCalls(id: string): number {
    return Number(
      (this.db.prepare(
        "SELECT COUNT(*) AS n FROM audit_refs WHERE task_id = ? AND type = 'tool.call'",
      ).get(id) as { n: number }).n,
    );
  }

  /**
   * What this task has spent and how many steps it has taken, across every run.
   * A resume seeds its counters from here, so the cap is a per-task total.
   */
  taskUsage(id: string): UsageEventBody | undefined {
    const found = row<{ body_json: string }>(
      this.db.prepare(
        "SELECT body_json FROM steps WHERE task_id = ? AND kind = 'usage' ORDER BY rowid DESC LIMIT 1",
      ).get(id),
    );
    return found && (JSON.parse(found.body_json) as UsageEventBody);
  }

  /**
   * The model transcript this task has built so far, oldest first. A resume
   * reads it back from here rather than from a loop object the pause discarded,
   * so a task survives a daemon restart.
   */
  taskTranscript(id: string): AdapterMessage[] {
    return rows<{ body_json: string }>(
      this.db.prepare(
        `SELECT body_json FROM steps WHERE task_id = ?
         AND kind IN ('observation', 'assistant', 'tool', 'user') ORDER BY rowid`,
      ).all(id),
    ).map((r) => JSON.parse(r.body_json) as AdapterMessage);
  }

  /**
   * The first durable sign that a task did anything. Idempotent by design:
   * only the first event to arrive sets the clock, so replaying the audit log
   * or a second event in the same millisecond cannot move the start time.
   */
  markTaskStarted(taskId: string, at: string): void {
    // Every task event funnels through here, and the column can only be set
    // once, so one write per task per process is enough.
    if (this.startedTasks.has(taskId)) return;
    this.startedTasks.add(taskId);
    this.db
      .prepare("UPDATE tasks SET started_at = ? WHERE id = ? AND started_at IS NULL")
      .run(at, taskId);
  }

  /**
   * Move a task to a terminal status and stamp the finish clock once. A later
   * status change (a stop racing a completion) cannot rewrite the first stamp,
   * so the finish time a reader saw stays the finish time it sees. Returns
   * whether this call is the one that finished the task.
   */
  finishTask(id: string, status: string, at = now()): boolean {
    const cancelledAt = status === "cancelled" ? at : null;
    const result = this.db.prepare(
      `UPDATE tasks SET status = ?, finished_at = COALESCE(finished_at, ?),
              cancelled_at = COALESCE(cancelled_at, ?)
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    ).run(status, at, cancelledAt, id);
    const finished = Number(result.changes) === 1;
    // A terminal task cannot still be the reason "your bot needs you" is lit:
    // close out any takeover it opened that a person never got to.
    if (finished) {
      this.db.prepare(
        "UPDATE takeovers SET state = 'terminated' WHERE task_id = ? AND state NOT IN ('agent', 'terminated')",
      ).run(id);
    }
    return finished;
  }

  /**
   * The receipt derived from the task's whole audit log. Null when the task is
   * not terminal, and null when its events are gone — finished before this
   * migration, or pruned. Saying "no receipt" is honest; a row of zeroes would
   * read as "it did nothing", which is a different and false claim.
   */
  private taskEvents(id: string): Array<{ type: string; body_json: string; ts: string }> {
    return rows<{ type: string; body_json: string; ts: string }>(
      this.db.prepare("SELECT type, body_json, ts FROM audit_refs WHERE task_id = ? ORDER BY seq").all(id),
    );
  }

  private deriveTaskReceipt(
    r: TaskDbRow,
  ): { finished_at: string; duration_ms: number; summary: TaskSummary } | null {
    if (!TERMINAL_TASK_STATUS.includes(r.status)) return null;
    const events = this.taskEvents(r.id);
    if (events.length === 0) return null;
    // A finish clock can never precede the task's own last event.
    const lastTs = events.at(-1)?.ts;
    const finished = maxIso(r.finished_at ?? r.cancelled_at ?? lastTs ?? r.created_at, lastTs);
    const from = Date.parse(r.started_at ?? r.created_at);
    return {
      finished_at: finished,
      duration_ms: Math.max(0, Date.parse(finished) - from),
      summary: taskSummaryFromEvents(events),
    };
  }

  /**
   * Fill in the derived task fields. A read NEVER freezes and never writes:
   * `finishTask` flips the row to terminal before the task's own terminal audit
   * event has been appended, so a read landing in that gap would have frozen a
   * receipt computed from an incomplete log — the exact "14 steps → 10 steps,
   * None" defect freezing exists to prevent. Until `freezeTaskSummary` runs,
   * every read recomputes and so is always current.
   */
  private hydrateTask(r: TaskDbRow): TaskRow {
    const { summary_json, ...rest } = r;
    if (summary_json) {
      return { ...rest, summary: JSON.parse(summary_json) as TaskSummary };
    }
    // A paused run has already done work — steps, sites, files, spend — and a
    // budget, step or runtime stop leaves it there for as long as it takes the
    // operator to answer. Terminal rows also take their finish clock from the
    // log; a paused one has not finished, so only the summary is derived.
    if (r.status === "paused") {
      const events = this.taskEvents(r.id);
      return { ...rest, summary: events.length ? taskSummaryFromEvents(events) : null };
    }
    return { ...rest, ...(this.deriveTaskReceipt(r) ?? { summary: null }) };
  }

  /**
   * Freeze the receipt so every later read returns the same numbers. Call this
   * only once the task's own terminal event is durably in the audit log — the
   * activity feed the UI streams is capped and lossy, so the frozen row is the
   * only durable record of what the task actually did. Idempotent: the first
   * freeze wins, and a task with no events is left unfrozen.
   */
  freezeTaskSummary(id: string): void {
    const found = this.taskDbRow(id);
    if (!found || found.summary_json) return;
    const derived = this.deriveTaskReceipt(found);
    if (!derived) return;
    this.db.prepare(
      `UPDATE tasks SET finished_at = ?, duration_ms = ?, summary_json = ?
       WHERE id = ? AND summary_json IS NULL`,
    ).run(derived.finished_at, derived.duration_ms, JSON.stringify(derived.summary), id);
  }

  /**
   * `summary_json` is frozen at the first terminal read, so every task that
   * finished before the receipt learned to read outcomes instead of
   * requests still names files the computer never wrote — with a live Open
   * button, on the same screen that admits the write was rejected.
   *
   * Recompute `files_saved` from the durable log, which now yields only files a
   * `tool.result` or `download.promoted` says landed, and keep an entry only if
   * `onDisk` still finds it. Nothing else in the frozen receipt is touched: the
   * old rows' step and site counts came from arguments this projection no
   * longer keeps, so recomputing those would replace a stale number with a
   * smaller lie.
   *
   * Versioned on `PRAGMA user_version`, so it runs once per database and is a
   * no-op afterwards; running it twice would change nothing anyway.
   */
  /** Schema version this database has already been migrated to. */
  private userVersion(): number {
    return Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
        ?.user_version ?? 0,
    );
  }

  repairFrozenFileLists(
    onDisk: (computerId: string, path: string) => boolean,
  ): { applied: boolean; repaired: number } {
    if (this.userVersion() >= RECEIPT_REPAIR_VERSION) return { applied: false, repaired: 0 };
    const update = this.db.prepare("UPDATE tasks SET summary_json = ? WHERE id = ?");
    const readEvents = this.db.prepare(
      "SELECT type, body_json FROM audit_refs WHERE task_id = ? ORDER BY seq",
    );
    let repaired = 0;
    for (const task of rows<{ id: string; computer_id: string; summary_json: string }>(
      this.db.prepare("SELECT id, computer_id, summary_json FROM tasks WHERE summary_json IS NOT NULL").all(),
    )) {
      let summary: TaskSummary;
      try {
        summary = JSON.parse(task.summary_json) as TaskSummary;
      } catch {
        continue;
      }
      const frozen = Array.isArray(summary.files_saved) ? summary.files_saved : [];
      if (frozen.length === 0) continue;
      // Compared by filename, not by path: the same file is recorded as
      // `today.md` in one row and `out/today.md` in the next, and
      // dropping a file that really was written because its two records spell
      // it differently would be the same failure pointing the other way.
      const derived = new Set(
        taskSummaryFromEvents(
          rows<{ type: string; body_json: string }>(readEvents.all(task.id)),
        ).files_saved.map(fileName),
      );
      const kept = frozen.filter(
        (path) => derived.has(fileName(path)) && onDisk(task.computer_id, path),
      );
      if (kept.length === frozen.length) continue;
      update.run(JSON.stringify({ ...summary, files_saved: kept, repaired: true }), task.id);
      repaired += 1;
    }
    this.db.exec(`PRAGMA user_version = ${RECEIPT_REPAIR_VERSION}`);
    return { applied: true, repaired };
  }

  /** Origins the operator has granted for this task, oldest grant first. */
  taskGrantedOrigins(taskId: string): string[] {
    return rows<{ origin: string }>(
      this.db.prepare("SELECT origin FROM task_origin_grants WHERE task_id = ? ORDER BY rowid").all(taskId),
    ).map((g) => g.origin);
  }

  /**
   * Record granted origins for a task. Re-granting the same origin is a no-op.
   * Returns the origins that were actually granted.
   *
   * A 120-second approval buys an origin trusted for the whole task, so the
   * count is capped: past `MAX_TASK_ORIGIN_GRANTS` the answer is no, and the
   * caller audits the refusal rather than growing an unbounded allowlist a
   * long-running task never gets to shed.
   */
  grantTaskOrigins(taskId: string, origins: string[], approvalId?: string): string[] {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO task_origin_grants (task_id, origin, created_at, approval_id) VALUES (?, ?, ?, ?)",
    );
    const at = now();
    const granted: string[] = [];
    let held = this.countTaskGrantedOrigins(taskId);
    for (const origin of origins) {
      if (!origin) continue;
      if (held >= MAX_TASK_ORIGIN_GRANTS) break;
      if (Number(insert.run(taskId, origin, at, approvalId ?? null).changes) === 1) {
        granted.push(origin);
        held += 1;
      }
    }
    return granted;
  }

  countTaskGrantedOrigins(taskId: string): number {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM task_origin_grants WHERE task_id = ?").get(taskId) as { n: number }).n,
    );
  }

  /**
   * Burn an approval and record what it granted in one transaction, so a crash
   * between the two can never leave a consumed approval with nothing granted —
   * the state that made an approved navigation land back on about:blank and ask
   * again.
   */
  consumeApprovalWithGrant(
    id: string,
    expected: ApprovalStatus,
    taskId: string,
    origins: string[],
    /**
     * What the human actually answered. Writing a fixed `allow_once` made the
     * durable record of an `allow_task` decision a lie.
     */
    decision: ApprovalDecision = "allow_once",
  ): ApprovalRow | undefined {
    // SAVEPOINT, not BEGIN: called inside an outer transaction, a bare BEGIN
    // throws and the catch then rolls the OUTER transaction back.
    // A savepoint nests, and rolling back to it leaves outer work alone.
    this.db.exec("SAVEPOINT consume_approval");
    try {
      const consumed = this.setApprovalStatusIf(id, expected, "consumed", decision);
      if (consumed) this.grantTaskOrigins(taskId, origins, id);
      this.db.exec("RELEASE consume_approval");
      return consumed;
    } catch (error) {
      this.db.exec("ROLLBACK TO consume_approval");
      this.db.exec("RELEASE consume_approval");
      throw error;
    }
  }

  insertHarnessTaskBinding(input: {
    task_id: string;
    computer_id: string;
    spend_cap_usd: number;
    max_steps: number;
    proxy_usd_per_tool_call: number;
  }): HarnessTaskBindingRow {
    const prior = this.getHarnessTaskBinding(input.computer_id);
    if (prior && !["completed", "failed", "cancelled"].includes(this.getTask(prior.task_id)?.status ?? "")) {
      throw new Error("computer has an active harness task");
    }
    if (this.getTask(input.task_id)) throw new Error("task_id has already been used");
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (prior) {
        // Keep the exact spent budget and denial receipt with the completed task.
        this.insertStep(prior.task_id, 0, "harness_binding", prior);
        this.db.prepare("DELETE FROM harness_task_bindings WHERE computer_id = ?").run(input.computer_id);
      }
      this.insertTask({ id: input.task_id, computer_id: input.computer_id,
        goal: "External harness task", adapter: "harness", max_steps: input.max_steps,
        spend_cap_usd: input.spend_cap_usd });
      this.db.prepare(
        `INSERT INTO harness_task_bindings
         (task_id, computer_id, execution, spend_cap_usd, max_steps,
          proxy_usd_per_tool_call, observed_tool_calls, denied,
          denial_audit_reserved, created_at)
         VALUES (?, ?, 'harness', ?, ?, ?, 0, 0, 0, ?)`,
      ).run(
        input.task_id,
        input.computer_id,
        input.spend_cap_usd,
        input.max_steps,
        input.proxy_usd_per_tool_call,
        createdAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getHarnessTaskBinding(input.computer_id)!;
  }

  getHarnessTaskBinding(computerId: string): HarnessTaskBindingRow | undefined {
    return row(
      this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM harness_task_bindings WHERE computer_id = ?`)
        .get(computerId),
    );
  }

  /**
   * One task's binding, live or archived. A computer holds one live binding at
   * a time and the previous one is filed against the task it belonged to, so a
   * finished task can still report the budget it actually ran against.
   */
  harnessBindingForTask(taskId: string): HarnessTaskBindingRow | undefined {
    const live = row<HarnessTaskBindingRow>(
      this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM harness_task_bindings WHERE task_id = ?`)
        .get(taskId),
    );
    if (live) return live;
    const archived = row<{ body_json: string }>(
      this.db.prepare(
        "SELECT body_json FROM steps WHERE task_id = ? AND kind = 'harness_binding' ORDER BY rowid DESC LIMIT 1",
      ).get(taskId),
    );
    return archived && (JSON.parse(archived.body_json) as HarnessTaskBindingRow);
  }

  /** Observe one attempted harness MCP call and claim its denial audit in-process. */
  observeHarnessToolCall(computerId: string): HarnessToolCallAttempt | undefined {
    const current = this.getHarnessTaskBinding(computerId);
    if (!current) return undefined;
    if (Boolean(current.denied)) {
      const emitDenialAudit =
        !current.denial_audit_reserved &&
        !this.harnessDenialAuditsInFlight.has(computerId);
      if (emitDenialAudit) this.harnessDenialAuditsInFlight.add(computerId);
      return {
        binding: current,
        denied: true,
        emit_denial_audit: emitDenialAudit,
        proxy_estimate_usd: harnessSpendUsd(
          current.observed_tool_calls,
          current.proxy_usd_per_tool_call,
        ),
        counted: false,
      };
    }

    const observedToolCalls = current.observed_tool_calls + 1;
    const proxyEstimateUsd = harnessSpendUsd(observedToolCalls, current.proxy_usd_per_tool_call);
    const denied = harnessCapReason({ ...current, observed_tool_calls: observedToolCalls }) !== null;
    this.db.prepare(
      `UPDATE harness_task_bindings
       SET observed_tool_calls = ?, denied = ?, denial_audit_reserved = ?
       WHERE computer_id = ?`,
    ).run(observedToolCalls, denied ? 1 : 0, 0, computerId);
    if (denied) this.harnessDenialAuditsInFlight.add(computerId);

    return {
      binding: {
        ...current,
        observed_tool_calls: observedToolCalls,
        denied: denied ? 1 : 0,
        denial_audit_reserved: 0,
      },
      denied,
      emit_denial_audit: denied,
      proxy_estimate_usd: proxyEstimateUsd,
      counted: true,
    };
  }

  /** Persist consumption only after append success; failure releases the retry claim. */
  finishHarnessDenialAudit(computerId: string, appended: boolean): void {
    if (appended) {
      this.db.prepare(
        `UPDATE harness_task_bindings SET denial_audit_reserved = 1
         WHERE computer_id = ? AND denied = 1`,
      ).run(computerId);
    }
    this.harnessDenialAuditsInFlight.delete(computerId);
  }

  pendingMessages(taskId: string): Array<{ id: string; content: string }> {
    return (this.db.prepare(`SELECT id, body_json FROM steps WHERE task_id = ?
      AND kind = 'user' AND json_extract(body_json, '$.delivered_at') IS NULL ORDER BY rowid`)
      .all(taskId) as Array<{ id: string; body_json: string }>).map(row => ({ id: row.id, content: JSON.parse(row.body_json).content }));
  }

  takeMessages(taskId: string): string[] {
    const messages = this.pendingMessages(taskId);
    const mark = this.db.prepare(`UPDATE steps SET body_json = json_set(body_json, '$.delivered_at', ?) WHERE id = ?`);
    for (const message of messages) mark.run(now(), message.id);
    return messages.map(message => message.content);
  }

  insertStep(taskId: string, seq: number, kind: string, body: unknown): void {
    this.db
      .prepare(
        `INSERT INTO steps (id, task_id, seq, kind, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(`step_${mintToken(8)}`, taskId, seq, kind, JSON.stringify(body), now());
  }

  insertApproval(input: {
    id?: string;
    task_id: string;
    tool: string;
    args: Record<string, unknown>;
    gate: string;
    bind: Record<string, unknown>;
  }): ApprovalRow {
    const rec: ApprovalRow = {
      id: input.id ?? `apr_${mintToken(12)}`,
      task_id: input.task_id,
      tool: input.tool,
      args_json: JSON.stringify(input.args),
      gate: input.gate,
      bind_json: JSON.stringify(input.bind),
      status: "pending",
      decision: null,
      created_at: now(),
      decided_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO approvals
         (id, task_id, tool, args_json, gate, bind_json, status, decision, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.task_id,
        rec.tool,
        rec.args_json,
        rec.gate,
        rec.bind_json,
        rec.status,
        rec.decision,
        rec.created_at,
        rec.decided_at,
      );
    return rec;
  }

  listApprovals(status?: ApprovalStatus): ApprovalRow[] {
    const where = status ? "WHERE status = ? " : "";
    const stmt = this.db.prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals ${where}ORDER BY created_at DESC`,
    );
    return rows(status ? stmt.all(status) : stmt.all());
  }

  getApproval(id: string): ApprovalRow | undefined {
    return row(
      this.db
        .prepare(
          `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`,
        )
        .get(id),
    );
  }

  setApprovalStatusIf(
    id: string,
    expected: ApprovalStatus,
    status: ApprovalStatus,
    decision: ApprovalDecision | null,
  ): ApprovalRow | undefined {
    const decidedAt = now();
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, decision = ?, decided_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(status, decision, decidedAt, id, expected);
    return Number(result.changes) === 1 ? this.getApproval(id) : undefined;
  }

  findApprovalByAction(
    taskId: string,
    actionHash: string,
  ): ApprovalRow | undefined {
    const candidates = rows<ApprovalRow>(
      this.db
        .prepare(
          `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(taskId),
    );
    return candidates.find((candidate) => {
      try {
        return (JSON.parse(candidate.bind_json) as { action_hash?: string }).action_hash === actionHash;
      } catch {
        return false;
      }
    });
  }

  expirePendingApprovals(at = now()): ApprovalRow[] {
    const expired: ApprovalRow[] = [];
    for (const approval of this.listApprovals("pending")) {
      let due: boolean;
      try {
        const bind = JSON.parse(approval.bind_json) as { expires?: string };
        due = typeof bind.expires === "string" && bind.expires <= at;
      } catch {
        due = true;
      }
      if (!due) continue;
      const updated = this.setApprovalStatusIf(approval.id, "pending", "expired", null);
      if (updated) expired.push(updated);
    }
    return expired;
  }

  insertTakeover(input: {
    id: string;
    computer_id: string;
    task_id?: string | null;
    state: TakeoverState;
    expires_at: string | null;
    epoch?: number;
  }): TakeoverRow {
    const rec: TakeoverRow = {
      id: input.id,
      computer_id: input.computer_id,
      task_id: input.task_id ?? null,
      state: input.state,
      expires_at: input.expires_at,
      created_at: now(),
      epoch: input.epoch && input.epoch > 0 ? Math.trunc(input.epoch) : 0,
      declined: 0,
      granted_to: null,
    };
    this.db
      .prepare(
        `INSERT INTO takeovers (id, computer_id, task_id, state, expires_at, created_at, epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.computer_id,
        rec.task_id,
        rec.state,
        rec.expires_at,
        rec.created_at,
        rec.epoch,
      );
    return rec;
  }

  getTakeover(id: string): TakeoverRow | undefined {
    return row(
      this.db
        .prepare(
          `SELECT ${TAKEOVER_COLUMNS} FROM takeovers WHERE id = ?`,
        )
        .get(id),
    );
  }

  latestTakeoverForComputer(computerId: string): TakeoverRow | undefined {
    return row(this.db.prepare(
      "SELECT * FROM takeovers WHERE computer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(computerId));
  }

  listTakeovers(): TakeoverRow[] {
    return rows(
      this.db
        .prepare(`SELECT ${TAKEOVER_COLUMNS} FROM takeovers ORDER BY created_at DESC`)
        .all(),
    );
  }

  /** Restart the lease clock. The takeover row is what pauses the task, so it is the clock that matters. */
  setTakeoverExpiry(id: string, expiresAt: string): void {
    this.db.prepare("UPDATE takeovers SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  updateTakeoverState(id: string, state: TakeoverState): void {
    this.db.prepare("UPDATE takeovers SET state = ? WHERE id = ?").run(state, id);
  }

  /** Control goes to one device, and the row remembers which. */
  grantTakeoverTo(id: string, device: string): void {
    this.db.prepare("UPDATE takeovers SET state = 'human', granted_to = ? WHERE id = ?")
      .run(device, id);
  }

  /** The person looked and handed nothing over: control goes back, refused. */
  declineTakeover(id: string): void {
    this.db.prepare("UPDATE takeovers SET state = 'agent', declined = 1 WHERE id = ?").run(id);
  }

  updateTakeoverEpoch(id: string, epoch: number): void {
    if (epoch <= 0) return;
    this.db.prepare("UPDATE takeovers SET epoch = ? WHERE id = ?").run(Math.trunc(epoch), id);
  }

  /**
   * The takeover still holding this computer. A row whose task has ended holds
   * nothing — nobody is coming to answer a question the task can no longer use
   * — and a row belonging to a different live task is that task's business, so
   * a caller that names its own task never inherits another one's wait. Rows
   * with no task are the operator's own control of the computer and always count.
   */
  activeTakeoverForComputer(computerId: string, taskId?: string): TakeoverRow | undefined {
    return row(
      this.db
        .prepare(
          `SELECT ${TAKEOVER_COLUMNS} FROM takeovers
           WHERE computer_id = ? AND state IN ${OPEN_TAKEOVER_STATES}
             AND (task_id IS NULL OR ? IS NULL OR task_id = ?)
             AND ${TAKEOVER_TASK_ALIVE}
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(computerId, taskId ?? null, taskId ?? null),
    );
  }

  /**
   * Tasks that died on an older daemon left their takeover rows open, and an
   * open row on a computer reads as "a person is still expected here" — so the
   * next task on that computer refused to take a single step. Close every row
   * whose task is terminal or gone. Versioned on `PRAGMA user_version`, so it
   * runs once per database; running it again would change nothing anyway.
   */
  closeStaleTakeovers(): { applied: boolean; closed: number } {
    if (this.userVersion() >= STALE_TAKEOVER_VERSION) return { applied: false, closed: 0 };
    const closed = Number(
      this.db.prepare(
        `UPDATE takeovers SET state = 'terminated'
         WHERE state IN ${OPEN_TAKEOVER_STATES} AND NOT ${TAKEOVER_TASK_ALIVE}`,
      ).run().changes,
    );
    this.db.exec(`PRAGMA user_version = ${STALE_TAKEOVER_VERSION}`);
    return { applied: true, closed };
  }

  appendAuditRef(input: {
    type: string;
    task_id?: string;
    computer_id?: string;
    body: Record<string, unknown>;
    hash: string;
  }): AuditRefRow {
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM audit_refs").get() as {
      m: number;
    };
    const seq = Number(seqRow.m) + 1;
    const rec: AuditRefRow = {
      seq,
      type: input.type,
      ts: now(),
      task_id: input.task_id ?? null,
      computer_id: input.computer_id ?? null,
      body_json: JSON.stringify(input.body),
      hash: input.hash,
    };
    this.db
      .prepare(
        `INSERT INTO audit_refs (seq, type, ts, task_id, computer_id, body_json, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.seq, rec.type, rec.ts, rec.task_id, rec.computer_id, rec.body_json, rec.hash);
    // Every task event funnels through here, so this is the one place that can
    // see the task's first real work. `usage` with zero steps is the receipt
    // emitted at creation, before the model has run — not a start.
    if (rec.task_id && (rec.type === "tool.call" || rec.type === "task.step" ||
        (rec.type === "usage" && Number(input.body.steps) > 0))) {
      this.markTaskStarted(rec.task_id, rec.ts);
    }
    return rec;
  }

  listAuditRefs(limit = 100): AuditRefRow[] {
    return rows(
      this.db
        .prepare(
          `SELECT seq, type, ts, task_id, computer_id, body_json, hash
           FROM audit_refs ORDER BY seq DESC LIMIT ?`,
        )
        .all(limit),
    );
  }
}
