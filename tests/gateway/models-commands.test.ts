import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, HELP_TEXT } from "../../src/gateway/gateway.js";
import { MODELS_REFUSED, modelsRefusalText, type ModelsRefusal, type ModelsRoles } from "../../src/gateway/models-commands.js";
import { ALLOWED_PROVIDERS, ROLE_LISTS, type CatalogModel } from "../../src/omp/model-roles.js";
import type { ResolvedRole } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { isHandledIntakeDenial } from "../../src/telegram/telegram-poll-runner.js";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §4.2: /models is Paco's only lever over which model answers, with no restart and no settings table. Each override is
// an append-only ledger row validated against the filtered catalog at set time: a pattern that would match a metered `google/`
// twin, a Codex model on a chat seat, or nothing at all must be refused with its reason, never saved silently, and a
// role-level judges override must be refused so the council seats never collapse onto one model.
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
let store: RunStore;
let n = 0;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

function command(text: string, from = 111): TypedTaskEvent {
  n += 1;
  const r = normalizeTelegramUpdate({ update_id: n, message: { message_id: n, text, from: { id: from }, chat: { id: 222 } } }, ALLOWLIST);
  if (!r.ok) throw new Error(`expected an event: ${r.error.code}`);
  return r.event as TypedTaskEvent;
}
const replies = () => [...drainOutbox(store).values()].map((p) => String(p.text));

// A catalog with the cases that matter: an allowed Anthropic model, the metered `google/` twin of an Antigravity id, a Codex
// model (allowed on reader/council seats, never on a chat seat) and an allowed Antigravity model.
const CATALOG: CatalogModel[] = [
  { provider: "anthropic", id: "claude-opus-5-5", thinking: ["low", "medium", "high"] },
  { provider: "google", id: "gemini-3.8-flash", thinking: null },
  { provider: "openai-codex", id: "gpt-6.1-sol", thinking: ["low", "medium", "high"] },
  { provider: "google-antigravity", id: "gemini-3.1-pro", thinking: ["low", "high"] }
];
const RESOLVED: ResolvedRole[] = [
  { key: "default", head: "anthropic/claude-opus-5-5:medium", candidates: ["anthropic/claude-opus-5-5:medium", "kimi-code/k3:low"], source: "list" },
  { key: "thinking", head: "anthropic/claude-opus-5-5:high", candidates: ["anthropic/claude-opus-5-5:high"], source: "override" },
  { key: "vision", head: null, candidates: [], source: "list" },
  { key: "judges:1", head: "openai-codex/gpt-6.1-sol", candidates: ["openai-codex/gpt-6.1-sol"], source: "list" }
];
const stub = (catalog: CatalogModel[] | null = CATALOG, resolved: ResolvedRole[] = RESOLVED): ModelsRoles =>
  ({ catalog: () => catalog, resolveAll: () => resolved });
const gateway = (roles: ModelsRoles = stub()) => new Gateway(store, undefined, undefined, undefined, undefined, { roles });
// The CLI's shape: no resolver at all (an explicit `undefined` argument would take the default above, hence a separate helper).
const bareGateway = () => new Gateway(store);
const overrides = () => store.getLedgerEvents().filter((e) => e.event_type === "model_role_override");

describe("parsing", () => {
  it("bare lists; set takes a role and one pattern; judges take a 0-based seat; reset takes a role and an optional seat", () => {
    expect(parseTelegramCommand("/models")).toEqual({ ok: true, command: { type: "models", action: "list" } });
    expect(parseTelegramCommand("/models set thinking opus")).toEqual({ ok: true, command: { type: "models", action: "set", role: "thinking", pattern: "opus" } });
    expect(parseTelegramCommand("/models set judges 1 gemini-3.1-pro"))
      .toEqual({ ok: true, command: { type: "models", action: "set", role: "judges", seat: 1, pattern: "gemini-3.1-pro" } });
    // A role-level judges set parses (so the handler can refuse it WITH the reason) rather than reading as a typo.
    expect(parseTelegramCommand("/models set judges opus")).toEqual({ ok: true, command: { type: "models", action: "set", role: "judges", pattern: "opus" } });
    expect(parseTelegramCommand("/models reset default")).toEqual({ ok: true, command: { type: "models", action: "reset", role: "default" } });
    expect(parseTelegramCommand("/models reset judges")).toEqual({ ok: true, command: { type: "models", action: "reset", role: "judges" } });
    expect(parseTelegramCommand("/models reset judges 2")).toEqual({ ok: true, command: { type: "models", action: "reset", role: "judges", seat: 2 } });
  });

  it("refuses unknown verbs, unknown roles (the retired `planner` chain name), missing or extra words, and a seat on a non-judge role", () => {
    for (const bad of ["/models frobnicate", "/models set", "/models set planner opus", "/models set default", "/models set default a b",
      "/models reset default 1", "/models set default 1 opus", `/models set default ${"x".repeat(65)}`]) {
      expect(parseTelegramCommand(bad).ok, bad).toBe(false);
    }
  });

  it("the adapter carries action in `program` and role/seat/pattern in metadata; a stranger's /models never becomes an event", () => {
    const e = command("/models set judges 1 gemini-3.1-pro");
    expect(e).toMatchObject({ type: "models", program: "set", metadata: { role: "judges", seat: 1, pattern: "gemini-3.1-pro" } });
    expect(command("/models")).toMatchObject({ type: "models", program: "list" });
    expect(normalizeTelegramUpdate({ update_id: 9000, message: { message_id: 1, text: "/models", from: { id: 999 }, chat: { id: 222 } } }, ALLOWLIST).ok).toBe(false);
  });
});

