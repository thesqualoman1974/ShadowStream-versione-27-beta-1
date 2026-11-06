'use strict';

const crypto = require('crypto');
const http = require('http');

const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

function createPkceVerifier() {
  return crypto.randomBytes(64).toString('base64url');
}

function createCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function buildYoutubeAuthorizationUrl({ clientId, redirectUri, state, verifier }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', YOUTUBE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createCodeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function exchangeYoutubeCode({ clientId, redirectUri, code, verifier, fetchImpl = fetch }) {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Scambio del codice OAuth YouTube rifiutato (HTTP ${response.status}).`);
  }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string'
    || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('YouTube non ha restituito le credenziali OAuth richieste.');
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}

function authorizeYoutube({ clientId, shell, fetchImpl = fetch, timeoutMs = 180000 }) {
  if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 256) {
    return Promise.reject(new TypeError('Client ID OAuth YouTube non valido.'));
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = createPkceVerifier();
  let redirectUri = '';

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer(async (request, response) => {
      let requestUrl;
      try {
        requestUrl = new URL(request.url, 'http://127.0.0.1');
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (request.method !== 'GET' || requestUrl.pathname !== '/oauth2callback') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (requestUrl.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Richiesta OAuth non valida. Torna a ShadowStream.');
        return;
      }
      const authorizationError = requestUrl.searchParams.get('error');
      if (authorizationError) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Autorizzazione YouTube annullata. Puoi chiudere questa finestra.');
        finish(new Error('Autorizzazione OAuth YouTube rifiutata o annullata.'));
        return;
      }
      const code = requestUrl.searchParams.get('code');
      if (!code || code.length > 4096) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Codice OAuth mancante o non valido.');
        finish(new Error('YouTube non ha restituito un codice OAuth valido.'));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'",
      });
      response.end('Account YouTube collegato. Puoi tornare a ShadowStream.');
      try {
        const credentials = await exchangeYoutubeCode({
          clientId: clientId.trim(),
          redirectUri,
          code,
          verifier,
          fetchImpl,
        });
        finish(null, credentials);
      } catch (error) {
        finish(error);
      }
    });

    const timeout = setTimeout(() => {
      finish(new Error('Tempo scaduto durante il collegamento dell’account YouTube.'));
    }, timeoutMs);

    function finish(error, credentials) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(credentials);
    }

    server.once('error', (error) => finish(new Error(`Avvio del callback OAuth non riuscito: ${error.message}`)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(new Error('Impossibile creare il callback locale per OAuth YouTube.'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const authorizationUrl = buildYoutubeAuthorizationUrl({
        clientId: clientId.trim(),
        redirectUri,
        state,
        verifier,
      });
      shell.openExternal(authorizationUrl).catch((error) => {
        finish(new Error(`Impossibile aprire il browser per OAuth YouTube: ${error.message}`));
      });
    });
  });
}

module.exports = {
  authorizeYoutube,
  buildYoutubeAuthorizationUrl,
  createCodeChallenge,
  createPkceVerifier,
  exchangeYoutubeCode,
};
