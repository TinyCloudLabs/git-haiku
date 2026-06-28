import { useCallback, useEffect, useState } from 'react';

import {
  getAudit,
  listCodes,
  mintCode,
  revokeCode,
  rotateCodes,
  type AuditEntry,
  type CodeSummary,
  type MintedCode,
  type OwnerAuthContext,
  type OwnerResult,
} from '../api';
import { PreviewHaiku } from './PreviewHaiku';

/**
 * Owner dashboard: mint / list / rotate / revoke secret codes, show share URLs,
 * and the audit trail. Every call uses the SIWE-auth headers via `auth`.
 */
export function OwnerDashboard({
  auth,
  owner,
  did,
  onRestoreToken,
}: {
  auth: OwnerAuthContext;
  owner: OwnerResult;
  did: string;
  /** Switch to the setup phase to rotate/re-store the GitHub token (heavy recap). */
  onRestoreToken: () => void;
}) {
  const [codes, setCodes] = useState<CodeSummary[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [justMinted, setJustMinted] = useState<MintedCode | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [c, a] = await Promise.all([listCodes(auth), getAudit(auth)]);
      setCodes(c);
      setAudit(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load dashboard');
    }
  }, [auth]);

  // Seed with the first code minted at registration so the owner sees it once.
  // A returning owner has no plaintext code (secretCode === ''); they just see
  // their existing codes list via refresh(), not a bogus "new code" card.
  useEffect(() => {
    if (owner.secretCode) {
      setJustMinted({ codeId: owner.codeId, secretCode: owner.secretCode });
    }
    void refresh();
  }, [owner, refresh]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  const onMint = () =>
    withBusy(async () => {
      setJustMinted(await mintCode(auth));
      await refresh();
    });

  const onRotate = () =>
    withBusy(async () => {
      setJustMinted(await rotateCodes(auth));
      await refresh();
    });

  const onRevoke = (codeId: string) =>
    withBusy(async () => {
      await revokeCode(auth, codeId);
      await refresh();
    });

  async function copyShareUrl(code: CodeSummary) {
    if (!code.secretCode) return;
    try {
      await navigator.clipboard.writeText(shareUrlFor(owner.ownerId, code.secretCode));
      setCopiedCodeId(code.codeId);
      setTimeout(() => setCopiedCodeId(null), 1500);
    } catch {
      setCopiedCodeId(null);
    }
  }

  return (
    <section className="stack">
      <div className="card">
        <h2>Owner dashboard</h2>
        <p className="muted">
          Signed in as{' '}
          <code className="mono" data-testid="owner-address">
            {shortDid(did)}
          </code>{' '}
          · GitHub <strong>{owner.githubLogin}</strong>
          {owner.hasGithubToken && (
            <>
              {' '}
              · <span className="ok-tick">✓</span> token stored
            </>
          )}
        </p>
        <div className="row">
          <button className="primary" onClick={onMint} disabled={busy}>
            Mint new code
          </button>
          <button className="ghost" onClick={onRotate} disabled={busy}>
            Rotate (revoke all + mint)
          </button>
          <button className="ghost" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button
            className="ghost"
            data-testid="dashboard-restore-token"
            onClick={onRestoreToken}
            disabled={busy}
          >
            Rotate / re-store GitHub token
          </button>
        </div>
        {error && <div className="denial">{error}</div>}
      </div>

      {justMinted && <NewCodeCard owner={owner.ownerId} minted={justMinted} />}

      <PreviewHaiku auth={auth} />

      <div className="card">
        <h3>Codes</h3>
        {codes === null ? (
          <p className="muted">Loading…</p>
        ) : codes.length === 0 ? (
          <p className="muted">No codes yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Code id</th>
                <th>Created</th>
                <th>Status</th>
                <th>Share URL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.codeId} className={c.active ? '' : 'revoked'}>
                  <td className="mono">{c.codeId}</td>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                  <td>{c.active ? 'active' : `revoked ${new Date(c.revokedAt!).toLocaleDateString()}`}</td>
                  <td>
                    {c.active && c.secretCode ? (
                      <button
                        className="ghost small"
                        data-testid={`copy-share-url-${c.codeId}`}
                        onClick={() => void copyShareUrl(c)}
                      >
                        {copiedCodeId === c.codeId ? 'Copied' : 'Copy URL'}
                      </button>
                    ) : c.active ? (
                      <span className="muted">Unavailable</span>
                    ) : (
                      <span className="muted">Revoked</span>
                    )}
                  </td>
                  <td>
                    {c.active && (
                      <button className="ghost small" onClick={() => onRevoke(c.codeId)} disabled={busy}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Audit trail</h3>
        {audit === null ? (
          <p className="muted">Loading…</p>
        ) : audit.length === 0 ? (
          <p className="muted">No requests yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Code id</th>
                <th>Decision</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td>{new Date(e.ts).toLocaleString()}</td>
                  <td className="mono">{e.codeId}</td>
                  <td className={e.decision === 'allow' ? 'allow' : 'deny'}>{e.decision}</td>
                  <td>{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function NewCodeCard({ owner, minted }: { owner: string; minted: MintedCode }) {
  const shareUrl = shareUrlFor(owner, minted.secretCode);
  const [copied, setCopied] = useState<'code' | 'url' | null>(null);

  async function copy(text: string, what: 'code' | 'url') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="card highlight">
      <h3>New code — shown once</h3>
      <p className="muted">Copy it now. Only its hash is stored; you can&apos;t see it again.</p>
      <div className="codepill-row">
        <code className="code-pill">{minted.secretCode}</code>
        <button className="ghost small" onClick={() => copy(minted.secretCode, 'code')}>
          {copied === 'code' ? 'Copied' : 'Copy code'}
        </button>
      </div>
      <label className="field">
        <span>Share URL</span>
        <div className="codepill-row">
          <input className="input mono" readOnly value={shareUrl} />
          <button className="ghost small" onClick={() => copy(shareUrl, 'url')}>
            {copied === 'url' ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </label>
    </div>
  );
}

function shareUrlFor(ownerId: string, secretCode: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/u/${ownerId}?code=${encodeURIComponent(secretCode)}`;
}

function shortDid(did: string): string {
  return did.length > 28 ? `${did.slice(0, 18)}…${did.slice(-8)}` : did;
}
