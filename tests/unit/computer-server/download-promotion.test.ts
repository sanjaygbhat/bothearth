import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { BrowserSession } from "../../../computer-server/src/browser/session.ts";

async function quarantine(session: BrowserSession, name: string, body = "downloaded") {
  return await session["quarantineDownload"]({
    suggestedFilename: () => name,
    saveAs: async (path: string) => writeFileSync(path, body),
  }) as { id: string; path: string };
}

describe("human-approved download promotion", () => {
  it("lists metadata, leaves unapproved bytes quarantined, then promotes one item", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mb-promote-ws-"));
    const quarantineDir = mkdtempSync(join(tmpdir(), "mb-promote-q-"));
    process.env.MODELBOT_WORKSPACE = workspace;
    process.env.MODELBOT_QUARANTINE = quarantineDir;
    const session = new BrowserSession();
    const saved = await quarantine(session, "sample.txt");

    assert.equal(existsSync(join(workspace, `${saved.id}-sample.txt`)), false);
    const listed = session.listQuarantine();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const item = (listed.data as { items: Array<Record<string, unknown>> }).items[0]!;
    assert.deepEqual(
      [item.id, item.name, item.size, item.content_type],
      [saved.id, "sample.txt", 10, "text/plain"],
    );
    assert.equal(Number.isNaN(Date.parse(String(item.downloaded_at))), false);

    const promoted = session.promoteQuarantine(saved.id);
    assert.equal(promoted.ok, true);
    if (!promoted.ok) return;
    const path = String((promoted.data as { workspace_path: string }).workspace_path);
    assert.equal(readFileSync(path, "utf8"), "downloaded");
    assert.equal(existsSync(saved.path), false);
  });

  it("sanitizes traversal names and refuses a workspace symlink overwrite", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mb-promote-safe-ws-"));
    const quarantineDir = mkdtempSync(join(tmpdir(), "mb-promote-safe-q-"));
    const outside = join(mkdtempSync(join(tmpdir(), "mb-promote-out-")), "outside.txt");
    writeFileSync(outside, "outside");
    process.env.MODELBOT_WORKSPACE = workspace;
    process.env.MODELBOT_QUARANTINE = quarantineDir;
    const session = new BrowserSession();

    const traversal = await quarantine(session, "../../escape.txt");
    const safe = session.promoteQuarantine(traversal.id);
    assert.equal(safe.ok, true);
    if (safe.ok) {
      const path = String((safe.data as { workspace_path: string }).workspace_path);
      assert.equal(path.startsWith(`${realpathSync(workspace)}/`), true);
      assert.equal(basename(path).includes("/"), false);
    }

    const blocked = await quarantine(session, "linked.txt", "attacker");
    symlinkSync(outside, join(workspace, `${blocked.id}-linked.txt`));
    assert.equal(session.promoteQuarantine(blocked.id).ok, false);
    assert.equal(readFileSync(outside, "utf8"), "outside");
    assert.equal(existsSync(blocked.path), true);
  });
});
