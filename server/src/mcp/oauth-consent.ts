interface ConsentParams {
  clientName: string;
  clientUri?: string;
  error?: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes?: string[];
  resource?: string;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function getConsentHTML(params: ConsentParams): string {
  const clientLabel = params.clientUri
    ? `<a href="${esc(params.clientUri)}" target="_blank" rel="noopener">${esc(params.clientName)}</a>`
    : `<strong>${esc(params.clientName)}</strong>`;

  const errorBlock = params.error
    ? `<div class="error">${esc(params.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>wactl — Authorize</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 2rem;
      width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; text-align: center; }
    h1 span { color: #22d3ee; }
    .subtitle {
      text-align: center; color: #94a3b8; font-size: 0.95rem;
      margin-bottom: 1.5rem; line-height: 1.4;
    }
    .subtitle a { color: #22d3ee; text-decoration: none; }
    .subtitle a:hover { text-decoration: underline; }
    .field { margin-bottom: 1rem; }
    label { display: block; font-size: 0.875rem; color: #94a3b8; margin-bottom: 0.25rem; }
    input[type="password"] {
      width: 100%; padding: 0.625rem 0.75rem; border: 1px solid #334155;
      background: #0f172a; color: #e2e8f0; border-radius: 6px; font-size: 1rem;
    }
    input:focus { outline: none; border-color: #22d3ee; }
    .buttons { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .btn {
      flex: 1; padding: 0.75rem; border: none; border-radius: 6px;
      font-size: 1rem; font-weight: 600; cursor: pointer;
    }
    .btn-primary { background: #22d3ee; color: #0f172a; }
    .btn-primary:hover { background: #06b6d4; }
    .btn-secondary { background: #334155; color: #e2e8f0; }
    .btn-secondary:hover { background: #475569; }
    .error {
      background: #7f1d1d; color: #fca5a5; padding: 0.75rem; border-radius: 6px;
      font-size: 0.875rem; margin-bottom: 1rem; text-align: center;
    }
    .scopes {
      background: #0f172a; border-radius: 6px; padding: 0.75rem;
      margin-bottom: 1rem; font-size: 0.85rem; color: #94a3b8;
    }
    .scopes li { margin-left: 1rem; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span>wactl</span> — Authorize</h1>
    <p class="subtitle">
      ${clientLabel} wants to access your WhatsApp via wactl.
    </p>
    ${errorBlock}
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${esc(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="S256">
      ${params.state ? `<input type="hidden" name="state" value="${esc(params.state)}">` : ""}
      ${params.scopes?.length ? `<input type="hidden" name="scope" value="${esc(params.scopes.join(" "))}">` : ""}
      ${params.resource ? `<input type="hidden" name="resource" value="${esc(params.resource)}">` : ""}
      <input type="hidden" name="password" id="password_hidden" value="">
      <div class="field">
        <label for="password_input">Admin password</label>
        <input type="password" id="password_input" required autofocus
               placeholder="Enter your wactl admin password">
      </div>
      <div class="buttons">
        <button type="submit" class="btn btn-primary">Authorize</button>
      </div>
    </form>
  </div>
  <script>
    document.querySelector('form').addEventListener('submit', function(e) {
      var pw = document.getElementById('password_input').value;
      document.getElementById('password_hidden').value = btoa(unescape(encodeURIComponent(pw)));
    });
  </script>
</body>
</html>`;
}
