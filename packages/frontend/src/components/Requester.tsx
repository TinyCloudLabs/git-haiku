import { useState } from 'react';

import { requestHaiku, type HaikuResponse } from '../api';
import { McpInstructions } from './McpInstructions';

/**
 * Requester surface: enter a secret code → get a three-line haiku. Plus the MCP
 * setup panel so an agent can fetch haikus with the same code.
 */
export function Requester({ initialCode = '' }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HaikuResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      setResult(await requestHaiku(code.trim()));
    } catch {
      setError('Could not reach the haiku service.');
    } finally {
      setLoading(false);
    }
  }

  const validCode = result?.allowed ? code.trim() : '';

  return (
    <section className="stack">
      <div className="card">
        <h2>Enter the secret code</h2>
        <p className="muted">
          One code in, a three-line haiku out — distilled from the owner&apos;s recent commit
          messages inside an attested TEE. Nothing else ever leaves.
        </p>
        <form onSubmit={onSubmit} className="form">
          <input
            className="input mono"
            placeholder="e.g. skp7-bsyr-t52d-5vdq"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            aria-label="secret code"
          />
          <button className="primary" disabled={loading || !code.trim()}>
            {loading ? 'Composing…' : 'Get Haiku'}
          </button>
        </form>

        {result && result.allowed && (
          <div className="haiku">
            {result.haiku.lines.map((line, i) => (
              <p key={i} className="haiku-line">
                {line}
              </p>
            ))}
            <p className="author-line">
              -{' '}
              <a
                href={`https://github.com/${result.author.githubLogin}`}
                target="_blank"
                rel="noreferrer"
              >
                @{result.author.githubLogin}
              </a>{' '}
              (
              <a
                href={`https://github.com/${result.author.githubLogin}`}
                target="_blank"
                rel="noreferrer"
              >
                github.com/{result.author.githubLogin}
              </a>
              )
            </p>
            <p className="proof">
              policy: {result.proof.policy_id} · attestation:{' '}
              {result.proof.attestation_url ? (
                <a href={result.proof.attestation_url} target="_blank" rel="noreferrer">
                  verify
                </a>
              ) : (
                'deferred (dev)'
              )}
            </p>
          </div>
        )}

        {result && !result.allowed && (
          <div className="denial">
            <strong>No haiku.</strong> {result.reason}
          </div>
        )}

        {error && <div className="denial">{error}</div>}
      </div>

      {validCode && <McpInstructions code={validCode} />}
    </section>
  );
}
