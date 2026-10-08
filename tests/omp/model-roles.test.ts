import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROVIDERS, CHAT_ROLES, clampEffort, isOverrideKey, matchOverride, resolveModelRolesMode, resolveRole, ROLE_LISTS, ROLE_NAMES,
  roleSelectors, STATIC_ROLE_LISTS, staticRoleChains, STEP_UP, type ResolveInput
} from "../../src/omp/model-roles.js";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { fixtureCatalog } from "../helpers/model-roles.js";

const NONE: ReadonlySet<string> = new Set();
const resolved = (i: Partial<ResolveInput> & Pick<ResolveInput, "role">): string[] =>
  resolveRole({ catalog: fixtureCatalog(), override: null, refused: NONE, mode: "resolved", ...i }).map(formatModelString);
const f = (l: ModelString[]) => l.map(formatModelString).join(",");

// Spec 2026-10-06 §4: every seat now runs on a role resolved from these lists. A wrong list or a wrong filter routes a
// chat turn to Codex or to a metered provider. Both are hard lines, so the tests pin the lists and each filter.
describe("role lists (code-owned, spec §4)", () => {
  it("every selector parses, sits on an allowed provider, and no chat role names Codex (Codex stays the self-write writer)", () => {
    for (const role of ROLE_NAMES) {
      for (const s of ROLE_LISTS[role]) {
        const m = parseModelString(s);
        expect(ALLOWED_PROVIDERS).toContain(m.provider);
        if (CHAT_ROLES.has(role)) expect(m.provider).not.toBe("openai-codex");
      }
    }
  });

  // Spec §4.3: HOUGE_MODEL_ROLES=static is the rollback switch, so it must be the pre-stage-A model path seat for seat.
  // These are the HOUGE_OMP_* DEFAULTS of src/omp/omp-config.ts:16-22 (main@80e23bb; unchanged since 94e3b4c), copied verbatim; a list edit that
  // touches static fails here. Two residual differences of static are accepted and live in the supervisor, not in these
  // lists (plan Decision 1): the per-child refused set (Q9) and the removed respawn-on-planner[0] rule (Task 8).
  it("static chains are today's seven HOUGE_OMP_* defaults, string for string (the rollback adds and drops no model)", () => {
    const c = staticRoleChains();
    expect(f(c.planner)).toBe("anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low");
    expect(f(c.reader)).toBe("google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-5.5:low");
    expect(f(c.media)).toBe("google-antigravity/gemini-3.8-flash:low");
    expect(f(c.ticks)).toBe("kimi-code/k3:low");
    expect(f(c.judges)).toBe("kimi-code/k3,openai-codex/gpt-5.5,google-antigravity/gemini-3.1-pro");
    expect(f(c.chair)).toBe("anthropic/claude-opus-5-5:low");
    expect(f(c.reviewer)).toBe("kimi-code/k3:high,google-antigravity/claude-opus-4-6:medium");
  });

  it("static Fast and Thinking are the Default list: the rollback routes every turn to today's planner chain", () => {
    expect(STATIC_ROLE_LISTS.fast).toEqual(STATIC_ROLE_LISTS.default);
    expect(STATIC_ROLE_LISTS.thinking).toEqual(STATIC_ROLE_LISTS.default);
  });

  it("static lists parse and stay on allowed providers, with no chat role on Codex", () => {
    for (const role of ROLE_NAMES) {
      for (const s of STATIC_ROLE_LISTS[role]) {
        const m = parseModelString(s);
        expect(ALLOWED_PROVIDERS).toContain(m.provider);
        if (CHAT_ROLES.has(role)) expect(m.provider).not.toBe("openai-codex");
      }
    }
  });

  it("Fast, Thinking and Tiny are the Decision 3 lists (Rev 4: no k3 on Fast; gemini-3.8-flash behind k3 on Tiny)", () => {
    expect(ROLE_LISTS.fast).toEqual(["anthropic/claude-sonnet-5-5:low", "google-antigravity/claude-sonnet-5-5:low",
      "google-antigravity/gemini-3.8-flash:low"]);
    expect(ROLE_LISTS.thinking).toEqual(["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high",
      "google-antigravity/claude-opus-4-6:high", "kimi-code/k3:high"]);
    expect(ROLE_LISTS.tiny).toEqual(["kimi-code/k3:low", "google-antigravity/gemini-3.8-flash:low"]);
  });

  // Paco 2026-10-07: Kimi is not renewed next year. A role whose only leg is k3 would empty the day the catalog drops it
  // (memory ticks and the cascade would then run the static k3 chain and fail), so every multi-seat role keeps another
  // provider. Judges are one selector per seat by design; seat 0 is the named exception (a list edit then).
  it("every role list except the per-seat judges keeps a non-Kimi leg", () => {
    for (const role of ROLE_NAMES.filter((r) => r !== "judges")) {
      expect(ROLE_LISTS[role].some((s) => parseModelString(s).provider !== "kimi-code"), role).toBe(true);
    }
  });

  it("a catalog that lists none of a role's selectors empties it in resolved mode (RoleResolver falls back, Task 7)", () => {
    expect(resolved({ role: "vision", catalog: fixtureCatalog().filter((m) => m.id !== "gemini-3.8-flash") })).toEqual([]);
  });

  it("every list selector is in the fixture catalog, so resolved mode over it returns the lists unchanged", () => {
    for (const role of ROLE_NAMES.filter((r) => r !== "judges")) expect(resolved({ role })).toEqual(ROLE_LISTS[role]);
    ROLE_LISTS.judges.forEach((s, seat) => expect(resolved({ role: "judges", seat })).toEqual([s]));
  });
});

