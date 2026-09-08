/**
 * Thin routine scheduler loop.
 * Missed-run: fire once if late < 1h; else skip to next. Single-flight per routine.
 */

import {
  createNotifyFanout,
  type NotifyPayload,
} from "../notify/index.ts";
import {
  MISSED_RUN_WINDOW_MS,
  nextCronRun,
  shouldFireMissed,
} from "./cron.ts";
import type {
  RoutineHistoryRow,
  RoutineRow,
  RoutinesStore,
  RoutineTaskTemplate,
} from "./store.ts";

export interface FireResult {
  ok: boolean;
  task_id?: string;
  artifacts?: unknown[];
  cost_usd?: number;
  error?: string;
}

export interface TaskRunner {
  run(input: {
    routine: RoutineRow;
    task: RoutineTaskTemplate;
    computer_name: string;
  }): Promise<FireResult>;
}

export interface SchedulerClock {
  now(): Date;
}

export type NotifyFn = (
  targets: string[],
  payload: NotifyPayload,
) => Promise<unknown>;

export interface SchedulerDeps {
  store: RoutinesStore;
  runner: TaskRunner;
  notifyFn?: NotifyFn;
  clock?: SchedulerClock;
  intervalMs?: number;
  missedWindowMs?: number;
}

async function defaultNotify(
  targets: string[],
  payload: NotifyPayload,
): Promise<void> {
  if (!targets.length) return;
  await createNotifyFanout(targets).send(payload);
}

/** Consecutive failed firings after which a routine is switched off. */
export const FATIGUE_LIMIT = 10;

const FATIGUE_NOTIFY =
  "This routine has failed ten times in a row, so it has been switched off.";

export class Scheduler {
  private readonly store: RoutinesStore;
  private readonly runner: TaskRunner;
  private readonly notifyFn: NotifyFn;
  private readonly clock: SchedulerClock;
  private readonly intervalMs: number;
  private readonly missedWindowMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();
  private readonly runs = new Set<Promise<RoutineHistoryRow>>();
  private tickBusy = false;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.notifyFn = deps.notifyFn ?? defaultNotify;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.intervalMs = deps.intervalMs ?? 15_000;
    this.missedWindowMs = deps.missedWindowMs ?? MISSED_RUN_WINDOW_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.tickBusy) return;
    this.tickBusy = true;
    try {
      await this.tickBody();
    } finally {
      this.tickBusy = false;
    }
  }

  private async tickBody(): Promise<void> {
    const now = this.clock.now();
    for (const routine of this.store.list()) {
      if (!routine.enabled) continue;
      if (!routine.next_run_at) {
        const next = nextCronRun(routine.cron, now);
        this.store.setNextRun(routine.id, next.toISOString(), now);
        continue;
      }
      const scheduled = new Date(routine.next_run_at);
      if (scheduled.getTime() > now.getTime()) continue;

      if (shouldFireMissed(scheduled, now, this.missedWindowMs)) {
        await this.execute(routine, {
          missed: scheduled.getTime() < now.getTime(),
        });
      } else {
        const next = nextCronRun(routine.cron, now);
        this.store.setNextRun(routine.id, next.toISOString(), now);
        this.store.insertHistory({
          routine_id: routine.id,
          status: "skipped",
          error: "missed beyond 1h window",
          missed: true,
          started_at: now,
        });
      }
    }
  }

  async runNow(routineId: string): Promise<RoutineHistoryRow> {
    const routine = this.store.get(routineId);
    if (!routine) throw new Error(`routine not found: ${routineId}`);
    return this.execute(routine, { missed: false, advanceCron: false });
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.runs);
  }

  private execute(routine: RoutineRow, opts: { missed: boolean; advanceCron?: boolean }): Promise<RoutineHistoryRow> {
    const run = this.executeRun(routine, opts);
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run)).catch(() => undefined);
    return run;
  }

  private async executeRun(
    routine: RoutineRow,
    opts: { missed: boolean; advanceCron?: boolean },
  ): Promise<RoutineHistoryRow> {
    const now = this.clock.now();
    if (this.inFlight.has(routine.id) || this.store.hasRunning(routine.id)) {
      return this.store.insertHistory({
        routine_id: routine.id,
        status: "skipped",
        error: "single-flight: already running",
        missed: opts.missed,
        started_at: now,
      });
    }

    this.inFlight.add(routine.id);
    const history = this.store.insertHistory({
      routine_id: routine.id,
      status: "running",
      missed: opts.missed,
      started_at: now,
    });

    if (opts.advanceCron !== false) {
      const next = nextCronRun(routine.cron, now);
      this.store.setNextRun(routine.id, next.toISOString(), now);
    }

    const task = this.store.parseTask(routine);
    const notifyTargets = this.store.parseNotify(routine);
    const notifyOn = this.store.parseNotifyOn(routine);

    try {
      const result = await this.runner.run({
        routine,
        task,
        computer_name: routine.computer_name,
      });
      const status = result.ok ? "done" : "failed";
      const finished =
        this.store.finishHistory(history.id, {
          status,
          task_id: result.task_id ?? null,
          artifacts: result.artifacts ?? [],
          cost_usd: result.cost_usd ?? null,
          error: result.error ?? null,
          finished_at: this.clock.now(),
        }) ?? history;

      if (status === "failed") {
        await this.applyFatigue(routine, notifyTargets, notifyOn, result.error ?? "failed");
      } else {
        const shouldNotify = notifyOn.includes("done");
        if (shouldNotify && notifyTargets.length) {
          await this.notifyFn(notifyTargets, {
            kind: "task_done",
            title: `ModelBot routine ${status}: ${routine.name}`,
            reason: `Routine ${routine.name} finished with status ${status}`,
            task_id: result.task_id,
          });
        }
      }
      return finished;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finished =
        this.store.finishHistory(history.id, {
          status: "failed",
          error: message,
          finished_at: this.clock.now(),
        }) ?? history;
      await this.applyFatigue(routine, notifyTargets, notifyOn, message);
      return finished;
    } finally {
      this.inFlight.delete(routine.id);
    }
  }

  private async applyFatigue(
    routine: RoutineRow,
    notifyTargets: string[],
    notifyOn: ReturnType<RoutinesStore["parseNotifyOn"]>,
    error: string,
  ): Promise<void> {
    const failures = this.store.consecutiveFailures(routine.id);
    if (notifyOn.includes("fail") && notifyTargets.length) {
      await this.notifyFn(notifyTargets, {
        kind: "routine_fail",
        title: `ModelBot routine failed: ${routine.name}`,
        reason: `Routine ${routine.name} failed: ${error}`,
      });
    }
    if (failures >= FATIGUE_LIMIT) {
      this.store.setEnabled(routine.id, false);
      if (notifyTargets.length) {
        await this.notifyFn(notifyTargets, {
          kind: "routine_fail",
          title: `ModelBot routine disabled: ${routine.name}`,
          reason: FATIGUE_NOTIFY,
        });
      }
    }
  }
}
