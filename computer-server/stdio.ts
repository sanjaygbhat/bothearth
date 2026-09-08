/** computer-server entry. Role selected by `--role browser|shell`. */
import { runStdioServer } from "./src/rpc-loop.ts";

const roleArg = process.argv.find((a) => a.startsWith("--role"));
let role: "browser" | "shell" = "browser";
if (roleArg?.includes("=")) {
  role = roleArg.split("=")[1] === "shell" ? "shell" : "browser";
} else {
  const idx = process.argv.indexOf("--role");
  if (idx >= 0 && process.argv[idx + 1] === "shell") role = "shell";
}

await runStdioServer(role);
