import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideRuntime,
  parseDockerContextList,
  parseDockerContextShow,
  parseDockerInfoKind,
} from "../../../src/sandbox/detect.ts";

describe("sandbox runtime detection parsers", () => {
  it("parses docker context list", () => {
    const names = parseDockerContextList(`
NAME                TYPE
desktop-linux       moby
* orbstack            orb
colima              moby
`);
    assert.ok(names.includes("orbstack"));
    assert.ok(names.includes("colima"));
    assert.ok(names.includes("desktop-linux"));
  });

  it("parses context show", () => {
    assert.equal(parseDockerContextShow("orbstack\n"), "orbstack");
  });

  it("parses docker info kind", () => {
    assert.equal(
      parseDockerInfoKind("Server Version: 27\nOperating System: OrbStack"),
      "orbstack",
    );
    assert.equal(
      parseDockerInfoKind("Name: colima\nOperating System: Ubuntu"),
      "colima",
    );
    assert.equal(
      parseDockerInfoKind("Operating System: Docker Desktop"),
      "docker",
    );
  });

  it("order OrbStack → Colima → Docker → Podman", () => {
    assert.equal(
      decideRuntime({ orbctlOk: true, dockerOk: true, podmanOk: true })?.kind,
      "orbstack",
    );
    assert.equal(
      decideRuntime({
        colimaOk: true,
        dockerOk: true,
        podmanOk: true,
      })?.kind,
      "colima",
    );
    assert.equal(
      decideRuntime({
        dockerOk: true,
        dockerInfo: "Operating System: Docker Desktop\n",
        podmanOk: true,
      })?.kind,
      "docker",
    );
    assert.equal(decideRuntime({ podmanOk: true })?.kind, "podman");
    assert.equal(decideRuntime({}), null);
  });
});
