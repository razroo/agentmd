import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "./parser.ts";
import { lint, formatDiagnostic } from "./linter.ts";
import { render } from "./render.ts";
import { loadFixtures } from "./fixtures.ts";
import { run } from "./runner.ts";
import { formatReport, overallPassed } from "./report.ts";
import { makeAgent, makeJudge } from "./anthropic.ts";
import { makeClaudeCodeAgent, makeClaudeCodeJudge } from "./claude-code.ts";
import type { AgentFn, JudgeFn } from "./anthropic.ts";

const USAGE = `bmd — structured markdown linter and adherence tester for agent prompts

usage:
  bmd lint <file>
  bmd render <file> [--out <path>]
  bmd test <file> --fixtures <path> [--via <api|claude-code>] [--model <id>] [--verbose]

commands:
  lint      validate structural conventions in the prompt file
  render    emit the compiled prompt (the form the model sees)
  test      run fixture cases against the compiled prompt and report per-rule adherence

test backends (--via):
  api           call the Anthropic SDK directly (requires ANTHROPIC_API_KEY) [default]
  claude-code   shell out to 'claude -p --bare' (uses your Claude Code login; no API key needed)

env:
  ANTHROPIC_API_KEY  required for \`bmd test --via api\`
`;

type Argv = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Argv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function loadDoc(path: string) {
  const source = readFileSync(path, "utf8");
  return parse(source, path);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }
  const { positional, flags } = parseArgs(rest);

  if (cmd === "lint") {
    const file = positional[0];
    if (!file) {
      process.stderr.write(`usage: bmd lint <file>\n`);
      process.exit(2);
    }
    const abs = resolve(file);
    const doc = loadDoc(abs);
    const diags = lint(doc);
    if (!diags.length) {
      process.stdout.write(`${file}: ok (0 diagnostics)\n`);
      return;
    }
    let errors = 0;
    for (const d of diags) {
      if (d.severity === "error") errors++;
      process.stdout.write(formatDiagnostic(d, file) + "\n");
    }
    process.stdout.write(`\n${diags.length} diagnostic${diags.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})\n`);
    process.exit(errors > 0 ? 1 : 0);
  }

  if (cmd === "render") {
    const file = positional[0];
    if (!file) {
      process.stderr.write(`usage: bmd render <file> [--out <path>]\n`);
      process.exit(2);
    }
    const abs = resolve(file);
    const doc = loadDoc(abs);
    const out = render(doc);
    const outPath = typeof flags.out === "string" ? flags.out : null;
    if (outPath) {
      writeFileSync(resolve(outPath), out);
      process.stdout.write(`wrote ${outPath}\n`);
    } else {
      process.stdout.write(out);
    }
    return;
  }

  if (cmd === "test") {
    const file = positional[0];
    const fixturesPath = typeof flags.fixtures === "string" ? flags.fixtures : null;
    if (!file || !fixturesPath) {
      process.stderr.write(`usage: bmd test <file> --fixtures <path> [--model <id>]\n`);
      process.exit(2);
    }
    const doc = loadDoc(resolve(file));
    const diags = lint(doc);
    const errors = diags.filter((d) => d.severity === "error");
    if (errors.length) {
      process.stderr.write(`refusing to run tests: file has ${errors.length} lint error(s). Run \`bmd lint ${file}\` first.\n`);
      process.exit(2);
    }
    const fixtures = loadFixtures(resolve(fixturesPath));
    const model = typeof flags.model === "string" ? flags.model : undefined;
    const via = typeof flags.via === "string" ? flags.via : "api";
    let agent: AgentFn;
    let judge: JudgeFn;
    if (via === "claude-code") {
      agent = makeClaudeCodeAgent({ model });
      judge = makeClaudeCodeJudge({ model });
    } else if (via === "api") {
      agent = makeAgent(model);
      judge = makeJudge(model);
    } else {
      process.stderr.write(`unknown --via value: ${via} (expected 'api' or 'claude-code')\n`);
      process.exit(2);
    }
    const result = await run(doc, fixtures, { agent, judge });
    const verbose = flags.verbose === true || flags.v === true;
    process.stdout.write(formatReport(result, { verbose }) + "\n");
    process.exit(overallPassed(result) ? 0 : 1);
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
