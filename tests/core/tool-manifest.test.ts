import { describe, expect, it } from "vitest";
import { manifestFor, renderManifestLines } from "../../src/core/tool-manifest.js";

describe("manifestFor (contract-derived tool manifest, ADR 0013)", () => {
  it("is the intersection of allowed_actions and known descriptors, in contract order", () => {
    const manifest = manifestFor(["intent_router", "web_search", "llm_answer", "lesson_write", "write_report"]);
    // Sentinels/report actions have no descriptor → never reach the model's menu.
    expect(manifest.map((m) => m.name)).toEqual(["web_search", "llm_answer", "lesson_write"]);
  });

  it("a capability the contract does not allow never appears (the contract stays the envelope)", () => {
    const manifest = manifestFor(["llm_answer", "write_report"]);
    expect(manifest.map((m) => m.name)).toEqual(["llm_answer"]);
  });

  it("unknown allowed actions are inert", () => {
    expect(manifestFor(["coding_agent_cli", "generic_shell"])).toEqual([]);
  });

  it("lesson_write is internal memory (side effect none) — no approval gate trips", () => {
    const [entry] = manifestFor(["lesson_write"]);
    expect(entry!.side_effect_level).toBe("none");
    expect(entry!.risk_level).toBe("low");
  });

  it("renders one prompt line per tool with description and input sketch", () => {
    const lines = renderManifestLines(manifestFor(["web_search", "lesson_write"]));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^- web_search: .+ Input: \{"query"/);
    // lesson_write's only model-controlled input is the scope (trust-anchored otherwise).
    expect(lines[1]).toContain('"scope"');
    expect(lines[1]).not.toContain('"feedback"');
  });
});

