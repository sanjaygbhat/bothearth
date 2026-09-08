/**
 * Inline SVG glyphs, built node by node — never `innerHTML` — so no string from
 * the daemon, a tool or a website can reach the parser.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS: Record<string, string[]> = {
  /** A sheet of paper with a folded corner — a file or a note. */
  file: [
    "M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z",
    "M14.5 3.7V8h4.2M9 12.5h6M9 16h4",
  ],
  /** A hand — take control. */
  hand: [
    "M8.5 11V5.6a1.6 1.6 0 0 1 3.2 0V11m0-1.2a1.6 1.6 0 0 1 3.2 0V11m0-.6a1.6 1.6 0 0 1 3.2 0v4.2a6 6 0 0 1-6 6h-.9a5 5 0 0 1-3.8-1.8l-2.6-3.1a1.6 1.6 0 0 1 2.3-2.2l1.4 1.3",
  ],
  /** A globe — a site out on the internet. */
  globe: ["M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Z", "M3.4 12h17.2M12 3.2c4.6 5 4.6 12.6 0 17.6-4.6-5-4.6-12.6 0-17.6"],
  /** A laptop — this Mac. */
  laptop: ["M5 6.5h14v9H5z", "M2.8 18.5h18.4"],
  /** A tick in a ring — done. */
  check: ["M7.8 12.3 10.7 15.2 16.4 9.4"],
};

export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name] ?? PATHS.file!) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** The done check: a ring that is already drawn, plus a tick that draws in. */
export function checkMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "check");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "9.5");
  const tick = document.createElementNS(SVG_NS, "path");
  tick.setAttribute("d", PATHS.check![0]!);
  svg.append(circle, tick);
  return svg;
}
