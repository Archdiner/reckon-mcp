# SCENARIO — Chunking / granularity of the v5 plan-gate

**Question being grounded:** when a big multi-decision plan hits `reckon_explain(stage="plan")`,
should we keep the one-swoop "explain all of this" (A), decompose into every load-bearing
decision (B), check only the top 1-3 (C, current lean), or check the riskiest now and defer
the rest to recall (D)?

**Method:** drove the DEPLOYED server (`/Users/asadr/.reckon/dist/server.js`) over stdio
JSON-RPC with `RECKON_HOME=/tmp/reckon-scenario`. Wrote 3 realistic coding-agent plans,
inventoried the decisions in each (instant), captured the exact `reckon_explain` prompt for
all 3, and ran 2 REAL grader calls (`claude -p --model claude-haiku-4-5`) on realistic
human explanations. Harness: `scenario-chunking-harness.mjs` (read-only; no source edited).

---

## Mechanical finding that frames everything

`reckon_explain` returns a FIXED template prompt (`elicit.ts::elicitPrompt`). It embeds only
`concept` + `subsystem` — it does **not** embed the plan text and does **not** vary with plan
size or decision count. Verified live for all three plans; the prompt was byte-identical
modulo the concept slug:

```
Before I build <concept> in <subsystem> — explain the plan back to me.

Not the steps — the MECHANISM:
  • why does this approach work?
  • what would BREAK if it were done differently?

In your own words, from your own head. A real swing beats a polished echo.
```

So TODAY, a 10-decision plan and a 1-decision plan produce the identical single ask. The
entire plan is collapsed into one undifferentiated "explain the plan back to me." The whole
`ground_truth` is stored and only ever seen by the grader (truncated to 8000 chars). **The
prompt has no notion of "a decision" at all** — that is the design fact options B/C/D would
each have to add.

---

## Scenario 1 — "Build a full-stack app" (Tasker)

Plan (1834 chars): Next.js App Router + RSC / TS / Tailwind / shadcn; TanStack Query;
react-hook-form + shared zod; tRPC API split by domain + Upstash rate limit; Postgres/Neon
via Prisma with a task_assignments join + status enum + soft-delete + composite index;
NextAuth DB-backed sessions with GitHub/Google/magic-link; Vercel + Neon preview branches +
Sentry.

### Decision inventory — 10 distinct load-bearing decisions

| # | Decision | Load-bearing? |
|---|----------|--------------|
| 1 | Next.js App Router + RSC as the frontend model | yes |
| 2 | TanStack Query for client cache/optimistic updates | medium |
| 3 | Shared zod schemas (validate once, both sides) | yes |
| 4 | tRPC (type-inferred) vs REST/OpenAPI codegen | **yes — dominant** |
| 5 | Rate limiting at edge via Upstash Redis | low |
| 6 | Postgres/Neon + Prisma as the store | yes |
| 7 | Schema shape: join table + status enum + soft-delete + composite index | yes |
| 8 | NextAuth **DB-backed sessions vs JWT** | **yes — dominant** |
| 9 | Vercel deploy + Neon branch-per-preview | medium |
| 10 | Observability (Vercel Analytics + Sentry) | low |

**Is there a clean top-1-3?** Partially. Two decisions clearly dominate (tRPC type-safety,
DB-sessions-vs-JWT) — these are the ones with a sharp "what breaks if done differently."
But the remaining ~8 are NOT negligible and NOT cleanly rankable against each other: the
schema/index decision, the RSC decision, and the preview-branch decision are all real,
roughly co-equal, and domain-independent of the top 2. It's "2 spikes + a flat tail of 6,"
not a clean 3-and-done.

### The one-swoop prompt

Exactly the fixed template above (concept = "the plan for …", subsystem = "architecture").
**Asking a human to answer this in one go = "give me the mechanism and the road-not-taken
for a 10-decision full-stack architecture, in one breath."** That is overwhelming as a
literal ask — no dev holds tRPC-vs-REST, JWT-vs-session, RSC hydration, index selectivity,
and preview-DB isolation all at mechanism depth simultaneously. In practice the human will
self-select the 2-3 they know (see PART 2), which the prompt neither guides nor rewards.

