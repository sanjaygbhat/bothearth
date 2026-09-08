#!/usr/bin/env node
/**
 * modelbot Herdr action: takeover-open — print bootstrap URL for a pending takeover's live view.
 */
import { spawn } from "node:child_process";
import { openSession, bootstrapUrl, baseUrl } from "../lib/client.mjs";

const argv = process.argv.slice(2);
const noOpen = argv.includes("--no-open");
const { api } = await openSession();

let takeovers = [];
try {
  const body = await api("/api/v1/takeovers");
  takeovers = body.takeovers ?? [];
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}

const pending = takeovers.filter((t) =>
  /^(takeover_requested|human)$/i.test(String(t.state ?? "")),
);
const pick =
  pending[0] ??
  takeovers.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

const boot = bootstrapUrl(baseUrl());
if (!pick) {
  console.log(boot);
  console.error("no takeover requests; opened/printed UI bootstrap URL");
  process.exit(0);
}

const live = `${boot}#/live/${encodeURIComponent(pick.computer_id)}`;
console.log(
  JSON.stringify(
    {
      url: live,
      takeover_id: pick.id,
      computer_id: pick.computer_id,
      state: pick.state,
    },
    null,
    2,
  ),
);

if (!noOpen && process.platform === "darwin") {
  spawn("open", [live], { stdio: "ignore", detached: true }).unref();
} else if (!noOpen && process.platform === "linux") {
  spawn("xdg-open", [live], { stdio: "ignore", detached: true }).unref();
}
