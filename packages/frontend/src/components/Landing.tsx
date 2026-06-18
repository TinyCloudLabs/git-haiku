/**
 * Marketing landing page. Explains what Git Haiku is, the trust contract, and
 * the "verifiable haiku from an attested TEE" pitch, with entry into the app.
 */
export function Landing({ onEnter }: { onEnter: (view: 'requester' | 'owner') => void }) {
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-glow" aria-hidden />
        <p className="eyebrow">Verifiable haiku · attested TEE · TinyCloud-delegated secrets</p>
        <h1 className="hero-title">
          A secret code in.
          <br />
          A three-line haiku out.
        </h1>
        <p className="hero-sub">
          Git Haiku distills your recent commit messages into a haiku — generated inside a
          hardware-attested enclave that can emit <em>only</em> the poem. Your GitHub token never
          leaves your own encrypted vault.
        </p>
        <div className="hero-cta">
          <button className="primary big" onClick={() => onEnter('requester')}>
            Get a haiku
          </button>
          <button className="ghost big" onClick={() => onEnter('owner')}>
            Set up your own
          </button>
        </div>
        <div className="haiku-sample" aria-hidden>
          <p>refactors at dusk—</p>
          <p>a thousand green checkmarks bloom</p>
          <p>then the merge conflict</p>
        </div>
      </section>

      <section className="trust">
        <h2>The trust contract</h2>
        <div className="trust-grid">
          <TrustCard
            n="01"
            title="You hold the key"
            body="Sign in with an OpenKey passkey. Your GitHub token is encrypted into your own TinyCloud secrets vault — we never store it in the clear."
          />
          <TrustCard
            n="02"
            title="Scoped delegation"
            body="You delegate exactly one capability to the backend's attested identity: read & decrypt that single secret. Nothing more. It expires in ~90 days."
          />
          <TrustCard
            n="03"
            title="Locked egress"
            body="The enclave can only emit a three-line haiku from your commit messages. An output guard blocks every other byte — no token, no raw commits, ever."
          />
          <TrustCard
            n="04"
            title="Provable, not promised"
            body="Each haiku ships with a TEE attestation you can verify. The poem is the only thing that can come out, and you can prove it."
          />
        </div>
      </section>

      <section className="how">
        <h2>How it works</h2>
        <ol className="how-steps">
          <li>
            <strong>Owner</strong> signs in, stashes their GitHub token in their own vault, and
            delegates read-only secret access to the enclave.
          </li>
          <li>
            They mint a <strong>secret code</strong> and share it (or wire it into an agent over MCP).
          </li>
          <li>
            A <strong>requester</strong> presents the code; the enclave reads the owner&apos;s commits
            under the delegation and returns an attested haiku.
          </li>
        </ol>
        <div className="hero-cta center">
          <button className="primary big" onClick={() => onEnter('requester')}>
            Try it with a code
          </button>
        </div>
      </section>

      <footer className="landing-footer">
        <span>Git Haiku</span>
        <span className="muted">Built on TinyCloud · OpenKey · Phala dstack TEE</span>
      </footer>
    </div>
  );
}

function TrustCard({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="trust-card">
      <span className="trust-n">{n}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
