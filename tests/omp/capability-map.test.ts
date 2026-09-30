import { describe, expect, it } from "vitest";
import { BUILTIN_CAPABILITY, capabilityFor } from "../../src/omp/capability-map.js";

describe("capability map — code decides a call's policy class, never the declaration or the model", () => {
  it("routes bash by command class: plain, external write, destructive", () => {
    expect(capabilityFor("bash", { command: "ls" })).toBe("shell");
    expect(capabilityFor("bash", { command: "git push" })).toBe("shell_external");
    expect(capabilityFor("bash", { command: "rm -rf build" })).toBe("shell_destructive");
  });
  it("maps every other bridge tool one-to-one and unknown names to null", () => {
    expect(capabilityFor("web_search", { query: "x" })).toBe("web_search");
    expect(capabilityFor("nope", {})).toBeNull();
  });
  it("classifies built-ins: read is fs_read, edit and write are fs_write", () => {
    expect(BUILTIN_CAPABILITY).toEqual({ read: "fs_read", edit: "fs_write", write: "fs_write" });
  });
});
