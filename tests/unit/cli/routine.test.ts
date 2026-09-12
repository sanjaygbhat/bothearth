/**
 * `modelbot routine run` POSTs `/api/v1/routines/:id/run` on the daemon.
 * It must not insert a local `skipped` history row or call `task create|wait`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runRoutineCli } from "../../../src/cli/routine.ts";
import { RoutinesStore } from "../../../src/scheduler/store.ts";

const STANDALONE_503 =
  "Routines require a configured standalone provider. Codex tasks can be started from the workspace.";

interface Hit {
  method: string;
  url: string;
  cookie?: string;
  csrf?: string;
}

function seedRoutine(db: string): { id: string; name: string } {
  const store = new RoutinesStore(db);
  const created = store.create({
    name: "daily",
    cron: "0 9 * * 1",
    computer_name: "office",
    task: { goal: "review inbox", capabilities: ["browser"] },
  });
  store.close();
  return { id: created.id, name: created.name };
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, hits: Hit[]) => void,
): Promise<{ base: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      cookie: req.headers.cookie,
      csrf: req.headers["x-csrf-token"] as string | undefined,
    });
    handler(req, res, hits);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    hits,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function captureStdio(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = log;
      console.error = error;
    },
  };
}

function interceptExit(): { codes: number[]; restore: () => void } {
  const codes: number[] = [];
  const orig = process.exit;
  process.exit = ((code?: number) => {
    codes.push(code ?? 0);
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  return {
    codes,
    restore: () => {
      process.exit = orig;
    },
  };
}

const saved: Record<string, string | undefined> = {};
const ENV = ["MODELBOT_BASE_URL", "MODELBOT_ENDPOINT", "MODELBOT_BOOTSTRAP_TOKEN"] as const;

function setEnv(base: string, token = "boot-token"): void {
  for (const key of ENV) {
    saved[key] = process.env[key];
  }
  process.env.MODELBOT_BASE_URL = base;
  delete process.env.MODELBOT_ENDPOINT;
  process.env.MODELBOT_BOOTSTRAP_TOKEN = token;
}

function restoreEnv(): void {
  for (const key of ENV) {
    const prev = saved[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

afterEach(restoreEnv);

describe("routine run hits the daemon", () => {
  it("POSTs /api/v1/routines/:id/run and prints task_id and history", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mb-routine-run-")), "modelbot.sqlite");
    const routine = seedRoutine(db);
    const mock = await listen((req, res) => {
      if (req.url === "/api/v1/session/bootstrap" && req.method === "POST") {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "modelbot_session=sess; Path=/; HttpOnly",
        });
        res.end(JSON.stringify({ csrf: "csrf-token" }));
        return;
      }
      if (req.url === `/api/v1/routines/${routine.id}/run` && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            history: {
              id: "hist_ok",
              routine_id: routine.id,
              status: "done",
              task_id: "task_abc",
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    setEnv(mock.base);
    const io = captureStdio();
    try {
      await runRoutineCli(["run", routine.name, "--db", db]);
    } finally {
      io.restore();
      await mock.close();
    }
    assert.match(io.lines.join("\n"), /task_id=task_abc/);
    assert.match(io.lines.join("\n"), /status=done/);
    assert.match(io.lines.join("\n"), /history=hist_ok/);
    assert.equal(
      mock.hits.some((h) => h.method === "POST" && h.url === `/api/v1/routines/${routine.id}/run`),
      true,
    );
    assert.equal(
      mock.hits.some((h) => /\/api\/v1\/tasks/.test(h.url)),
      false,
    );
    const store = new RoutinesStore(db);
    try {
      assert.equal(store.listHistory(routine.id).length, 0);
      assert.equal(
        store.listHistory(routine.id).some((h) => h.status === "skipped"),
        false,
      );
    } finally {
      store.close();
    }
  });

  it("prints the 503 standalone message and does not fake a task", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mb-routine-503-")), "modelbot.sqlite");
    const routine = seedRoutine(db);
    const mock = await listen((req, res) => {
      if (req.url === "/api/v1/session/bootstrap" && req.method === "POST") {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "modelbot_session=sess; Path=/; HttpOnly",
        });
        res.end(JSON.stringify({ csrf: "csrf-token" }));
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/run")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "E_CAPABILITY", message: STANDALONE_503 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    setEnv(mock.base);
    const io = captureStdio();
    const exit = interceptExit();
    try {
      await runRoutineCli(["run", routine.id, "--db", db]);
      assert.fail("routine run should exit on 503");
    } catch (err) {
      assert.match(String(err), /process\.exit\(1\)/);
    } finally {
      exit.restore();
      io.restore();
      await mock.close();
    }
    assert.deepEqual(exit.codes, [1]);
    assert.equal(io.lines.includes(STANDALONE_503), true);
    assert.equal(
      mock.hits.some((h) => /\/api\/v1\/tasks/.test(h.url)),
      false,
    );
    const store = new RoutinesStore(db);
    try {
      assert.equal(store.listHistory(routine.id).length, 0);
    } finally {
      store.close();
    }
  });
});
