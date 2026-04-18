import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_AGENT_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";

export type AgentFn = (systemPrompt: string, userInput: string) => Promise<string>;
export type JudgeFn = (judgePrompt: string, output: string) => Promise<boolean>;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Export it in your shell or skip `bmd test` (use `bmd lint`/`bmd render` for offline work).",
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

function textFromResponse(
  blocks: Anthropic.Messages.ContentBlock[],
): string {
  return blocks
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function makeAgent(model: string = DEFAULT_AGENT_MODEL): AgentFn {
  return async (systemPrompt, userInput) => {
    const res = await client().messages.create({
      model,
      system: systemPrompt,
      max_tokens: 1024,
      messages: [{ role: "user", content: userInput }],
    });
    return textFromResponse(res.content);
  };
}

export function makeJudge(model: string = DEFAULT_JUDGE_MODEL): JudgeFn {
  return async (judgePrompt, output) => {
    const system =
      "You are a strict binary judge. Answer only with the single token 'yes' or 'no', lowercase, no punctuation.";
    const user = [
      "The following text is the output of another agent:",
      "---BEGIN OUTPUT---",
      output,
      "---END OUTPUT---",
      "",
      `Question: ${judgePrompt}`,
      "",
      "Answer with exactly 'yes' or 'no'.",
    ].join("\n");
    const res = await client().messages.create({
      model,
      system,
      max_tokens: 4,
      messages: [{ role: "user", content: user }],
    });
    const text = textFromResponse(res.content).trim().toLowerCase();
    return text.startsWith("yes");
  };
}
