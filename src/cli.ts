import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "./parser.ts";
import { lint, formatDiagnostic } from "./linter.ts";
import { render } from "./render.ts";
import { loadFixtures } from "./fixtures.ts";
import { run } from "./runner.ts";
import {
  formatBaselineDiff,
  formatReport,
  overallPassed,
  toJSON,
} from "./report.ts";
import { DEFAULT_TEMPERATURE, makeAgent, makeJudge } from "./anthropic.ts";
import { makeClaudeCodeAgent, makeClaudeCodeJudge } from "./claude-code.ts";
import { diffPrompts, formatDiff } from "./diff.ts";
import type { AgentFn, JudgeFn } from "./anthropic.ts";
import type { Backend, RunMeta } from "./types.ts";
import type { RunResult } from "./runner.ts";

const USAGE = `agentmd — structured markdown linter and adherence tester for agent prompts

usage:
  agentmd lint <file> [--watch]
  agentmd render <file> [--out <path>]
  agentmd test <file> --fixtures <path>
                      [--via <api|claude-code>] [--model <id>]
                      [--temperature <n>] [--concurrency <n>]
                      [--format <text|json>] [--out <path>]
                      [--baseline <path>] [--verbose] [--watch]
  agentmd diff <old.md> <new.md>
  agentmd new <name> [--dir <path>]

commands:
  lint      validate structural conventions in the prompt file
  render    emit the compiled prompt (the form the model sees)
  test      run fixture cases against the compiled prompt and report per-rule adherence
  diff      structural diff of rule sets between two prompt files
  new       scaffold a starter agent file and fixture

test backends (--via):
  api           call the Anthropic SDK directly (requires ANTHROPIC_API_KEY) [default]
  claude-code   shell out to 'claude -p' (uses your Claude Code login; no API key needed)

notes:
  --temperature defaults to 0 for the api backend; ignored by claude-code (no such flag)
  --baseline expects a JSON report produced by an earlier --format json run; exits
  non-zero if any rule's adherence is lower than in the baseline

env:
  ANTHROPIC_API_KEY  required for \`agentmd test --via api\`
`;

const SCAFFOLD_AGENT = (name: string) => `# Agent: ${name}

One short paragraph describing what this agent does.

## Hard limits

- [H1] Replace with a concrete, non-negotiable rule.
  why: the motivation — ideally a past incident or measured failure mode

## Defaults

- [D1] Replace with a sensible default the agent may override with a stated reason.
  why: why this is the right default most of the time

## Procedure

1. One action per step.
2. Reference rules inline like [H1], [D1].
3. Self-check against [H1], [D1]; revise if any fail.

## Routing

| When | Do |
|------|-----|
| specific condition | specific action |
| otherwise | fallback action |

## Output format

Describe the exact shape the agent must return.
`;

