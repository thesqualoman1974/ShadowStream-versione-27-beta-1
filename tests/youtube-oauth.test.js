'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  authorizeYoutube,
  buildYoutubeAuthorizationUrl,
  createCodeChallenge,
  createPkceVerifier,
  exchangeYoutubeCode,
} = require('../electron/streaming/youtube-oauth');

function requestCallback(callbackUrl) {
  return new Promise((resolve, reject) => {
    http.get(callbackUrl, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

test('creates a high-entropy PKCE verifier and S256 challenge', () => {
  const verifier = createPkceVerifier();
  assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.match(createCodeChallenge(verifier), /^[A-Za-z0-9_-]+$/);
});

test('builds a YouTube desktop OAuth URL using PKCE and a local callback', () => {
  const url = new URL(buildYoutubeAuthorizationUrl({
    clientId: 'public-client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:12345/oauth2callback',
    state: 'random-state',
    verifier: 'A'.repeat(64),
  }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('exchanges the code without a distributed client secret and validates the token response', async () => {
  let request;
  const credentials = await exchangeYoutubeCode({
    clientId: 'public-client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:12345/oauth2callback',
    code: 'authorization-code',
    verifier: 'verifier',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
      };
    },
  });
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('client_secret'), null);
  assert.equal(body.get('code_verifier'), 'verifier');
  assert.equal(credentials.accessToken, 'access');
  assert.equal(credentials.refreshToken, 'refresh');
  assert.ok(credentials.expiresAt > Date.now());
});

test('completes OAuth only after the loopback callback returns the matching state', async () => {
  let authorizationUrl;
  const credentialsPromise = authorizeYoutube({
    clientId: 'public-client.apps.googleusercontent.com',
    shell: {
      openExternal: async (url) => {
        authorizationUrl = new URL(url);
        const callback = new URL(authorizationUrl.searchParams.get('redirect_uri'));
        const invalid = new URL(callback);
        invalid.searchParams.set('state', 'wrong-state');
        invalid.searchParams.set('code', 'ignored-code');
        assert.equal(await requestCallback(invalid), 400);

        callback.searchParams.set('state', authorizationUrl.searchParams.get('state'));
        callback.searchParams.set('code', 'authorization-code');
        assert.equal(await requestCallback(callback), 200);
      },
    },
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('code'), 'authorization-code');
      assert.equal(body.get('client_secret'), null);
      return {
        ok: true,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
      };
    },
  });
  const credentials = await credentialsPromise;
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(credentials.accessToken, 'access-token');
});
