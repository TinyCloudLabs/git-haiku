import { useState } from 'react';

import { Landing } from './components/Landing';
import { OwnerFlow } from './components/OwnerFlow';
import { Requester } from './components/Requester';

type View = 'landing' | 'requester' | 'owner';

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
  return { view: 'landing', code: '' };
}

export function App() {
  const start = initialView();
  const [view, setView] = useState<View>(start.view);

  if (view === 'landing') {
    return <Landing onEnter={setView} />;
  }

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
        </nav>
      </header>

      <main>{view === 'requester' ? <Requester initialCode={start.code} /> : <OwnerFlow />}</main>

      <footer className="footer">
        verifiable haiku · attested TEE · your secrets stay yours
      </footer>
    </div>
  );
}
