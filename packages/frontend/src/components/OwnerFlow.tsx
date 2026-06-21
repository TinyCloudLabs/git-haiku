import { useState } from 'react';

import {
  registerOwner,
  sendDelegation,
  type OwnerResult,
  type OwnerAuthContext,
} from '../api';
import { signInOwner, type OwnerSession } from '../lib/ownerSession';
import { putGithubToken, materializeBackendDelegation } from '../lib/tinycloud';
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
      onSignedIn={(s) => {
        setSession(s);
        setPhase('setup');
      }}
    />
  );
}

// ── Phase 1: OpenKey sign-in ──────────────────────────────────────────

function SignInPhase({ onSignedIn }: { onSignedIn: (s: OwnerSession) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setError(null);
    try {
      onSignedIn(await signInOwner());
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

  async function run(e: React.FormEvent) {
    e.preventDefault();
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
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="ghp_…"
          />
        </label>
        <button className="primary" disabled={busy || !githubLogin.trim() || !githubToken.trim()}>
          {busy ? 'Working…' : 'Authorize & generate code'}
        </button>
      </form>

      {status && <p className="muted status">{status}</p>}
      {error && <div className="denial">{error}</div>}
    </section>
  );
}

function short(did: string): string {
  return did.length > 28 ? `${did.slice(0, 18)}…${did.slice(-8)}` : did;
}

export type { OwnerAuthContext };
