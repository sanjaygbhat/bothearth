import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getNativeModelCatalog, resolveNativeTaskSettings } from "../../../src/daemon/native-models.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";

test("Codex model discovery uses model/list, hides internal entries and shares concurrent reads", async () => {
  const cli = fakeCli("bothearth-models-codex", home => `
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
assert.equal(process.env.MODELBOT_MODEL_DISCOVERY_CANARY,undefined);
assert.ok(process.argv.includes('app-server'));
console.log('null'); console.log('"diagnostic"');
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 appendFileSync(${JSON.stringify(join(home, "requests.jsonl"))},line+'\\n');
 assert.ok(['initialize','initialized','model/list'].includes(request.method));
 if(request.method==='initialize') console.log(JSON.stringify({id:1,result:{}}));
 if(request.method==='model/list') console.log(JSON.stringify({id:2,result:{data:[
  {model:'gpt-6-astra',displayName:'GPT-6 Astra',hidden:false,private:'never return this'},
  {model:'internal-review',displayName:'Internal',hidden:true},
  {model:'bad model',displayName:'Invalid'}
 ]}}));
}`);
  const previous = process.env.MODELBOT_MODEL_DISCOVERY_CANARY;
  process.env.MODELBOT_MODEL_DISCOVERY_CANARY = "never pass this";
  try {
    const one = getNativeModelCatalog("codex", cli), two = getNativeModelCatalog("codex", cli);
    assert.equal(one, two);
    const result = await one;
    assert.equal(result.default_model, "gpt-6-astra");
    assert.deepEqual(result.models, [{ id: "gpt-6-astra", label: "GPT-6 Astra", source: "native_cli", access: "listed" }]);
    assert.equal(readFileSync(cli.path("requests.jsonl"), "utf8").trim().split("\n").length, 3);
    assert.equal(JSON.stringify(result).includes("never return"), false);
  } finally {
    if (previous === undefined) delete process.env.MODELBOT_MODEL_DISCOVERY_CANARY;
    else process.env.MODELBOT_MODEL_DISCOVERY_CANARY = previous;
  }
});

test("Claude discovery pins resolved model IDs and prefers listed Fable over the account default", async () => {
  const cli = fakeCli("bothearth-models-claude", () => `
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
assert.ok(process.argv.includes('--strict-mcp-config'));
assert.equal(process.argv[process.argv.indexOf('--tools')+1],'');
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 assert.equal(request.type,'control_request'); assert.equal(request.request.subtype,'initialize');
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{
  account:{email:'private-canary@example.invalid'},
  models:[
   {value:'default',resolvedModel:'claude-opus-5[1m]',displayName:'Default',description:'Opus 5 with 1M context · description'},
   {value:'opus[1m]',resolvedModel:'claude-opus-5[1m]',displayName:'Opus',description:'Opus 5 with 1M context · description'},
   {value:'fable',resolvedModel:'claude-fable-5-1',displayName:'Fable',description:'Fable 5.1 · description'},
   {value:'sonnet',resolvedModel:'claude-sonnet-5',displayName:'Sonnet',description:'Sonnet 5 · description'}
 ]}}}));
}`);
  const result = await getNativeModelCatalog("claude", cli);
  assert.equal(result.default_model, "claude-fable-5-1");
  assert.equal(result.models.filter(model => model.id === "claude-opus-5[1m]").length, 1);
  assert.deepEqual(result.models.find(model => model.id === "claude-fable-5-1"),
    { id: "claude-fable-5-1", label: "Fable 5.1", source: "native_cli", access: "listed" });
  assert.equal(JSON.stringify(result).includes("private-canary"), false);
  assert.equal(result.models.some(model => model.id === "default"), false);
});

test("failed native discovery marks cached and documented choices unverified", async () => {
  const cli = fakeCli("bothearth-models-cache", () => "process.exit(1)");
  writeFileSync(cli.path("models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6-astra", display_name: "Astra", visibility: "list" },
    { slug: "internal", visibility: "hide" },
  ] }));
  const result = await getNativeModelCatalog("codex", { ...cli, configuredModel: "custom/deployment" });
  assert.equal(result.default_model, "gpt-6-astra");
  assert.deepEqual(result.models, [
    { id: "gpt-6-astra", label: "Astra", source: "cache", access: "unverified" },
    { id: "custom/deployment", label: "custom/deployment", source: "custom", access: "unverified" },
  ]);
  assert.match(result.message!, /unverified/);
  const missing = await getNativeModelCatalog("claude", { home: cli.home, binary: cli.path("missing-cli") });
  assert.equal(missing.default_model, "claude-fable-5-1");
  assert.ok(missing.models.every(model => model.source === "documented" && model.access === "unverified"));
});

