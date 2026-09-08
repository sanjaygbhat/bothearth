#!/usr/bin/env node
/**
 * modelbot Herdr action: computer-open — print (and open) UI bootstrap URL.
 * Uses MODELBOT_BOOTSTRAP_TOKEN; does not consume the token server-side.
 */
import { spawn } from "node:child_process";
import { bootstrapUrl, baseUrl } from "../lib/client.mjs";

const url = bootstrapUrl(baseUrl());
console.log(url);

const noOpen = process.argv.includes("--no-open");
if (!noOpen && process.platform === "darwin") {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
} else if (!noOpen && process.platform === "linux") {
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}
