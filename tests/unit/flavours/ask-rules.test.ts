import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const FILES = [
  "flavours/codex-modelbot/AGENTS.md",
  "flavours/codex-modelbot/skills/modelbot-computer/SKILL.md",
  "flavours/claude-modelbot/skills/modelbot-computer/SKILL.md",
];

const TOOL_MEANING =
  "hands the person the keyboard and mouse of the bot's computer and waits until they give it back";

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "sign-in", re: /\bsign[\s-]?in\b/i },
  { name: "CAPTCHA", re: /\bcaptcha\b/i },
  { name: "dialogs", re: /\bdialogs?\b/i },
  { name: "passwords", re: /\bpasswords?\b/i },
  { name: "explain what happened", re: /explain what happened/i },
  { name: "rather than guessing", re: /rather than guessing/i },
];

test("flavour files keep request_takeover meaning and drop when-to-ask coaching", () => {
  for (const rel of FILES) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.match(text, /request_takeover/);
    assert.ok(text.includes(TOOL_MEANING), `${rel} missing tool meaning`);
    for (const p of FORBIDDEN) {
      assert.equal(p.re.test(text), false, `${rel} still has ${p.name}`);
    }
  }
});
