/** Match origin/host against patterns: exact host, `*.example.com`, or full origin/URL. */
export function originMatchesPattern(originOrHost: string, pattern: string): boolean {
  let host: string;
  let pathHave = "/";
  let protocol = "";
  let port = "";
  try {
    if (originOrHost.includes("://")) {
      const u = new URL(originOrHost);
      host = u.hostname.toLowerCase();
      pathHave = u.pathname || "/";
      protocol = u.protocol;
      port = u.port;
    } else {
      host = originOrHost.toLowerCase().replace(/\/.*$/, "");
    }
  } catch {
    host = originOrHost.toLowerCase();
  }

  const p = pattern.toLowerCase();

  // Full origin/URL pattern — do not split on the `://` slashes.
  if (p.includes("://")) {
    try {
      const u = new URL(pattern);
      const hostPat = u.hostname.toLowerCase();
      const pathWant = u.pathname || "/";
      if (protocol !== u.protocol || port !== u.port) return false;
      if (!hostMatches(host, hostPat)) return false;
      if (pathWant === "/") return true;
      return pathHave === pathWant || pathHave.startsWith(pathWant.endsWith("/") ? pathWant : `${pathWant}/`);
    } catch {
      return false;
    }
  }

  // host/path pattern: `example.com/app`
  if (p.includes("/")) {
    const [hostPat, ...pathParts] = p.split("/");
    const pathWant = "/" + pathParts.join("/");
    if (!hostMatches(host, hostPat!)) return false;
    if (pathWant === "/") return true;
    return pathHave === pathWant || pathHave.startsWith(pathWant + "/");
  }

  return hostMatches(host, p);
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    const base = pattern.slice(2);
    return host === base || host.endsWith(suffix);
  }
  return host === pattern;
}
