/**
 * Store-only ZIP (method 0). Node's zlib has CRC but no zip container.
 * One file in memory at a time; the caller streams from the workspace.
 */
import { crc32 } from "node:zlib";

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

function u32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0);
  return buf;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const UTF8 = 1 << 11;

export type ZipEntry = { name: string; data: Uint8Array };

/** Pack listed files into a store-only zip. Entry names must already be relative. */
export function zipStore(files: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const size = data.length;
    const local = Buffer.concat([
      u32(LOCAL),
      u16(20),
      u16(UTF8),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    centrals.push(Buffer.concat([
      u32(CENTRAL),
      u16(20),
      u16(20),
      u16(UTF8),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    central,
    u32(EOCD),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
}
