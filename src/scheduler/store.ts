/**
 * SQLite-backed routines + run history.
 * Attaches to daemon DatabaseSync or opens its own path.
 */

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ComputerCapability } from "../types/contracts.ts";
import { nextCronRun, parseCron } from "./cron.ts";

/** A person may keep this many routines switched on. */
export const MAX_ENABLED_ROUTINES = 20;
export const TOO_MANY_ENABLED = `You already have ${MAX_ENABLED_ROUTINES} routines switched on. Switch one off before adding another.`;

export type NotifyOn = "fail" | "done";
export type RunStatus = "running" | "done" | "failed" | "skipped";

export interface RoutineTaskTemplate {
  goal: string;
  capabilities: ComputerCapability[];
  /** Optional origin/domain hints for the task. */
  origins?: string[];
  max_steps?: number;
  adapter?: string;
}

export interface RoutineRow {
  id: string;
  name: string;
  cron: string;
  computer_name: string;
  task_json: string;
  notify_json: string;
  notify_on_json: string;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutineHistoryRow {
  id: string;
  routine_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  task_id: string | null;
  artifacts_json: string;
  cost_usd: number | null;
  error: string | null;
  missed: number;
}

export interface CreateRoutineInput {
  name: string;
  cron: string;
  computer_name: string;
  task: RoutineTaskTemplate;
  notify?: string[];
  notify_on?: NotifyOn[];
  enabled?: boolean;
  id?: string;
}

function nowIso(d = new Date()): string {
  return d.toISOString();
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function asRows<T>(value: unknown): T[] {
  return value as T[];
}

function asRow<T>(value: unknown): T | undefined {
  return (value as T | undefined) ?? undefined;
}

export class RoutinesStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  constructor(pathOrDb: string | DatabaseSync = ":memory:") {
    if (typeof pathOrDb === "string") {
      this.db = new DatabaseSync(pathOrDb);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.ownsDb = true;
    } else {
      this.db = pathOrDb;
      this.ownsDb = false;
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        computer_name TEXT NOT NULL,
        task_json TEXT NOT NULL,
        notify_json TEXT NOT NULL DEFAULT '[]',
        notify_on_json TEXT NOT NULL DEFAULT '["fail"]',
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routine_history (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        task_id TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        cost_usd REAL,
        error TEXT,
        missed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_routine_history_routine
        ON routine_history(routine_id, started_at DESC);
    `);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  parseTask(r: RoutineRow): RoutineTaskTemplate {
    return JSON.parse(r.task_json) as RoutineTaskTemplate;
  }

  parseNotify(r: RoutineRow): string[] {
    return JSON.parse(r.notify_json) as string[];
  }

  parseNotifyOn(r: RoutineRow): NotifyOn[] {
    return JSON.parse(r.notify_on_json) as NotifyOn[];
  }

  countEnabled(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM routines WHERE enabled = 1")
      .get() as { n: number };
    return Number(r.n);
  }

  create(input: CreateRoutineInput, now = new Date()): RoutineRow {
    parseCron(input.cron);
    const enabled = input.enabled === false ? 0 : 1;
    if (enabled === 1 && this.countEnabled() >= MAX_ENABLED_ROUTINES) {
      throw new Error(TOO_MANY_ENABLED);
    }
    const id = input.id ?? mintId("rtn");
    const ts = nowIso(now);
    const next = nextCronRun(input.cron, now).toISOString();
    const rec: RoutineRow = {
      id,
      name: input.name,
      cron: input.cron.trim(),
      computer_name: input.computer_name,
      task_json: JSON.stringify(input.task),
      notify_json: JSON.stringify(input.notify ?? []),
      notify_on_json: JSON.stringify(input.notify_on ?? ["fail"]),
      enabled,
      next_run_at: next,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO routines
         (id, name, cron, computer_name, task_json, notify_json, notify_on_json,
          enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.name,
        rec.cron,
        rec.computer_name,
        rec.task_json,
        rec.notify_json,
        rec.notify_on_json,
        rec.enabled,
        rec.next_run_at,
        rec.created_at,
        rec.updated_at,
      );
    return rec;
  }

  list(): RoutineRow[] {
    return asRows(
      this.db
        .prepare(
          `SELECT id, name, cron, computer_name, task_json, notify_json, notify_on_json,
                  enabled, next_run_at, created_at, updated_at
           FROM routines ORDER BY created_at DESC`,
        )
        .all(),
    );
  }

  get(id: string): RoutineRow | undefined {
    return asRow(
      this.db
        .prepare(
          `SELECT id, name, cron, computer_name, task_json, notify_json, notify_on_json,
                  enabled, next_run_at, created_at, updated_at
           FROM routines WHERE id = ?`,
        )
        .get(id),
    );
  }

  getByName(name: string): RoutineRow | undefined {
    return asRow(
      this.db
        .prepare(
          `SELECT id, name, cron, computer_name, task_json, notify_json, notify_on_json,
                  enabled, next_run_at, created_at, updated_at
           FROM routines WHERE name = ?`,
        )
        .get(name),
    );
  }

  remove(id: string): boolean {
    const r = this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  setNextRun(id: string, nextRunAt: string | null, now = new Date()): void {
    this.db
      .prepare("UPDATE routines SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(nextRunAt, nowIso(now), id);
  }

  setEnabled(id: string, enabled: boolean, now = new Date()): void {
    if (enabled) {
      const row = this.get(id);
      if (row && row.enabled !== 1 && this.countEnabled() >= MAX_ENABLED_ROUTINES) {
        throw new Error(TOO_MANY_ENABLED);
      }
    }
    this.db
      .prepare("UPDATE routines SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nowIso(now), id);
  }

  /** Tail of finished non-skipped runs that are `failed`. Skips do not break the streak. */
  consecutiveFailures(routineId: string, limit = 20): number {
    const rows = asRows<{ status: RunStatus }>(
      this.db
        .prepare(
          `SELECT status FROM routine_history
           WHERE routine_id = ? AND status IN ('done', 'failed')
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(routineId, limit),
    );
    let failures = 0;
    for (const run of rows) {
      if (run.status !== "failed") break;
      failures += 1;
    }
    return failures;
  }

  insertHistory(input: {
    routine_id: string;
    status: RunStatus;
    task_id?: string | null;
    artifacts?: unknown[];
    cost_usd?: number | null;
    error?: string | null;
    missed?: boolean;
    started_at?: Date;
  }): RoutineHistoryRow {
    const started = input.started_at ?? new Date();
    const rec: RoutineHistoryRow = {
      id: mintId("rh"),
      routine_id: input.routine_id,
      status: input.status,
      started_at: nowIso(started),
      finished_at: input.status === "running" ? null : nowIso(started),
      task_id: input.task_id ?? null,
      artifacts_json: JSON.stringify(input.artifacts ?? []),
      cost_usd: input.cost_usd ?? null,
      error: input.error ?? null,
      missed: input.missed ? 1 : 0,
    };
    this.db
      .prepare(
        `INSERT INTO routine_history
         (id, routine_id, status, started_at, finished_at, task_id, artifacts_json, cost_usd, error, missed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.routine_id,
        rec.status,
        rec.started_at,
        rec.finished_at,
        rec.task_id,
        rec.artifacts_json,
        rec.cost_usd,
        rec.error,
        rec.missed,
      );
    return rec;
  }

  finishHistory(
    id: string,
    update: {
      status: Exclude<RunStatus, "running">;
      artifacts?: unknown[];
      cost_usd?: number | null;
      error?: string | null;
      task_id?: string | null;
      finished_at?: Date;
    },
  ): RoutineHistoryRow | undefined {
    const finished = nowIso(update.finished_at ?? new Date());
    this.db
      .prepare(
        `UPDATE routine_history
         SET status = ?, finished_at = ?,
             artifacts_json = COALESCE(?, artifacts_json),
             cost_usd = COALESCE(?, cost_usd),
             error = ?,
             task_id = COALESCE(?, task_id)
         WHERE id = ?`,
      )
      .run(
        update.status,
        finished,
        update.artifacts !== undefined ? JSON.stringify(update.artifacts) : null,
        update.cost_usd !== undefined ? update.cost_usd : null,
        update.error ?? null,
        update.task_id !== undefined ? update.task_id : null,
        id,
      );
    return this.getHistory(id);
  }

  getHistory(id: string): RoutineHistoryRow | undefined {
    return asRow(
      this.db
        .prepare(
          `SELECT id, routine_id, status, started_at, finished_at, task_id,
                  artifacts_json, cost_usd, error, missed
           FROM routine_history WHERE id = ?`,
        )
        .get(id),
    );
  }

  listHistory(routineId: string, limit = 20): RoutineHistoryRow[] {
    return asRows(
      this.db
        .prepare(
          `SELECT id, routine_id, status, started_at, finished_at, task_id,
                  artifacts_json, cost_usd, error, missed
           FROM routine_history WHERE routine_id = ?
           ORDER BY started_at DESC LIMIT ?`,
        )
        .all(routineId, limit),
    );
  }

  hasRunning(routineId: string): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 AS x FROM routine_history
         WHERE routine_id = ? AND status = 'running' LIMIT 1`,
      )
      .get(routineId) as { x: number } | undefined;
    return r !== undefined;
  }

  toPublic(r: RoutineRow): Record<string, unknown> {
    return {
      id: r.id,
      name: r.name,
      cron: r.cron,
      computer_name: r.computer_name,
      task: this.parseTask(r),
      notify: this.parseNotify(r),
      notify_on: this.parseNotifyOn(r),
      enabled: r.enabled === 1,
      next_run_at: r.next_run_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  historyPublic(h: RoutineHistoryRow): Record<string, unknown> {
    return {
      id: h.id,
      routine_id: h.routine_id,
      status: h.status,
      started_at: h.started_at,
      finished_at: h.finished_at,
      task_id: h.task_id,
      artifacts: JSON.parse(h.artifacts_json) as unknown[],
      cost_usd: h.cost_usd,
      error: h.error,
      missed: h.missed === 1,
    };
  }
}
