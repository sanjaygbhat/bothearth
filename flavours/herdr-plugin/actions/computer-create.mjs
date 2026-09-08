#!/usr/bin/env node
/** modelbot Herdr action: computer-create — POST /api/v1/computers */
import { openSession } from "../lib/client.mjs";

const argv = process.argv.slice(2);
let name = "herdr";
const nameFlag = argv.indexOf("--name");
if (nameFlag >= 0 && argv[nameFlag + 1]) name = argv[nameFlag + 1];
else if (argv[0] && !argv[0].startsWith("-")) name = argv[0];

const capsFlag = argv.indexOf("--capabilities");
const capabilities =
  capsFlag >= 0 && argv[capsFlag + 1]
    ? argv[capsFlag + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : ["browser", "shell"];

const { api } = await openSession();
const out = await api("/api/v1/computers", {
  method: "POST",
  body: { name, capabilities, persistent: argv.includes("--persistent") },
});
console.log(JSON.stringify(out, null, 2));
