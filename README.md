# Reckon

Reckon checks that you can actually explain what your AI coding agent built, before it ships.

It is a Model Context Protocol (MCP) server for Claude Code. When the agent makes a load-bearing decision, Reckon asks you to explain it in your own words. A separate, isolated grader then checks that explanation against the real code. If you are just restating what you were shown, it says so and asks you to try again. Later, it asks you about the same decision again, cold, to check whether it actually stuck.

The idea is simple: if you cannot explain what you shipped, you do not understand it, and you probably should not ship it yet.

## Why

AI agents make it easy to accept code you have not really understood. You read a plan, it looks right, you approve it, it gets built. This is the illusion of explanatory depth: you feel like you understand something until you are asked to explain the mechanism, and then the feeling collapses. Rozenblit and Keil measured this in 2002. Reckon is built on that finding.

Most tools that try to help either explain the code to you, which you passively accept, or make you approve a diff, which does not test understanding at all. Reckon does the opposite. It makes you produce the explanation, and it grades it against the artifact.

## How it works

```
  you (or the agent) reach a decision
        |
        v
  ELICIT   Reckon asks you to explain the mechanism, not the steps:
           "why does this work, and what breaks if it were done differently?"
        |
        v
  GRADE    a separate grader (a different, cheaper model that only sees the
           code and your explanation) scores it against a rubric and returns
           the single biggest gap, not a report card
        |
        v
  RESCUE   if you miss, you can open the source and try again. that answer is
           marked "assisted" and comes back sooner, because reading it off the
           page is not the same as knowing it
        |
        v
  RECALL   later, cold, with the source gone, Reckon asks you again. that is
           the real test of whether it stuck
```

The grader runs in a separate process on a different model than the one that wrote the code. It only sees the code and your explanation, never the original chat. That isolation is the point: it cannot rubber-stamp its own work, and it is cheap because it does not replay the whole session.

## Status

This is experimental and early. It works, it is tested, and it is deployed for the author, but it has not yet been used across many real sessions by many people. That is what this release is for. Expect rough edges. The grader adds real latency, often 30 to 60 seconds per grade, because it spawns a separate model call. The decision triggers are soft, not hard (see Limitations).

## Requirements

- Claude Code (the `claude` CLI), version 2.1 or later
- Node.js 20 or later
- A Claude subscription. The grader runs through `claude -p`, so it uses your existing Claude Code auth. No separate API key is needed.

## Install

```bash
git clone <your-fork-url> reckon
cd reckon/mcp-server
npm install
npm run build
npm run deploy
```

`npm run deploy` does the following, and backs up anything it touches first:

- builds the server and copies it to `~/.reckon`
- points `~/.reckon/.mcp.json` at the built server
- installs the hooks into `~/.reckon/hooks`
- migrates the `hooks` block of `~/.claude/settings.json` to the Reckon wiring, preserving every other setting

Restart Claude Code afterward so it loads the server and the hooks.

To undo a deploy, restore the `.bak-*` files it created (in `~/.reckon` and `~/.claude`).

## Usage

Once installed, the agent calls Reckon on its own at decision points. You do not have to invoke anything. In practice:

- When you approve a plan and the agent leaves plan mode, a hook reminds it to run the comprehension check on the plan before building. You explain the plan back, the grader checks it.
- When the agent makes a load-bearing call mid-session, a standing instruction nudges it to flag that call the same way.

The tools the server exposes:

| Tool | What it does |
|------|--------------|
| `reckon_explain` | opens a checkpoint and returns the prompt to put to you |
| `reckon_grade` | submits your explanation to the isolated grader |
| `reckon_recall_due` | lists past explanations due for a cold recall check |
| `reckon_recall_answer` | grades your cold-recall answer and reschedules |
| `classify` | decides whether a diff is worth a checkpoint |
| `get_log` | reads your explanation history |

### Rigor

There are two levels, and no "easy" mode on purpose:

