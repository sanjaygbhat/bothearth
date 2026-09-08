#!/usr/bin/env node
/** modelbot Herdr action: status — JSON snapshot of computers/tasks/takeovers/approvals */
import { openSession } from "../lib/client.mjs";

const { api } = await openSession();
const [computers, tasks, takeovers, approvals] = await Promise.all([
  api("/api/v1/computers"),
  api("/api/v1/tasks"),
  api("/api/v1/takeovers").catch((e) => ({ takeovers: [], _error: String(e.message) })),
  api("/api/v1/approvals"),
]);
console.log(
  JSON.stringify(
    {
      computers: computers.computers ?? computers,
      tasks: tasks.tasks ?? tasks,
      takeovers: takeovers.takeovers ?? takeovers,
      approvals: approvals.approvals ?? approvals,
    },
    null,
    2,
  ),
);
