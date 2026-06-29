import { useState } from 'react';

import { requestHaiku, requestWeeklyReport, type HaikuResponse, type WeeklyReportResponse } from '../api';
import { McpInstructions } from './McpInstructions';
import { WeeklyReportCard } from './WeeklyReportCard';

/**
 * Requester surface: enter a secret code → get a haiku or weekly report.
 */
type RequestKind = 'haiku' | 'report';

export function Requester({
  initialCode = '',
  initialKind = 'haiku',
}: {
  initialCode?: string;
  initialKind?: RequestKind;
}) {
  const [code, setCode] = useState(initialCode);
  const [kind, setKind] = useState<RequestKind>(initialKind);
  const [loading, setLoading] = useState(false);
  const [haikuResult, setHaikuResult] = useState<HaikuResponse | null>(null);
  const [reportResult, setReportResult] = useState<WeeklyReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setHaikuResult(null);
    setReportResult(null);
    setError(null);
    try {
      if (kind === 'haiku') {
        setHaikuResult(await requestHaiku(code.trim()));
      } else {
        setReportResult(await requestWeeklyReport(code.trim()));
      }
    } catch {
      setError(kind === 'haiku' ? 'Could not reach the haiku service.' : 'Could not reach the report service.');
    } finally {
      setLoading(false);
    }
  }

  const validHaikuCode = haikuResult?.allowed ? code.trim() : '';
  const submitLabel = kind === 'haiku' ? 'Get Haiku' : 'Get Report';
  const loadingLabel = kind === 'haiku' ? 'Composing…' : 'Writing…';

  return (
    <section className="stack">
      <div className="card">
        <h2>Enter the secret code</h2>
        <p className="muted">
          One code can fetch a three-line haiku or the owner&apos;s last-week report, both
          generated from commit metadata inside an attested TEE.
        </p>
        <div className="segmented" role="group" aria-label="request type">
          <button
            type="button"
            className={kind === 'haiku' ? 'segment active' : 'segment'}
            onClick={() => setKind('haiku')}
          >
            Haiku
          </button>
          <button
            type="button"
            className={kind === 'report' ? 'segment active' : 'segment'}
            onClick={() => setKind('report')}
          >
            Weekly report
          </button>
        </div>
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
            {loading ? loadingLabel : submitLabel}
          </button>
        </form>

        {haikuResult && haikuResult.allowed && (
          <div className="haiku">
            {haikuResult.haiku.lines.map((line, i) => (
              <p key={i} className="haiku-line">
                {line}
              </p>
            ))}
            <p className="author-line">
              -{' '}
              <a
                href={`https://github.com/${haikuResult.author.githubLogin}`}
                target="_blank"
                rel="noreferrer"
              >
                @{haikuResult.author.githubLogin}
              </a>{' '}
              (
              <a
                href={`https://github.com/${haikuResult.author.githubLogin}`}
                target="_blank"
                rel="noreferrer"
              >
                github.com/{haikuResult.author.githubLogin}
              </a>
              )
            </p>
            <p className="proof">
              policy: {haikuResult.proof.policy_id} · attestation:{' '}
              {haikuResult.proof.attestation_url ? (
                <a href={haikuResult.proof.attestation_url} target="_blank" rel="noreferrer">
                  verify
                </a>
              ) : (
                'deferred (dev)'
              )}
            </p>
          </div>
        )}

        {haikuResult && !haikuResult.allowed && (
          <div className="denial">
            <strong>No haiku.</strong> {haikuResult.reason}
          </div>
        )}

        {reportResult && !reportResult.allowed && (
          <div className="denial">
            <strong>No report.</strong> {reportResult.reason}
          </div>
        )}

        {error && <div className="denial">{error}</div>}
      </div>

      {reportResult && reportResult.allowed && <WeeklyReportCard report={reportResult.report} />}

      {validHaikuCode && <McpInstructions code={validHaikuCode} />}
    </section>
  );
}