test("Claude falls back to a listed Opus selection when Fable is not listed", async () => {
  const cli = fakeCli("bothearth-models-opus", () => `
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[
  {value:'opus',resolvedModel:'claude-opus-5',description:'Opus 5 · description'},
  {value:'sonnet',resolvedModel:'claude-sonnet-5',description:'Sonnet 5 · description'}
 ]}}}));
}`);
  const result = await getNativeModelCatalog("claude", cli);
  assert.equal(result.default_model, "claude-opus-5");
  assert.equal(result.models.find(model => model.id === "claude-fable-5-1")?.access, "unverified");
});

test("Codex follows a newer native default instead of a dated product constant", async () => {
  const cli = fakeCli("bothearth-models-new-default", () => `
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(request.method==='initialize') console.log(JSON.stringify({id:1,result:{}}));
 if(request.method==='model/list') console.log(JSON.stringify({id:2,result:{data:[
  {model:'gpt-6-astra',displayName:'Astra',isDefault:false},
  {model:'gpt-7-test',displayName:'Synthetic future default',isDefault:true}
 ]}}));
}`);
  assert.equal((await getNativeModelCatalog("codex", cli)).default_model, "gpt-7-test");
});

test("Claude chooses the newest listed Fable version even when native rows are out of order", async () => {
  const cli = fakeCli("bothearth-models-new-fable", () => `
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[
  {value:'old',resolvedModel:'claude-fable-5-1',description:'Older Fable'},
  {value:'newer',resolvedModel:'claude-fable-5-10',description:'Synthetic future Fable'},
  {value:'middle',resolvedModel:'claude-fable-5-2',description:'Middle Fable'},
  {value:'default',resolvedModel:'claude-sonnet-5',description:'Sonnet'}
 ]}}}));
}`);
  assert.equal((await getNativeModelCatalog("claude", cli)).default_model, "claude-fable-5-10");
});

const defaults = { adapter: "codex" as const, model: "gpt-6-astra", models: { claude: "claude-fable-5-1" } };

test("every new task defaults to executor and preserves its selected model", () => {
  assert.equal(resolveNativeTaskSettings({ reasoning_effort: "high" }, defaults).reasoning_effort, "high");
  for (const input of [{ reasoning_effort: "ultra" }, { reasoning_effort: {} }, { adapter: "claude", reasoning_effort: "high" }])
    assert.throws(() => resolveNativeTaskSettings(input, defaults));
  assert.deepEqual(resolveNativeTaskSettings({}, defaults), { adapter: "codex", model: "gpt-6-astra", execution_mode: "executor" });
  assert.deepEqual(resolveNativeTaskSettings({ adapter: "claude", model: "claude-opus-5[1m]" }, defaults),
    { adapter: "claude", model: "claude-opus-5[1m]", execution_mode: "executor" });
  assert.equal(resolveNativeTaskSettings({ adapter: "claude" }, defaults).model, "claude-fable-5-1");
  assert.equal(resolveNativeTaskSettings({ model: "gateway/custom-model" }, defaults).model, "gateway/custom-model");
  assert.equal(resolveNativeTaskSettings({ adapter: "claude", model: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom" }, defaults).model,
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom");
});

test("orchestration resolves independent executor settings without replacing either selection", () => {
  assert.deepEqual(resolveNativeTaskSettings({ execution_mode: "orchestrator", executor: { adapter: "claude", model: "claude-opus-5" } }, defaults),
    { adapter: "codex", model: "gpt-6-astra", execution_mode: "orchestrator", executor: { adapter: "claude", model: "claude-opus-5" } });
  assert.deepEqual(resolveNativeTaskSettings({ execution_mode: "orchestrator" }, defaults).executor, { adapter: "codex", model: "gpt-6-astra" });
  assert.equal(resolveNativeTaskSettings({ execution_mode: "orchestrator", executor: { adapter: "claude" } }, defaults).executor?.model, "claude-fable-5-1");
});

test("invalid options and model-switching aliases fail clearly", () => {
  for (const input of [
    { adapter: "other" }, { model: "" }, { model: "model\nnext-command" }, { model: "--help" }, { model: "x".repeat(513) },
    { model: "default" }, { model: "best" }, { model: "opusplan" }, { execution_mode: true },
    { executor: { adapter: "claude", model: "claude-opus-5" } },
    { execution_mode: "orchestrator", executor: [] }, { execution_mode: "orchestrator", executor: null },
    { execution_mode: "orchestrator", executor: { adapter: "other" } },
  ]) assert.throws(() => resolveNativeTaskSettings(input, defaults));
});
