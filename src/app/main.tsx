import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@infra/web-ipc-client';
import '@shared/styles/tokens.css';
import '@shared/styles/base.css';
import './app.css';
import '@features/projects/projects.css';
import '@features/sessions/sessions.css';
import '@features/workspace/workspace.css';
import '@features/chat/chat.css';
import '@features/settings/settings.css';
import '@features/providers/providers.css';
import '@features/mcp/mcp.css';
import '@features/extensions/extensions.css';
import '@features/profiles/profiles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found in index.html');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
