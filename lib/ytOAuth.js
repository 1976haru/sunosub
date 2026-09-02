import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logYtApiError } from './ytErrorLog.js';

/**
 * TASK CS-v1.6 — publishing translated titles/descriptions back to YouTube
 * ("자동 번역 등록") is a *write* to the user's own channel, so unlike every
 * other network call in this app it cannot be done with an API key. It needs
 * OAuth 2.0 with the youtube.force-ssl scope and the channel owner's consent.
 *
 * Everything here stays on the user's own machine: the client ID/secret and
 * refresh token live in .yt_oauth.json (mode 600, gitignored) exactly like
 * .gemini_key, and the redirect URI points back at this same localhost server.
 *
 * Known operational limit, surfaced in the UI rather than hidden: while the
 * Google Cloud OAuth consent screen is in "테스트(Testing)" mode with an
 * External user type, Google expires the refresh token after 7 days. That is
 * fine for a personal tool — it just means reconnecting weekly — but it must
 * be *visible*, otherwise publishing mysteriously starts failing with
 * invalid_grant. isProbablyExpired() and the friendly invalid_grant message in
 * getAccessToken() exist for exactly that.
 *
 * TASK CS-v2.4 — 계정이 여러 개가 되었습니다. 구조상 핵심: OAuth 클라이언트
 * (clientId + clientSecret = 구글 클라우드 프로젝트)는 모든 계정이 공유하고,
 * refresh token만 계정별입니다. 그래서 Cloud Console 설정은 채널을 몇 개
 * 늘리든 최초 1회로 끝나고, 계정마다 반복되는 것은 구글 동의 절차뿐입니다.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OAUTH_FILE = path.join(__dirname, '..', '.yt_oauth.json');

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const TESTING_REFRESH_TOKEN_DAYS = 7;

/** state → { at, label, reconnectId } for the consent round trips in flight. */
const pendingStates = new Map();

/*
 * TASK CS-v2.4 — accountId → { token, expiresAt }. This used to be one
 * module-level variable, which stops being merely untidy the moment there is
 * more than one account: a cached access token minted for the Korean channel
 * would be reused for a request the user aimed at the Japanese one, and the
 * write would land on the wrong channel. Keyed by account, never shared.
 */
const accessTokenCache = new Map();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/*
 * TASK CS-v2.4 — the account id is a generated random value, not the channel
 * id. The row has to exist before consent finishes (it is what carries the
 * label through the Google round trip), and until Google comes back we do not
 * know which channel the user picked.
 */
function newAccountId() {
  return `acc_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeAccount(row, index = 0) {
  return {
    id: String(row?.id || '') || newAccountId(),
    label: String(row?.label || '').trim() || `계정 ${index + 1}`,
    refreshToken: String(row?.refreshToken || ''),
    channelId: String(row?.channelId || ''),
    channelTitle: String(row?.channelTitle || ''),
    connectedAt: String(row?.connectedAt || ''),
  };
}

/*
 * TASK CS-v2.4 — the v1.6 file shape held exactly one connection at the top
 * level: { refreshToken, channelId, channelTitle, connectedAt }. The user's
 * machine has a live one of those. Reading it into accounts[0] (and writing
 * the migrated shape back once) keeps that connection working; ignoring the
 * old keys would look like data loss — an already-consented channel would show
 * up as "not connected" and need a fresh trip through Google.
 */
function migrateShape(raw) {
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map(normalizeAccount) : [];
  const legacyToken = String(raw.refreshToken || '');
  let migrated = false;
  if (legacyToken && !accounts.some((account) => account.refreshToken === legacyToken)) {
    accounts.unshift(normalizeAccount({
      id: newAccountId(),
      label: String(raw.channelTitle || '').trim() || '기존 연결',
      refreshToken: legacyToken,
      channelId: raw.channelId,
      channelTitle: raw.channelTitle,
      connectedAt: raw.connectedAt,
    }));
    migrated = true;
  }

  let activeAccountId = String(raw.activeAccountId || '');
  if (!accounts.some((account) => account.id === activeAccountId)) activeAccountId = accounts[0]?.id || '';

  const file = {
    clientId: String(raw.clientId || ''),
    clientSecret: String(raw.clientSecret || ''),
    accounts,
    activeAccountId,
  };
  // Write the migrated shape back once, so the legacy top-level keys stop
  // lingering in the file after the first read.
  const hadLegacyKeys = ['refreshToken', 'connectedAt', 'channelId', 'channelTitle'].some((key) => key in raw);
  return { file, needsWrite: migrated || hadLegacyKeys };
}

function persist(file) {
  fs.writeFileSync(OAUTH_FILE, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function readOAuthFile() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8')) || {};
  } catch {
    return { clientId: '', clientSecret: '', accounts: [], activeAccountId: '' };
  }
  const { file, needsWrite } = migrateShape(raw);
  // A read must never throw just because the file is read-only; the migrated
  // shape is already correct in memory either way.
  if (needsWrite) { try { persist(file); } catch { /* keep going with the in-memory shape */ } }
  return file;
}

function writeOAuthFile(patch) {
  const next = { ...readOAuthFile(), ...patch };
  persist(next);
  return next;
}

export function redirectUri(port = Number(process.env.PORT || 5300)) {
  return `http://localhost:${port}/api/yt/oauth/callback`;
}

