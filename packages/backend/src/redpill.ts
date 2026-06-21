import type { HaikuLines } from '@githaiku/shared';

import { config } from './config';
import type { CommitMeta } from './github';
import type { HaikuGenerator } from './haiku';

/**
 * RedPill haiku generator.
 *
 * RedPill is Phala's confidential LLM gateway — OpenAI-compatible, raw fetch, NO
 * SDK. The default model `phala/deepseek-v4-flash` runs in a TEE with
 * ECDSA-signed, attestable tier-1 inference.
 *
 * The model sees ONLY bounded commit metadata (message / repo / timestamp) — the
 * same data the deterministic generator gets. It is instructed to reply with
 * ONLY three haiku lines. We parse exactly 3 non-empty lines; anything else is a
 * CLEAN failure (no commit data leaked, no padding/fabrication). The shared
 * egress guard re-validates the final shape downstream regardless.
 */

const SYSTEM_PROMPT =
  'You are a haiku poet. Reply with ONLY a single haiku: exactly three short ' +
  'lines, roughly 5-7-5 syllables, evoking the spirit of recent software work. ' +
  'No title, no commentary, no numbering, no markdown, no code fences — just the ' +
  'three lines, one per line.';

/** Build the user prompt from bounded commit metadata only. */
function buildUserPrompt(commits: CommitMeta[]): string {
  const lines = commits.map((c) => `- ${c.repo}: ${c.message} (${c.timestamp})`).join('\n');
  return `Write a haiku summarizing these recent commits:\n${lines}`;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Parse model text into exactly 3 non-empty haiku lines.
 *
 * - split on newlines, trim, drop empties
 * - drop markdown code-fence lines (``` ...)
 * - strip leading list/quote markers (-, *, >, "1.")
 * Returns null if the result is not exactly 3 usable lines.
 */
export function parseHaikuLines(text: string): HaikuLines | null {
  const cleaned = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('```'))
    .map((l) => l.replace(/^([-*>]|\d+[.)])\s+/, '').trim())
    .filter((l) => l.length > 0);

  if (cleaned.length !== 3) return null;
  return [cleaned[0]!, cleaned[1]!, cleaned[2]!] as const;
}

export class RedpillHaikuGenerator implements HaikuGenerator {
  readonly kind = 'redpill';

  async generate(commits: CommitMeta[]): Promise<HaikuLines> {
    const { baseUrl, model, apiKey, timeoutMs } = config.redpill;
    if (!apiKey) {
      // Selection guarantees this never happens, but fail loudly if it does.
      throw new Error('redpill generator selected but REDPILL_API_KEY is not set');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(commits) },
          ],
          max_tokens: 128,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`RedPill request timed out after ${timeoutMs}ms`);
      }
      throw new Error('RedPill request failed');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Do NOT include the body — it may echo prompt content.
      throw new Error(`RedPill chat/completions returned ${res.status}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('RedPill response missing message content');
    }

    const lines = parseHaikuLines(content);
    if (!lines) {
      // Clean failure — no commit data, no padding/fabrication.
      throw new Error('RedPill did not return exactly three usable haiku lines');
    }
    return lines;
  }
}
