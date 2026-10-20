import { describe, expect, it } from "vitest";
import { gateTargets } from "../../src/omp/gate-path.js";

// 2b-i final review A4: omp's built-in read fetches a `www.`-prefixed path over the network (pi-tui read.ts isReadableUrlPath
// `/^www\./i`). Before this the gate resolved it as a cwd-relative LOCAL file, so the read was judged as local text.
describe("gateTargets: a www. path is a URL read", () => {
  it.each(["www.example.com/x?d=abc", "www.example.com/x", "WWW.x.y/z", "@www.x/y"])("%j is refused url_read", (raw) => {
    expect(gateTargets(raw, "/h", "/h/ws")).toEqual({ ok: false, reason: "url_read" });
  });
  it("a local file merely containing www stays a local target", () => {
    expect(gateTargets("notes/www.txt", "/h", "/h/ws")).toEqual({ ok: true, targets: ["/h/ws/notes/www.txt"] });
  });
});