export function saveClientCredentials(clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) throw httpError('클라이언트 ID와 보안 비밀번호를 모두 입력해 주세요.');
  if (!id.includes('.apps.googleusercontent.com')) {
    throw httpError('클라이언트 ID 형식이 올바르지 않습니다. (…apps.googleusercontent.com 이어야 합니다)');
  }

  const file = readOAuthFile();
  const changed = file.clientId !== id || file.clientSecret !== secret;
  // TASK CS-v2.4 — one OAuth client (= one Google Cloud project) is shared by
  // every account; only the refresh tokens are per-account. Re-saving the
  // *same* credentials — which the user does whenever they re-paste them —
  // must therefore not touch the accounts at all. A genuinely different client
  // does invalidate every token it did not issue, but even then the rows stay:
  // only the tokens are blanked, so the labels survive and the user just
  // presses [재연결].
  if (!changed) return writeOAuthFile({ clientId: id, clientSecret: secret });

  accessTokenCache.clear();
  const accounts = file.accounts.map((account) => ({ ...account, refreshToken: '', connectedAt: '' }));
  return writeOAuthFile({ clientId: id, clientSecret: secret, accounts });
}

export function hasClientCredentials() {
  const { clientId, clientSecret } = readOAuthFile();
  return Boolean(clientId && clientSecret);
}

export function listAccounts() {
  return readOAuthFile().accounts;
}

/**
 * Resolves an account id to its row. An empty id means "the active one" —
 * every route that takes an optional accountId relies on that.
 */
export function getAccount(accountId) {
  const file = readOAuthFile();
  if (!file.accounts.length) {
    throw httpError('연결된 유튜브 계정이 없습니다. [계정 추가]를 먼저 눌러 주세요.', 401);
  }
  const wanted = String(accountId || '').trim() || file.activeAccountId;
  const found = file.accounts.find((account) => account.id === wanted);
  if (!found) {
    throw httpError(`계정을 찾지 못했습니다(${wanted || '없음'}). 계정 목록을 새로고침한 뒤 다시 골라 주세요.`, 404);
  }
  return found;
}

export function setActiveAccount(accountId) {
  const id = String(accountId || '').trim();
  const file = readOAuthFile();
  if (!file.accounts.some((account) => account.id === id)) {
    throw httpError(`계정을 찾지 못했습니다(${id || '없음'}).`, 404);
  }
  writeOAuthFile({ activeAccountId: id });
  return id;
}

export function renameAccount(accountId, label) {
  const id = String(accountId || '').trim();
  const name = String(label || '').trim().slice(0, 60);
  if (!name) throw httpError('계정 별명을 입력해 주세요.');
  const file = readOAuthFile();
  const account = file.accounts.find((row) => row.id === id);
  if (!account) throw httpError(`계정을 찾지 못했습니다(${id || '없음'}).`, 404);
  account.label = name;
  writeOAuthFile({ accounts: file.accounts });
  return account;
}

