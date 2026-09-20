// The LLM behind every agent is Claude, through the local `claude` CLI in
// print mode. No API key: it uses the Claude Code session already on this
// machine. One call takes a few seconds, which is why the buying loop waits
// between rounds.

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.env.CLAUDE_BIN ?? "claude";
// Run from an empty directory: the model should answer the agent's prompt, not
// read this repository and talk about it.
const SANDBOX = mkdtempSync(join(tmpdir(), "renn-llm-"));

/** One prompt, one short answer. Empty string if the CLI fails or times out. */
export function ask(prompt: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((ok) => {
    const child = execFile(
      BIN,
      ["-p", prompt],
      { timeout: timeoutMs, maxBuffer: 1 << 20, cwd: SANDBOX },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`  [llm] ${String(stderr || err.message).slice(0, 120)}`);
          return ok("");
        }
        ok(stdout.trim());
      },
    );
    child.stdin?.end();
  });
}

/** Ask for JSON and parse the first object in the answer. null if unusable. */
export async function askJson<T>(prompt: string): Promise<T | null> {
  const raw = await ask(`${prompt}\n\nAnswer with one JSON object and nothing else.`);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
