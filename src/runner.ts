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
  definedRules: string[];
}

export interface RunOptions {
  agent: AgentFn;
  judge?: JudgeFn;
}

export function validateFixturesAgainstDoc(doc: Doc, fixtures: Fixtures): void {
  if (fixtures.agent && fixtures.agent !== doc.agent) {
    throw new Error(
      `Fixtures target agent "${fixtures.agent}" but the prompt defines agent "${doc.agent}". Update the fixture's "agent:" field or point at the right prompt file.`,
    );
  }
  const definedIds = new Set<string>();
  for (const r of doc.hardLimits) definedIds.add(r.id);
  for (const r of doc.defaults) definedIds.add(r.id);
  const unknown: { case: string; rule: string }[] = [];
  for (const c of fixtures.cases) {
    for (const exp of c.expectations) {
      if (!definedIds.has(exp.rule)) unknown.push({ case: c.name, rule: exp.rule });
    }
  }
  if (unknown.length) {
    const lines = unknown.map((u) => `  - case "${u.case}" references rule [${u.rule}]`);
    const defined = [...definedIds].sort().join(", ") || "(none)";
    throw new Error(
      `Fixtures reference rule IDs that don't exist in the prompt:\n${lines.join("\n")}\ndefined rules: ${defined}`,
    );
  }
}

export async function run(
  doc: Doc,
  fixtures: Fixtures,
  opts: RunOptions,
): Promise<RunResult> {
  validateFixturesAgainstDoc(doc, fixtures);
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
  const definedRules = [
    ...doc.hardLimits.map((r) => r.id),
    ...doc.defaults.map((r) => r.id),
  ];
  return { agent: doc.agent, cases, definedRules };
}
