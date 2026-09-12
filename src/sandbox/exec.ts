/**
 * execTransport — long-lived `docker exec -i` stdio JSON-RPC client.
 */

import { createJsonRpcClient, type JsonRpcClient } from "./client.ts";
import { detectRuntime } from "./detect.ts";
import { createDockerCli, type DockerCli } from "./docker.ts";
import { execStdioArgs } from "./flags.ts";
import {
  containerForRole,
  sanitizeComputerName,
  type ComputerRole,
} from "./names.ts";

export const DEFAULT_COMPUTER_SERVER_ENTRY = [
  "node",
  "/opt/computer-server/stdio.js",
] as const;

/** Minimal length-prefixed JSON-RPC ping echo (when computer-server absent). */
export const PING_ECHO_NODE = [
  "node",
  "-e",
  `const{stdin,stdout}=process;let b=Buffer.alloc(0);stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){if(b.length<4)break;const n=b.readUInt32BE(0);if(b.length<4+n)break;const body=b.subarray(4,4+n);b=b.subarray(4+n);if(body[0]!==0)continue;const msg=JSON.parse(body.subarray(1).toString());if(msg.method==='ping'){const res=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{ok:true,pong:true}}));const out=Buffer.alloc(5+res.length);out.writeUInt32BE(1+res.length,0);out[4]=0;res.copy(out,5);stdout.write(out);}}});`,
  "--",
] as const;

export interface ExecTransportOpts {
  onLiveFrame?: Parameters<typeof createJsonRpcClient>[3];
  onNotification?: Parameters<typeof createJsonRpcClient>[4];
  cli?: DockerCli;
  entry?: string[];
}

export async function execTransport(
  name: string,
  role: ComputerRole,
  opts: ExecTransportOpts = {},
): Promise<JsonRpcClient> {
  const n = sanitizeComputerName(name);
  const entry = [...(opts.entry ?? DEFAULT_COMPUTER_SERVER_ENTRY), "--role", role];
  const container = containerForRole(n, role);
  const cli = opts.cli ?? createDockerCli(await detectRuntime());
  const child = cli.spawn(execStdioArgs(container, entry));
  if (!child.stdin || !child.stdout) {
    throw new Error("failed to spawn docker exec stdio");
  }
  return createJsonRpcClient(child.stdin, child.stdout, child, opts.onLiveFrame, opts.onNotification);
}
