import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { WebAuthGate } from './WebAuthGate';
import { initStorageSynchronization } from './storage-sync';
import { registerPwaServiceWorker } from '@infra/pwa';
import '@infra/web-ipc-client';
import '@shared/styles/tokens.css';
import '@shared/styles/base.css';
import './app.css';
import '@app/components/confirmation-modal.css';
import '@features/projects/projects.css';
import '@features/sessions/sessions.css';
import '@features/workspace/workspace.css';
import '@features/chat/chat.css';
import '@features/settings/settings.css';
import '@features/providers/providers.css';
import '@features/mcp/mcp.css';
import '@features/extensions/extensions.css';
import '@features/profiles/profiles.css';
import '@features/terminal/terminal.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found in index.html');
}

// Initialize storage synchronization between localStorage and server's open-pi-viewer.json
void initStorageSynchronization();

// Register PWA service worker in web browser mode
registerPwaServiceWorker();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <WebAuthGate>
      <App />
    </WebAuthGate>
  </React.StrictMode>
);
