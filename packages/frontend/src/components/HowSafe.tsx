import { useState } from 'react';

import { BACKEND_URL } from '../lib/config';

/**
 * "How is this safe?" — the trust contract in plain language PLUS the tools a
 * skeptical user needs to verify it themselves: the live TDX attestation
 * endpoint and a copy-paste prompt that points their own AI agent at the
 * attestation + public source so it can confirm the running deployment matches.
 *
 * Links derive from config (BACKEND_URL) where a runtime value exists; the
 * public GitHub repo is a fixed constant.
 */

const REPO_URL = 'https://github.com/TinyCloudLabs/git-haiku';
const README_URL = `${REPO_URL}/blob/main/README.md`;
const README_RAW_URL =
  'https://raw.githubusercontent.com/TinyCloudLabs/git-haiku/refs/heads/main/README.md';

export function HowSafe() {
  // In dev BACKEND_URL is '' (same-origin proxy); fall back to the live origin
  // so the attestation link + verify prompt are absolute and copy-pasteable.
  const origin = BACKEND_URL || (typeof window !== 'undefined' ? window.location.origin : '');
  const attestationUrl = `${origin}/attestation`;

  const verifyPrompt =
    `Fetch ${attestationUrl} and the source + README at ${README_RAW_URL} ; ` +
    `confirm the attested compose/image digest corresponds to the published ` +
    `git-haiku backend image and that the code only emits haiku-shaped output ` +
    `(the egress guard in packages/shared).`;

  return (
    <section className="stack">
      <div className="card">
        <h2>How is this safe?</h2>
        <p className="muted">
          You don&apos;t have to trust us — you can check it. Here&apos;s the contract, then two ways
          to verify it yourself.
        </p>

        <div className="consent">
          <h3>The trust contract</h3>
          <ul>
            <li>
              Your GitHub token lives in <strong>your own</strong> TinyCloud Secrets vault, encrypted
              under your key. We never see it in the clear.
            </li>
            <li>
              The backend runs inside an <strong>attested Phala TEE</strong> — a hardware enclave
              whose exact code is measured and provable.
            </li>
            <li>
              It can emit <strong>only</strong> a three-line haiku built from your commit messages.
              An output guard blocks every other byte.
            </li>
            <li>Denials and errors leak nothing — no token, no raw commits, no metadata.</li>
          </ul>
        </div>
      </div>

      <div className="card">
        <h2>Verify it yourself — attestation</h2>
        <p className="muted">
          The backend exposes a real TDX quote. Open it and look at the JSON:
        </p>
        <p>
          <a href={attestationUrl} target="_blank" rel="noopener noreferrer">
            {attestationUrl}
          </a>
        </p>
        <ul className="how-steps">
          <li>
            <code className="mono">dev: false</code> plus a real <code className="mono">quote</code>{' '}
            means it is genuinely running in a TEE — not a dev stub.
          </li>
          <li>
            The <code className="mono">image_digest</code> carried in each haiku&apos;s{' '}
            <code className="mono">proof</code> binds that result to the exact attested compose, so
            the poem you got provably came from the code that was measured.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Verify it yourself — the code</h2>
        <p className="muted">
          The full source is public and the published image is reproducible from it:
        </p>
        <p>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            {REPO_URL}
          </a>{' '}
          ·{' '}
          <a href={README_URL} target="_blank" rel="noopener noreferrer">
            README
          </a>
        </p>
        <p className="muted">
          Don&apos;t take our word for the match — hand this prompt to your own AI agent and let it
          check that the running deployment matches the source:
        </p>
        <CopyBlock label="Verification prompt for your AI agent" text={verifyPrompt} />
      </div>
    </section>
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
