import { describe, expect, it } from "vitest";
import { chatWorkspace } from "../../src/omp/workspace.js";

describe("chatWorkspace (fix round 1, M-5): one helper for the planner cwd, bash cwd and the attachment root", () => {
  it("places a chat's workspace under <data>/omp/workspace/chat-<id>", () => {
    expect(chatWorkspace("/d", "42")).toBe("/d/omp/workspace/chat-42");
    expect(chatWorkspace("/d", "-1001")).toBe("/d/omp/workspace/chat--1001");
  });
});
