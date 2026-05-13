// API base URL is auto-picked per host:
//   - On GitHub Pages (*.github.io) the static frontend cannot run Node, so we call the Render backend.
//   - Everywhere else (localhost, *.onrender.com) we use same-origin (empty string) because the server.js
//     hosting this page also serves /api/* on the same origin.
window.API_BASE = location.hostname.endsWith('.github.io')
  ? 'https://ss-tools.onrender.com'
  : '';
