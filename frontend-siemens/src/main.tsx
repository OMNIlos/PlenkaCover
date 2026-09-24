import React from 'react';
import ReactDOM from 'react-dom/client';
import '@siemens/ix/dist/siemens-ix/siemens-ix.css';
import { defineCustomElements as defineIxIconCustomElements } from '@siemens/ix-icons/loader';

import App from './App';
import { AuthGate } from './components/auth/AuthGate';
import { registerPlenkaIcons } from './icons/registerIcons';
import { reloadWhenReleaseChanges } from './releaseRefresh';
import './styles.css';

registerPlenkaIcons();
defineIxIconCustomElements();

const releaseEntry = document
  .querySelector<HTMLScriptElement>('script[type="module"][src]')
  ?.getAttribute('src');
let releaseCheckInFlight = false;
const checkRelease = () => {
  if (document.hidden || releaseCheckInFlight) return;
  releaseCheckInFlight = true;
  void reloadWhenReleaseChanges(releaseEntry).finally(() => {
    releaseCheckInFlight = false;
  });
};
window.addEventListener('focus', checkRelease);
document.addEventListener('visibilitychange', checkRelease);
window.setInterval(checkRelease, 60_000);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
