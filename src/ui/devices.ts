/**
 * Settings → Devices.
 *
 * Pair a phone with a one-use link that expires in ten minutes, see what is
 * already paired, and take access away again. The link is also drawn as a QR
 * code so a phone can be pointed at the screen instead of retyping 80
 * characters — the encoder below is written out in full so this file adds no
 * dependency and nothing about the link ever leaves this machine.
 *
 * Two safety rules: a link is only ever created by an explicit click, and it is
 * never copied to the clipboard without one. It is cleared from the DOM when it
 * expires and when the pane goes away.
 */

import { apiDelete, apiGet, apiPost } from "./api.ts";
import { appendTextChild } from "./safe.ts";

const REMOTE_GUIDE =
  "https://github.com/sanjaygbhat/bothearth/blob/main/docs/REMOTE-DEPLOY.md";
const PAIRING_TTL_MS = 10 * 60_000;

/*
 * QR code — byte mode, error-correction level M, versions 1-20. ISO/IEC 18004:
 * bit stream, Reed-Solomon over GF(256)/0x11D, block interleaving, function
 * patterns, all eight masks scored by the standard penalty rules. The pieces
 * are exported so they can be tested against the specification's worked example.
 */

/** Error-correction codewords per block, level M, versions 1-20. */
const EC_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];

/** Number of error-correction blocks, level M, versions 1-20. */
const EC_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

const MAX_VERSION = 20;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

/** Multiply two field elements of GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Total data + error-correction codewords a version holds. */
export function totalCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    bits -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

function dataCodewords(version: number): number {
  const blocks = EC_BLOCKS_M[version - 1] as number;
  return totalCodewords(version) - (EC_PER_BLOCK_M[version - 1] as number) * blocks;
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** Smallest version that fits `byteLength` bytes at level M, or 0. */
export function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacity = dataCodewords(version) * 8;
    if (4 + charCountBits(version) + byteLength * 8 <= capacity) return version;
  }
  return 0;
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < degree) result[j] ^= result[j + 1] as number;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((d, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(d, factor);
    });
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const size = version * 4 + 17;
  // Ascending, with the first coordinate pinned at 6: the three corners the
  // finder patterns already own are then exactly (0,0), (0,last) and (last,0).
  const result: number[] = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

type Grid = { size: number; modules: boolean[][]; isFunction: boolean[][] };

function makeGrid(size: number): Grid {
  const row = () => new Array<boolean>(size).fill(false);
  return {
    size,
    modules: Array.from({ length: size }, row),
    isFunction: Array.from({ length: size }, row),
  };
}

function setFunction(grid: Grid, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return;
  (grid.modules[y] as boolean[])[x] = dark;
  (grid.isFunction[y] as boolean[])[x] = true;
}

