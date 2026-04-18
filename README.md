# better-markdown (`bmd`)

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
   `bmd test` ships fixture cases through the compiled prompt and reports
   per-rule pass rate — the only loop that tells you if a change made the
   prompt better or worse.

No new syntax. Markdown stays markdown. `bmd` just adds a tight dialect and
a test harness.

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

## CLI

```
bmd lint <file>
bmd render <file> [--out <path>]
bmd test <file> --fixtures <path> [--via <api|claude-code>] [--model <id>]
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
bin/bmd             tsx entry shim
```
