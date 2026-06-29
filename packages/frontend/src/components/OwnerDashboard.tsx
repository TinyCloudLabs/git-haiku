import { useCallback, useEffect, useState } from 'react';

import {
  generateLastWeekReport,
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
  type WeeklyReport,
} from '../api';
import { PreviewHaiku } from './PreviewHaiku';
import { WeeklyReportCard } from './WeeklyReportCard';

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
  const [copiedShareTarget, setCopiedShareTarget] = useState<string | null>(null);
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
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

  async function onWeeklyReport(force = false) {
    setReportBusy(true);
    setReportError(null);
    try {
      setWeeklyReport(await generateLastWeekReport(auth, { force }));
    } catch (err) {
      setReportError(err instanceof Error ? err.message : 'failed to generate report');
    } finally {
      setReportBusy(false);
    }
  }

  async function copyShareUrl(code: CodeSummary, kind: ShareKind) {
    if (!code.secretCode) return;
    const target = `${code.codeId}:${kind}`;
    try {
      await navigator.clipboard.writeText(shareUrlFor(owner.ownerId, code.secretCode, kind));
      setCopiedShareTarget(target);
      setTimeout(() => setCopiedShareTarget(null), 1500);
    } catch {
      setCopiedShareTarget(null);
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
          <button
            className="ghost"
            data-testid="weekly-report-run"
            onClick={() => void onWeeklyReport()}
            disabled={reportBusy}
          >
            {reportBusy ? 'Writing report…' : 'What did I do last week?'}
          </button>
          {weeklyReport && (
            <button
              className="ghost"
              data-testid="weekly-report-regenerate"
              onClick={() => void onWeeklyReport(true)}
              disabled={reportBusy}
            >
              Regenerate report
            </button>
          )}
        </div>
        {error && <div className="denial">{error}</div>}
        {reportError && <div className="denial">{reportError}</div>}
      </div>

      {justMinted && <NewCodeCard owner={owner.ownerId} minted={justMinted} />}

      {weeklyReport && <WeeklyReportCard report={weeklyReport} />}

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
                      <div className="share-actions">
                        <button
                          className="ghost small"
                          data-testid={`copy-share-url-${c.codeId}`}
                          onClick={() => void copyShareUrl(c, 'haiku')}
                        >
                          {copiedShareTarget === `${c.codeId}:haiku` ? 'Copied' : 'Haiku'}
                        </button>
                        <button
                          className="ghost small"
                          data-testid={`copy-report-url-${c.codeId}`}
                          onClick={() => void copyShareUrl(c, 'report')}
                        >
                          {copiedShareTarget === `${c.codeId}:report` ? 'Copied' : 'Report'}
                        </button>
                      </div>
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
  const haikuUrl = shareUrlFor(owner, minted.secretCode, 'haiku');
  const reportUrl = shareUrlFor(owner, minted.secretCode, 'report');
  const [copied, setCopied] = useState<'code' | 'haiku-url' | 'report-url' | null>(null);

  async function copy(text: string, what: 'code' | 'haiku-url' | 'report-url') {
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
        <span>Haiku URL</span>
        <div className="codepill-row">
          <input className="input mono" readOnly value={haikuUrl} />
          <button className="ghost small" onClick={() => copy(haikuUrl, 'haiku-url')}>
            {copied === 'haiku-url' ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </label>
      <label className="field">
        <span>Weekly report URL</span>
        <div className="codepill-row">
          <input className="input mono" readOnly value={reportUrl} />
          <button className="ghost small" onClick={() => copy(reportUrl, 'report-url')}>
            {copied === 'report-url' ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </label>
    </div>
  );
}

type ShareKind = 'haiku' | 'report';

function shareUrlFor(ownerId: string, secretCode: string, kind: ShareKind): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const kindParam = kind === 'report' ? '&kind=report' : '';
  return `${origin}/u/${ownerId}?code=${encodeURIComponent(secretCode)}${kindParam}`;
}

function shortDid(did: string): string {
  return did.length > 28 ? `${did.slice(0, 18)}…${did.slice(-8)}` : did;
}
