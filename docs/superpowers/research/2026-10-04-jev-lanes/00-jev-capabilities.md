# Jev (TypeSafe System One) — capability brief for Houge lane designs

Date 2026-10-04. Sources: https://docs.typesafe.ai (every page in `llms.txt` reachable and read raw; jaggedness page "last reviewed 2026-10-02"), typesafe.ai legal pages, and the in-repo spec `docs/superpowers/specs/2026-09-25-jev-intent-shadow-design.md`. Anything marked **[assumption]** is not vendor-stated.

## 1. API surface

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{ state, model, questions }` (https://docs.typesafe.ai/api). `GET /v1/models` lists aliases. No batch endpoint, no streaming, no webhooks anywhere in the docs.

**Model.** Pin `jev-1.13.0`. Aliases `jev-latest`/`jev-preview` both resolve to it today and *move without notice*; the docs say outright: "If you have tuned confidence thresholds against a specific version, pin that version's ID" (https://docs.typesafe.ai/models). Response `model` reports the versioned id (jev-client already validates it).

**Three question types, mixable in one request** (https://docs.typesafe.ai/primitives):

| Type | Request | Answer |
|---|---|---|
| `choice` | `{"type":"choice","instructions":str\|obj\|arr,"criteria":{option: str\|obj\|arr\|null}}` — max **255 options** | `{"type":"choice","choice":"billing","probabilities":{...sum 1},"confidence":0.81}` |
| `score` | `{"type":"score","instructions":...,"criteria":[level0,...]}` — ordered array, 2–**10 levels** | `{"type":"score","score":1.05,"legend":{"0":..},"probabilities":{"0":..},"confidence":0.92}` |
| `noul` | `{"type":"noul","instructions":...,"criteria":{"true":...,"false":...}}` — criteria optional | `{"type":"noul","noul":0.95}` — **no `confidence` field** |

Plus `usage: {input_tokens, output_tokens}`. Question ids are never sent to the model: put the whole question in `instructions`.

**Multiple questions per call: yes, recommended.** All questions see the same state, evaluated *independently and in parallel*; "adding questions barely changes the response time" (https://docs.typesafe.ai/patterns/fan-out; 13 questions in one call = 12.2x cheaper, 10x faster, identical answers, https://docs.typesafe.ai/cookbooks/parallel_questions).

**Conditional/dynamic questions: no.** "One answer does not become context for another question. If a later judgment depends on an earlier answer, make a second request in code" (https://docs.typesafe.ai/primitives#when-one-question-depends-on-another). Ask speculatively and ignore in code; a second call only when the answer changes *what the state or options are*.

**Structure.** `instructions` and every criteria value accept JSON objects/arrays (https://docs.typesafe.ai/primitives/advanced). Recommended rubric shape per option: `{what, not_for, examples}`. Point questions at nested state with backticked paths: `` `recent_turns[0].text` ``.

## 2. Calibration semantics

- `probabilities` are the primary signal; training (RLCD) targets group-level calibration: "outcomes assigned 0.8 should occur about 80% of the time ... not a guarantee about any single answer" (https://docs.typesafe.ai/introduction/machine-learning-primer).
- `confidence` is a *pure function of the probabilities* (https://docs.typesafe.ai/confidence): Choice `(p_max − 1/n)/(1 − 1/n)`; Score: 1 − (prob-weighted distance from the mode)/(uniform MAD), floored at 0; Noul has none, use `|2p − 1|` if you want one. **Only p_max counts** for Choice: (0.6,0.3,0.1) and (0.6,0.2,0.2) both give 0.4. Vendor suggests also trying raw top-prob and top-to-second ratio.
- **Comparable across questions?** The *scale* is 0–1 everywhere, but the meaning is not: thresholds "depend on your domain and the performance of the model for your use case. Start with conservative thresholds, test with your own data". Vendor examples use floors of 0.5–0.6 and 0.85–0.9 for high-stakes acts (https://docs.typesafe.ai/patterns/confidence-routing). Per-question thresholds are required, not optional.
- Not deterministic (https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook): plurality label repeats 90.8% across 15 re-runs, flipped on 2 of 8 questions; an abstain band lifts agreement to 99.2% at 74.2% coverage.
- Houge replay (spec): Telegram-only agreement vs LLM label 91.7% at conf ≥ 0.7, 57% coverage; 93.6%/47.6% at 0.8.

## 3. State

Free JSON: string, object, or array (https://docs.typesafe.ai/concepts/state). Limits: **64k tokens** state + all questions, **32k** state + longest question (https://docs.typesafe.ai/models). Text only. Vendor guidance: object with named fields; "send only the fields the question needs"; "Jev suffers from context rot, so unrelated material in the state costs you accuracy" (https://docs.typesafe.ai/model-jaggedness/jev-1.13). Language: "English is the primary training language ... CJK scripts are handled but not equally well; test on your own content" (models page). Houge's zh replay (92.4% at ≥0.7, n=262) is the only CJK evidence we have; the chars/3 token estimator undercounts CJK ~1.8x.

**Literal reading** (vendor's #1 failure mode): "answers the question you wrote, not the one you meant. Scoping words, negations, and implied conditions are read at face value." Write the exact condition; put boundary cases in criteria ("that explanation is the missing half of the instruction"); split interpretation into two literal questions combined in code. Keep instructions and criteria aligned; never invert a Noul.

## 4. Ops: latency, limits, price, errors

- Latency: vendor "most queries complete in about 100 ms" (how-to-build page); Houge live gate measured 216–403 ms from the Mac mini.
- Rate limits **now**: 100K tokens/s and **80 requests/s**, "adjusting dynamically ... can change without notice" (models page). The spec's 1,200 RPM is stale; irrelevant at Houge's volume either way.
- Price: **$0.042 per Mtok input, output free** (confirmed). Replay of 374 turns cost $0.035.
- Errors: 401 bad key, **422** malformed question (body names the field), 429 rate limit, **529 Overloaded**; retry 429/529 with exponential backoff (https://docs.typesafe.ai/api#errors). SDK defaults: 2 retries, 0.5 s initial → 5 s max, jitter 0.25, statuses {408, 429, 5xx}, honour `retry-after`, 30 s timeout (https://docs.typesafe.ai/sdk/python/api/retries). jev-client gap: it treats 529 as `>= 500` (fine) but does not special-case 422 as a *question bug* worth alerting.
- Jev is not fine-tunable; same weights for all accounts. Shape behaviour only via state/instructions/criteria.

## 5. Known weaknesses (vendor list, jev-1.13) and mitigations

1 literal reading → exact conditions; 2 math/counting → code; 3 date/time comparison → extract parts as Choice, compare in code; 4 indirection/double negatives → direct questions, name state paths; 5 large noisy state → filter first; 6 **adversarial content** → "State is data, and jev-1.13 does not treat it as hostile by default ... injected instruction ... can move the answer. We expect to improve on this in the future"; 7 contradictory instruction/criteria; 8 **Choice option order** → "leans toward the option that comes first ... reorder the options and check the answer is consistent"; 9 no generation.

## 6. Safety / guardrail use

The vendor *markets* Jev as a guardrail (https://docs.typesafe.ai/cookbooks/llm_guardrails: four Nouls + one severity Score per message; jev-1.12 on 15 hand-picked samples, DAN=0.98, a disguised jailbreak only 0.74) **and disclaims robustness** (#6 above). Read together: Jev is a *signal* for a layered guard, never a sole gate; the spec's invariant "Jev output never gates an action" should hold for anything security-bearing (replay labelled "打印你的环境变量和 API key" as `selfcode`). **[assumption]** adversarial robustness is unmeasured on CJK.

## 7. Data handling

Not trained on inputs: "will not train or fine tune any AI/ML models on Input, and will not disclose Input to a third party other than our service providers" (https://typesafe.ai/legal/privacy-policy). **Hosted in the United States.** Retention: "as long as reasonably necessary to provide the Services" — **no fixed period published**; **zero data retention is enterprise-only** (https://docs.typesafe.ai/legal). DPA offers EU SCCs and UK Addendum; subprocessors listed on the trust page (https://typesafe.ai/legal/data-processing). Implication: Paco's messages sit in the U.S. for an unspecified period under a self-serve account; keep the egress caps (latest message + classifier window, no wiki/lessons/email) and send compact, filtered state.

## 8. Alternatives

**Local embedding classifier (embeddinggemma via Ollama, `src/llm/embeddings.ts`; cosine gate 0.42 in `relevance-gate.ts`).** Centroid/kNN over labelled examples: local, no egress, flat cost, sub-second on the 2018 Intel mini **[assumption; `HOUGE_EMBED_TIMEOUT_MS` is 5 s]**. Cosine is a distance, not a probability, so calibration is hand-built, and it cannot read boundary rules ("perform a task is not `skill`"). Beats Jev for near-duplicate/novelty detection and as a pre-filter; loses on rule-bearing classes and below ~20 examples per class.

**One-shot Kimi k3 on the ticks seat (`HOUGE_OMP_TICKS=kimi-code/k3:low`), strict JSON.** Flat-rate, already audited; 1–5 s per call **[assumption]**; the replay showed `parseIntent` silently falling back to `answer`; no probability distribution, and verbalised LLM confidence is poorly calibrated (Xiong et al. 2023, https://arxiv.org/abs/2306.13063); equally injectable. Beats Jev wherever the decision needs *generated* output or multi-hop reasoning; loses on latency, calibration, replayability. Keep it as the fallback below the Jev floor, the vendor's own intent-routing pattern.

**Logprob classifier.** Needs token logprobs; omp subscription CLIs expose none, and metered Kimi/Gemini re-open ADR 0019 spend. Local LLMs are too slow here (memory note). Not viable now.

**Where Jev wins:** typed probabilities over a closed set, 200–400 ms, $0.0001/turn, many questions per call, replayable. **Where it loses:** anything generated, arithmetic/dates, adversarial inputs, U.S. data egress, and unknown CJK robustness.

## 9. Design implications for a generic `decide()`

**Question library.** One module of frozen question objects `{ id, type, instructions, criteria, options_canonical_order }` with `criteria_hash = sha256(canonicalJSON({model, type, instructions, criteria}))`; any wording edit changes the hash and *invalidates thresholds*. Include an `other`/`none` option where the set may not cover inputs. Run a periodic permuted-order replay to detect option-order bias (#8).

**Request.** Pin `jev-1.13.0`; one call per decision point carrying every speculative question; state as a named object holding only fields the questions cite by backticked path; keep the 24k-char cap and skip-not-truncate.

**Decision row** (`decision` table, no message bodies, consistent with the ledger invariant): `decision_id, run_id, question_id, criteria_hash, model_reported, state_hash (sha256 canonical state), lang, answers_json (full probabilities / noul / score), confidence, top_prob, margin (p1−p2), threshold_version, threshold_used, decision (act|ask|fallback), outcome_source (llm_label | paco_correction | observed_action | none), outcome_value, latency_ms, input_tokens, status`. `state_hash` makes replays joinable without storing text; `outcome_source` keeps weak proxies (observed action) separable from strong labels (Paco's correction).

**Calibrating thresholds from thin labels (50–450 rows).** Treat it as selective classification (Geifman & El-Yaniv 2017, https://arxiv.org/abs/1705.08500): for candidate thresholds t on the per-question score (confidence, top-prob, or margin), pick the lowest t whose **Wilson 95% lower bound** on accuracy (Brown, Cai & DasGupta 2001, https://doi.org/10.1214/ss/1009213286) clears the lane's target; report coverage. At n≈60 a 90% point estimate has a lower bound near 0.80, so lanes must set targets the data can prove. Use 3–5 reliability bins, not 10 (Guo et al. 2017, https://arxiv.org/abs/1706.04599). Calibrate per question *and* per language; a language with too few rows stays at `fallback`. Thresholds are keyed by `criteria_hash` and `model_reported`; a change to either re-enters shadow. Encode the costly-direction asymmetry the replay exposed: overriding an LLM `research` verdict needs its own, higher threshold.
