# agentmd

A structured-markdown format and CLI for writing LLM agent prompts — with a
linter that checks what actually matters, and a fixture-driven adherence
tester that runs each prompt through a small model and reports whether the
agent followed the rules.

Two ideas, both of which the usual "prompt DSL" approach gets wrong:

1. **Lint structure, not words.** Flagging "good", "nice", "appropriate" is
   cargo-cult. The real bugs in agent prompts are missing rationale,
   dangling cross-references, duplicate IDs, multi-action procedure steps,
   routing tables with no fallback branch. Those are what this linter
   catches.
2. **Measure adherence.** A prompt is only good if the model follows it.
   `agentmd test` ships fixture cases through the compiled prompt and reports
   per-rule pass rate — the only loop that tells you if a change made the
   prompt better or worse.

No new syntax. Markdown stays markdown. `agentmd` just adds a tight dialect
and a test harness.

## Install

```
npm install
```

Requires Node ≥ 22.

## Format

A prompt file is a regular markdown file with these conventions:

```markdown
# Agent: my-agent

One short paragraph describing what the agent does.

## Hard limits

- [H1] Rule text.
  why: the motivation — ideally a past incident
- [H2] Another rule.
  why: ...

## Defaults

- [D1] A default the agent should follow unless it has a stated reason to deviate.
  why: ...

## Procedure

1. One action per step.
2. Reference rules inline with [H1], [D1].

## Routing

| When | Do |
|------|-----|
| specific condition | specific action |
| otherwise | fallback action |

## Output format

Free-form context sections. Pass through to the prompt untouched.
```

Rule ID conventions:

- `H#` — hard limits (never violate)
- `D#` — defaults (overridable with an explicit stated reason)

Every rule needs `[ID]` and a `why:`. The why is load-bearing: when the agent
hits an edge case, the rationale is how it decides. Rules without a why are a
lint error.

## Example — a real file, end to end

Here's the full `examples/outreach-writer.md` that ships in this repo. It's
been iterated against the adherence harness until Claude Haiku 4.5 hits 8/8
on the fixture cases in `examples/fixtures/outreach-writer.yml`:

```markdown
# Agent: outreach-writer

Cold outbound email writer for B2B sales. Given a prospect profile and optional
company context, produce a short, specific email that earns a reply.

## Hard limits

- [H1] Produce at most 140 words in the email body.
  why: emails over 140 words have under 2% reply rate in our historical data
- [H2] Never fabricate metrics, customer names, or company facts.
  why: 2025-11 incident — fabricated ARR figure in outbound email, lost the deal
- [H3] Do not use placeholder tokens like [Company] or {name} in the output.
  why: placeholders leak when the copy is pasted straight into a send tool

## Defaults

- [D1] When company_context is provided, name the prospect's company in the first sentence and reference one specific fact from that context. Without company_context, open with a concrete observation about the prospect's role or seniority.
  why: naming the company signals the email was written for them; ESPs flag generic openers ("Hope you're well") as spam
- [D2] End with exactly one direct ask: propose a 15-minute call with two specific time windows (e.g., "Tuesday 10am or Thursday 2pm ET?"). Do not hedge ("Worth grabbing…?", "Would you be open…?"). Do not add a second open question after the ask.
  why: hedged phrasing reads as unsure; multiple asks dilute intent and reply rate drops
- [D3] Write in four short paragraphs, one idea per paragraph.
  why: small screens and quick skims — paragraphs over 3 lines get skipped

## Procedure

1. Read the prospect profile; identify role, seniority, likely priorities.
2. Pick one specific observation about their company or role.
3. Draft the email following [D1], [D2], [D3].
4. Self-check against [H1], [H2], [H3], [D1], [D2]; revise if any fail.

## Routing

| When | Do |
|------|-----|
| Prospect is IC engineer | Lead with a technical observation |
| Prospect is director or VP | Lead with a business-outcome framing |
| No company_context provided | Use only role-level framing; do not invent company facts |
| otherwise | Default to role-level framing |

## Output format

Return just the email body. No subject line, no signature block, no preamble
like "Here is the email:". Plain text, no markdown.
```

A representative output Haiku produced during the last adherence run
(input: senior backend engineer at Acme, Go + Kubernetes, company context
about 200+ microservices on GKE and recent layoffs):

```
At Acme, managing 200+ microservices on GKE means your team is likely
bottlenecked on deployment velocity or debugging cross-service issues—I
work with senior engineers at scale who tell us these are the top
constraints.

With recent headcount changes, that pressure probably got tighter. We help
teams ship faster and automate infrastructure work so you do more with
less.

We built this specifically for Go services in Kubernetes. Happy to walk
through how it works for your setup.

Could we grab 15 minutes Tuesday 2pm or Thursday 10am ET?
```