describe("/models list", () => {
  it("shows role → head, effort, list or override (with its pattern), and the candidates; a role with no candidate says so", () => {
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus", actor: "paco" });
    expect(gateway().intake(command("/models"))).toMatchObject({ ok: true, status: "models_returned" });
    const text = replies()[0]!;
    expect(text).toContain("catalog: 4 models");
    expect(text).toContain("**default** → `anthropic/claude-opus-5-5:medium` · effort medium · list");
    expect(text).toContain("candidates: `anthropic/claude-opus-5-5:medium`, `kimi-code/k3:low`");
    expect(text).toContain("**thinking** → `anthropic/claude-opus-5-5:high` · effort high · override `opus`");
    expect(text).toContain("**vision** → (no candidate)");
    expect(text).toContain("**judges:1** → `openai-codex/gpt-6.1-sol`");
  });

  it("says when the catalog is unavailable or the switch is static, because then the lists run as written", () => {
    gateway(stub(null)).intake(command("/models"));
    expect(replies()[0]).toContain("catalog unavailable");
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    gateway().intake(command("/models"));
    expect(replies()[0]).toContain("static");
  });
});

describe("/models set", () => {
  it("saves a pattern that matches an allowed model for the role, as one model_role_override row keyed by the role", () => {
    expect(gateway().intake(command("/models set thinking opus"))).toMatchObject({ ok: true, status: "models_returned" });
    expect(store.latestModelRoleOverrides().get("thinking")).toBe("opus");
    expect(overrides().map((e) => e.payload)).toEqual([{ key: "thinking", pattern: "opus", actor: "paco" }]);
    expect(replies()[0]).toContain("thinking → override `opus`");
  });

  it("a judge seat is its own key; Codex is allowed on reader and council seats", () => {
    gateway().intake(command("/models set judges 1 gemini-3.1-pro"));
    gateway().intake(command("/models set reader gpt-6.1"));
    expect(store.latestModelRoleOverrides().get("judges:1")).toBe("gemini-3.1-pro");
    expect(store.latestModelRoleOverrides().get("reader")).toBe("gpt-6.1");
  });

  const refusals: Array<[string, ModelsRoles, ModelsRefusal]> = [
    // the only match is the metered google/ twin: the allow-list runs before matching
    ["/models set fast gemini-3.8-flash", stub(), "outside_allow_list"],
    // the only match is Codex, and no chat turn is ever routed to Codex
    ["/models set default gpt-6.1", stub(), "outside_allow_list"],
    ["/models set default nonexistent-model", stub(), "no_match"],
    ["/models set judges opus", stub(), "role_judges"],
    [`/models set judges ${ROLE_LISTS.judges.length} opus`, stub(), "no_seat"],
    ["/models set thinking opus", stub(null), "catalog_unavailable"]
  ];
  for (const [text, roles, reason] of refusals) {
    it(`refuses ${JSON.stringify(text)} with ${reason}, saves nothing, and is a handled denial`, () => {
      const r = gateway(roles).intake(command(text));
      if (r.ok) throw new Error("expected a refusal");
      expect(r.error.code).toBe(MODELS_REFUSED);
      expect(isHandledIntakeDenial(r.error.code)).toBe(true);
      expect(replies()).toEqual([modelsRefusalText(reason)]);
      expect(overrides()).toHaveLength(0);
    });
  }

  it("the allow-list refusal names the allowed providers, so Paco knows why", () => {
    expect(modelsRefusalText("outside_allow_list")).toContain(ALLOWED_PROVIDERS.join(", "));
  });

  it("static mode refuses: an override it would never apply must not look saved", () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    const r = gateway().intake(command("/models set thinking opus"));
    expect(r.ok).toBe(false);
    expect(replies()).toEqual([modelsRefusalText("static_mode")]);
  });

  it("a redelivered set saves once and replies once", () => {
    const e = command("/models set thinking opus");
    gateway().intake(e);
    gateway().intake(e);
    expect(overrides()).toHaveLength(1);
    expect(replies()).toHaveLength(1);
  });
});

describe("/models reset", () => {
  it("reset <role> appends an empty-pattern row, so the role goes back to its code list", () => {
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus", actor: "paco" });
    gateway().intake(command("/models reset thinking"));
    expect(store.latestModelRoleOverrides().has("thinking")).toBe(false);
    expect(replies()[0]).toContain("thinking");
  });

  it("reset with no override changes nothing and says so (no ledger row)", () => {
    gateway().intake(command("/models reset default"));
    expect(overrides()).toHaveLength(0);
    expect(replies()).toEqual(["No override on default; nothing changed."]);
  });

  it("reset judges clears every judge seat; reset judges <n> clears that seat only", () => {
    store.recordModelRoleOverride({ key: "judges:0", pattern: "opus", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-3.1-pro", actor: "paco" });
    gateway().intake(command("/models reset judges 2"));
    expect([...store.latestModelRoleOverrides().keys()]).toEqual(["judges:0"]);
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-3.1-pro", actor: "paco" });
    gateway().intake(command("/models reset judges"));
    expect([...store.latestModelRoleOverrides().keys()]).toEqual([]);
  });
});

describe("gating and help", () => {
  it("a gateway without a resolver (the CLI) replies 'not available here' as a handled denial", () => {
    const r = bareGateway().intake(command("/models"));
    if (r.ok) throw new Error("expected a refusal");
    expect(isHandledIntakeDenial(r.error.code)).toBe(true);
    expect(replies()).toEqual([modelsRefusalText("unavailable")]);
  });

  it("/help lists /models", () => {
    expect(HELP_TEXT).toContain("/models");
  });
});
