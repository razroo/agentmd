import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtures } from "../src/fixtures.ts";

function writeTemp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmd-fixtures-"));
  const path = join(dir, "fixtures.yml");
  writeFileSync(path, contents);
  return path;
}

test("loadFixtures: rejects unknown check types", () => {
  const path = writeTemp(`cases:
  - name: c
    input: x
    expectations:
      - rule: H1
        check: does_not_exist
        value: 5
`);
  assert.throws(() => loadFixtures(path), /unknown check "does_not_exist"/);
});

test("loadFixtures: accepts every documented check type", () => {
  const path = writeTemp(`cases:
  - name: c
    input: x
    expectations:
      - rule: H1
        check: word_count_le
        value: 5
      - rule: H1
        check: word_count_ge
        value: 1
      - rule: H1
        check: char_count_le
        value: 100
      - rule: H1
        check: does_not_contain
        value: ["banned"]
      - rule: D1
        check: contains_all
        value: ["required"]
      - rule: D1
        check: regex
        value: "^x"
      - rule: D1
        check: llm_judge
        prompt: "Is it good?"
`);
  const fx = loadFixtures(path);
  assert.equal(fx.cases[0].expectations.length, 7);
});

test("loadFixtures: non-judge checks must have a value field", () => {
  const path = writeTemp(`cases:
  - name: c
    input: x
    expectations:
      - rule: H1
        check: word_count_le
`);
  assert.throws(() => loadFixtures(path), /missing a "value:" field/);
});

test("loadFixtures: llm_judge must have a prompt field", () => {
  const path = writeTemp(`cases:
  - name: c
    input: x
    expectations:
      - rule: D1
        check: llm_judge
`);
  assert.throws(() => loadFixtures(path), /missing a "prompt:" field/);
});