/** Days since consent — used only to warn, never to block a still-working token. */
export function connectionAgeDays(account) {
  const connectedAt = account?.connectedAt;
  if (!connectedAt) return null;
  const ms = Date.now() - new Date(connectedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function isProbablyExpired(account) {
  const days = connectionAgeDays(account);
  return days !== null && days >= TESTING_REFRESH_TOKEN_DAYS;
}

export function buildAuthUrl(port, { label = '', reconnectId = '' } = {}) {
  const { clientId } = readOAuthFile();
  if (!clientId) throw httpError('먼저 구글 OAuth 클라이언트 ID와 보안 비밀번호를 저장해 주세요.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, {
    at: Date.now(),
    label: String(label || '').trim().slice(0, 60),
    reconnectId: String(reconnectId || '').trim(),
  });
  for (const [key, entry] of pendingStates) {
    if (Date.now() - entry.at > 10 * 60 * 1000) pendingStates.delete(key);
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(port));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', YOUTUBE_SCOPE);
  // offline + consent: we need a refresh token every time, including on a
  // re-authorization after the 7-day testing-mode expiry (Google only returns
  // a refresh token when it re-prompts).
  //
  // TASK CS-v2.4 — `select_account` is what makes multi-account work at all.
  // With `consent` alone Google silently reuses whichever account the browser
  // is already signed in to, so pressing [계정 추가] re-connects the *same*
  // channel and the whole feature looks broken. Forcing the account chooser is
  // the difference between "add another channel" and "re-add the one you have".
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Returns the { label, reconnectId } stashed with this state, or null. */
export function consumeState(state) {
  const key = String(state || '');
  const entry = pendingStates.get(key);
  if (!entry) return null;
  pendingStates.delete(key);
  return { label: entry.label, reconnectId: entry.reconnectId };
}

async function tokenRequest(body, { accountLabel = '' } = {}) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(data?.error || '');
    if (code === 'invalid_grant') {
      throw httpError(
        `${accountLabel ? `"${accountLabel}" 계정의 ` : ''}구글 연결이 만료되었거나 취소되었습니다. 계정 목록에서 [재연결]을 눌러 주세요. ` +
        '(OAuth 동의 화면이 "테스트" 상태이면 구글이 7일마다 연결을 만료시킵니다.)',
        401
      );
    }
    throw httpError(`구글 토큰 요청 실패: ${data?.error_description || code || response.status}`, 400);
  }
  return data;
}

/**
 * Creates a new account row — or refreshes the one named by reconnectId —
 * from the authorization code. Which channel is behind it is still unknown at
 * this point; rememberChannel() fills that in right afterwards.
 */
export async function exchangeCodeForTokens(code, port, { label = '', reconnectId = '' } = {}) {
  const file = readOAuthFile();
  const { clientId, clientSecret } = file;
  if (!clientId || !clientSecret) throw httpError('OAuth 클라이언트 정보가 없습니다.');
  const data = await tokenRequest({
    code: String(code || ''),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(port),
    grant_type: 'authorization_code',
  });
  if (!data.refresh_token) {
    throw httpError('구글이 refresh token을 주지 않았습니다. 구글 계정 > 보안 > 서드파티 액세스에서 기존 권한을 삭제한 뒤 다시 시도해 주세요.');
  }

  const now = new Date().toISOString();
  const wantedId = String(reconnectId || '').trim();
  let account = wantedId ? file.accounts.find((row) => row.id === wantedId) : null;
  if (account) {
    account.refreshToken = data.refresh_token;
    account.connectedAt = now;
    if (label) account.label = String(label).trim().slice(0, 60);
  } else {
    account = normalizeAccount({
      id: newAccountId(),
      label: String(label || '').trim().slice(0, 60),
      refreshToken: data.refresh_token,
      connectedAt: now,
    }, file.accounts.length);
    file.accounts.push(account);
  }
  writeOAuthFile({ accounts: file.accounts, activeAccountId: account.id });
  accessTokenCache.set(account.id, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3500) - 60) * 1000 });
  return { accountId: account.id, accessToken: data.access_token, label: account.label };
}

export async function getAccessToken(accountId) {
  const account = getAccount(accountId);
  const cached = accessTokenCache.get(account.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const { clientId, clientSecret } = readOAuthFile();
  if (!account.refreshToken) {
    throw httpError(`"${account.label}" 계정이 아직 연결되지 않았습니다. 계정 목록에서 [재연결]을 눌러 주세요.`, 401);
  }
  const data = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: account.refreshToken,
    grant_type: 'refresh_token',
  }, { accountLabel: account.label });
  accessTokenCache.set(account.id, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3500) - 60) * 1000 });
  return data.access_token;
}

/** Removes one account. Deleting the active one falls back to the first left. */
export function disconnect(accountId) {
  const file = readOAuthFile();
  const id = String(accountId || '').trim() || file.activeAccountId;
  const index = file.accounts.findIndex((account) => account.id === id);
  if (index < 0) throw httpError(`계정을 찾지 못했습니다(${id || '없음'}).`, 404);
  const [removed] = file.accounts.splice(index, 1);
  accessTokenCache.delete(removed.id);
  const activeAccountId = file.activeAccountId === removed.id ? (file.accounts[0]?.id || '') : file.activeAccountId;
  const next = writeOAuthFile({ accounts: file.accounts, activeAccountId });
  return { removed: { id: removed.id, label: removed.label }, activeAccountId: next.activeAccountId };
}

