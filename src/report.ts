import type { RunResult } from "./runner.ts";

export interface FormatOptions {
  verbose?: boolean;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatReport(result: RunResult, opts: FormatOptions = {}): string {
  const out: string[] = [];
  out.push(`agent: ${result.agent}`);
  out.push("");

  for (const c of result.cases) {
    out.push(`case: ${c.name}`);
    if (opts.verbose) {
      out.push("  output:");
      out.push(indent(c.output, "    | "));
      out.push("");
    }
    for (const ck of c.checks) {
      const status = ck.passed ? "PASS" : "FAIL";
      out.push(`  [${ck.rule}] ${ck.check.padEnd(18)} ${status}  ${ck.detail}`);
    }
    out.push("");
  }

  // Per-rule adherence
  const byRule = new Map<string, { passed: number; total: number }>();
  for (const c of result.cases) {
    for (const ck of c.checks) {
      const entry = byRule.get(ck.rule) ?? { passed: 0, total: 0 };
      entry.total += 1;
      if (ck.passed) entry.passed += 1;
      byRule.set(ck.rule, entry);
    }
  }

  out.push("adherence by rule:");
  const rules = [...byRule.keys()].sort();
  for (const r of rules) {
    const { passed, total } = byRule.get(r)!;
    const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
    const flag = pct === 100 ? "" : pct >= 75 ? "  ~" : "  ← attention";
    out.push(`  [${r}] ${passed}/${total} (${pct}%)${flag}`);
  }
  out.push("");

  const totalChecks = [...byRule.values()].reduce((s, e) => s + e.total, 0);
  const totalPassed = [...byRule.values()].reduce((s, e) => s + e.passed, 0);
  const overallPct = totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 0;
  out.push(`overall: ${totalPassed}/${totalChecks} (${overallPct}%)`);
  return out.join("\n");
}

export function overallPassed(result: RunResult): boolean {
  for (const c of result.cases) {
    for (const ck of c.checks) if (!ck.passed) return false;
  }
  return true;
}
