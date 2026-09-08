import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseVersion,
  countdownLabel,
  gfMultiply,
  qrMatrix,
  rsDivisor,
  rsRemainder,
  totalCodewords,
} from "../../../src/ui/devices.ts";

/* ---------------------------------------------------------------------------
   An independent reader, written from the specification rather than from the
   encoder, so a round trip is real evidence and not the encoder agreeing with
   itself. It rebuilds the function-module map, lifts the mask, walks the
   zigzag, de-interleaves the blocks and parses the byte-mode segment back.
   ------------------------------------------------------------------------ */

const EC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const EC_BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

function maskAt(mask: number, x: number, y: number): boolean {
  const rules = [
    () => (x + y) % 2 === 0,
    () => y % 2 === 0,
    () => x % 3 === 0,
    () => (x + y) % 3 === 0,
    () => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    () => ((x * y) % 2) + ((x * y) % 3) === 0,
    () => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    () => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  return (rules[mask] as () => boolean)();
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const size = version * 4 + 17;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

function functionMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) (map[y] as boolean[])[x] = true;
  };
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as Array<[number, number]>) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
  }
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark((pos[i] as number) + dx, (pos[j] as number) + dy);
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return map;
}

/** Read the first copy of the 15 format bits and check its BCH remainder. */
function readFormat(m: boolean[][]): { ecl: number; mask: number } {
  const bit = (x: number, y: number) => ((m[y] as boolean[])[x] ? 1 : 0);
  let bits = 0;
  const order: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) order.push([8, i]);
  order.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i += 1) order.push([14 - i, 8]);
  order.forEach(([x, y], i) => {
    bits |= bit(x as number, y as number) << i;
  });
  const raw = bits ^ 0x5412;
  const data = (raw >>> 10) & 0x1f;
  let rem = raw;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  assert.equal(rem & 0x3ff, 0, "the format information carries a valid BCH remainder");
  return { ecl: data >>> 3, mask: data & 7 };
}

function decode(matrix: boolean[][]): string {
  const size = matrix.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1, "a QR side is 4v+17 modules");
  const { ecl, mask } = readFormat(matrix);
  assert.equal(ecl, 0, "level M");

  const isFn = functionMap(version);
  const m = matrix.map((row, y) =>
    row.map((cell, x) => ((isFn[y] as boolean[])[x] ? cell : cell !== maskAt(mask, x, y))),
  );

  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!(isFn[y] as boolean[])[x]) bits.push((m[y] as boolean[])[x] ? 1 : 0);
      }
    }
  }
  const stream: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] as number);
    stream.push(byte);
  }

  const numBlocks = EC_BLOCKS_M[version - 1] as number;
  const ecc = EC_PER_BLOCK_M[version - 1] as number;
  const raw = totalCodewords(version);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let cursor = 0;
  for (let i = 0; i <= shortLen; i += 1) {
    for (let j = 0; j < numBlocks; j += 1) {
      if (i === shortLen - ecc && j < shortBlocks) continue;
      (blocks[j] as number[])[i] = stream[cursor] as number;
      cursor += 1;
    }
  }
  const data: number[] = [];
  for (let j = 0; j < numBlocks; j += 1) {
    const length = shortLen - ecc + (j < shortBlocks ? 0 : 1);
    data.push(...(blocks[j] as number[]).slice(0, length));
  }

  const read = (start: number, count: number) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const index = start + i;
      value = (value << 1) | (((data[index >> 3] as number) >> (7 - (index & 7))) & 1);
    }
    return value;
  };
  assert.equal(read(0, 4), 0b0100, "byte mode");
  const countBits = version < 10 ? 8 : 16;
  const length = read(4, countBits);
  const bytes: number[] = [];
  for (let i = 0; i < length; i += 1) bytes.push(read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/* ------------------------------------------------------------------------ */

test("Reed-Solomon matches the worked example in ISO/IEC 18004", () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(
    rsRemainder(data, rsDivisor(10)),
    [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
  );
  // GF(256) sanity: 2 is a generator, and multiplication is commutative.
  assert.equal(gfMultiply(0, 0xff), 0);
  assert.equal(gfMultiply(1, 0x53), 0x53);
  assert.equal(gfMultiply(0x57, 0x83), gfMultiply(0x83, 0x57));
});

test("codeword capacity matches the published tables", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 10, 20].map(totalCodewords),
    [26, 44, 70, 100, 134, 172, 196, 346, 1085],
  );
  assert.equal(chooseVersion(1), 1);
  assert.equal(chooseVersion(14), 1, "a version 1 code at level M holds 14 bytes");
  assert.equal(chooseVersion(15), 2);
  assert.equal(chooseVersion(100_000), 0, "too long returns nothing rather than a broken code");
});

test("a pairing link survives an encode and an independent decode", () => {
  const samples = [
    "https://fixture.example/#bootstrap=uZ4v1Qk9",
    "https://modelbot.fixture.example/#bootstrap=" + "a".repeat(43),
    "https://a-rather-long-private-address.example.org/#bootstrap=" + "Zx9-_".repeat(12),
    "ModelBot",
  ];
  for (const sample of samples) {
    const matrix = qrMatrix(sample);
    assert.ok(matrix.length > 0, `encodes ${sample.length} bytes`);
    assert.equal(decode(matrix), sample);
  }
});

test("the finder, separator and timing patterns are where a scanner looks for them", () => {
  const matrix = qrMatrix("https://fixture.example/#bootstrap=uZ4v1Qk9");
  const size = matrix.length;
  const at = (x: number, y: number) => (matrix[y] as boolean[])[x];
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as Array<[number, number]>) {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(at(ox + dx, oy + dy), ring !== 2, `finder at ${ox},${oy}`);
      }
    }
  }
  // Separators: the light ring around each finder.
  for (let i = 0; i < 8; i += 1) {
    assert.equal(at(7, i), false);
    assert.equal(at(i, 7), false);
  }
  // Timing patterns alternate, starting dark at module 8.
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(at(i, 6), i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(at(6, i), i % 2 === 0, `vertical timing at ${i}`);
  }
  assert.equal(at(8, size - 8), true, "the always-dark module is set");
});

test("the ten-minute countdown reads as a clock and never goes negative", () => {
  assert.equal(countdownLabel(10 * 60_000), "10:00");
  assert.equal(countdownLabel(9 * 60_000 + 5_000), "9:05");
  assert.equal(countdownLabel(59_000), "0:59");
  assert.equal(countdownLabel(0), "0:00");
  assert.equal(countdownLabel(-5_000), "0:00");
});
