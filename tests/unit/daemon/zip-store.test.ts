import assert from "node:assert/strict";
import test from "node:test";
import { zipStore } from "../../../src/daemon/zip-store.ts";

function listedZip(buf: Uint8Array): Map<string, Buffer> {
  const data = Buffer.from(buf);
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 <= data.length && data.readUInt32LE(i) === 0x04034b50) {
    const nameLen = data.readUInt16LE(i + 26);
    const extraLen = data.readUInt16LE(i + 28);
    const size = data.readUInt32LE(i + 18);
    const nameStart = i + 30;
    const name = data.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    out.set(name, Buffer.from(data.subarray(dataStart, dataStart + size)));
    i = dataStart + size;
  }
  return out;
}

test("a store zip holds exactly the files it was given", () => {
  const zip = zipStore([
    { name: "out/a.txt", data: Buffer.from("alpha") },
    { name: "out/b.txt", data: Buffer.from("beta") },
  ]);
  const files = listedZip(zip);
  assert.deepEqual([...files.keys()], ["out/a.txt", "out/b.txt"]);
  assert.equal(files.get("out/a.txt")!.toString(), "alpha");
  assert.equal(files.get("out/b.txt")!.toString(), "beta");
  assert.equal(files.has("secret.txt"), false);
});

test("an empty list still yields a well-formed zip", () => {
  const zip = zipStore([]);
  assert.equal(listedZip(zip).size, 0);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
