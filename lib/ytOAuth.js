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
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OAUTH_FILE = path.join(__dirname, '..', '.yt_oauth.json');

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const TESTING_REFRESH_TOKEN_DAYS = 7;

const pendingStates = new Map();
let accessTokenCache = null;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function readOAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeOAuthFile(patch) {
  const next = { ...readOAuthFile(), ...patch };
  fs.writeFileSync(OAUTH_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
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
  // Changing the client invalidates any refresh token issued by the old one.
  accessTokenCache = null;
  return writeOAuthFile({ clientId: id, clientSecret: secret, refreshToken: '', connectedAt: '', channelTitle: '', channelId: '' });
}

export function hasClientCredentials() {
  const { clientId, clientSecret } = readOAuthFile();
  return Boolean(clientId && clientSecret);
}

export function isConnected() {
  return Boolean(readOAuthFile().refreshToken);
}

/** Days since consent — used only to warn, never to block a still-working token. */
export function connectionAgeDays() {
  const { connectedAt } = readOAuthFile();
  if (!connectedAt) return null;
  const ms = Date.now() - new Date(connectedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function isProbablyExpired() {
  const days = connectionAgeDays();
  return days !== null && days >= TESTING_REFRESH_TOKEN_DAYS;
}

export function buildAuthUrl(port) {
  const { clientId } = readOAuthFile();
  if (!clientId) throw httpError('먼저 구글 OAuth 클라이언트 ID와 보안 비밀번호를 저장해 주세요.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  for (const [key, at] of pendingStates) {
    if (Date.now() - at > 10 * 60 * 1000) pendingStates.delete(key);
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(port));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', YOUTUBE_SCOPE);
  // offline + consent: we need a refresh token every time, including on a
  // re-authorization after the 7-day testing-mode expiry (Google only returns
  // a refresh token when it re-prompts).
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export function consumeState(state) {
  const key = String(state || '');
  if (!pendingStates.has(key)) return false;
  pendingStates.delete(key);
  return true;
}

async function tokenRequest(body) {
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
        '구글 연결이 만료되었거나 취소되었습니다. [유튜브 계정 연결]을 다시 눌러 재연결해 주세요. ' +
        '(OAuth 동의 화면이 "테스트" 상태이면 구글이 7일마다 연결을 만료시킵니다.)',
        401
      );
    }
    throw httpError(`구글 토큰 요청 실패: ${data?.error_description || code || response.status}`, 400);
  }
  return data;
}

export async function exchangeCodeForTokens(code, port) {
  const { clientId, clientSecret } = readOAuthFile();
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
  writeOAuthFile({ refreshToken: data.refresh_token, connectedAt: new Date().toISOString() });
  accessTokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3500) - 60) * 1000 };
  return data.access_token;
}

export async function getAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now()) return accessTokenCache.token;
  const { clientId, clientSecret, refreshToken } = readOAuthFile();
  if (!refreshToken) throw httpError('유튜브 계정이 연결되어 있지 않습니다. [유튜브 계정 연결]을 먼저 눌러 주세요.', 401);
  const data = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  accessTokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3500) - 60) * 1000 };
  return data.access_token;
}

export function disconnect() {
  accessTokenCache = null;
  return writeOAuthFile({ refreshToken: '', connectedAt: '', channelTitle: '', channelId: '' });
}

export function rememberChannel({ channelId, channelTitle }) {
  return writeOAuthFile({ channelId: String(channelId || ''), channelTitle: String(channelTitle || '') });
}

/** Thin authorized wrapper around the YouTube Data API. */
export async function youtubeApi(pathname, { method = 'GET', query = {}, body = null } = {}) {
  const token = await getAccessToken();
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
      throw httpError('오늘의 YouTube API 사용 한도를 모두 썼습니다. 태평양 시간 자정(한국 시간 오후 4~5시)에 초기화됩니다.', 429);
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
