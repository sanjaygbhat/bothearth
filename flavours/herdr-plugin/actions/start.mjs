#!/usr/bin/env node
/** modelbot Herdr action: start — POST /api/v1/computers/:id/start */
import { openSession, resolveComputerId } from "../lib/client.mjs";

const argv = process.argv.slice(2);
const { api } = await openSession();
const id = await resolveComputerId(api, argv);
const out = await api(`/api/v1/computers/${encodeURIComponent(id)}/start`, {
  method: "POST",
  body: {},
});
console.log(JSON.stringify({ computer_id: id, ...out }, null, 2));
