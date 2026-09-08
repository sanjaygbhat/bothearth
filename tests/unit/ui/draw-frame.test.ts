import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paintLiveFrame } from "../../../src/ui/live/session.ts";

describe("paintLiveFrame", () => {
  it("drops a decoded frame after control changes and closes its bitmap", async () => {
    const { LiveView } = await import("../../../src/ui/live/session.ts");
    const original = globalThis.createImageBitmap;
    let finish!: (bitmap: ImageBitmap) => void;
    let closed = false;
    globalThis.createImageBitmap = (() => new Promise<ImageBitmap>((resolve) => { finish = resolve; })) as typeof createImageBitmap;
    try {
      const view = Object.assign(Object.create(LiveView.prototype), {
        mode: "human", epoch: 2, ws: {}, objectUrl: null,
        canvas: { width: 1, height: 1, getContext: () => ({ drawImage: () => assert.fail("obsolete human frame painted") }) },
      });
      const painting = view.drawFrame("image/jpeg", new Uint8Array());
      view.mode = "agent";
      finish({ width: 1, height: 1, close() { closed = true; } } as ImageBitmap);
      await painting;
      assert.equal(closed, true);
    } finally {
      if (original) globalThis.createImageBitmap = original;
      else Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
  });

  it("calls createImageBitmap when available", async () => {
    const calls: Blob[] = [];
    const orig = globalThis.createImageBitmap;
    (globalThis as { createImageBitmap?: typeof orig }).createImageBitmap =
      async (blob: Blob) => {
        calls.push(blob);
        return { width: 2, height: 3, close() {} };
      };
    let drawn = false;
    const canvas = {
      width: 0,
      height: 0,
      getContext() {
        return {
          drawImage() {
            drawn = true;
          },
        };
      },
    };
    try {
      await paintLiveFrame(
        canvas as unknown as Parameters<typeof paintLiveFrame>[0],
        "image/jpeg",
        new Uint8Array([0xff, 0xd8]),
      );
      assert.equal(calls.length, 1);
      assert.equal(canvas.width, 2);
      assert.equal(canvas.height, 3);
      assert.equal(drawn, true);
    } finally {
      if (orig) {
        globalThis.createImageBitmap = orig;
      } else {
        delete (globalThis as { createImageBitmap?: typeof orig })
          .createImageBitmap;
      }
    }
  });

  it("falls back when createImageBitmap is absent", async () => {
    const orig = globalThis.createImageBitmap;
    delete (globalThis as { createImageBitmap?: typeof orig }).createImageBitmap;
    const FakeImage = class {
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    };
    const g = globalThis as { Image?: typeof Image };
    const origImage = g.Image;
    g.Image = FakeImage as unknown as typeof Image;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:test";
    const origRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = () => undefined;
    let drawn = false;
    const canvas = {
      width: 0,
      height: 0,
      getContext() {
        return {
          drawImage() {
            drawn = true;
          },
        };
      },
    };
    try {
      await paintLiveFrame(
        canvas as unknown as Parameters<typeof paintLiveFrame>[0],
        "image/jpeg",
        new Uint8Array([0xff, 0xd8]),
      );
      assert.equal(drawn, true);
    } finally {
      if (orig) globalThis.createImageBitmap = orig;
      g.Image = origImage;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
