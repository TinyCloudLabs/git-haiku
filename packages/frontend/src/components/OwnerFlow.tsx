import { useEffect, useState } from 'react';

import {
  getOwner,
  registerOwner,
  sendDelegation,
  type OwnerResult,
  type OwnerAuthContext,
} from '../api';
import { signInOwner, type OwnerSession } from '../lib/ownerSession';
import { putGithubToken, materializeBackendDelegation, hasGithubToken } from '../lib/tinycloud';
import { verifyGithubToken, type GithubTokenResult } from '../lib/githubVerify';
import { OwnerDashboard } from './OwnerDashboard';

type Phase = 'signin' | 'setup' | 'dashboard';

/**
 * The real owner flow:
 *   1. OpenKey passkey sign-in → TinyCloud session + signer
 *   2. consent + GitHub login/token → secrets.put(GITHUB_TOKEN) →
 *      register owner → materialize + POST the backend delegation
 *   3. dashboard: codes + audit
 */
export function OwnerFlow() {
  const [phase, setPhase] = useState<Phase>('signin');
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [owner, setOwner] = useState<OwnerResult | null>(null);

  if (phase === 'dashboard' && session && owner) {
    return <OwnerDashboard auth={session.auth} owner={owner} did={session.did} />;
  }

  if (phase === 'setup' && session) {
    return (
      <SetupPhase
        session={session}
        onDone={(o) => {
          setOwner(o);
          setPhase('dashboard');
        }}
      />
    );
  }

  return (
    <SignInPhase
      onSignedIn={(s, existing) => {
        setSession(s);
        if (existing) {
          setOwner(existing);
          setPhase('dashboard');
        } else {
          setPhase('setup');
        }
      }}
    />
  );
}

// ── Phase 1: OpenKey sign-in ──────────────────────────────────────────

