/**
 * `Open` on a receipt file is an ordinary top-level navigation, so the
 * two things the route returned — raw `{"error":"E_IO"}` for a missing file and
 * a bare `application/octet-stream` body for a real one — both replaced the
 * whole app window, with no back affordance and no recovery short of quitting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { contentDisposition, fileGone } from "../../../src/daemon/server.ts";

function capture() {
  const res = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    writeHead(status: number, headers: Record<string, string | number>) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? "";
    },
  };
  return res as typeof res & Parameters<typeof fileGone>[1];
}

test("a browser navigation gets a page it can read, not a JSON blob", () => {
  const res = capture();
  fileGone({ headers: { accept: "text/html,application/xhtml+xml" } } as never, res);
  assert.equal(res.status, 404);
  assert.match(String(res.headers["content-type"]), /^text\/html/);
  assert.match(res.body, /This file isn(&rsquo;|')t here any more/);
  assert.doesNotMatch(res.body, /E_IO/, "the owner is never shown an error code");
  assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
});

test("fetch still gets the JSON it parses", () => {
  const res = capture();
  fileGone({ headers: { accept: "application/json" } } as never, res);
  assert.equal(res.status, 404);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), { error: "E_IO", message: "file not found" });
});

test("a request with no Accept header is treated as a program, not a person", () => {
  const res = capture();
  fileGone({ headers: {} } as never, res);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
});

test("a real file downloads instead of replacing the window", () => {
  assert.match(contentDisposition("out/report.csv"), /^attachment; filename="report\.csv"/);
  assert.match(contentDisposition("out/report.csv"), /filename\*=UTF-8''report\.csv$/);
});

test("the filename can never break out of the header", () => {
  for (const evil of ['out/a"b.csv', "out/a\r\nSet-Cookie: x=1.csv", "../../etc/passwd", "out/a;b.csv"]) {
    const header = contentDisposition(evil);
    assert.doesNotMatch(header, /[\r\n]/, header);
    const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? "";
    assert.doesNotMatch(quoted, /["\r\n/\;]/, quoted);
  }
});

test("a nameless path still yields a usable attachment name", () => {
  assert.match(contentDisposition("out/"), /filename="file"/);
});