/*
 * TASK CS-v2.4 — duplicate-channel defence, and it is not a nicety.
 *
 * If the browser is still signed in to the previous Google account, the user
 * presses [계정 추가] believing they added the Japanese channel while Google
 * actually handed back the Korean one a second time. Two rows then carry
 * different labels for the same channelId, and picking the "Japanese" row
 * publishes Japanese titles onto the Korean channel — a wrong write to a live
 * public channel, exactly the class of accident CLAUDE.md §4 exists to stop.
 *
 * So: same channelId as another row → drop the new row, refresh the existing
 * row's token, and tell the caller which account it collided with, so the
 * callback page can say so instead of silently "succeeding".
 */
export function rememberChannel(accountId, { channelId, channelTitle } = {}) {
  const file = readOAuthFile();
  const index = file.accounts.findIndex((account) => account.id === String(accountId || '').trim());
  if (index < 0) throw httpError(`계정을 찾지 못했습니다(${accountId || '없음'}).`, 404);

  const incoming = file.accounts[index];
  const cid = String(channelId || '');
  const title = String(channelTitle || '');
  const duplicateIndex = cid ? file.accounts.findIndex((account, i) => i !== index && account.channelId === cid) : -1;

  if (duplicateIndex >= 0) {
    const kept = file.accounts[duplicateIndex];
    const duplicateOf = { id: kept.id, label: kept.label, channelTitle: kept.channelTitle || title };
    if (incoming.refreshToken) kept.refreshToken = incoming.refreshToken;
    if (incoming.connectedAt) kept.connectedAt = incoming.connectedAt;
    if (title) kept.channelTitle = title;
    kept.channelId = cid;
    accessTokenCache.delete(kept.id);
    accessTokenCache.delete(incoming.id);
    file.accounts.splice(index, 1);
    const activeAccountId = file.activeAccountId === incoming.id ? kept.id : file.activeAccountId;
    writeOAuthFile({ accounts: file.accounts, activeAccountId });
    return { account: kept, duplicateOf, merged: true };
  }

  if (cid) incoming.channelId = cid;
  if (title) incoming.channelTitle = title;
  // The channel name becomes the label only while the user has not named the
  // account themselves.
  if (title && /^계정 \d+$/.test(incoming.label)) incoming.label = title;
  writeOAuthFile({ accounts: file.accounts });
  return { account: incoming, duplicateOf: null, merged: false };
}

/** Thin authorized wrapper around the YouTube Data API. */
export async function youtubeApi(pathname, { method = 'GET', query = {}, body = null, accountId = '' } = {}) {
  const token = await getAccessToken(accountId);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `YouTube API 오류 (${response.status})`;
    const errors = Array.isArray(data?.error?.errors) ? data.error.errors : [];
    const reason = errors[0]?.reason || '';

    // TASK CS-v2.3 — data.error.errors[]에는 {reason, location, locationType,
    // message}가 필드별로 들어 있는데 지금까지 message 한 줄만 쓰고 버렸다.
    // 상태와 무관하게(성공한 재시도 이전의 실패 포함되지 않음 — 이 함수는
    // !response.ok 분기에서만 호출된다) 실패는 전부 파일로 남긴다.
    logYtApiError({ pathname, method, status: response.status, message, errors });

    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      // TASK CS-v2.4 — 쿼터는 계정별이 아니라 OAuth 클라이언트가 속한 구글
      // 클라우드 프로젝트 전체에 걸립니다. 계정을 바꿔 봐도 소용없다는 걸
      // 적어 두지 않으면, 사용자가 계정을 하나씩 바꿔 보다가 앱이 고장났다고
      // 판단합니다(계정 3개면 실패도 3번 반복합니다).
      throw httpError(
        '오늘의 YouTube API 사용 한도를 모두 썼습니다. 태평양 시간 자정(한국 시간 오후 4~5시)에 초기화됩니다. ' +
        '이 한도는 계정별이 아니라 OAuth 클라이언트가 속한 구글 클라우드 프로젝트 전체에 적용되므로, ' +
        '다른 계정으로 바꿔도 오늘은 등록할 수 없습니다.',
        429
      );
    }
    if (reason === 'forbidden' || response.status === 403) {
      throw httpError(`권한 오류: ${message} (연결한 구글 계정이 이 영상의 채널 소유자인지 확인해 주세요.)`, 403);
    }

    // errors[]에 location이 있으면("어느 필드가 문제인지") 사용자 메시지에
    // 같이 보여준다 — "The request metadata is invalid." 한 줄로는 title인지
    // tags인지 구분할 방법이 없었다.
    const detail = errors
      .filter((e) => e.location)
      .map((e) => `${e.reason || e.message || '오류'} (${e.location})`)
      .join(', ');
    throw httpError(detail ? `${message} — ${detail}` : message, response.status);
  }
  return data;
}
