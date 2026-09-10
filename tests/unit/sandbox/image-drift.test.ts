/**
 * A container pins the image *id* it was created from, so rebuilding
 * `modelbot/computer:dev` never reaches a computer that already exists — and
 * the home screen's default browser is `persistent: true`, so it outlives every
 * rebuild. A newly built image can therefore sit on disk with `write_file` in it
 * while the running container has never heard of the tool.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DockerCli } from "../../../src/sandbox/docker.ts";
import { computerImageDrifted } from "../../../src/sandbox/lifecycle.ts";

/** Never probe the real machine from a unit test. */
const runtime = { kind: "docker", binary: "docker" } as const;

function cli(responses: Record<string, string | Error>): DockerCli & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    binary: "docker",
    seen,
    async run(args: string[]) {
      seen.push(args);
      const kind = args.includes("--platform") ? "platform" : args.includes("{{json .ImageManifestDescriptor}}") ? "manifest" : args[0];
      const key = `${kind} ${args.at(-1)}`;
      const hit = responses[key];
      if (hit === undefined) throw new Error(`Error: No such object: ${args.at(-1)}`);
      if (hit instanceof Error) throw hit;
      return hit;
    },
    runSync: () => "",
    spawn: (() => { throw new Error("not used"); }) as never,
  };
}

describe("image drift", () => {
  it("compares an explicitly selected image instead of the container's previous tag", async () => {
    const c = cli({
      "inspect modelbot-mine-browser": "sha256:old|modelbot/computer:previous|1111111111111111",
      "image modelbot/computer:selected": "sha256:new|2222222222222222",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c, browserImage: "modelbot/computer:selected" }), true);
  });
  it("sees a container still running the image its tag has moved off", async () => {
    const drifted = await computerImageDrifted("mine", {
      runtime,
      cli: cli({
        "inspect modelbot-mine-browser": "sha256:old|modelbot/computer:dev",
        "image modelbot/computer:dev": "sha256:new\n",
        "image sha256:old": "sha256:old\n",
      }),
    });
    assert.equal(drifted, true, "the container is a build behind the tag it names");
  });

  it("leaves a current container alone, so boot does not churn", async () => {
    const drifted = await computerImageDrifted("mine", {
      runtime,
      cli: cli({
        "inspect modelbot-mine-browser": "sha256:same|modelbot/computer:dev",
        "inspect modelbot-mine-proxy": "sha256:p|modelbot/proxy:dev",
        "image modelbot/computer:dev": "sha256:same\n",
        "image modelbot/proxy:dev": "sha256:p\n",
      }),
    });
    assert.equal(drifted, false);
  });

  it("a computer with no containers has nothing to be behind", async () => {
    assert.equal(await computerImageDrifted("gone", { runtime, cli: cli({}) }), false);
  });

  it("a tag that no longer resolves is not treated as drift", async () => {
    // Otherwise every boot would recreate containers from an image that is not
    // there, replacing a working computer with a broken one.
    const drifted = await computerImageDrifted("mine", {
      runtime,
      cli: cli({ "inspect modelbot-mine-browser": "sha256:old|modelbot/computer:dev" }),
    });
    assert.equal(drifted, false);
  });

  it("checks the shell and proxy containers too", async () => {
    const c = cli({
      "inspect modelbot-mine-shell": "sha256:old|modelbot/shell:dev",
      "image modelbot/shell:dev": "sha256:new\n",
      "image sha256:old": "sha256:old\n",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), true);
    assert.ok(c.seen.some((a) => a.at(-1) === "modelbot-mine-shell"));
  });

  it("matching build stamps preserve a fresh container even when OCI index and config IDs differ", async () => {
    const c = cli({
      "inspect modelbot-mine-browser": "sha256:config|modelbot/computer:dev|d6a93787a68961ac",
      "image modelbot/computer:dev": "sha256:index|d6a93787a68961ac\n",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), false);
    assert.equal(c.seen.some(args => args[0] === "image" && args.at(-1) === "sha256:config"), false);
  });

  it("different build stamps detect an outdated computer without resolving its config ID", async () => {
    const c = cli({
      "inspect modelbot-mine-browser": "sha256:config|modelbot/computer:dev|1111111111111111",
      "image modelbot/computer:dev": "sha256:index|2222222222222222\n",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), true);
  });

  it("unstamped image aliases resolve to the same canonical Docker image", async () => {
    const c = cli({
      "inspect modelbot-mine-browser": "sha256:config|modelbot/computer:dev|",
      "image modelbot/computer:dev": "sha256:index|\n",
      "image sha256:config": "sha256:index\n",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), false);
  });

  for (const moved of [false, true]) it(`compares an unstamped OCI image on the container's platform: ${moved ? "changed" : "current"}`, async () => {
    const c = cli({
      "inspect modelbot-mine-browser": "sha256:config|modelbot/computer:dev|",
      "image modelbot/computer:dev": "sha256:index|\n",
      "manifest modelbot-mine-browser": JSON.stringify({ digest: "sha256:manifest", platform: { os: "linux", architecture: "arm64" } }),
      "platform modelbot/computer:dev": moved ? "sha256:new-manifest\n" : "sha256:manifest\n",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), moved);
    assert.ok(c.seen.some(args => args.includes("--platform") && args.includes("linux/arm64")));
  });

  it("an unresolvable legacy config ID cannot prove that its container is stale", async () => {
    const c = cli({
      "inspect modelbot-mine-browser": "sha256:config|modelbot/computer:dev|",
      "image modelbot/computer:dev": "sha256:index|d6a93787a68961ac\n",
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), false);
  });

  it("an absent or malformed stamp falls back to actual Docker image identity", async () => {
    for (const [runningStamp, currentStamp] of [["", "d6a93787a68961ac"], ["d6a93787a68961ac", ""], ["<no value>", "<no value>"]]) {
      const c = cli({
        "inspect modelbot-mine-browser": `sha256:old|modelbot/computer:dev|${runningStamp}`,
        "image modelbot/computer:dev": `sha256:new|${currentStamp}\n`,
        "image sha256:old": "sha256:old\n",
      });
      assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), true);
    }
  });
});
