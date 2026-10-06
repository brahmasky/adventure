import { describe, expect, it } from "vitest";
import { isBareAck } from "../../src/omp/bare-ack.js";

// Spec §5.1 slot A: a bare ack while an approval card waits must never be read as consent; the list is code-owned.
describe("isBareAck", () => {
  it.each(["好", "好的", "嗯", "ok", "OK", "Okay", "是的", "对", "👍", "yes", "行", "可以", "好。", "ok!"])("accepts %s", (t) => expect(isBareAck(t)).toBe(true));
  it.each(["好，再查一次", "ok but why", "approve", "/approve 12", "不要", "", "   "])("rejects %s", (t) => expect(isBareAck(t)).toBe(false));
});
