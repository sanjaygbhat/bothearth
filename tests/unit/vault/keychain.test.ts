import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteStoredOsKey,
  linuxSecretToolProvider,
  macosKeychainProvider,
} from "../../../src/vault/providers.ts";
import type { KeyStoreRunner } from "../../../src/vault/providers.ts";

const SERVICE = "com.modelbot.test-vault";
const ACCOUNT = "master-key";
const GOOD = "a".repeat(64);

test("an unavailable headless keyring fails before generating or storing a replacement key", async () => {
  for (const failure of [
    { status: null, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" },
  ]) {
    const calls: string[] = [];
    const provider = linuxSecretToolProvider(SERVICE, ACCOUNT, (_bin, args) => {
      calls.push(args[0]!); return failure;
    });
    await assert.rejects(provider.resolve(true), /Secret Service is unavailable.*encrypted systemd credential/);
    assert.deepEqual(calls, ["lookup"], "unavailable does not mean the vault key is missing");
  }
});

/** `security -i` tokenises its stdin command on whitespace, honouring `"`. */
function parseInteractive(input: string): string[] {
  return (input.trim().match(/"[^"]*"|\S+/g) ?? []).map((t) =>
    t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
  );
}

/**
 * Fake `security`. Mirrors the real CLI's damaging quirk: `add-generic-password -w`
 * with no argument stores an EMPTY password and still exits 0. Writes arrive
 * through `security -i` on stdin, exactly as the provider sends them.
 */
function fakeSecurity(
  initial?: string,
  opts?: { storeAs?: string; addStatus?: number },
) {
  let stored = initial;
  const calls: string[][] = [];
  const stdin: string[][] = [];
  const exec: KeyStoreRunner = (bin, args, io) => {
    calls.push([bin, ...args]);
    const argv = args[0] === "-i" ? parseInteractive(io?.input ?? "") : args;
    if (args[0] === "-i") stdin.push(argv);
    const ok = { status: 0, stdout: "", stderr: "" };
    switch (argv[0]) {
      case "add-generic-password": {
        if (opts?.addStatus) {
          return { status: opts.addStatus, stdout: "", stderr: "boom" };
        }
        const i = argv.indexOf("-w");
        stored = opts?.storeAs ?? (i >= 0 ? (argv[i + 1] ?? "") : "");
        return ok;
      }
      case "find-generic-password":
        return stored === undefined
          ? { status: 44, stdout: "", stderr: "could not be found" }
          : { status: 0, stdout: `${stored}\n`, stderr: "" };
      case "delete-generic-password": {
        if (stored === undefined) {
          return { status: 44, stdout: "", stderr: "could not be found" };
        }
        stored = undefined;
        return ok;
      }
      default:
        throw new Error(`unexpected security call: ${argv[0]}`);
    }
  };
  return { exec, calls, stdin, read: () => stored };
}

test("the master key never reaches argv — it is written over stdin", async () => {
  const kc = fakeSecurity();
  const provider = macosKeychainProvider(SERVICE, ACCOUNT, kc.exec);
  const key = Buffer.alloc(32, 0xab);
  const hex = key.toString("hex");

  await provider.store!(key);
  assert.equal(kc.read(), hex);
  assert.deepEqual((await provider.resolve(false)).key, key);

  // `ps -ww -o args` is readable by any same-user process, so no argv
  // element of any `security` call may be — or contain — the master key.
  for (const call of kc.calls) {
    for (const arg of call) {
      assert.ok(!/[0-9a-f]{64}/i.test(arg), `key material in argv: ${call.join(" ")}`);
    }
  }
  // It arrives on stdin instead, still as the value of `-w` (a trailing `-w`
  // makes `security` prompt and silently store an empty password, exiting 0).
  assert.deepEqual(kc.calls[0], ["security", "-i"]);
  const write = kc.stdin[0]!;
  assert.equal(write[0], "add-generic-password");
  assert.notEqual(write.at(-1), "-w");
  assert.equal(write[write.indexOf("-w") + 1], hex);
});

test("a malformed stored key (the shipped '-U') fails with recovery guidance", async () => {
  const kc = fakeSecurity("-U");
  const provider = macosKeychainProvider(SERVICE, ACCOUNT, kc.exec);

  await assert.rejects(provider.resolve(true), (e: Error) => {
    assert.match(e.message, /modelbot init --reset-vault-key/);
    assert.match(e.message, /64 hexadecimal characters/);
    assert.doesNotMatch(e.message, /-U'|"-U"/); // never echo the stored value
    return true;
  });
  // Must not silently rotate: a new key would orphan an existing vault.
  assert.equal(kc.read(), "-U");
});

test("an empty stored key is corrupt, not missing", async () => {
  const kc = fakeSecurity("");
  const provider = macosKeychainProvider(SERVICE, ACCOUNT, kc.exec);
  await assert.rejects(provider.resolve(true), /--reset-vault-key/);
  assert.equal(kc.read(), "");
});

test("a missing item reports plainly, and is created when asked", async () => {
  const kc = fakeSecurity();
  const provider = macosKeychainProvider(SERVICE, ACCOUNT, kc.exec);

  await assert.rejects(provider.resolve(false), /no vault master key found/);

  const created = await provider.resolve(true);
  assert.equal(created.key.length, 32);
  assert.match(kc.read()!, /^[0-9a-f]{64}$/);
});

test("add-then-verify mismatch aborts instead of orphaning the vault", async () => {
  // `security` exits 0 but stored something else — exactly the shipped failure.
  const kc = fakeSecurity(undefined, { storeAs: "" });
  const provider = macosKeychainProvider(SERVICE, ACCOUNT, kc.exec);
  await assert.rejects(provider.resolve(true), (e: Error) => {
    assert.match(e.message, /read it back, and the two did not match/);
    return true;
  });
});

test("a failing add-generic-password surfaces its stderr", async () => {
  const kc = fakeSecurity(undefined, { addStatus: 1 });
  const provider = macosKeychainProvider(SERVICE, ACCOUNT, kc.exec);
  await assert.rejects(provider.resolve(true), /add-generic-password failed: boom/);
});

test("deleteStoredOsKey clears the item and tolerates it being absent", {
  skip: process.platform !== "darwin",
}, () => {
  const kc = fakeSecurity(GOOD);
  deleteStoredOsKey(SERVICE, ACCOUNT, kc.exec);
  assert.equal(kc.read(), undefined);
  deleteStoredOsKey(SERVICE, ACCOUNT, kc.exec); // already gone: still fine
});
