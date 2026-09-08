/**
 * Daemon integration for routines (routes + scheduler loop).
 * Core logic lives in src/scheduler/** (ARCHITECTURE §2).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComputerCapability } from "../types/contracts.ts";
import {
  createNotifyFanout,
  type NotifyPayload,
} from "../notify/index.ts";
import {
  RoutinesStore,
  Scheduler,
  type CreateRoutineInput,
  type FireResult,
  type RoutineTaskTemplate,
} from "../scheduler/index.ts";
import type { Store } from "./store.ts";
import { writeJson } from "./ws.ts";

type RoutinesNotifyFn = (
  targets: string[],
  payload: NotifyPayload,
) => Promise<unknown>;

export interface RoutinesDaemonDeps {
  store: Store;
  createTask: (input: {
    computer_id: string;
    goal: string;
    capabilities?: ComputerCapability[];
    max_steps?: number;
    adapter?: string;
    origins?: string[];
  }) => Promise<FireResult>;
  notifyTargetsDefault?: string[];
  notifyFn?: RoutinesNotifyFn;
  clock?: { now(): Date };
  intervalMs?: number;
}

export interface RoutinesHandle {
  routines: RoutinesStore;
  scheduler: Scheduler;
  handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    readBody: () => Promise<string>,
  ): Promise<boolean>;
  stop(): void;
}

function parseTaskBody(raw: unknown): RoutineTaskTemplate {
  if (!raw || typeof raw !== "object") {
    throw new Error("task required");
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.goal !== "string" || !t.goal.trim()) {
    throw new Error("task.goal required");
  }
  const caps = Array.isArray(t.capabilities)
    ? (t.capabilities as ComputerCapability[])
    : (["browser"] as ComputerCapability[]);
  const origins = Array.isArray(t.origins)
    ? (t.origins as string[]).filter((x) => typeof x === "string")
    : undefined;
  return {
    goal: t.goal,
    capabilities: caps,
    origins,
    max_steps: typeof t.max_steps === "number" ? t.max_steps : undefined,
    adapter: typeof t.adapter === "string" ? t.adapter : undefined,
  };
}

async function defaultNotify(
  targets: string[],
  payload: NotifyPayload,
): Promise<void> {
  if (!targets.length) return;
  await createNotifyFanout(targets).send(payload);
}

export function startRoutines(deps: RoutinesDaemonDeps): RoutinesHandle {
  const routines = new RoutinesStore(deps.store.db);
  const notifyFn = deps.notifyFn ?? defaultNotify;

  const scheduler = new Scheduler({
    store: routines,
    clock: deps.clock,
    intervalMs: deps.intervalMs,
    notifyFn,
    runner: {
      async run({ task, computer_name }): Promise<FireResult> {
        const computers = deps.store.listComputers();
        const computer =
          computers.find((c) => c.name === computer_name) ??
          computers.find((c) => c.id === computer_name);
        if (!computer) {
          return { ok: false, error: `computer not found: ${computer_name}` };
        }
        try {
          return await deps.createTask({
            computer_id: computer.id,
            goal: task.goal,
            capabilities: task.capabilities,
            max_steps: task.max_steps,
            adapter: task.adapter,
            origins: task.origins,
          });
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
  });
  scheduler.start();

  async function handleApi(
    _req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    readBody: () => Promise<string>,
  ): Promise<boolean> {
    if (path === "/api/v1/routines" && method === "GET") {
      writeJson(res, 200, {
        routines: routines.list().map((r) => routines.toPublic(r)),
      });
      return true;
    }

    if (path === "/api/v1/routines" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody()) as Record<string, unknown>;
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return true;
      }
      try {
        if (typeof body.name !== "string" || !body.name.trim()) {
          writeJson(res, 400, { error: "E_IO", message: "name required" });
          return true;
        }
        if (typeof body.cron !== "string") {
          writeJson(res, 400, { error: "E_IO", message: "cron required" });
          return true;
        }
        if (
          typeof body.computer_name !== "string" ||
          !body.computer_name.trim()
        ) {
          writeJson(res, 400, {
            error: "E_IO",
            message: "computer_name required",
          });
          return true;
        }
        const input: CreateRoutineInput = {
          name: body.name.trim(),
          cron: body.cron,
          computer_name: body.computer_name.trim(),
          task: parseTaskBody(body.task ?? { goal: body.goal }),
          notify: Array.isArray(body.notify)
            ? (body.notify as string[])
            : deps.notifyTargetsDefault,
          notify_on: Array.isArray(body.notify_on)
            ? (body.notify_on as CreateRoutineInput["notify_on"])
            : ["fail"],
          enabled: body.enabled !== false,
        };
        const created = routines.create(input);
        writeJson(res, 201, { routine: routines.toPublic(created) });
      } catch (err) {
        writeJson(res, 400, {
          error: "E_IO",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    const runMatch = /^\/api\/v1\/routines\/([^/]+)\/run$/.exec(path);
    if (runMatch && method === "POST") {
      const id = decodeURIComponent(runMatch[1]!);
      try {
        const history = await scheduler.runNow(id);
        writeJson(res, 200, { history: routines.historyPublic(history) });
      } catch (err) {
        writeJson(res, 404, {
          error: "not_found",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    const histMatch = /^\/api\/v1\/routines\/([^/]+)\/history$/.exec(path);
    if (histMatch && method === "GET") {
      const id = decodeURIComponent(histMatch[1]!);
      if (!routines.get(id)) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, {
        history: routines
          .listHistory(id)
          .map((h) => routines.historyPublic(h)),
      });
      return true;
    }

    const oneMatch = /^\/api\/v1\/routines\/([^/]+)$/.exec(path);
    if (oneMatch && method === "GET") {
      const id = decodeURIComponent(oneMatch[1]!);
      const r = routines.get(id);
      if (!r) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { routine: routines.toPublic(r) });
      return true;
    }

    if (oneMatch && method === "DELETE") {
      const id = decodeURIComponent(oneMatch[1]!);
      if (!routines.remove(id)) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return {
    routines,
    scheduler,
    handleApi,
    stop() {
      scheduler.stop();
    },
  };
}
