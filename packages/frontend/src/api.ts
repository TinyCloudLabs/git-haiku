export interface HaikuSuccess {
  allowed: true;
  haiku: { lines: [string, string, string] };
  proof: { policy_id: string; image_digest: string | null; attestation_url: string | null };
}
export interface HaikuDenial {
  allowed: false;
  reason: string;
}
export type HaikuResponse = HaikuSuccess | HaikuDenial;

export async function requestHaiku(code: string): Promise<HaikuResponse> {
  const res = await fetch('/api/haiku', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return (await res.json()) as HaikuResponse;
}

export interface OwnerResult {
  ownerId: string;
  secretCode: string;
  githubLogin: string;
  hasGithubToken: boolean;
}

export async function createOwner(input: {
  githubLogin: string;
  githubToken: string;
}): Promise<OwnerResult> {
  const res = await fetch('/api/owner', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `setup failed (${res.status})`);
  }
  return (await res.json()) as OwnerResult;
}
