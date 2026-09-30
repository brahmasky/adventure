// Idea Radar R2 panel seats (ADR 0027, spec §§1–2; omp runtime spec §8): the three judges and the
// chair are omp one-shot seats — tool-less, session-less, subscription legs under the `houge`
// profile. Each JUDGE is pinned to ONE model string by index (`HOUGE_OMP_JUDGES`), never a chain:
// a healthy-leg fallback would silently void model diversity and the quorum semantics. The CHAIR
// rides `HOUGE_OMP_CHAIR`. Both the daemon tick and `houge radar-panel` build their seats HERE, so
// the two sites cannot drift apart (the CLI site once kept firing metered APIs after the daemon moved).
import { judgeSeat, oneShotAdapter, seatChain, type OneShotAdapterOptions } from "../llm/registry.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RunStore } from "../run/run-store.js";
import type { PanelSeat } from "./idea-panel.js";
import type { RadarLlm } from "./idea-radar.js";

/** Which `HOUGE_OMP_JUDGES` index serves which named judge (default kimi-code/k3, openai-codex/gpt-5.5, gemini-3.1-pro). */
export const PANEL_JUDGE_SEAT_INDEX = { kimi: 0, codex: 1, gemini: 2 } as const;

export interface PanelSeatBindings {
  judges: { kimi: RadarLlm; gemini: RadarLlm };
  codexJudge: PanelSeat;
  chair: PanelSeat;
}

export interface OmpPanelSeatsInput {
  store: RunStore;
  /** The run-less audit scope (`tick:idea_panel`, `cli:radar-panel`). */
  correlation_id: string;
  env: NodeJS.ProcessEnv;
  /** Tests only: bypass the `omp --version` spawn. */
  versionCheck?: OneShotAdapterOptions["versionCheck"];
}

/** The four panel seats on omp. A seat never throws into the tick: every failure is `{ok:false}`. */
export function buildOmpPanelSeats(input: OmpPanelSeatsInput): PanelSeatBindings {
  const cfg = resolveOmpConfig(input.env);
  const opts = input.versionCheck ? { versionCheck: input.versionCheck } : {};
  const seat = (role: "judge" | "chair", chain: ReturnType<typeof seatChain>) => {
    const one = oneShotAdapter(input.store, cfg, { correlation_id: input.correlation_id, role }, undefined, { ...opts, chain });
    return async (question: string, system: string): Promise<{ ok: true; answer: string } | { ok: false; unavailable?: boolean }> => {
      if (chain.length === 0) return { ok: false, unavailable: true };
      try {
        const r = await one.answer({ question, system });
        return r.ok ? { ok: true, answer: r.answer } : { ok: false, ...(r.unavailable ? { unavailable: true } : {}) };
      } catch {
        return { ok: false };
      }
    };
  };
  const judge = (name: keyof typeof PANEL_JUDGE_SEAT_INDEX) => seat("judge", judgeSeat(cfg, PANEL_JUDGE_SEAT_INDEX[name]));
  const kimi = judge("kimi");
  const gemini = judge("gemini");
  const codex = judge("codex");
  const chair = seat("chair", seatChain(cfg, "chair"));
  return {
    judges: {
      kimi: async (i) => { const r = await kimi(i.question, i.system); return r.ok ? r : { ok: false }; },
      gemini: async (i) => { const r = await gemini(i.question, i.system); return r.ok ? r : { ok: false }; }
    },
    codexJudge: (i) => codex(i.digest, i.system),
    chair: (i) => chair(i.digest, i.system)
  };
}
