import type { Doc } from "./types.ts";
import type { Fixtures } from "./fixtures.ts";
import { formatInput } from "./fixtures.ts";
import { render } from "./render.ts";
import { runCheck } from "./checks.ts";
import type { AgentFn, JudgeFn } from "./anthropic.ts";

export interface CaseCheckResult {
  rule: string;
  check: string;
  passed: boolean;
  detail: string;
}

export interface CaseResult {
  name: string;
  output: string;
  checks: CaseCheckResult[];
}

export interface RunResult {
  agent: string;
  cases: CaseResult[];
}

export interface RunOptions {
  agent: AgentFn;
  judge?: JudgeFn;
}

export async function run(
  doc: Doc,
  fixtures: Fixtures,
  opts: RunOptions,
): Promise<RunResult> {
  const systemPrompt = render(doc);
  const cases: CaseResult[] = [];
  for (const c of fixtures.cases) {
    const userInput = formatInput(c.input);
    const output = await opts.agent(systemPrompt, userInput);
    const checks: CaseCheckResult[] = [];
    for (const exp of c.expectations) {
      const r = await runCheck(exp, output, opts.judge);
      checks.push({
        rule: exp.rule,
        check: exp.check,
        passed: r.passed,
        detail: r.detail,
      });
    }
    cases.push({ name: c.name, output, checks });
  }
  return { agent: doc.agent, cases };
}