function SignInPhase({
  onSignedIn,
}: {
  onSignedIn: (s: OwnerSession, existing: OwnerResult | null) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setError(null);
    try {
      // 1. OpenKey passkey sign-in. 2. get-or-route: an existing owner goes
      // straight to their dashboard; a new address gets the setup form. A 404 in
      // getOwner returns null (new owner); any other failure throws and is
      // surfaced below — no silent fallback.
      const s = await signInOwner();
      const existing = await getOwner(s.auth);
      onSignedIn(s, existing);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>Sign in with OpenKey</h2>
      <p className="muted">
        Git Haiku never holds your GitHub token. You sign in with an OpenKey passkey, store the
        token in <strong>your own</strong> TinyCloud secrets vault, and delegate exactly one
        capability to the attested backend: read &amp; decrypt that one secret.
      </p>
      <button className="primary" onClick={signIn} disabled={loading}>
        {loading ? 'Connecting…' : 'Sign in with OpenKey'}
      </button>
      {error && <div className="denial">{error}</div>}
    </section>
  );
}

// ── Phase 2: consent + secrets.put + register + delegate ──────────────

function SetupPhase({
  session,
  onDone,
}: {
  session: OwnerSession;
  onDone: (owner: OwnerResult) => void;
}) {
  const [githubLogin, setGithubLogin] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Returning-owner state: whether a token is ALREADY stored in their vault.
  // `null` = still checking. We never read/show the token value, only presence.
  const [tokenStored, setTokenStored] = useState<boolean | null>(null);

  // Frontend-only token check (against api.github.com, never our backend).
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<GithubTokenResult | null>(null);

  // On mount, surface what's already there instead of a blank form.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const present = await hasGithubToken(session.tcw);
        if (!cancelled) setTokenStored(present);
      } catch {
        if (!cancelled) setTokenStored(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.tcw]);

  // Re-typing the token invalidates a stale verification result.
  function onTokenChange(value: string) {
    setGithubToken(value);
    if (verifyResult) setVerifyResult(null);
  }

  async function verify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await verifyGithubToken(githubToken);
      setVerifyResult(result);
      // Default the login to the verified account if the field is empty.
      if (result.ok && !githubLogin.trim()) setGithubLogin(result.login);
    } finally {
      setVerifying(false);
    }
  }

  // Block storing a token we KNOW is invalid (a checked-and-failed result).
  const tokenKnownInvalid = verifyResult !== null && !verifyResult.ok;

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (tokenKnownInvalid) {
      setError('This token failed verification — fix it before storing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 1. Owner writes the token into their OWN TinyCloud secrets vault.
      setStatus('Encrypting your token into your TinyCloud vault…');
      await putGithubToken(session.tcw, githubToken.trim());

      // 2. Register the owner record (binds the address; mints the first code).
      setStatus('Registering you with the backend…');
      const ownerResult = await registerOwner(session.auth, { githubLogin: githubLogin.trim() });

      // 3. Materialize + send the KV-get+decrypt delegation to the backend DID.
      setStatus('Delegating read-only secret access to the attested backend…');
      const serialized = await materializeBackendDelegation(
        session.tcw,
        session.backendDid,
        session.composedRequest,
      );
      const delegation = await sendDelegation(session.auth, {
        ownerId: ownerResult.ownerId,
        serialized,
      });

      setStatus(`Delegation active (expires ${new Date(delegation.expiresAt).toLocaleDateString()}).`);
      onDone(ownerResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Set up your haiku source</h2>

      {tokenStored && (
        <div className="stored-state">
          <p>
            <span className="ok-tick">✓</span> A GitHub token is already stored in your vault.
            Re-store below to rotate it, or continue to your dashboard.
          </p>
        </div>
      )}

      <div className="consent">
        <h3>What you&apos;re authorizing</h3>
        <ul>
          <li>Your GitHub token is encrypted into your own TinyCloud secrets vault.</li>
          <li>
            You delegate <strong>only</strong> read + decrypt of that one secret to the backend&apos;s
            attested identity (<code className="mono">{short(session.backendDid)}</code>).
          </li>
          <li>
            The backend can <strong>only</strong> emit three-line haikus from your commit messages —
            the egress guard blocks everything else.
          </li>
          <li>The delegation expires automatically (~90 days). Revoke any time by rotating codes.</li>
        </ul>
      </div>

      <form onSubmit={run} className="form column">
        <label className="field">
          <span>GitHub login (whose commits the haiku describes)</span>
          <input
            className="input"
            value={githubLogin}
            onChange={(e) => setGithubLogin(e.target.value)}
            placeholder="octocat"
          />
        </label>
        <label className="field">
          <span>GitHub token (stored in YOUR vault, never sent to us in the clear)</span>
          <input
            className="input mono"
            type="password"
            value={githubToken}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="ghp_…"
          />
          <div className="row">
            <button
              type="button"
              className="ghost small"
              onClick={() => void verify()}
              disabled={verifying || !githubToken.trim()}
            >
              {verifying ? 'Verifying…' : 'Verify token'}
            </button>
            <span className="muted token-verify-hint">Checks GitHub directly — your token never leaves your browser for this.</span>
          </div>
          {verifyResult && <TokenVerifyResult result={verifyResult} />}
          <TokenHelp />
        </label>
        <button
          className="primary"
          disabled={busy || !githubLogin.trim() || !githubToken.trim() || tokenKnownInvalid}
        >
          {busy ? 'Working…' : 'Authorize & generate code'}
        </button>
      </form>

      {status && <p className="muted status">{status}</p>}
      {error && <div className="denial">{error}</div>}
    </section>
  );
}

// ── GitHub token verification result ──────────────────────────────────

/**
 * Renders the outcome of the frontend-only GitHub token check. Valid → green
 * state with login + scopes (or a fine-grained note). Invalid → clear error
 * pointing at the existing token-help links below.
 */
function TokenVerifyResult({ result }: { result: GithubTokenResult }) {
  if (!result.ok) {
    return (
      <div className="denial token-verify">
        <strong>Invalid or insufficient token.</strong> {result.message} Create a new one with the
        links below.
      </div>
    );
  }

  return (
    <div className="token-verify valid">
      <p>
        <span className="ok-tick">✓</span> Valid — authenticated as{' '}
        <strong>{result.login}</strong>.
      </p>
      <p className="muted">
        {result.scopes === null
          ? 'Fine-grained token (GitHub does not expose its scopes here).'
          : result.scopes.length === 0
            ? 'Classic token with no scopes (read-only of public data).'
            : `Scopes: ${result.scopes.join(', ')}`}
      </p>
      <p className="muted">
        {result.canReadRepos
          ? 'Confirmed read access to your repositories.'
          : 'Note: could not confirm repository read access — fine for public-only sources.'}
      </p>
    </div>
  );
}

// ── GitHub token help ─────────────────────────────────────────────────

/**
 * Inline help under the token input. Git Haiku reads ONLY commit metadata
 * (messages, repo names, timestamps — never file contents/diffs), so the
 * minimum grant is read-only. A token is optional for public repos only.
 */
function TokenHelp() {
  return (
    <div className="token-help muted">
      <p className="token-help-line">
        Create one:{' '}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noopener noreferrer"
        >
          fine-grained token
        </a>{' '}
        (recommended) or{' '}
        <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer">
          classic token
        </a>
        . Public repos only? A token is optional.
      </p>
      <details className="token-help-details">
        <summary>What permissions?</summary>
        <p>
          Git Haiku reads <strong>only commit metadata</strong> — messages, repo names, timestamps.
          Never file contents or diffs. Grant the minimum:
        </p>
        <ul>
          <li>
            <strong>Fine-grained (recommended):</strong> Repository access = the repos you want
            summarized (or all). Permissions → <code className="mono">Contents: Read-only</code> and{' '}
            <code className="mono">Metadata: Read-only</code> (Metadata is mandatory).
          </li>
          <li>
            <strong>Classic (alt):</strong> <code className="mono">repo</code> scope for private
            repos, or <code className="mono">public_repo</code> for public-only. Read access is all
            that&apos;s used.
          </li>
        </ul>
      </details>
    </div>
  );
}

function short(did: string): string {
  return did.length > 28 ? `${did.slice(0, 18)}…${did.slice(-8)}` : did;
}

export type { OwnerAuthContext };