describe("arming policy (step ⓪·2): evolution tools appear only when their flags arm them", () => {
  const EVOLUTION = ["self_diagnose", "self_write_propose", "skill_author"];

  it("code defaults: skills ON, codex + selfwrite OFF", () => {
    const names = manifestFor(EVOLUTION, {}).map((m) => m.name);
    expect(names).toEqual(["skill_author"]);
  });

  it("all armed: each is listed, in contract order", () => {
    const names = manifestFor(EVOLUTION, {
      HOUGE_CODEX_ENABLED: "1",
      HOUGE_SELFWRITE_ENABLED: "1",
      HOUGE_SKILLS_ENABLED: "1"
    }).map((m) => m.name);
    expect(names).toEqual(EVOLUTION);
  });

  it("each flag disarms exactly its tool", () => {
    const armed = { HOUGE_CODEX_ENABLED: "1", HOUGE_SELFWRITE_ENABLED: "1", HOUGE_SKILLS_ENABLED: "1" };
    expect(manifestFor(EVOLUTION, { ...armed, HOUGE_CODEX_ENABLED: "0" }).map((m) => m.name)).toEqual([
      "self_write_propose",
      "skill_author"
    ]);
    expect(manifestFor(EVOLUTION, { ...armed, HOUGE_SELFWRITE_ENABLED: "0" }).map((m) => m.name)).toEqual([
      "self_diagnose",
      "skill_author"
    ]);
    expect(manifestFor(EVOLUTION, { ...armed, HOUGE_SKILLS_ENABLED: "0" }).map((m) => m.name)).toEqual([
      "self_diagnose",
      "self_write_propose"
    ]);
  });

  it("the heavy tools' prompt lines hint terminality (calling it ENDS this turn)", () => {
    const lines = renderManifestLines(
      manifestFor(["self_write_propose", "skill_author"], { HOUGE_SELFWRITE_ENABLED: "1" })
    );
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line).toContain("ENDS this turn");
  });

  it("http_fetch defaults OFF: unlisted (and therefore unreachable) at code defaults", () => {
    const names = manifestFor(["web_search", "http_fetch", "llm_answer"], {}).map((m) => m.name);
    expect(names).toEqual(["web_search", "llm_answer"]);
  });

  it("http_fetch armed: listed in contract order with its url input sketch", () => {
    const env = { HOUGE_HTTPFETCH_ENABLED: "1" };
    const names = manifestFor(["web_search", "http_fetch", "llm_answer"], env).map((m) => m.name);
    expect(names).toEqual(["web_search", "http_fetch", "llm_answer"]);
    const [entry] = manifestFor(["http_fetch"], env);
    expect(entry!.side_effect_level).toBe("external_read");
    expect(entry!.risk_level).toBe("low");
    const lines = renderManifestLines(manifestFor(["http_fetch"], env));
    expect(lines[0]).toMatch(/^- http_fetch: .+ Input: \{"url"/);
  });

  it("to_local_time defaults OFF: unlisted (and therefore unreachable) at code defaults", () => {
    const names = manifestFor(["http_fetch", "to_local_time", "llm_answer"], {}).map((m) => m.name);
    expect(names).toEqual(["llm_answer"]);
  });

  it("to_local_time armed: listed in contract order, pure (side effect none), with its items sketch", () => {
    const env = { HOUGE_TIME_TOOL_ENABLED: "1" };
    const names = manifestFor(["web_search", "to_local_time", "llm_answer"], env).map((m) => m.name);
    expect(names).toEqual(["web_search", "to_local_time", "llm_answer"]);
    const [entry] = manifestFor(["to_local_time"], env);
    // Pure compute → NOT external_read (so Dual-LLM never quarantines it), never trips a gate.
    expect(entry!.side_effect_level).toBe("none");
    expect(entry!.risk_level).toBe("low");
    const lines = renderManifestLines(manifestFor(["to_local_time"], env));
    expect(lines[0]).toMatch(/^- to_local_time: .+ Input: \{"items"/);
    expect(lines[0]).toContain("never do timezone math yourself");
  });

  it("schedule_task defaults OFF: unlisted (and therefore unreachable) at code defaults", () => {
    const names = manifestFor(["llm_answer", "schedule_task"], {}).map((m) => m.name);
    expect(names).toEqual(["llm_answer"]);
  });

  it("schedule_task armed: listed in contract order, mirroring lesson_write's none/low (no approval gate trips)", () => {
    const env = { HOUGE_SCHEDULER_ENABLED: "1" };
    const names = manifestFor(["llm_answer", "schedule_task"], env).map((m) => m.name);
    expect(names).toEqual(["llm_answer", "schedule_task"]);
    const [entry] = manifestFor(["schedule_task"], env);
    // Creating a schedule is local sqlite bookkeeping (the FIRE rides the gated normal
    // path later) — the lesson_write class, so no approval prompt can fire.
    const [lessonWrite] = manifestFor(["lesson_write"], env);
    expect(entry!.side_effect_level).toBe(lessonWrite!.side_effect_level);
    expect(entry!.risk_level).toBe(lessonWrite!.risk_level);
    const lines = renderManifestLines(manifestFor(["schedule_task"], env));
    expect(lines[0]).toMatch(/^- schedule_task: .+ Input: \{"goal"/);
    // The sketch teaches all three spec kinds AND the cancel shape.
    expect(entry!.inputSketch).toContain('"kind":"weekly"');
    expect(entry!.inputSketch).toContain('"kind":"daily"');
    expect(entry!.inputSketch).toContain('"kind":"once"');
    expect(entry!.description).toContain('{"cancel":"sch_..."}');
  });

  it("to_local_time carries the event label in BOTH input sketches, and the description says to pass it (B6)", () => {
    const [plain] = manifestFor(["to_local_time"], { HOUGE_TIME_TOOL_ENABLED: "1" });
    expect(plain!.inputSketch).toContain('"label":"Argentina vs Egypt"');
    expect(plain!.description).toContain("Pass each event's name as label");
    const [evidence] = manifestFor(["to_local_time"], {
      HOUGE_TIME_TOOL_ENABLED: "1",
      HOUGE_TZ_EVIDENCE_ENABLED: "1"
    });
    expect(evidence!.inputSketch).toContain("zone_evidence");
    expect(evidence!.inputSketch).toContain('"label":"Argentina vs Egypt"');
  });

  it("the manifest entries never leak the arming predicate (registration metadata only)", () => {
    const [entry] = manifestFor(["self_write_propose"], { HOUGE_SELFWRITE_ENABLED: "1" });
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual([
      "category",
      "description",
      "inputSketch",
      "name",
      "output_limit_bytes",
      "risk_level",
      "side_effect_level"
    ]);
  });
});

describe("P2 bounty tools arming (spec 2026-07-18)", () => {
  const P2_TOOLS = ["bounty_scan", "project_track", "project_update", "project_list"];

  it("unlisted by default (flag off ⇒ off the model's menu entirely)", () => {
    expect(manifestFor(P2_TOOLS, {})).toEqual([]);
  });

  it("all four listed when HOUGE_BOUNTY_ENABLED arms them", () => {
    const manifest = manifestFor(P2_TOOLS, { HOUGE_BOUNTY_ENABLED: "1" } as NodeJS.ProcessEnv);
    expect(manifest.map((entry) => entry.name)).toEqual(P2_TOOLS);
    const scan = manifest.find((entry) => entry.name === "bounty_scan")!;
    expect(scan.side_effect_level).toBe("external_read");
    for (const name of ["project_track", "project_update", "project_list"]) {
      expect(manifest.find((entry) => entry.name === name)!.side_effect_level).toBe("none");
    }
  });
});

describe("Google identity tools arming (ADR 0025): the GOOGLE × DUAL_LLM couple", () => {
  const GOOGLE_TOOLS = ["gmail_read", "google_api"];

  it("unlisted by default (both flags off ⇒ off the model's menu entirely)", () => {
    expect(manifestFor(GOOGLE_TOOLS, {})).toEqual([]);
  });

  it("both listed when HOUGE_GOOGLE_ENABLED and HOUGE_DUAL_LLM_ENABLED are BOTH on (quarantined external reads)", () => {
    const manifest = manifestFor(GOOGLE_TOOLS, {
      HOUGE_GOOGLE_ENABLED: "1",
      HOUGE_DUAL_LLM_ENABLED: "1"
    } as NodeJS.ProcessEnv);
    expect(manifest.map((entry) => entry.name)).toEqual(GOOGLE_TOOLS);
    for (const entry of manifest) {
      expect(entry.side_effect_level).toBe("external_read");
      expect(entry.risk_level).toBe("medium");
    }
  });

  it("each flag ALONE arms nothing — the couple is the point (no un-quarantined mail read, no dark listing)", () => {
    expect(manifestFor(GOOGLE_TOOLS, { HOUGE_GOOGLE_ENABLED: "1" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(manifestFor(GOOGLE_TOOLS, { HOUGE_DUAL_LLM_ENABLED: "1" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});