function drawFormatBits(grid: Grid, mask: number): void {
  // Level M is 0b00; 15 bits with a BCH(15,5) remainder, then the fixed mask.
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  const size = grid.size;
  for (let i = 0; i <= 5; i += 1) setFunction(grid, 8, i, getBit(bits, i));
  setFunction(grid, 8, 7, getBit(bits, 6));
  setFunction(grid, 8, 8, getBit(bits, 7));
  setFunction(grid, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) setFunction(grid, 14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i += 1) setFunction(grid, size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) setFunction(grid, 8, size - 15 + i, getBit(bits, i));
  setFunction(grid, 8, size - 8, true);
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const size = grid.size;
  for (let i = 0; i < size; i += 1) {
    setFunction(grid, 6, i, i % 2 === 0);
    setFunction(grid, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as Array<[number, number]>) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(grid, cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = positions[i] as number;
      const cy = positions[j] as number;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormatBits(grid, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(grid, a, b, bit);
      setFunction(grid, b, a, bit);
    }
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function finderCount(history: number[]): number {
  const n = history[1] as number;
  const core =
    n > 0 &&
    history[2] === n &&
    history[3] === n * 3 &&
    history[4] === n &&
    history[5] === n;
  return (
    (core && (history[0] as number) >= n * 4 && (history[6] as number) >= n ? 1 : 0) +
    (core && (history[6] as number) >= n * 4 && (history[0] as number) >= n ? 1 : 0)
  );
}

function addHistory(size: number, runLength: number, history: number[]): void {
  if (history[0] === 0) runLength += size;
  history.pop();
  history.unshift(runLength);
}

function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let result = 0;
  const scanLine = (get: (i: number) => boolean): void => {
    let runColor = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i += 1) {
      if (get(i) === runColor) {
        run += 1;
        if (run === 5) result += PENALTY_N1;
        else if (run > 5) result += 1;
      } else {
        addHistory(size, run, history);
        if (!runColor) result += finderCount(history) * PENALTY_N3;
        runColor = get(i);
        run = 1;
      }
    }
    if (runColor) {
      addHistory(size, run, history);
      run = 0;
    }
    addHistory(size, run + size, history);
    result += finderCount(history) * PENALTY_N3;
  };
  for (let y = 0; y < size; y += 1) scanLine((x) => (modules[y] as boolean[])[x] as boolean);
  for (let x = 0; x < size; x += 1) scanLine((y) => (modules[y] as boolean[])[x] as boolean);
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = (modules[y] as boolean[])[x];
      if (
        c === (modules[y] as boolean[])[x + 1] &&
        c === (modules[y + 1] as boolean[])[x] &&
        c === (modules[y + 1] as boolean[])[x + 1]
      ) {
        result += PENALTY_N2;
      }
    }
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * PENALTY_N4;
}

/** Encode `text` as a boolean matrix (true = dark). Empty when it will not fit. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const version = chooseVersion(bytes.length);
  if (version === 0) return [];

  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, charCountBits(version));
  for (const byte of bytes) append(byte, 8);

  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] as number);
    data.push(byte);
  }

  const numBlocks = EC_BLOCKS_M[version - 1] as number;
  const blockEccLen = EC_PER_BLOCK_M[version - 1] as number;
  const raw = totalCodewords(version);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const length = shortLen - blockEccLen + (i < shortBlocks ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const interleaved: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - blockEccLen || j >= shortBlocks) interleaved.push(block[i] as number);
    });
  }

  const grid = makeGrid(version * 4 + 17);
  drawFunctionPatterns(grid, version);

  let index = 0;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < grid.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? grid.size - 1 - vert : vert;
        if (!(grid.isFunction[y] as boolean[])[x] && index < interleaved.length * 8) {
          (grid.modules[y] as boolean[])[x] = getBit(
            interleaved[index >>> 3] as number,
            7 - (index & 7),
          );
          index += 1;
        }
      }
    }
  }

  let best = -1;
  let bestScore = Infinity;
  let bestModules: boolean[][] = [];
  for (let mask = 0; mask < 8; mask += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      for (let x = 0; x < grid.size; x += 1) {
        if (!(grid.isFunction[y] as boolean[])[x]) {
          (grid.modules[y] as boolean[])[x] =
            (grid.modules[y] as boolean[])[x] !== maskAt(mask, x, y);
        }
      }
    }
    drawFormatBits(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
      bestModules = grid.modules.map((row) => [...row]);
    }
    // Undo: the mask is its own inverse.
    for (let y = 0; y < grid.size; y += 1) {
      for (let x = 0; x < grid.size; x += 1) {
        if (!(grid.isFunction[y] as boolean[])[x]) {
          (grid.modules[y] as boolean[])[x] =
            (grid.modules[y] as boolean[])[x] !== maskAt(mask, x, y);
        }
      }
    }
  }
  return best >= 0 ? bestModules : [];
}

/**
 * Build an `<svg>` of the code. One `<path>` of square subpaths keeps the node
 * count flat, which matters because this is redrawn on every new link.
 */
