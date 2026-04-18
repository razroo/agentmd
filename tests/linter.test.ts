import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.ts";
import { lint } from "../src/linter.ts";

function lintSource(src: string) {
  return lint(parse(src));
}

test("L2: missing why on hard limit", () => {
  const d = lintSource(`# Agent: a\n\n## Hard limits\n\n- [H1] do a thing\n\n## Procedure\n\n1. step one\n`);
  const l2 = d.filter((x) => x.code === "L2");
  assert.equal(l2.length, 1);
  assert.match(l2[0].message, /why:/);
});

test("L3: duplicate ID across scopes", () => {
  const src = `# Agent: a

## Hard limits

- [H1] one thing
  why: because

## Defaults

- [H1] another thing
  why: because

## Procedure

1. step one
`;
  const d = lintSource(src);
  assert.ok(d.some((x) => x.code === "L3"), "expected L3 duplicate-ID diagnostic");
});

test("L4: reference to undefined rule", () => {
  const src = `# Agent: a

## Hard limits

- [H1] thing
  why: reason

## Procedure

1. do [H9]
`;
  const d = lintSource(src);
  assert.ok(d.some((x) => x.code === "L4"));
});

test("L6: procedure step with 'and'", () => {
  const src = `# Agent: a

## Hard limits

- [H1] thing
  why: reason

## Procedure

1. Read the file and write the output
`;
  const d = lintSource(src);
  assert.ok(d.some((x) => x.code === "L6"));
});

test("L8: routing without fallback row", () => {
  const src = `# Agent: a

## Hard limits

- [H1] thing
  why: reason

## Procedure

1. step

## Routing

| When | Do |
|------|-----|
| IC | technical |
| VP | business |
`;
  const d = lintSource(src);
  assert.ok(d.some((x) => x.code === "L8"));
});

test("L8: routing with fallback row passes", () => {
  const src = `# Agent: a

## Hard limits

- [H1] thing
  why: reason

## Procedure

1. step

## Routing

| When | Do |
|------|-----|
| IC | technical |
| otherwise | business |
`;
  const d = lintSource(src);
  assert.ok(!d.some((x) => x.code === "L8"));
});

test("L9: missing Agent heading", () => {
  const d = lintSource(`## Hard limits\n\n- [H1] x\n  why: y\n\n## Procedure\n\n1. step\n`);
  assert.ok(d.some((x) => x.code === "L9" && x.severity === "error"));
});

test("L9: missing Procedure", () => {
  const d = lintSource(`# Agent: x\n\n## Hard limits\n\n- [H1] y\n  why: z\n`);
  assert.ok(d.some((x) => x.code === "L9" && /Procedure/.test(x.message)));
});

test("clean file emits no errors", () => {
  const src = `# Agent: a

A description.

## Hard limits

- [H1] thing
  why: reason

## Procedure

1. step one
2. step two
`;
  const d = lintSource(src);
  const errors = d.filter((x) => x.severity === "error");
  assert.equal(errors.length, 0, JSON.stringify(d, null, 2));
});
