import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SESSION_MAX_LIFETIME_MS,
  SESSION_TTL_MS,
  sessionCookieHeader,
} from "../../../src/daemon/auth.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

test("a session outlives the daemon that issued it", async () => {
  const root = mkdtempSync(join(tmpdir(), "modelbot-session-restart-"));
  const sqlitePath = join(root, "state.sqlite");
  const opts = {
    host: "127.0.0.1",
    mcpToken: "session-mcp",
    bootstrapToken: "session-boot",
    workspaceRoot: root,
    sqlitePath,
  };
  let daemon = await startDaemon({ ...opts, port: 0 });
  const port = daemon.port;
  try {
    const { headers } = await bootstrapSession(daemon, "session-boot");
    await daemon.close();
    // Same database, same port: the browser tab the owner left open sends the
    // same cookie, and must not be sent back to `modelbot pair`.
    daemon = await startDaemon({ ...opts, port });
    const res = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers });
    assert.equal(res.status, 200, "a restart invalidated a live session");
    assert.equal((await res.json() as { ok: boolean }).ok, true);
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a browser left alone for a day does not have to pair again", () => {
  const root = mkdtempSync(join(tmpdir(), "modelbot-session-idle-"));
  const store = new Store(join(root, "state.sqlite"));
  try {
    const session = store.createSession();
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    store.db.prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE id = ?")
      .run(yesterday, new Date(Date.parse(yesterday) + SESSION_TTL_MS).toISOString(), session.id);
    assert.ok(store.getSession(session.id),
      "a day of not touching the tab sent the owner back to `modelbot pair`");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session cookie survives a closed browser", () => {
  const header = sessionCookieHeader("sid");
  assert.match(header, /Max-Age=2592000/, "a browser-session cookie dies with the window");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
});

test("activity slides the session window, and the absolute cap stops it", () => {
  const root = mkdtempSync(join(tmpdir(), "modelbot-session-slide-"));
  const store = new Store(join(root, "state.sqlite"));
  try {
    const session = store.createSession();
    const first = Date.parse(session.expires_at);

    // Nothing to gain from a write per poll: a renewal inside the same minute
    // leaves the row alone.
    assert.equal(store.touchSession(session.id)!.expires_at, session.expires_at);

    const later = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const slid = store.touchSession(session.id, later)!;
    assert.equal(Date.parse(slid.expires_at), Date.parse(later) + SESSION_TTL_MS,
      "an authenticated request did not renew the session");
    assert.ok(Date.parse(slid.expires_at) > first);
    assert.equal(store.getSession(session.id)!.expires_at, slid.expires_at, "the renewal was not durable");

    // A session paired a month ago, still in use: sliding may not carry it past
    // its cap, so it gets the last hour of its life and no more.
    const old = store.createSession();
    const born = new Date(Date.now() - SESSION_MAX_LIFETIME_MS + 60 * 60_000).toISOString();
    store.db.prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE id = ?")
      .run(born, new Date(Date.now() + 120_000).toISOString(), old.id);
    const capped = store.touchSession(old.id)!;
    assert.equal(Date.parse(capped.expires_at), Date.parse(born) + SESSION_MAX_LIFETIME_MS,
      "sliding pushed a session past its absolute cap");
    assert.ok(Date.parse(capped.expires_at) < Date.now() + SESSION_TTL_MS);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
