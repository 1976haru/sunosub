import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run with: node --test tests/ytOAuth.multiClient.test.mjs
// Isolated temp copy: never touches the real local .yt_oauth.json.
async function fixture(initialFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunosub-oauth-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../lib/ytOAuth.js', import.meta.url), path.join(root, 'lib', 'ytOAuth.js'));
  fs.writeFileSync(path.join(root, 'lib', 'ytErrorLog.js'), 'export const logYtApiError = () => {};\n');
  fs.writeFileSync(path.join(root, '.yt_oauth.json'), JSON.stringify(initialFile, null, 2));
  const oauth = await import(pathToFileURL(path.join(root, 'lib', 'ytOAuth.js')).href);
  return { oauth, root, read: () => JSON.parse(fs.readFileSync(path.join(root, '.yt_oauth.json'), 'utf8')) };
}

const aClient = 'client-a.apps.googleusercontent.com';
const bClient = 'client-b.apps.googleusercontent.com';

test('saving B credentials never clears A credentials or refresh token', async () => {
  const f = await fixture({
    clientId: aClient, clientSecret: 'a-secret',
    activeAccountId: 'account-A',
    accounts: [{ id: 'account-A', label: 'A', refreshToken: 'a-refresh',
      channelId: 'UC_A', channelTitle: 'OldPopLounge', connectedAt: '2026-10-28T00:00:00Z' }],
  });
  const originalFetch = globalThis.fetch;
  try {
    f.oauth.saveClientCredentials(bClient, 'b-secret');
    let saved = f.read();
    assert.equal(saved.accounts[0].refreshToken, 'a-refresh');
    assert.equal(saved.accounts[0].clientId, aClient);
    assert.equal(saved.accounts[0].clientSecret, 'a-secret');
    assert.equal(saved.clientId, bClient);

    const start = new URL(f.oauth.buildAuthUrl(5300, { label: 'B' }));
    assert.equal(start.searchParams.get('client_id'), bClient);
    assert.match(start.searchParams.get('prompt'), /select_account/);
    const pending = f.oauth.consumeState(start.searchParams.get('state'));

    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('client_id'), bClient);
        return new Response(JSON.stringify({ access_token: 'b-access', refresh_token: 'b-refresh', expires_in: 3600 }), { status: 200 });
      }
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('client_id'), aClient);
      assert.equal(form.get('refresh_token'), 'a-refresh');
      return new Response(JSON.stringify({ access_token: 'a-access', expires_in: 3600 }), { status: 200 });
    };
    const newAccount = await f.oauth.exchangeCodeForTokens('b-auth-code', 5300, pending);
    saved = f.read();
    assert.equal(saved.accounts.length, 2);
    assert.equal(saved.accounts[0].refreshToken, 'a-refresh');
    assert.equal(saved.accounts[1].clientId, bClient);
    assert.equal(saved.accounts[1].refreshToken, 'b-refresh');
    assert.equal(await f.oauth.getAccessToken('account-A'), 'a-access');
    assert.equal(await f.oauth.getAccessToken(newAccount.accountId), 'b-access');

    f.oauth.saveClientCredentials(aClient, 'a-secret');
    const bReconnect = new URL(f.oauth.buildAuthUrl(5300, { reconnectId: newAccount.accountId }));
    assert.equal(bReconnect.searchParams.get('client_id'), bClient, 'B reconnect must not use the new default');
    assert.equal(f.read().accounts[1].refreshToken, 'b-refresh');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('disconnected legacy A can reconnect with restored A default, but wrong channel is rejected', async () => {
  const f = await fixture({
    clientId: bClient, clientSecret: 'b-secret',
    activeAccountId: 'account-A',
    accounts: [{ id: 'account-A', label: 'A', refreshToken: '', channelId: 'UC_A' }],
  });
  const originalFetch = globalThis.fetch;
  try {
    f.oauth.saveClientCredentials(aClient, 'a-secret');
    const start = new URL(f.oauth.buildAuthUrl(5300, { reconnectId: 'account-A' }));
    assert.equal(start.searchParams.get('client_id'), aClient);
    const pending = f.oauth.consumeState(start.searchParams.get('state'));
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        assert.equal(new URLSearchParams(options.body).get('client_id'), aClient);
        return new Response(JSON.stringify({ access_token: 'other-access', refresh_token: 'other-refresh', expires_in: 3600 }), { status: 200 });
      }
      assert.match(String(url), /youtube\/v3\/channels/);
      return new Response(JSON.stringify({ items: [{ id: 'UC_NOT_A' }] }), { status: 200 });
    };
    await assert.rejects(f.oauth.exchangeCodeForTokens('wrong-code', 5300, pending), /다른 유튜브 채널/);
    assert.equal(f.read().accounts[0].refreshToken, '', 'wrong-channel reconnect must preserve the old account row');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
