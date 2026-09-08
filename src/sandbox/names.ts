/** Container / network / volume naming for one computer. */
export function sanitizeComputerName(name: string): string {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!n || n.length > 48) {
    throw new Error(`invalid computer name: ${JSON.stringify(name)}`);
  }
  return n;
}

export function resourceNames(name: string) {
  const n = sanitizeComputerName(name);
  return {
    name: n,
    label: "modelbot.computer",
    labelValue: n,
    networkInternal: `modelbot-${n}-internal`,
    networkEgress: `modelbot-${n}-egress`,
    volumeProfile: `modelbot-${n}-profile`,
    containerBrowser: `modelbot-${n}-browser`,
    containerShell: `modelbot-${n}-shell`,
    containerProxy: `modelbot-${n}-proxy`,
  } as const;
}

export type ComputerRole = "browser" | "shell";

export function containerForRole(name: string, role: ComputerRole): string {
  const r = resourceNames(name);
  return role === "browser" ? r.containerBrowser : r.containerShell;
}
