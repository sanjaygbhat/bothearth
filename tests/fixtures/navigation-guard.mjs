// Executed inside the real hardened browser image; destination counters prove prevention.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createState, dispatch } from "/opt/computer-server/src/dispatch.ts";

let origin, destination;
const hits = [];
const fixture = createServer((req, res) => {
  hits.push(`${req.headers.host}${req.url}`);
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/redirect") { res.writeHead(302, { location: destination + "/landing" }); res.end(); }
  else if (req.url === "/landing") res.end("Destination reached");
  else res.end(`<a href="${destination}/landing">Direct</a><a href="${origin}/redirect" target="_blank">Popup</a><button onclick="location.href='${destination}/landing'">Script</button><button onclick="setTimeout(() => location.href='${destination}/landing', 500)">Delayed</button>`);
});
await new Promise((resolve) => fixture.listen(0, resolve));
origin = `http://127.0.0.1:${fixture.address().port}`;
destination = `http://localhost:${fixture.address().port}`;
const state = createState("browser");
let id = 0;
const call = (method, params = {}, origins = [origin]) => dispatch(state, {
  jsonrpc: "2.0", id: ++id, method: "policy.call", params: { method, params, navigation_origins: origins },
});
const raw = (method, params = {}) => dispatch(state, { jsonrpc: "2.0", id: ++id, method, params });
const notContacted = () => assert.ok(!hits.some((hit) => hit.startsWith("localhost:")), JSON.stringify(hits));
async function home() {
  await sleep(100); // Chromium commits its error page asynchronously after an aborted navigation.
  const result = await call("browser_navigate", { url: origin });
  assert.equal(result.ok, true, JSON.stringify(result));
  hits.length = 0;
}
async function ref(label) {
  const snapshot = await call("browser_snapshot", {});
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const line = snapshot.data.yaml.split("\n").find((line) => line.includes(`"${label}"`));
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  assert.ok(ref, snapshot.data.yaml);
  return { snapshot_id: snapshot.data.snapshot_id, ref };
}
try {
  await home();
  const directRef = await ref("Direct");
  let result = await call("browser_click", directRef);
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result)); notContacted();
  assert.equal(result.error.details.navigation_url, destination + "/landing");
  assert.equal(state.browser.page.url(), origin + "/", "denial must preserve the source document");
  result = await call("browser_click", directRef, [origin, destination]);
  assert.equal(result.ok, true, "the exact approved ref click remains usable");
  assert.ok(hits.some((hit) => hit.startsWith("localhost:")));

  await home();
  result = await call("browser_navigate", { url: origin + "/redirect" });
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result)); notContacted();
  assert.equal(state.browser.page.url(), origin + "/", "a refused redirect also preserves the source document");

  await home();
  const target = await ref("Direct");
  result = await call("browser_press", { ...target, key: "Enter" });
  await sleep(150); notContacted();
  // A late intercepted navigation is surfaced before any following model observation.
  if (result.ok) result = await call("browser_snapshot", {});
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result));

  await home();
  const box = await state.browser.page.getByRole("button", { name: "Script" }).boundingBox();
  result = await call("computer_mouse", { action: "click", x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(150); notContacted();
  if (result.ok) result = await call("browser_snapshot", {});
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result));

  await home();
  const delayedBox = await state.browser.page.getByRole("button", { name: "Delayed" }).boundingBox();
  result = await call("computer_mouse", { action: "click", x: delayedBox.x + delayedBox.width / 2, y: delayedBox.y + delayedBox.height / 2 });
  assert.equal(result.ok, true, "the initiating tool finishes before delayed navigation");
  assert.equal(state.browser.page.url(), origin + "/");
  await sleep(1_000);
  notContacted();
  result = await call("browser_snapshot", {});
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result));
  assert.equal(result.error.details.navigation_url, destination + "/landing");

  await home();
  result = await call("browser_click", await ref("Popup"));
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result));
  assert.match(result.error.message, /popups/);
  assert.deepEqual(hits, [], "initial popup must not contact even its first URL");
  assert.equal(state.browser.context.pages().length, 1, "blocked popup must not replace live view with a blank page");

  await home();
  result = await call("browser_tabs", { action: "new", url: origin + "/redirect" });
  assert.equal(result.error?.code, "E_POLICY", JSON.stringify(result)); notContacted();

  await home();
  result = await call("browser_navigate", { url: origin + "/redirect" }, [origin, destination]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(hits.some((hit) => hit.startsWith("localhost:")));

  await home();
  const request = await raw("request_takeover", { reason: "operator navigation test" });
  const takeover_id = request.data.takeover_id;
  assert.equal((await raw("takeover.grant", { takeover_id })).ok, true);
  assert.equal((await call("browser_snapshot", {})).error?.code, "E_TAKEOVER_BUSY");
  await state.browser.page.goto(origin + "/redirect");
  assert.ok(hits.some((hit) => hit.startsWith("localhost:")), "operator navigation remains usable");
  assert.equal(state.browser.consumeNavigationDenied(), null);
  console.log("NAVIGATION_PRECONTACT_PASS: anchor, redirect, Enter, coordinates, delayed script, popup, explicit tab, approved origin, HUMAN");
} finally {
  await state.browser?.close();
  await new Promise((resolve) => fixture.close(resolve));
}
