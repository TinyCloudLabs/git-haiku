import { useState } from 'react';

import { BACKEND_URL } from '../lib/config';

/**
 * MCP setup panel.
 *
 * Given a valid code, render copy-paste config that lets an agent (Claude,
 * Cursor, etc.) fetch haikus over MCP. The Git Haiku backend exposes a single
 * public POST /api/haiku {code}; we wrap it as an MCP tool via the reference
 * `mcp-remote`/`fetch`-style descriptor so the requester doesn't have to run a
 * server. The code is the only credential — it is the bearer of access.
 */
export function McpInstructions({ code }: { code: string }) {
  // Prod uses VITE_BACKEND_URL; in dev BACKEND_URL is '' (same-origin proxy) so
  // fall back to the current origin for a copy-pasteable absolute endpoint.
  const origin = BACKEND_URL || (typeof window !== 'undefined' ? window.location.origin : '');
  const endpoint = `${origin}/api/haiku`;

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        'git-haiku': {
          command: 'npx',
          args: ['-y', 'mcp-server-fetch'],
          env: {
            GIT_HAIKU_ENDPOINT: endpoint,
            GIT_HAIKU_CODE: code,
          },
        },
      },
    },
    null,
    2,
  );

  const descriptor = JSON.stringify(
    {
      name: 'git-haiku',
      description: 'Fetch a verifiable haiku distilled from recent commit messages (TEE-attested).',
      tools: [
        {
          name: 'get_haiku',
          description: 'Return a three-line haiku for the configured Git Haiku code.',
          transport: { type: 'http', method: 'POST', url: endpoint },
          request: { headers: { 'content-type': 'application/json' }, body: { code } },
        },
      ],
    },
    null,
    2,
  );

  const curl = `curl -s -X POST ${endpoint} \\\n  -H 'content-type: application/json' \\\n  -d '{"code":"${code}"}'`;

  return (
    <div className="card mcp">
      <h2>Use it from an agent (MCP)</h2>
      <p className="muted">
        Drop this into your agent&apos;s MCP config. The code is the credential — anyone with it can
        fetch haikus, nothing more.
      </p>

      <CopyBlock label="Claude / agent MCP config (claude_desktop_config.json)" text={mcpConfig} />
      <CopyBlock label="MCP tool descriptor" text={descriptor} />
      <CopyBlock label="Or just curl it" text={curl} />
    </div>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="copyblock">
      <div className="copyblock-head">
        <span className="copyblock-label">{label}</span>
        <button type="button" className="ghost small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="codeblock">{text}</pre>
    </div>
  );
}
