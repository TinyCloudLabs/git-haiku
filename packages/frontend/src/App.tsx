import { useState } from 'react';

import { createOwner, requestHaiku, type HaikuResponse, type OwnerResult } from './api';

type Tab = 'requester' | 'owner';

export function App() {
  const [tab, setTab] = useState<Tab>('requester');
  return (
    <div className="page">
      <header className="masthead">
        <h1>Git Haiku</h1>
        <p className="tagline">
          A secret code in. A three-line haiku out. Nothing else ever leaves.
        </p>
        <nav className="tabs">
          <button className={tab === 'requester' ? 'tab active' : 'tab'} onClick={() => setTab('requester')}>
            Get a haiku
          </button>
          <button className={tab === 'owner' ? 'tab active' : 'tab'} onClick={() => setTab('owner')}>
            Owner setup
          </button>
        </nav>
      </header>

      <main>{tab === 'requester' ? <RequesterView /> : <OwnerView />}</main>

      <footer className="footer">
        <span className="devbadge">DEV PREVIEW</span> deterministic haiku · local secret store ·
        TEE/attestation, TinyCloud delegated secrets &amp; OpenKey deferred
      </footer>
    </div>
  );
}

function RequesterView() {
  const [code, setCode] = useState('');
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
      // Operational/network error — carries no commit data.
      setError('Could not reach the haiku service.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>Enter the secret code</h2>
      <form onSubmit={onSubmit} className="form">
        <input
          className="input"
          placeholder="e.g. skp7-bsyr-t52d-5vdq"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
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
          <p className="proof">
            policy: {result.proof.policy_id} · attestation:{' '}
            {result.proof.attestation_url ?? 'deferred (dev)'}
          </p>
        </div>
      )}

      {result && !result.allowed && (
        <div className="denial">
          <strong>No haiku.</strong> {result.reason}
        </div>
      )}

      {error && <div className="denial">{error}</div>}
    </section>
  );
}

function OwnerView() {
  const [githubLogin, setGithubLogin] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OwnerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await createOwner({ githubLogin: githubLogin.trim(), githubToken }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'setup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>Owner setup</h2>
      <p className="muted">
        Store your GitHub login (and optionally a token), then share the generated secret code. With
        no token, haikus render from a built-in dev fixture.
      </p>
      <form onSubmit={onSubmit} className="form column">
        <label className="field">
          <span>GitHub login (required)</span>
          <input className="input" value={githubLogin} onChange={(e) => setGithubLogin(e.target.value)} placeholder="octocat" />
        </label>
        <label className="field">
          <span>GitHub token (optional, dev-local)</span>
          <input className="input" type="password" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="ghp_…" />
        </label>
        <button className="primary" disabled={loading || !githubLogin.trim()}>
          {loading ? 'Saving…' : 'Generate secret code'}
        </button>
      </form>

      {result && (
        <div className="owner-result">
          <p>Share this secret code with requesters:</p>
          <code className="code-pill">{result.secretCode}</code>
          <p className="muted">
            login: {result.githubLogin} · token stored: {String(result.hasGithubToken)}
          </p>
        </div>
      )}

      {error && <div className="denial">{error}</div>}
    </section>
  );
}