const SCAFFOLD_FIXTURES = (name: string) => `agent: ${name}
cases:
  - name: smoke
    input: "Replace me with a representative user input."
    expectations:
      - rule: H1
        check: word_count_le
        value: 200
      - rule: D1
        check: llm_judge
        prompt: "Does the output follow [D1]? Answer yes only if it does."
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

function runLintOnce(file: string): number {
  const abs = resolve(file);
  let doc;
  try {
    doc = loadDoc(abs);
  } catch (err) {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const diags = lint(doc);
  if (!diags.length) {
    process.stdout.write(`${file}: ok (0 diagnostics)\n`);
    return 0;
  }
  let errors = 0;
  for (const d of diags) {
    if (d.severity === "error") errors++;
    process.stdout.write(formatDiagnostic(d, file) + "\n");
  }
  process.stdout.write(
    `\n${diags.length} diagnostic${diags.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})\n`,
  );
  return errors > 0 ? 1 : 0;
}

interface TestOnceOptions {
  agent: AgentFn;
  judge: JudgeFn | undefined;
  meta: Partial<RunMeta>;
  concurrency: number;
  verbose: boolean;
  format: "text" | "json";
  outPath: string | null;
  baselinePath: string | null;
}

function loadBaseline(path: string): RunResult | null {
  try {
    const raw = readFileSync(resolve(path), "utf8");
    return JSON.parse(raw) as RunResult;
  } catch (err) {
    process.stderr.write(
      `failed to read baseline at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function runTestOnce(
  file: string,
  fixturesPath: string,
  opts: TestOnceOptions,
): Promise<number> {
  let doc;
  try {
    doc = loadDoc(resolve(file));
  } catch (err) {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const diags = lint(doc);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length) {
    process.stderr.write(
      `refusing to run tests: file has ${errors.length} lint error(s). Run \`agentmd lint ${file}\` first.\n`,
    );
    return 2;
  }
  let fixtures;
  try {
    fixtures = loadFixtures(resolve(fixturesPath));
  } catch (err) {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let result;
  try {
    result = await run(doc, fixtures, {
      agent: opts.agent,
      judge: opts.judge,
      meta: opts.meta,
      concurrency: opts.concurrency,
    });
  } catch (err) {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const rendered =
    opts.format === "json"
      ? toJSON(result)
      : formatReport(result, { verbose: opts.verbose }) + "\n";
  if (opts.outPath) {
    writeFileSync(resolve(opts.outPath), rendered);
    process.stdout.write(`wrote ${opts.outPath}\n`);
  } else {
    process.stdout.write(rendered);
  }

  let regressed = false;
  if (opts.baselinePath) {
    const baseline = loadBaseline(opts.baselinePath);
    if (!baseline) return 2;
    const diff = formatBaselineDiff(result, baseline);
    process.stdout.write("\n" + diff.rendered + "\n");
    if (diff.regressedRules.length) {
      process.stdout.write(
        `\nregression: ${diff.regressedRules.map((r) => `[${r}]`).join(", ")}\n`,
      );
      regressed = true;
    }
  }

  if (regressed) return 1;
  return overallPassed(result) ? 0 : 1;
}

function watchFiles(paths: string[], onChange: () => void) {
  let timer: NodeJS.Timeout | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 120);
  };
  const dirs = new Set(paths.map((p) => dirname(resolve(p))));
  const targets = new Set(paths.map((p) => basename(resolve(p))));
  for (const d of dirs) {
    try {
      watch(d, (_event, filename) => {
        if (filename && targets.has(filename.toString())) trigger();
      });
    } catch (err) {
      process.stderr.write(`watch failed for ${d}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.stdout.write(`watching ${paths.join(", ")} — press ^C to exit\n`);
}

function scaffoldNew(name: string, dir: string): number {
  const agentPath = resolve(dir, `${name}.md`);
  const fixturesDir = resolve(dir, "fixtures");
  const fixturesPath = resolve(fixturesDir, `${name}.yml`);
  if (existsSync(agentPath)) {
    process.stderr.write(`refusing to overwrite existing file: ${agentPath}\n`);
    return 1;
  }
  if (existsSync(fixturesPath)) {
    process.stderr.write(`refusing to overwrite existing file: ${fixturesPath}\n`);
    return 1;
  }
  if (!existsSync(fixturesDir)) {
    mkdirSync(fixturesDir, { recursive: true });
  }
  writeFileSync(agentPath, SCAFFOLD_AGENT(name));
  writeFileSync(fixturesPath, SCAFFOLD_FIXTURES(name));
  process.stdout.write(
    `created ${agentPath}\ncreated ${fixturesPath}\n\nnext:\n  agentmd lint ${agentPath}\n  agentmd test ${agentPath} --fixtures ${fixturesPath} --via claude-code\n`,
  );
  return 0;
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
      process.stderr.write(`usage: agentmd lint <file> [--watch]\n`);
      process.exit(2);
    }
    if (flags.watch === true) {
      runLintOnce(file);
      watchFiles([file], () => {
        process.stdout.write(`\n--- change detected, re-linting ---\n`);
        runLintOnce(file);
      });
      return;
    }
    process.exit(runLintOnce(file));
  }

  if (cmd === "render") {
    const file = positional[0];
    if (!file) {
      process.stderr.write(`usage: agentmd render <file> [--out <path>]\n`);
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
      process.stderr.write(`usage: agentmd test <file> --fixtures <path> [--model <id>]\n`);
      process.exit(2);
    }
    const model = typeof flags.model === "string" ? flags.model : undefined;
    const viaFlag = typeof flags.via === "string" ? flags.via : "api";
    if (viaFlag !== "api" && viaFlag !== "claude-code") {
      process.stderr.write(`unknown --via value: ${viaFlag} (expected 'api' or 'claude-code')\n`);
      process.exit(2);
    }
    const via = viaFlag as Backend;

    const temperatureFlag = flags.temperature;
    let temperature: number | null = null;
    if (typeof temperatureFlag === "string") {
      const n = Number(temperatureFlag);
      if (Number.isNaN(n)) {
        process.stderr.write(`invalid --temperature value: ${temperatureFlag}\n`);
        process.exit(2);
      }
      temperature = n;
    } else if (via === "api") {
      temperature = DEFAULT_TEMPERATURE;
    }

    let concurrency = 1;
    if (typeof flags.concurrency === "string") {
      const n = Number(flags.concurrency);
      if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(`invalid --concurrency value: ${flags.concurrency}\n`);
        process.exit(2);
      }
      concurrency = Math.floor(n);
    }

    const formatFlag = typeof flags.format === "string" ? flags.format : "text";
    if (formatFlag !== "text" && formatFlag !== "json") {
      process.stderr.write(`unknown --format value: ${formatFlag} (expected 'text' or 'json')\n`);
      process.exit(2);
    }
    const format = formatFlag as "text" | "json";

    let agent: AgentFn;
    let judge: JudgeFn;
    if (via === "claude-code") {
      if (typeof flags.temperature === "string") {
        process.stderr.write(
          `warning: --temperature is ignored by the claude-code backend (no such flag on 'claude -p')\n`,
        );
      }
      agent = makeClaudeCodeAgent({ model });
      judge = makeClaudeCodeJudge({ model });
    } else {
      const agentOpts = temperature !== null ? { model, temperature } : { model };
      agent = makeAgent(agentOpts);
      judge = makeJudge(agentOpts);
    }

    const meta: Partial<RunMeta> = {
      via,
      model: model ?? null,
      judgeModel: model ?? null,
      temperature: via === "claude-code" ? null : temperature,
    };

    const verbose = flags.verbose === true || flags.v === true;
    const outPath = typeof flags.out === "string" ? flags.out : null;
    const baselinePath = typeof flags.baseline === "string" ? flags.baseline : null;

    const testOpts: TestOnceOptions = {
      agent,
      judge,
      meta,
      concurrency,
      verbose,
      format,
      outPath,
      baselinePath,
    };

    if (flags.watch === true) {
      await runTestOnce(file, fixturesPath, testOpts);
      watchFiles([file, fixturesPath], () => {
        process.stdout.write(`\n--- change detected, re-running tests ---\n`);
        runTestOnce(file, fixturesPath, testOpts).catch((err) => {
          process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      });
      return;
    }
    process.exit(await runTestOnce(file, fixturesPath, testOpts));
  }

  if (cmd === "diff") {
    const oldPath = positional[0];
    const newPath = positional[1];
    if (!oldPath || !newPath) {
      process.stderr.write(`usage: agentmd diff <old.md> <new.md>\n`);
      process.exit(2);
    }
    const oldDoc = loadDoc(resolve(oldPath));
    const newDoc = loadDoc(resolve(newPath));
    const d = diffPrompts(oldDoc, newDoc);
    process.stdout.write(formatDiff(oldDoc.agent || oldPath, newDoc.agent || newPath, d));
    return;
  }

  if (cmd === "new") {
    const name = positional[0];
    if (!name) {
      process.stderr.write(`usage: agentmd new <name> [--dir <path>]\n`);
      process.exit(2);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      process.stderr.write(`invalid agent name: ${name} (use letters, digits, dot, underscore, hyphen)\n`);
      process.exit(2);
    }
    const dir = typeof flags.dir === "string" ? flags.dir : process.cwd();
    process.exit(scaffoldNew(name, dir));
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