function qrSvg(text: string, label: string): SVGSVGElement | null {
  const matrix = qrMatrix(text);
  if (matrix.length === 0) return null;
  const size = matrix.length;
  const quiet = 2;
  const span = size + quiet * 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${span} ${span}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  let d = "";
  for (let y = 0; y < size; y += 1) {
    const row = matrix[y] as boolean[];
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < size && row[x + run]) run += 1;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

type DeviceRow = { id: string; label: string; expires_at: string; current: boolean };

export function countdownLabel(remainingMs: number): string {
  const seconds = Math.max(0, Math.round(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "until 8:00 pm on Sun" — a time a person reads, never a raw timestamp. */
function signedInUntil(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "further notice";
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? `${time} today` : `${time} on ${when.toLocaleDateString(undefined, { weekday: "long" })}`;
}

/** Render the Devices section into `pane`. Returns a disposer. */
export function renderDevices(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", "Devices");
  const lede = appendTextChild(
    pane,
    "p",
    "Your phone can watch a task and take control of BotHearth on this host. Task content and live frames are sent to the paired device over your private connection.",
    "set-lede",
  );

  const actions = document.createElement("div");
  actions.className = "set-actions";
  const issue = document.createElement("button");
  issue.type = "button";
  issue.className = "btn primary";
  issue.textContent = "Connect a phone";
  issue.disabled = true;
  const guide = document.createElement("a");
  guide.className = "btn";
  guide.href = REMOTE_GUIDE;
  guide.target = "_blank";
  guide.rel = "noopener noreferrer";
  guide.textContent = "Show me how";
  guide.hidden = true;
  actions.append(issue, guide);
  pane.append(actions);

  const status = document.createElement("p");
  status.className = "set-msg";
  status.setAttribute("role", "status");
  pane.append(status);

  const pair = document.createElement("div");
  pair.className = "set-pair";
  pair.hidden = true;
  const qrHost = document.createElement("div");
  qrHost.className = "set-qr";
  const pairBody = document.createElement("div");
  pairBody.className = "set-pair-body";
  const pairHead = appendTextChild(pairBody, "p", "", "set-n");
  appendTextChild(
    pairBody,
    "p",
    "It works once, and whoever opens it can drive your bot — send it to nobody else.",
    "set-w",
  );
  const countdown = document.createElement("p");
  countdown.className = "set-w set-countdown";
  const link = document.createElement("textarea");
  link.className = "set-link";
  link.readOnly = true;
  link.setAttribute("aria-label", "One-use link for your phone");
  const copyRow = document.createElement("div");
  copyRow.className = "set-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn sm";
  copy.textContent = "Copy connection link";
  copyRow.append(copy);
  pairBody.append(countdown, link, copyRow);
  pair.append(qrHost, pairBody);
  pane.append(pair);

  const listHead = appendTextChild(pane, "p", "Paired now", "caps");
  const list = document.createElement("div");
  list.className = "set-rows";
  pane.append(list);

  let expiry: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let issuing = false;
  let expiresAt = 0;

  const clearLink = () => {
    clearTimeout(expiry);
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    expiresAt = 0;
    link.value = "";
    qrHost.replaceChildren();
    pair.hidden = true;
  };

  const fail = (error: unknown) => {
    if (!live()) return;
    status.dataset.tone = "danger";
    status.textContent =
      error instanceof Error
        ? error.message
        : "That did not go through. Check your connection and try again.";
  };

  const tick = () => {
    if (!live() || expiresAt === 0) return;
    countdown.textContent = `Expires in ${countdownLabel(expiresAt - Date.now())} · one use only`;
  };

  const refresh = async (): Promise<void> => {
    const [session, inventory] = await Promise.all([
      apiGet("/api/v1/session") as Promise<{ public_origin?: string | null; origin?: string | null }>,
      apiGet("/api/v1/session/devices") as Promise<{ devices?: DeviceRow[] }>,
    ]);
    if (!live()) return;
    const remote = session.public_origin ?? session.origin ?? location.origin ?? "";
    const reachable = remote.startsWith("https://");
    issue.disabled = !reachable;
    guide.hidden = reachable;
    lede.textContent = reachable
      ? "Your phone can watch a task and take control of BotHearth on this host. Task content and live frames are sent to the paired device over your private connection."
      : "Your phone needs a private HTTPS address to reach this Mac. A link that only works on this computer will not open on a phone — set one up first, then come back.";

    list.replaceChildren();
    const devices = inventory.devices ?? [];
    if (devices.length === 0) {
      appendTextChild(list, "p", "Nothing paired yet.", "set-note");
    }
    for (const device of devices) {
      const row = document.createElement("div");
      row.className = "set-row";
      const text = document.createElement("div");
      text.className = "set-grow";
      appendTextChild(text, "span", device.current ? `${device.label} · this one` : device.label, "set-n");
      appendTextChild(text, "span", `Signed in until ${signedInUntil(device.expires_at)}`, "set-w");
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = device.current ? "btn sm" : "btn sm danger";
      revoke.textContent = device.current ? "Sign out on this device" : "Revoke access";
      revoke.addEventListener("click", () => {
        if (revoke.disabled) return;
        revoke.disabled = true;
        void (async () => {
          if (device.current) {
            await apiPost("/api/v1/session/logout");
            clearLink();
            if (live()) location.reload();
            return;
          }
          await apiDelete(`/api/v1/session/devices/${encodeURIComponent(device.id)}`);
          if (!live()) return;
          await refresh();
          if (!live()) return;
          status.dataset.tone = "ok";
          status.textContent = "That device can no longer reach ModelBot. Your tasks are untouched.";
        })().catch((error) => {
          fail(error);
          if (live()) revoke.disabled = false;
        });
      });
      row.append(text, revoke);
      list.append(row);
    }
    listHead.hidden = false;
    if (!status.textContent) status.textContent = "";
  };

  issue.addEventListener("click", () => {
    if (issuing || issue.disabled) return;
    issuing = true;
    issue.disabled = true;
    clearLink();
    return void (async () => {
      try {
        const invitation = (await apiPost("/api/v1/session/pairings")) as {
          url: string;
          expires_at: string;
        };
        if (!live()) return;
        const url = new URL(invitation.url);
        const remaining = Date.parse(invitation.expires_at) - Date.now();
        if (url.protocol !== "https:" || remaining <= 0 || remaining > PAIRING_TTL_MS + 1000) {
          throw new Error(
            "That link cannot be made right now. Give this Mac a private HTTPS address, then try again.",
          );
        }
        link.value = url.href;
        expiresAt = Date.now() + remaining;
        pairHead.textContent = "Point your phone’s camera at this";
        const svg = qrSvg(url.href, "Scan this with your phone to pair it");
        qrHost.replaceChildren();
        if (svg) qrHost.append(svg);
        qrHost.hidden = !svg;
        pair.hidden = false;
        tick();
        ticker = setInterval(tick, 1000);
        status.textContent = "";
        expiry = setTimeout(() => {
          clearLink();
          if (!live()) return;
          status.dataset.tone = "warn";
          status.textContent = "That link expired. Make a new one when your phone is ready.";
        }, remaining);
      } catch (error) {
        fail(error);
      } finally {
        issuing = false;
        if (live()) issue.disabled = false;
      }
    })();
  });

  copy.addEventListener("click", () => {
    if (!link.value) return;
    return void (async () => {
      try {
        await navigator.clipboard.writeText(link.value);
        if (!live()) return;
        status.dataset.tone = "ok";
        status.textContent = "Link copied. Send it only to your own phone.";
      } catch {
        if (!live()) return;
        link.focus();
        link.select();
        status.dataset.tone = "warn";
        status.textContent = "Copying is blocked here. The link is selected — copy it by hand.";
      }
    })();
  });

  void refresh().catch(fail);

  return () => {
    disposed = true;
    clearLink();
  };
}
