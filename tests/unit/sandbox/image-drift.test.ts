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
      const key = `${args[0]} ${args.at(-1)}`;
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
  it("sees a container still running the image its tag has moved off", async () => {
    const drifted = await computerImageDrifted("mine", {
      runtime,
      cli: cli({
        "inspect modelbot-mine-browser": "sha256:old|modelbot/computer:dev",
        "image modelbot/computer:dev": "sha256:new\n",
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
    });
    assert.equal(await computerImageDrifted("mine", { runtime, cli: c }), true);
    assert.ok(c.seen.some((a) => a.at(-1) === "modelbot-mine-shell"));
  });
});
