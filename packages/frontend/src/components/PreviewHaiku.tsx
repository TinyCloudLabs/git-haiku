import { useState } from 'react';

import {
  previewHaiku,
  type OwnerAuthContext,
  type PreviewResponse,
  type PreviewStage,
} from '../api';

/**
 * Owner-side end-to-end preview. Calls `POST /api/preview` (owner SIWE auth)
 * and renders the three-line haiku on success, or a clear, stage-keyed message
 * on failure — so the owner can validate the whole pipeline (stored token →
 * GitHub activity → generation) and SEE the haiku before sharing a code.
 */
export function PreviewHaiku({ auth }: { auth: OwnerAuthContext }) {
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(force = false) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await previewHaiku(auth, { force }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'preview failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Preview your haiku</h3>
      <p className="muted">
        Run the full pipeline once — read your stored token, fetch your recent GitHub activity, and
        generate a haiku — without minting or sharing a code.
      </p>
      <div className="row">
        <button className="primary" data-testid="preview-run" onClick={() => void run()} disabled={busy}>
          {busy ? 'Generating…' : result ? 'Preview cached haiku' : 'Preview / test haiku'}
        </button>
        {result?.allowed && (
          <button
            className="ghost"
            data-testid="preview-regenerate"
            onClick={() => void run(true)}
            disabled={busy}
          >
            Regenerate haiku
          </button>
        )}
      </div>

      {error && <div className="denial">{error}</div>}

      {result && result.allowed && (
        <div className="haiku" data-testid="haiku">
          {result.haiku.lines.map((line, i) => (
            <p key={i} className="haiku-line" data-testid="haiku-line">
              {line}
            </p>
          ))}
        </div>
      )}

      {result && !result.allowed && (
        <div className="denial">{stageMessage(result.stage)}</div>
      )}
    </div>
  );
}

/** Map an egress-guard failure stage to an actionable owner-facing message. */
function stageMessage(stage: PreviewStage): string {
  switch (stage) {
    case 'secrets':
      return "Couldn't read your stored token — re-store it on the setup page.";
    case 'github':
      return "Couldn't read your GitHub activity — check the token's permissions and that the account has recent commits.";
    case 'generate':
      return "Couldn't generate the haiku from your activity. Try again, or check your recent commit messages.";
    case 'internal':
    default:
      return 'Something went wrong on our side generating the preview. Please try again.';
  }
}