describe("resolveRole — spec §4 steps 1–4", () => {
  it("applies the provider allow-list before matching: a google/ or moonshot/ twin is never a candidate", () => {
    expect(matchOverride("gemini-3.8-flash", "vision", fixtureCatalog()).map((m) => `${m.provider}/${m.id}`)).toEqual(["google-antigravity/gemini-3.8-flash"]);
    expect(resolved({ role: "vision", override: "gemini-3.8-flash" })).toEqual(["google-antigravity/gemini-3.8-flash:low"]);
    expect(matchOverride("kimi-k3", "tiny", fixtureCatalog())).toEqual([]); // moonshot is metered
  });

  it("never routes a chat seat to Codex, while Reader and the judges may use it", () => {
    expect(matchOverride("gpt-6.1", "default", fixtureCatalog())).toEqual([]);
    expect(resolved({ role: "default", override: "gpt-6.1" })).toEqual(ROLE_LISTS.default);
    expect(matchOverride("gpt-6.1", "reader", fixtureCatalog()).map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("puts the override first, then the catalogued list, duplicates dropped; the override takes the list's effort for that model", () => {
    expect(resolved({ role: "thinking", override: "opus-4-6" })).toEqual([
      "google-antigravity/claude-opus-4-6:high", "anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high", "kimi-code/k3:high"
    ]);
    // A pattern matching two providers' models yields both, in catalog order, each with the list's effort for it.
    expect(resolved({ role: "default", override: "opus-5-5" }).slice(0, 2)).toEqual(["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium"]);
    expect(resolved({ role: "vision", override: "GEMINI-3.1-PRO" })).toEqual(["google-antigravity/gemini-3.1-pro:low", "google-antigravity/gemini-3.8-flash:low"]);
  });

  it("drops a listed selector the catalog no longer lists (a retired model), matching provider/id without the :effort", () => {
    // The 2026-10-07 Antigravity generation change, either way round: the role keeps whichever generation is listed.
    const newGen = fixtureCatalog().filter((m) => !(m.provider === "google-antigravity" && m.id === "claude-opus-4-6"));
    expect(resolved({ role: "default", catalog: newGen })).toEqual(["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "kimi-code/k3:low"]);
    const oldGen = fixtureCatalog().filter((m) => !(m.provider === "google-antigravity" && /^claude-(opus|sonnet)-5-5$/.test(m.id)));
    expect(resolved({ role: "default", catalog: oldGen })).toEqual(["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"]);
  });

  it("skips what the running child refused, in the list and in the override alike", () => {
    expect(resolved({ role: "default", refused: new Set(["anthropic/claude-opus-5-5"]) }))
      .toEqual(["google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"]);
    expect(resolved({ role: "thinking", override: "opus-4-6", refused: new Set(["google-antigravity/claude-opus-4-6"]) })[0]).toBe("anthropic/claude-opus-5-5:high");
  });

  it("static mode is the static list in order: no catalog check, no override, uncatalogued gpt-5.5 kept (§4.3)", () => {
    expect(resolved({ role: "fast", mode: "static", catalog: [], override: "opus" })).toEqual(STATIC_ROLE_LISTS.default);
    expect(resolved({ role: "reader", mode: "static" })).toEqual(STATIC_ROLE_LISTS.reader); // the fixture has no gpt-5.5
    expect(resolved({ role: "judges", seat: 1, mode: "static" })).toEqual(["openai-codex/gpt-5.5"]);
    expect(resolved({ role: "default", mode: "static", refused: new Set(["anthropic/claude-opus-5-5"]) }))
      .toEqual(["google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"]); // the refused set applies in static too (Q9)
  });

  it("with no catalog in resolved mode, keeps the whole list and applies an override only as an exact list match (Decision 4)", () => {
    expect(resolved({ role: "default", catalog: null })).toEqual(ROLE_LISTS.default);
    expect(resolved({ role: "default", catalog: null, override: "KIMI-CODE/k3" })).toEqual([
      "kimi-code/k3:low", "anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium"
    ]);
    expect(resolved({ role: "default", catalog: null, override: "opus" })).toEqual(ROLE_LISTS.default);
  });

  it("resolves each judge seat from its own index; a seat override leads that seat only", () => {
    expect(resolved({ role: "judges", seat: 1 })).toEqual(["openai-codex/gpt-6.1-sol"]);
    expect(resolved({ role: "judges", seat: 1, override: "gemini-3.1-pro" })).toEqual(["google-antigravity/gemini-3.1-pro", "openai-codex/gpt-6.1-sol"]);
    expect(roleSelectors("judges")).toEqual([]); // no seat, no selectors: the judges never form one fallback chain
  });
});

describe("clampEffort — Decision 2", () => {
  const cat = fixtureCatalog();
  const k3 = parseModelString("kimi-code/k3:low");

  it("fits the routed effort to the model's catalogued levels, ties rounding up", () => {
    expect(clampEffort(k3, "medium", cat, "resolved")).toEqual({ provider: "kimi-code", model: "k3", effort: "high" });
    expect(clampEffort(k3, "low", cat, "resolved").effort).toBe("low");
    expect(clampEffort(parseModelString("google-antigravity/gemini-3.1-pro"), "medium", cat, "resolved").effort).toBe("high");
  });

  it("with no routed effort, clamps the selector's own effort, and keeps a selector with none effort-less", () => {
    expect(clampEffort(parseModelString("anthropic/claude-opus-5-5:medium"), null, cat, "resolved").effort).toBe("medium");
    expect(clampEffort(parseModelString("kimi-code/k3"), null, cat, "resolved")).toEqual({ provider: "kimi-code", model: "k3" }); // a judge seat
    expect(clampEffort(parseModelString("google-antigravity/claude-opus-5-5:medium"), "high", cat, "resolved").effort).toBe("high");
  });

  it("strips the effort of a model whose catalog thinking is null: no set_thinking_level", () => {
    expect(clampEffort(parseModelString("anthropic/claude-3-haiku-20240307:low"), "high", cat, "resolved"))
      .toEqual({ provider: "anthropic", model: "claude-3-haiku-20240307" });
  });

  it("static mode and a missing catalog keep the selector as listed (routed effort is ledgered, not applied)", () => {
    expect(clampEffort(k3, "high", cat, "static")).toBe(k3);
    expect(clampEffort(k3, "high", null, "resolved")).toBe(k3);
  });
});

describe("mode, step-up and override keys", () => {
  it("HOUGE_MODEL_ROLES defaults to resolved; only 'static' (any case, trimmed) is the rollback", () => {
    expect(resolveModelRolesMode({})).toBe("resolved");
    expect(resolveModelRolesMode({ HOUGE_MODEL_ROLES: " STATIC " })).toBe("static");
    expect(resolveModelRolesMode({ HOUGE_MODEL_ROLES: "off" })).toBe("resolved");
  });

  it("an exhausted role steps up Fast → Default → Thinking → nothing (no_planner_leg)", () => {
    expect([STEP_UP.fast, STEP_UP.default, STEP_UP.thinking]).toEqual(["default", "thinking", null]);
  });

  it("accepts a role name or judges:<n> as an override key, nothing else", () => {
    expect(["thinking", "judges", "judges:0", "judges:2"].every(isOverrideKey)).toBe(true);
    expect(["planner", "judges:x", "judges:-1", "Thinking", ""].some(isOverrideKey)).toBe(false);
  });
});
