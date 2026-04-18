import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.ts";
import { run } from "../src/runner.ts";
import type { Fixtures } from "../src/fixtures.ts";

const DOC = `# Agent: echo-agent

Echoes a fixed output for testing.

## Hard limits

- [H1] at most 5 words
  why: testing

## Procedure

1. emit five words
`;

const FIXTURES: Fixtures = {
  cases: [
    {
      name: "basic",
      input: "whatever",
      expectations: [
        { rule: "H1", check: "word_count_le", value: 5 },
        { rule: "H1", check: "does_not_contain", value: ["banned"] },
      ],
    },
    {
      name: "failing",
      input: "whatever",
      expectations: [
        { rule: "H1", check: "word_count_le", value: 2 },
      ],
    },
  ],
};

test("run: executes all cases and checks with fake agent", async () => {
  const doc = parse(DOC);
  const agent = async () => "one two three four five";
  const result = await run(doc, FIXTURES, { agent });

  assert.equal(result.agent, "echo-agent");
  assert.equal(result.cases.length, 2);

  const basic = result.cases[0];
  assert.equal(basic.checks.length, 2);
  assert.equal(basic.checks[0].passed, true);
  assert.equal(basic.checks[1].passed, true);

  const failing = result.cases[1];
  assert.equal(failing.checks[0].passed, false);
});

test("run: passes rendered system prompt to the agent", async () => {
  const doc = parse(DOC);
  let capturedSystem = "";
  const agent = async (system: string) => {
    capturedSystem = system;
    return "ok";
  };
  await run(doc, { cases: [{ name: "n", input: "x", expectations: [] }] }, { agent });
  assert.match(capturedSystem, /Agent: echo-agent/);
  assert.match(capturedSystem, /Hard limits/);
  assert.match(capturedSystem, /\[H1\]/);
});