### PART 2 — real grade (LATENCY 76.9s)

Human explanation: deep mechanism on tRPC type-safety (#4) and DB-sessions-vs-JWT (#8),
explicitly vague on the other ~8 ("I think RSC helps initial load somehow"; "honestly fuzzy
on why a DB branch per preview"; "not sure what the composite index buys").

```
pass: TRUE   overlap: medium
mechanism:1  inference:2  correctness:2  coverage:1
integration:1  tradeoffs:2  self_monitoring:2
hole: (none — passed)
```

**Grader behavior on the big input:** it did NOT flail and did NOT return an incoherent
multi-topic hole. It rewarded the 2 deeply-explained decisions (inference 2, tradeoffs 2),
docked `coverage` to 1 for the 8 skipped decisions, and **passed anyway** — the 3 gates
cleared on the strength of 2 areas out of 10. The honest "I'm fuzzy on X" earned
`self_monitoring: 2` rather than a penalty. Scores are coherent, but they are scores of
"did the human explain SOMETHING well," not "does the human understand THIS PLAN."

---

## Scenario 2 — "Design/refactor the database" (events/analytics)

Plan (2162 chars): Postgres 16 OLTP + ClickHouse columnar for the event firehose; Debezium
CDC over the WAL → Kafka → ClickHouse; 3NF for OLTP, denormalized wide event table;
btree FKs + (org_id,created_at) in PG, MergeTree ORDER BY (org_id,event_type,timestamp) +
bloom skip-index on user_id in CH; shard by org_id hash, x2 ReplicatedMergeTree, 90-day TTL
to S3, daily rollup materialized view.

### Decision inventory — 9 distinct load-bearing decisions

| # | Decision | Load-bearing? |
|---|----------|--------------|
| 1 | Split by access pattern: Postgres OLTP + ClickHouse OLAP | **yes — dominant** |
| 2 | CDC (Debezium WAL→Kafka) as the sync mechanism vs app double-write | yes |
| 3 | 3NF OLTP vs deliberately denormalized events | yes |
| 4 | ClickHouse ORDER BY (sort key) as the primary "index" | **yes — dominant** |
| 5 | Bloom-filter skip index on user_id | low |
| 6 | JSONB (PG) vs Map + materialized columns (CH) for properties | medium |
| 7 | Shard by org_id hash vs by time | yes |
| 8 | x2 ReplicatedMergeTree for HA | medium |
| 9 | 90-day TTL tiered to S3 + daily rollup materialized view | yes |

**Is there a clean top-1-3?** Same shape: 2 dominant (the OLTP/OLAP split, the sort-key-as-
index) with a sharp "what breaks," plus ~7 real-but-co-equal decisions (CDC, sharding key,
TTL/rollup, normalization) that a "top 3" would have to arbitrarily truncate. Sharding-by-
org_id and TTL/rollup are genuinely load-bearing yet would fall outside a top-3 cut.

### PART 2 — real grade (LATENCY 57.1s)

Human explanation: deep on the OLTP/OLAP split (#1, with the row-vs-column disk mechanism)
and the sort-key-as-index (#4, with the "wrong sort key = full scan" failure mode), plus
correctly named CDC as the sync path; explicitly vague on sharding-key choice and on what
the rollup saves.

```
pass: TRUE   overlap: medium
mechanism:2  inference:2  correctness:2  coverage:1
integration:2  tradeoffs:1  self_monitoring:2
hole: (none — passed)
```

**Grader behavior:** clean, coherent, fast, single verdict. Again `coverage: 1` (7 decisions
un-articulated) but a PASS because the gates cleared on 2 well-explained decisions. No
flailing across the 9 topics; the grader effectively latched onto the strongest thread and
graded that.

---

## Scenario 3 — "Deploy on AWS" (PART 1 only)

Plan (1989 chars): ECS Fargate (vs EC2/EKS); ALB with ACM TLS + path routing; ECS target-
tracking autoscaling on CPU 60% + RequestCountPerTarget, min2/max20; VPC public/private
across 2 AZs + NAT + the ALB→task→RDS security-group chain; Secrets Manager injection via
task-def + scoped IAM + Lambda rotation; Terraform with S3/DynamoDB state.

### Decision inventory — 9 distinct load-bearing decisions

| # | Decision | Load-bearing? |
|---|----------|--------------|
| 1 | Fargate vs EC2 vs EKS (compute model) | **yes — dominant** |
| 2 | ALB + ACM TLS termination + path routing | yes |
| 3 | Dual autoscaling signal (CPU + RequestCountPerTarget) | yes |
| 4 | Public/private subnet split across 2 AZs | yes |
| 5 | The SG defense-in-depth chain (ALB→task→RDS) | **yes — dominant** |
| 6 | NAT gateway for private-subnet egress | medium |
| 7 | Secrets Manager injection vs baked env vars + scoped IAM | yes |
| 8 | Secret rotation via Lambda | low |
| 9 | Terraform + S3/DynamoDB remote state locking | medium |

**Is there a clean top-1-3?** Same again: 2 clear spikes (Fargate choice, the SG chain) +
~7 real co-equal decisions. Autoscaling-dual-signal and Secrets-injection are genuinely
load-bearing and would be cut by a top-3.

### The one-swoop prompt (captured live)

```
Before I build deploy the API service on AWS in infrastructure — explain the plan back to me.
Not the steps — the MECHANISM:
  • why does this approach work?
  • what would BREAK if it were done differently?
...
```

Asking one human to give the mechanism + counterfactual for all 9 (compute model, TLS,
dual-signal scaling, subnet topology, the SG chain, NAT, secrets injection, IAM scoping,
rotation) in one answer is the same overwhelming ask.

---

## Cross-scenario datum: how many decisions does one "plan" contain?

```
                       distinct       clear      remaining co-equal
scenario               load-bearing   "spikes"   load-bearing tail
─────────────────────────────────────────────────────────────────
full-stack app             10           2              ~6
database refactor           9           2              ~7
AWS deploy                  9           2              ~7
─────────────────────────────────────────────────────────────────
PATTERN: ~9-10 decisions, "2 spikes + a flat tail of ~7", every time.
```

The shape is remarkably consistent: **each realistic "plan" is ~8-10 load-bearing decisions,
with 2 that dominate and a long flat tail of ~7 that are individually real and not cleanly
rank-orderable against each other.**

---

## VERDICTS

### (a) Is one-swoop (A) actually too much? — YES as an ASK, but the grader survives it.

Two separate things, and they diverge:

```
                     ┌─────────────────────────────────────────────┐
  THE PROMPT (ask)   │  overwhelming. One fixed "explain the whole  │
                     │  plan" for 9-10 decisions. No human holds     │  ✗ too much
                     │  all of them at mechanism depth at once.      │
                     └─────────────────────────────────────────────┘
                     ┌─────────────────────────────────────────────┐
  THE GRADER         │  handled the big input FINE. Coherent single │
                     │  verdict, no flailing, 57-77s. But it passes  │  ⚠ passes
                     │  on 2-of-10 coverage — coverage:1, gates clear│    partial
                     └─────────────────────────────────────────────┘
```

- The **prompt** is too much: it demands a breadth no human answers, so the human silently
  narrows to the 2-3 they know. Option A leaves that narrowing invisible and ungoverned.
- The **grader** is NOT overwhelmed — this is the honest surprise. On both real grades it
  returned one coherent hole-or-pass, sane per-dimension scores, in <80s. It did not spray
  a 10-topic critique. **If you feared the grader would flail on big input, it does not.**
- BUT the grader passing is itself the problem for A: a human who understands 2 of 10
  decisions PASSES the whole plan. `coverage: 1` is the only signal that 8 went unexamined,
  and coverage is a non-gate — it cannot fail the check. **A lets 80% of a plan through
  ungrasped as long as 2 decisions are explained well.** That is the real cost of one-swoop:
  not grader failure, but a false "you understand this plan."

### (b) Do real plans have a clean top-1-3 (supporting C)? — NO, not cleanly.

```
  decision weight profile (all 3 scenarios):

   weight │ ██                        <- 2 dominant "spikes"
          │ ██
          │ ██ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓   <- ~7 real, co-equal tail
          │ ██ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░ ░  <- 2-3 genuinely minor
          └────────────────────────────
             1  2  3  4  5  6  7  8  9 10
```

There IS a clean top-**2** (the spikes have a sharp counterfactual; they're identifiable).
There is NOT a clean top-**3**: the boundary between #3 and #8 is arbitrary. In every
scenario, cutting at 3 drops genuinely load-bearing decisions (schema/index; sharding-key
and TTL/rollup; dual-signal autoscaling and secrets-injection). So **C is well-defined for
"top 2" but under-defined for "top 3," and it hard-drops real decisions in the tail.** If C
ships, it should be "top 2, the spikes" — and even then it silently forgives the tail, same
as A but with less coverage.

### (c) Observations that argue for B or D instead.

**For D (check riskiest now, defer the rest to recall) — strongest evidence:**
- The "2 spikes + flat tail" shape is exactly what D is built for: gate the 2 dominant
  decisions at plan time (they have the sharp what-breaks, they're where a wrong call is
  expensive), and let the ~7-tail decisions resurface as cold recalls over time instead of
  demanding all of them up front.
- The v5 infra already supports this: `scheduleAfterGrade` + `reckon_recall_due` exist. D is
  mostly a decomposition + a "defer" tag on the tail, not new machinery.
- D directly fixes A's real defect (false pass on 2-of-10) without B's cost: you explicitly
  gate the spikes rather than accidentally passing on whichever 2 the human happened to know.

**For B (decompose into every decision) — partial evidence, real cost:**
- The grader per-decision would be sharp (a single-decision explanation is what the rubric's
  mechanism/inference gates were tuned for). Each grade was 57-77s, so 9-10 grades per plan
  = **9-13 minutes of grading per plan gate.** That is almost certainly too heavy for a
  plan-time gate. B is the "correct but unaffordable" option unless grades parallelize AND
  the human is willing to answer 9 mechanism prompts before any code is written.
- B also over-weights the tail: forcing mechanism depth on "NAT gateway for egress" or
  "bloom skip-index" is ceremony; those are the ░ minor decisions.

**Against C specifically:** the data shows "top 3" isn't a natural cut. If you want the C
family, it's "top 2 spikes." But top-2-only shares A's blind spot for the tail — which is
why **D (top-2 now + tail to recall) dominates C (top-2 now, tail dropped):** same up-front
cost, but the tail is retained instead of forgotten.

### One-line synthesis

```
A  one-swoop        → grader copes, but PASSES on 2-of-10 coverage → false "you get it"
B  every decision   → sharp per-item, but ~10min/plan + ceremony on the tail → unaffordable
C  top 1-3          → "top 3" isn't a real cut; = top-2 + drop tail → A's blind spot, less coverage
D  riskiest + defer → matches the 2-spike/7-tail shape; reuses recall infra; fixes A's false-pass  ← evidence favors
```

---

## Notes / honesty

- The grader genuinely does NOT flail on big spanning input — both real grades were clean,
  coherent, single-verdict, <80s. If the design worry was "big plan breaks the grader," that
  worry is not supported by evidence. The real problem is subtler: it passes on partial
  coverage because `coverage` is a non-gate.
- Both graded explanations were deliberately "strong on 2, vague on ~7" — the realistic
  human profile. Both PASSED. That is the single most decision-relevant datum here.
- Latency: 57.1s and 76.9s (open+grade round-trip, includes `claude -p` cold start). Per the
  budget, 2 real grades were run; scenario 3 was PART-1-only.
- Only files added: this doc + `scenario-chunking-harness.mjs`. No source touched. Isolated
  `RECKON_HOME=/tmp/reckon-scenario`.
```
