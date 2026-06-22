import { useState } from 'react';

import { Landing } from './components/Landing';
import { OwnerFlow } from './components/OwnerFlow';
import { Requester } from './components/Requester';
import { HowSafe } from './components/HowSafe';

type View = 'landing' | 'requester' | 'owner' | 'safe';

/**
 * Top-level view router (no router dep). The share-URL shape `/u/<owner>?code=…`
 * deep-links straight into the requester with the code prefilled.
 */
function initialView(): { view: View; code: string } {
  if (typeof window === 'undefined') return { view: 'landing', code: '' };
  const path = window.location.pathname;
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  if (path.startsWith('/u/') || code) return { view: 'requester', code };
  if (path.startsWith('/owner')) return { view: 'owner', code: '' };
  if (path.startsWith('/safe')) return { view: 'safe', code: '' };
  return { view: 'landing', code: '' };
}

export function App() {
  const start = initialView();
  const [view, setView] = useState<View>(start.view);

  if (view === 'landing') {
    return <Landing onEnter={setView} />;
  }

  const body =
    view === 'requester' ? (
      <Requester initialCode={start.code} />
    ) : view === 'owner' ? (
      <OwnerFlow />
    ) : (
      <HowSafe />
    );

  return (
    <div className="page">
      <header className="masthead">
        <button className="brand" onClick={() => setView('landing')}>
          Git Haiku
        </button>
        <nav className="tabs">
          <button className={view === 'requester' ? 'tab active' : 'tab'} onClick={() => setView('requester')}>
            Get a haiku
          </button>
          <button className={view === 'owner' ? 'tab active' : 'tab'} onClick={() => setView('owner')}>
            Owner
          </button>
          <button className={view === 'safe' ? 'tab active' : 'tab'} onClick={() => setView('safe')}>
            How is this safe?
          </button>
        </nav>
      </header>

      <main>{body}</main>

      <footer className="footer">
        verifiable haiku · attested TEE · your secrets stay yours
      </footer>
    </div>
  );
}
