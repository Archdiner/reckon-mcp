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

This is experimental and early. It works, it is tested, and it is deployed for the author, but it has not yet been used across many real sessions by many people. That is what this release is for. Expect rough edges. The grader adds real latency, often 30 to 60 seconds per grade, because it spawns a separate model call. In Mode A the triggers are hard gates: a comprehension checkpoint blocks the build until you pass it, even under `--dangerously-skip-permissions` (see Limitations for what it does not yet cover).

## Requirements

- Claude Code (the `claude` CLI), version 2.1 or later
- Node.js 20 or later
- A Claude subscription. The grader runs through `claude -p`, so it uses your existing Claude Code auth. No separate API key is needed.

## Install

```bash
git clone https://github.com/Archdiner/reckon-mcp.git
cd reckon-mcp/mcp-server
npm install
npm run build
npm run deploy
```

`npm run deploy` does the following, and backs up anything it touches first:

- builds the server and copies it to `~/.reckon`
- registers the reckon MCP server at **user scope**, so Claude Code loads it in every project
- installs the hooks into `~/.reckon/hooks`
- merges Reckon's hooks into `~/.claude/settings.json`, preserving every other hook and setting

If `claude` was on your PATH during deploy, registration is already done. If it wasn't, or
the `reckon_*` tools don't show up, run this once in your terminal:

```bash
claude mcp add reckon -s user -- node "$HOME/.reckon/dist/server.js"
```

Restart Claude Code afterward so it loads the server and the hooks. Confirm it worked with
`claude mcp list` (reckon should read `✔ Connected`).

To undo a deploy, restore the `.bak-*` files it created (in `~/.reckon` and `~/.claude`).

## Usage

Once installed, the agent calls Reckon on its own at decision points. You do not have to invoke anything. In practice:

- When you approve a plan and the agent leaves plan mode, a hook blocks the build until you pass the comprehension check. A plan is first grouped into 2 to 4 coherent sub-problems (data layer, auth, infrastructure, and so on). You give one explanation covering all of them, and the grader requires the mechanism of each, so a partial answer fails. This covers the whole plan in one bounded explanation, rather than either one overwhelming "explain everything" prompt that a partial answer could pass, or many separate asks.
- When the agent builds directly (a plan dumped as prose, no plan mode), a second hook blocks the first load-bearing write into a subsystem (a new dependency, or accumulated churn past a threshold) until you pass the check for it. That is what catches an autonomous session that never enters plan mode.
- Both gates hold even under `--dangerously-skip-permissions`: the hooks run before the permission-mode check, so bypassing the prompt does not bypass the checkpoint.

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

- Coverage has gaps. Mode A hard-gates two signatures: leaving plan mode, and writes via Edit/Write/MultiEdit (including a plan dumped as prose and built directly, which the plan-gate alone would miss). It does not yet cover file writes made through `Bash` heredocs or `NotebookEdit`, so a determined agent can still route around it. Closing those paths is future work.
- Grading is slow. Each grade spawns a separate model call, so budget roughly 30 to 60 seconds. A plan checkpoint is slower still (around 90 seconds), because it runs a decomposition pass and then a grading pass.
- The grader is a model, not an oracle. It is good at catching restatement and missing mechanism, but it is not perfect.

## The research behind it

- [Chi, De Leeuw, Chiu, LaVancher (1994): Eliciting self-explanations improves understanding](https://doi.org/10.1207/s15516709cog1803_3)
- [Rozenblit and Keil (2002): The illusion of explanatory depth](https://doi.org/10.1207/s15516709cog2605_1)
- [Russ, Scherr, Hammer, Mikeska (2008): Recognizing mechanistic reasoning](https://doi.org/10.1002/sce.20264)
- [Roediger and Karpicke (2006): Test-enhanced learning](https://doi.org/10.1111/j.1467-9280.2006.01693.x)
- [Biggs and Collis (1982): SOLO taxonomy](https://www.johnbiggs.com.au/academic/solo-taxonomy/)
- [Zheng et al. (2023): Judging LLM-as-a-judge (MT-Bench)](https://arxiv.org/abs/2306.05685)
- [Liu et al. (2023): G-Eval](https://arxiv.org/abs/2303.16634)
- [Kazemitabaar et al. (2024): Explain-before-Usage: LLM-graded code explanation](https://arxiv.org/abs/2410.08922)

The full design rationale is in [reckon-design-doc-v5.md](reckon-design-doc-v5.md).

## Development

```bash
cd mcp-server
npm install
npm run build
npm test        # unit tests
```

The grader model can be overridden with `RECKON_GRADER_MODEL`. The ledger location can be moved with `RECKON_HOME` (used by the tests so they never touch your real data).

## License

MIT. See [LICENSE](LICENSE).