Naming Acme and citing a specific fact satisfies `[D1]`; closing with one
direct two-window ask satisfies `[D2]`; 88 words stays under `[H1]`; no
fabricated numbers satisfies `[H2]`. The full report the harness produces
is further down under [Report](#report).

### The iteration loop this unlocks

The reason to write prompts this way isn't the syntax — it's that rule
changes produce a measurable number. An earlier version of this file had:

```markdown
- [D1] Open with a specific observation about the prospect's company or role.
- [D2] Close with one concrete next step (a 15-min call or a link).
```

Against the fixtures, that scored 6/8 (75%): `[D1]` 0/1 (no company name),
`[D2]` 1/2 (one case closed with a hedged "Worth grabbing…?"). Tightening
`[D1]` to "name the company in the first sentence when context is
provided" and `[D2]` to "exactly one direct ask with two specific time
windows" — plus adding `[D1]` and `[D2]` to the self-check in step 4 —
moved the score to 8/8 (100%) in one rerun. Without the harness you'd be
guessing whether the changes helped.

## CLI

```
agentmd lint <file>
agentmd render <file> [--out <path>]
agentmd test <file> --fixtures <path> [--via <api|claude-code>] [--model <id>]
```

- `lint` — structural checks (see below). Exits non-zero on errors.
- `render` — emit the compiled prompt (what the model sees). `render` adds
  explicit "must never be violated" / "may be overridden…" scope labels.
- `test` — run fixture cases through the compiled prompt and report per-rule
  adherence.

### Test backends

`--via api` (default): calls the Anthropic SDK. Requires `ANTHROPIC_API_KEY`.

`--via claude-code`: shells out to `claude -p` on PATH. Uses your Claude Code
login, so no API key needed. The runner passes:

- `--system-prompt <rendered>` (overrides the default system prompt)
- `--tools ""` (no tool use — pure LLM one-shot)
- `--no-session-persistence` (doesn't pollute session history)
- spawns with `cwd = os.tmpdir()` so the project's `CLAUDE.md` is not
  auto-discovered and leaked into the test

Caveat: a user-level `~/.claude/CLAUDE.md` may still load. If that matters,
use `--via api`.

## Lint rules

| Code | Severity | What it checks |
|------|----------|----------------|
| L1 | error | Every rule has an `[ID]` |
| L2 | error | Every hard-limit/default has a `why:` line |
| L3 | error | Rule IDs are unique |
| L4 | error | `[ID]` references in prose resolve to a defined rule |
| L5 | warning | H-ids live in Hard limits, D-ids in Defaults |
| L6 | warning | Procedure steps do one thing (no `" and "` / `" or "`) |
| L7 | warning | Procedure steps stay short (≤ ~15 words) |
| L8 | warning | Routing tables include a fallback row |
| L9 | error/warning | Required sections present (Agent heading, Procedure, at least one rule) |

Deliberately **not** checked: vague-word heuristics. They produce false
positives on real prose and miss the actual bugs.

## Fixtures

```yaml
agent: outreach-writer
cases:
  - name: ic-engineer-prospect
    input:
      prospect_profile: "Senior backend engineer at Acme, Go + Kubernetes"
      company_context: "Acme runs 200 microservices, recent layoffs"
    expectations:
      - rule: H1
        check: word_count_le
        value: 140
      - rule: H2
        check: does_not_contain
        value: ["$", "%"]
      - rule: D1
        check: llm_judge
        prompt: "Does the email open with a specific observation about Acme?"
```

The input is passed verbatim to the agent as the user message (strings) or
serialised as YAML (objects). Each expectation ties a rule ID to a check.

### Check types

| check | value | meaning |
|-------|-------|---------|
| `word_count_le` | number | output has at most N words |
| `word_count_ge` | number | output has at least N words |
| `char_count_le` | number | output has at most N characters |
| `does_not_contain` | string or list | none of the substrings appear (case-insensitive) |
| `contains_all` | string or list | all substrings appear (case-insensitive) |
| `regex` | string | pattern matches somewhere in the output |
| `llm_judge` | (uses `prompt:`) | a small model answers yes/no against your question |

`llm_judge` is the escape hatch for things that only a model can evaluate
("does the opener reference the prospect's company?"). Keep the judge prompt
narrow and binary.

**Convention: `yes` must always mean the rule was followed.** Phrase the
judge question positively: *"Does the email avoid fabricating metrics?"*
rather than *"Does the email fabricate metrics?"* — otherwise `passed=true`
will fire on rule violations.

## Report

```
agent: outreach-writer

case: ic-engineer-with-context
  [H1] word_count_le       PASS  127 words (limit 140)
  [H3] does_not_contain    PASS  none of 5 forbidden substrings present
  [D1] llm_judge           PASS  judge: yes
  [D2] llm_judge           FAIL  judge: no

...

adherence by rule:
  [D1] 2/2 (100%)
  [D2] 1/2 (50%)  ← attention
  [H1] 2/2 (100%)
  [H3] 2/2 (100%)

overall: 7/8 (88%)
```

Rule-grouped output tells you which rule the agent is missing — which is the
thing you can actually go fix.

## Dev

```
npm test          # node:test suites for parser, linter, checks, runner
npm run typecheck # tsc --noEmit
```

The runner takes an `AgentFn` and optional `JudgeFn` by injection, so tests
run fully offline against a fake agent. The Anthropic client is isolated to
`src/anthropic.ts`.

## Layout

```
src/
  types.ts          AST shapes
  parser.ts         markdown → AST
  render.ts         AST → compiled prompt
  linter.ts         structural checks (L1–L9)
  checks.ts         check functions
  fixtures.ts       YAML loader
  runner.ts         wires prompt + fixtures + agent
  anthropic.ts      Claude client (AgentFn + JudgeFn via SDK)
  claude-code.ts    Claude client (AgentFn + JudgeFn via `claude -p` subprocess)
  report.ts         format per-rule adherence
  cli.ts            command dispatcher

examples/
  outreach-writer.md
  fixtures/outreach-writer.yml

tests/              node:test suites
bin/agentmd         tsx entry shim
```