- `medium` is the floor and the default. The minimum bar that still teaches you something. You cannot go below it.
- `harsh` is opt-in and stricter.

The floor exists so that when you are tired and want to breeze through, the weakest option still holds a real bar. You can dial the difficulty up, never down to nothing.

## How grading works, and privacy

The grader is a `claude -p` call on a small model (Haiku by default). It runs locally through your own Claude Code auth. It sees only the code snippet and your explanation. Your explanations and decision history live in a local SQLite file at `~/.reckon/reckon-v5.db` and never leave your machine. There is no server, no telemetry, no API key.

If the grader cannot run for any reason, it fails open: your explanation is logged but clearly marked ungraded, so an outage never blocks you and never silently pretends to have graded.

## Limitations

Worth being honest about:

- The triggers are soft. The plan-gate hook fires on the "leaving plan mode" signal, which is reliable for planned work. But a session where you just say "proceed" and never enter plan mode has no such signal, so the agent can skip the check. Hardening this to a hard gate is future work.
- Grading is slow. Each grade spawns a separate model call, so budget roughly 30 to 60 seconds.
- The grader is a model, not an oracle. It is good at catching restatement and missing mechanism, but it is not perfect.

## The research behind it

Reckon is not a vibe. Each piece traces to a specific finding:

- Self-explanation effect. Chi, Bassok, Lewis, Reimann, Glaser (1989), and Chi, De Leeuw, Chiu, LaVancher (1994). Explaining to yourself improves understanding, and the quality signal is inference beyond the given, not restatement.
- Illusion of explanatory depth. Rozenblit and Keil (2002). People overrate their understanding until asked to produce the mechanism. This is why Reckon asks for mechanism, not procedure.
- Mechanistic reasoning. Russ, Scherr, Hammer, Mikeska (2008). A real explanation names entities, their activities, and the causal chain.
- SOLO taxonomy. Biggs and Collis (1982). The line between listing correct facts and connecting them into a whole. Reckon scores coverage and integration separately for this reason.
- LLM-as-judge practice. Zheng et al. (2023) and Liu et al. G-Eval (2023). Reference-guided judging, reasoning before scoring, and not letting the author grade its own work.

The full design rationale is in [reckon-design-doc-v5.md](reckon-design-doc-v5.md).

## Development

```bash
cd mcp-server
npm install
npm run build
npm test        # unit tests
```

The grader model can be overridden with `RECKON_GRADER_MODEL`. The ledger location can be moved with `RECKON_HOME` (used by the tests so they never touch your real data).

## Testing

Reckon was battle-tested before this release. Results:

- Unit tests: 10 of 10 pass (loop mechanics, recall scheduling, the rigor floor, ungraded handling).
- Grader efficacy: on a 16-case battery of good versus slop explanations, the grader was correct 15 times, with zero false passes and zero false failures. Every slop type (restatement, confident-but-wrong, names-the-parts-no-mechanism, verbose fluent filler, verbatim parroting) was caught by the correct rubric gate.
- Full loop, end to end: 13 of 13 branch checks pass through the live server, covering pass, fail, assisted rescue scheduled sooner than a clean pass, medium versus harsh rigor, plan stage, input validation, and metadata-only recall with no source leak.
- Hooks and integration: 22 of 22 pass. A real headless `claude -p` session loads the server and sees the tools.
- Adversarial: prompt injection, including explanations that contained a fully-formed fake grader verdict, did not flip a single grade. SQL injection payloads were stored as inert literals. Fail-open is loud, never a silent fake pass.

Two low-severity bugs were found and fixed before release: missing input validation on `reckon_explain`, and an ungraded fail-open pass being written to the ledger as if it had been graded.

Known rough edges that are not fixed yet: grading latency is real (a live grade measured 58 seconds), and a session where you just say "proceed" without entering plan mode can still skip the check, because the triggers are soft rather than hard.

## License

MIT. See [LICENSE](LICENSE).
