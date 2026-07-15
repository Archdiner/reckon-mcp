# Reckon v5 — Comprehension Loop (design doc)

**Status:** draft, 2026-07-15
**Supersedes:** the "decision-checkpoint" framing of v0–v4 (does not necessarily delete it — see §7)
**One line:** Reckon stops being an *interrupter that makes you commit a position* and becomes a *comprehension loop that verifies you can actually explain what your agent built — and makes you learn it if you can't.*

---

## 1. Why v5 exists (the pivot)

The v0–v4 product is built around the **fork**: at a decision point, make the human commit a position before the agent reveals its take. That mechanic is real and occasionally saves you (it killed a speculative vector DB this very session). But three things broke under stress-testing:

```
  1. FALSE FORKS      it stops you at sequencing points that aren't real
                      decisions ("build next step? y/n") → alarm fatigue
                      → you rubber-stamp the real ones.

  2. UNVERIFIED       commit-blind → reveal an UNAUTHORITATIVE guess →
     REVEAL           "oh sure ok" → no learning actually happens.

  3. WRONG UNIT       it's anchored to typing/deciding. In a multi-agent,
                      better-AI world the durable human job isn't typing —
                      it's UNDERSTANDING what the fleet shipped.
```

**The invariant that survives all of it** (the human's own landing): *at every altitude, you should be able to explain what your agent is doing.* Feynman technique — reason it through, articulate it back, get quizzed later, wire it in.

**The scientific spine** — Illusion of Explanatory Depth (Rozenblit & Keil 2002): people rate their understanding as high *until asked to produce the mechanism*, at which point it collapses ~0.9 pts. That measurable gap between "I get it" and "I can explain it" is the thing Reckon sells.

---

## 2. Target architecture — the comprehension loop

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                    │
   │   agent plans / builds                                             │
   │          │                                                         │
   │          ▼                                                         │
   │   ① ELICIT ─────── mechanism prompt, NOT procedure                 │
   │          │         "why does this work / what breaks if changed?"  │
   │          ▼                                                         │
   │   ② GRADE ──────── isolated subagent · different model             │
   │          │         7-dim rubric (silent) · reference-guided        │
   │          │         surfaces the ONE hole, never a scorecard        │
   │          │                                                         │
   │      pass │ fail-gate                                              │
   │          │    │                                                    │
   │          │    ▼                                                    │
   │          │  ③ RESCUE ── source available (marked ASSISTED)         │
   │          │    │         chill tone: "close — dig into WHY X, retry"│
   │          │    └──► re-explain ──► back to ②                        │
   │          ▼                                                         │
   │   ④ VERIFY / RECALL ── logged now; re-quizzed COLD later           │
   │                        (source gone) = the real retention test     │
   │                                                                    │
   └──────────────────────────────────────────────────────────────────┘
```

### ① Elicit
- **Mechanism prompt, not procedure.** "Walk me through the steps" does NOT trigger the illusion of explanatory depth; "why does this work, and what breaks if done differently?" does. The elicitation question is what makes the grade meaningful.
- Altitude flexes with the work: throwaway demo → explainable in one breath (barely fires); systems-critical → explain the mechanism deeply. **The care-gate solves itself** — trivial work is trivially explainable, so Reckon stays light without a manual "off" switch.

### ② Grade — the isolated grader (settled this session)
```
  WHERE   a separate subagent (Claude Code Task/subagent primitive)
  MODEL   a DIFFERENT model than the one that wrote the code
  SEES    ONLY (plan/diff as ground truth  +  the human's explanation)
  NOT     the main session, the code-writing reasoning, prior turns
  WHY     isolation does double duty:
            · token efficiency (bounded context, no session replay)
            · TRUST — blind to the "answer" it can't rubber-stamp;
              grading is a COMPARISON task, harder to fake than generation
```
Research-backed judging hygiene (baked in):
- **reference-guided** — always feed the grader the actual diff/plan as ground truth (antidote to leniency + catches claims the artifact contradicts).
- **reason-before-scoring** (G-Eval CoT) — reason through each rubric dim, then score.
- **don't self-judge** — grader model ≠ coding-agent model (kills self-preference/sycophancy).
- **surface ONE hole** phrased as a re-explanation prompt — never a 7-row scorecard.

### ③ Rescue (settled this session)
- **Source stays available.** Removing it is detrimental — without it a stuck human can't learn at all; the source is the loop's *exit ramp to learning*, not a cheat.
- **BUT** a source-open answer is **marked `ASSISTED`** — because reading-and-parroting with the doc in front of you is *environmental support*, the exact illusion-of-depth trap. High source-overlap = restatement = still slop.
- **Tone is chill/positive** throughout: "you're close — dig into why X breaks, take another pass."

### ④ Verify / Recall (the temporal loop — Reckon's moat)
- The thing nobody else owns: the decision/explanation **resurfaces COLD, later, source gone.** That's the real retention test.
- `ASSISTED` passes are re-quizzed **harder / sooner** — you leaned on the source, so you owe a cold pass.
- Hold it cold → learned. Can't → it resurfaces again. This is where "connect neural pathways" actually happens.

---

## 3. Rigor levels (settled this session)

```
  ✗ GENTLE   deleted. does not exist. feel-good, catches nothing.
  ● MEDIUM   the FLOOR (default). the minimum difficulty that still
             produces beneficial learning. cannot dial below this.
  ▲ HARSH    opt-in ceiling. higher bar, blocks on gate-fail, demands
             a real second pass.
```
The floor is the whole trick: self-picked rigor is fine **because you can only opt UP, never below beneficial.** Kills the adverse-selection flaw (dialing down exactly when you're weakest).

---

## 4. The grading rubric (research-backed — Chi, Russ, SOLO, IOED)

7 dimensions, score each 0–2, **★ = hard gate** (fail one → slop regardless of total):

```
  ★ MECHANISM (why/how)   entities + activities + causal chain, not "what changed"
  ★ INFERENCE-beyond      rationale NOT in the artifact; not a paraphrase / echo
  ★ CORRECTNESS           matches what the code/plan actually does
    COVERAGE              hits the decision the outcome hinges on (not trivia)
    INTEGRATION           connects the parts (≠ coverage — can name all, explain none)
    TRADEOFFS             what was chosen against, and why
    SELF-MONITORING       flags own uncertainty honestly
```
Sharpest single signal (Chi): **overlap with the source.** Low-overlap + high-inference = understanding; high-overlap = restatement = slop. Coverage and integration are scored *separately* or a name-everything-explain-nothing answer sails through (SOLO multistructural trap).

---

## 5. Current system inventory (what exists today)

**Two parallel implementations exist — and the deployed one is NOT this repo.**

```
  DEPLOYED / ACTIVE  →  ~/.reckon/  +  ~/.claude/…      (call it v0)
  IN-PROJECT / STALE →  ./mcp-server/ + ./reckon-*.js   (call it v2, OLDER)
```

### v0 — `~/.reckon/` (active, registered, richer)
| File | Role |
|---|---|
| `server.js` | MCP server; 13 tools (fork/commit/reconcile/classify/diff_open/get_log/leak_health/get_due_for_recheck/record_review + build-arc: intent/verify/probe + set_session) |
| `primitive.js` | commit→reveal→reconcile core; `classifyResponse` position/abdication gate; `grade` (deterministic) |
| `classifier.js` | diff → shouldCheckpoint (import-add or >40 lines) |
| `db.js` | SQLite (`reckon.db`); recall scheduling (FSRS-like), earned-delegation (embed cosine), reviews, intents |
| `hook.js` | PreToolUse hook (Edit/Write/MultiEdit); classify → tty checkpoint; abdication block; always allows |
| `render.js` | ASCII diff/checkpoint rendering |
| `fork-guard.js` | UserPromptSubmit nudge — **defined, NOT registered** |
| `recall-hook.js` | **exists, NOT wired** |
| `weekly-review.js` | CLI-only, not in prod flow |
| `reckon.db` | the live ledger (decisions/reviews/intents) |
| `prompts.jsonl` | logged prompts/responses |
| `test/` | real unit + integration suite |
| Registration | `~/.reckon/.mcp.json`, `~/.claude/hooks.json`, `~/.claude/skills/reckon/SKILL.md`, `~/.claude/output-styles/reckon.md` |

### v2 — `./` this repo (stale, unregistered, superseded)
| File | Status |
|---|---|
| `./mcp-server/{server,primitive,classifier,storage}.ts` | superseded by v0 (no build-arc, no embed, no advanced recall) |
| `./reckon-hook.js`, `./reckon-hook-mcp.js`, `./reckon-fork-guard.js` | not registered; v0 versions are live |
| `./skills/reckon.md` | simpler dup of the registered skill |
| `./test-integration.js`, `./test.txt` | stub / stray |
| `./reckon-design-doc.md`, `./reckon-design-doc-v4.md`, `./README.md` | design history |

---

## 6. DELETE / KEEP / REPLACE (against the v5 target)

```
  KIND      COMPONENT                                    ACTION
  ───────────────────────────────────────────────────────────────────────
  KEEP      Door ③ recall/decay (db.js scheduling,       KEEP — this IS the
            reviews, get_due_for_recheck)                 v5 temporal loop
  KEEP      SQLite storage layer + ledger                 KEEP, extend schema
  KEEP      earned-delegation embed/cosine matching       KEEP (recall matching)
  KEEP      elicit + reconcile scaffolding (primitive)    KEEP the shell, see REPLACE
  KEEP      output-style + skill infra                    KEEP, retune copy
  KEEP      PreToolUse hook plumbing (spawn, tty, ANSI)   KEEP as delivery rail
  ───────────────────────────────────────────────────────────────────────
  REPLACE   grade() deterministic char-count scoring      → isolated 7-dim LLM
                                                             grader subagent (§2)
  REPLACE   "reveal agent's withheld take" mechanic       → grade explanation vs
                                                             ground truth (§7 gates this)
  REPLACE   classifier thresholds (40 lines/import)       → explanation-worthy
                                                             decision-point detection
  ADD       elicitation (mechanism-prompt) stage          new
  ADD       rescue (source + ASSISTED flag) stage         new
  ADD       rigor levels (medium floor / harsh opt-in)    new
  ADD       ASSISTED → harder cold-recall scheduling      new (extends Door ③)
  ───────────────────────────────────────────────────────────────────────
  DELETE    entire ./mcp-server/ (v2, stale, unregistered)  DELETE after §7
  DELETE    ./reckon-hook.js, ./reckon-hook-mcp.js,          DELETE (dup)
            ./reckon-fork-guard.js
  DELETE    ./skills/reckon.md (dup of registered)           DELETE
  DELETE    ./test-integration.js, ./test.txt                DELETE (stub/stray)
  DELETE    ~/.reckon/weekly-review.js                        DELETE (out of scope)
  RESOLVE   ~/.reckon/fork-guard.js, recall-hook.js           wire-or-delete
            (defined but never registered)                    (dead as-is)
  RESOLVE   two DBs (reckon.db active, decisions.db v2)        consolidate to one
```

**Hygiene fix (the "no remnants" ask):** the deployed source lives in `~/.reckon/` but development happens here. That drift is the root bloat. v5 should **make this repo the single source of truth** and deploy `~/.reckon/` FROM it (build/install step), so there's one codebase, not two that silently diverge.

---

## 7. The one open decision (yours to make — not pinned here)

Everything above assumes the comprehension loop is the product. The unresolved fork is **its relationship to the existing fork/decision-checkpoint machinery:**

```
  PIVOT   explanation-grading REPLACES the fork mechanic.
          delete commit→reveal→reconcile forks. one loop, comprehension-only.
          → maximal simplicity; loses the decision-time judgment elicitation
            that caught the measure-first save this session.

  LAYER   explanation-grading is a NEW door ALONGSIDE forks.
          forks = decision-time judgment; grading = post-build comprehension.
          → keeps both values; more surface area, two mechanics to maintain,
            and the false-fork/fatigue problem still needs solving on the fork side.
```

This decision changes two rows in §6 (the `REPLACE "reveal…"` and whether the fork tools survive). **It's a real architecture fork — flagging, not deciding.**

---

## 8. Open build questions (sequencing, once §7 is settled)
- Decision-point detection: what makes a moment "explanation-worthy" (the §6 classifier replacement) — deterministic taxonomy, model-judgment, or hybrid? (earlier terrain: pure taxonomy misses omissions + strategy forks.)
- Grader model choice + cost per grade (isolated subagent token budget).
- Rubric calibration: hand-label a sample, tune grader to human agreement (Cohen's κ) before trusting at scale — non-optional per the LLM-judge research.
- Cold-recall cadence for `ASSISTED` vs clean passes (extend `recallInterval`).
- Delivery surface: terminal ASCII confirmed (no external app, no flow interruption).
```
