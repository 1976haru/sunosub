const LANGUAGES = [
  '광둥어 (홍콩)', '그린란드어', '네덜란드어 (네덜란드)', '네덜란드어 (벨기에)', '노르웨이어',
  '덴마크어', '독일어 (독일)', '독일어 (스위스)', '독일어 (오스트리아)', '러시아어',
  '루마니아어', '말레이어', '베트남어', '벵골어 (인도)', '스웨덴어',
  '스페인어 (멕시코)', '스페인어 (라틴 아메리카)', '스페인어 (스페인)', '아랍어', '영어 (미국)',
  '영어 (영국)', '영어 (인도)', '영어 (캐나다)', '이탈리아어', '인도네시아어',
  '일본어', '중국어 (싱가포르)', '태국어', '튀르키예어 (터키어)', '페르시아어',
  '포르투갈어 (브라질)', '포르투갈어 (포르투갈)', '폴란드어', '프랑스어 (벨기에)', '프랑스어 (스위스)',
  '프랑스어 (캐나다)', '프랑스어 (프랑스)', '필리핀어', '힌디어', '그리스어',
  '헝가리어', '체코어', '우크라이나어', '히브리어', '아프리칸스어',
  '아이슬란드어', '카탈로니아어', '슬로바키아어', '핀란드어', '크로아티아어'
];
const CORE_LANGUAGES = new Set([
  '영어 (미국)', '일본어', '스페인어 (라틴 아메리카)', '포르투갈어 (브라질)', '프랑스어 (프랑스)',
  '독일어 (독일)', '이탈리아어', '인도네시아어', '태국어', '베트남어'
]);

const state = {
  selected: new Set(LANGUAGES),
  results: [],
  sourceMeta: null,
  translating: false,
  geminiConfigured: false,
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add('hidden'), 1900);
}

function setError(id, message = '') {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function applyTranslateGate() {
  const gate = $('translateGate');
  $('translateBtn').disabled = !state.geminiConfigured;
  if (state.geminiConfigured) {
    gate.classList.add('hidden');
    return;
  }
  gate.innerHTML = '무료 Gemini 키를 설정하면 번역할 수 있습니다. 상단 앱 셸의 키 배지에서 입력하세요 (무료, 결제 등록 불필요). ' +
    '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">키 발급받기</a>';
  gate.classList.remove('hidden');
}

async function loadStatus() {
  try {
    const status = await api('/api/yt/status');
    state.geminiConfigured = Boolean(status.geminiConfigured);
    $('statusBadges').innerHTML = `
      <span class="badge ${status.geminiConfigured ? 'ok' : 'warn'}">Gemini ${status.geminiConfigured ? '설정됨' : '키 필요'}</span>
      <span class="badge ${status.youtubeApiConfigured ? 'ok' : 'warn'}">YouTube API ${status.youtubeApiConfigured ? '설정됨' : '선택 사항'}</span>
      <span class="badge">${escapeHtml(status.model)}</span>`;
    applyTranslateGate();
  } catch (error) {
    $('statusBadges').innerHTML = '<span class="badge warn">서버 상태 확인 실패</span>';
  }
}

function updateTitleCount() {
  const count = Array.from($('sourceTitle').value).length;
  const el = $('sourceTitleCount');
  el.textContent = `${count} / 100`;
  el.classList.toggle('over', count > 100);
}

function renderLanguages(filter = '') {
  const query = filter.trim().toLowerCase();
  $('languageGrid').innerHTML = LANGUAGES
    .filter(lang => lang.toLowerCase().includes(query))
    .map(lang => `
      <label class="language-item">
        <input type="checkbox" value="${escapeHtml(lang)}" ${state.selected.has(lang) ? 'checked' : ''} />
        <span>${escapeHtml(lang)}</span>
      </label>`).join('');
  $('languageGrid').querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(input.value);
      else state.selected.delete(input.value);
      updateSelectedCount();
    });
  });
  updateSelectedCount();
}

function updateSelectedCount() {
  $('selectedCount').textContent = `${state.selected.size}개 선택`;
}

function setSourceMeta(data) {
  state.sourceMeta = data;
  const meta = $('sourceMeta');
  if (!data) {
    meta.classList.add('hidden');
    return;
  }
  const bits = [
    `추출 방식: ${data.source || '-'}`,
    data.channelTitle ? `채널: ${data.channelTitle}` : '',
    data.videoId ? `비디오 ID: ${data.videoId}` : '',
    data.warning ? `주의: ${data.warning}` : '',
    data.descriptionIncomplete ? '설명이 일부만 확인됐을 수 있습니다.' : ''
  ].filter(Boolean);
  meta.textContent = bits.join(' · ');
  meta.classList.remove('hidden');
}

async function extractVideo() {
  const url = $('youtubeUrl').value.trim();
  if (!url) return setError('mainError', 'YouTube URL을 입력해 주세요.');
  setError('mainError');
  $('extractBtn').disabled = true;
  $('extractBtn').textContent = '추출 중…';
  try {
    const data = await api('/api/yt/extract', { method: 'POST', body: JSON.stringify({ url }) });
    $('sourceTitle').value = data.title || '';
    $('sourceDescription').value = data.description || '';
    setSourceMeta(data);
    updateTitleCount();
    saveLocal();
    showToast('제목과 설명을 가져왔습니다.');
  } catch (error) {
    setError('mainError', error.message);
  } finally {
    $('extractBtn').disabled = false;
    $('extractBtn').textContent = '제목·설명 추출';
  }
}

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size));
  return result;
}

async function translateSelected() {
  if (state.translating || !state.geminiConfigured) return;
  const title = $('sourceTitle').value.trim();
  const description = $('sourceDescription').value;
  const selected = LANGUAGES.filter(lang => state.selected.has(lang));
  if (!title) return setError('translateError', '원문 제목을 입력해 주세요.');
  if (!selected.length) return setError('translateError', '번역 언어를 하나 이상 선택해 주세요.');
  setError('translateError');
  state.translating = true;
  state.results = [];
  $('resultsList').innerHTML = '';
  $('resultsPanel').classList.add('hidden');
  $('translateBtn').disabled = true;
  $('translateBtn').textContent = '번역 중…';
  $('progressWrap').classList.remove('hidden');

  const batches = chunk(selected, 8);
  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      $('progressText').textContent = `${selected.length}개 언어 중 ${Math.min(i * 8 + batch.length, selected.length)}개 처리 중 · 묶음 ${i + 1}/${batches.length}`;
      $('progressBar').style.width = `${Math.round((i / batches.length) * 100)}%`;
      const data = await api('/api/yt/translate', {
        method: 'POST',
        body: JSON.stringify({ title, description, languages: batch }),
      });
      state.results.push(...data.results);
      renderResults();
      saveLocal();
      if (i < batches.length - 1) await sleep(250);
    }
    $('progressBar').style.width = '100%';
    $('progressText').textContent = `${state.results.length}개 언어 번역 완료`;
    showToast('번역이 완료되었습니다.');
  } catch (error) {
    setError('translateError', `${state.results.length}개 언어까지 저장되었습니다. 다음 묶음에서 오류가 발생했습니다: ${error.message}`);
  } finally {
    state.translating = false;
    $('translateBtn').disabled = !state.geminiConfigured;
    $('translateBtn').textContent = '선택 언어 번역 시작';
  }
}

function renderResults() {
  if (!state.results.length) {
    $('resultsPanel').classList.add('hidden');
    return;
  }
  $('resultsPanel').classList.remove('hidden');
  $('resultsList').innerHTML = state.results.map((result, index) => {
    const titleCount = Array.from(result.translatedTitle || '').length;
    return `
      <article class="result-card" data-index="${index}">
        <div class="result-title-row">
          <h3>${escapeHtml(result.language)}</h3>
          <div class="result-actions">
            <button class="mini-btn" data-action="copy-title">제목 복사</button>
            <button class="mini-btn" data-action="regen-title">제목 재생성</button>
            <button class="mini-btn" data-action="copy-description">설명 복사</button>
            <button class="mini-btn" data-action="regen-description">설명 재생성</button>
          </div>
        </div>
        <div class="result-grid">
          <div>
            <div class="result-label-row"><span class="result-label">번역 제목</span><span class="counter ${titleCount > 100 ? 'over' : ''}">${titleCount} / 100</span></div>
            <textarea data-field="translatedTitle" rows="2">${escapeHtml(result.translatedTitle)}</textarea>
          </div>
          <div>
            <div class="result-label-row"><span class="result-label">번역 설명</span></div>
            <textarea data-field="translatedDescription" rows="9">${escapeHtml(result.translatedDescription)}</textarea>
          </div>
        </div>
      </article>`;
  }).join('');

  $('resultsList').querySelectorAll('.result-card').forEach(card => {
    const index = Number(card.dataset.index);
    card.querySelectorAll('textarea').forEach(textarea => {
      textarea.addEventListener('input', () => {
        state.results[index][textarea.dataset.field] = textarea.value;
        if (textarea.dataset.field === 'translatedTitle') {
          const counter = textarea.closest('div').querySelector('.counter');
          const n = Array.from(textarea.value).length;
          counter.textContent = `${n} / 100`;
          counter.classList.toggle('over', n > 100);
        }
        saveLocal();
      });
    });
    card.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        const result = state.results[index];
        if (action === 'copy-title') return copyText(result.translatedTitle);
        if (action === 'copy-description') return copyText(result.translatedDescription);
        const field = action === 'regen-description' ? 'description' : 'title';
        button.disabled = true;
        const old = button.textContent;
        button.textContent = '처리 중…';
        try {
          const data = await api('/api/yt/regenerate', {
            method: 'POST',
            body: JSON.stringify({
              title: $('sourceTitle').value,
              description: $('sourceDescription').value,
              language: result.language,
              field,
            })
          });
          if (field === 'title') result.translatedTitle = data.text;
          else result.translatedDescription = data.text;
          renderResults();
          saveLocal();
          showToast('재생성했습니다.');
        } catch (error) {
          setError('translateError', error.message);
        } finally {
          button.disabled = false;
          button.textContent = old;
        }
      });
    });
  });
}

async function copyText(text) {
  await navigator.clipboard.writeText(String(text || ''));
  showToast('클립보드에 복사했습니다.');
}

function csvEscape(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const rows = [['언어', '번역 제목', '번역 설명'], ...state.results.map(x => [x.language, x.translatedTitle, x.translatedDescription])];
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  download('﻿' + csv, 'youtube_translations.csv', 'text/csv;charset=utf-8');
}

function exportJson() {
  const payload = {
    source: { title: $('sourceTitle').value, description: $('sourceDescription').value, meta: state.sourceMeta },
    translations: state.results,
  };
  download(JSON.stringify(payload, null, 2), 'youtube_translations.json', 'application/json;charset=utf-8');
}

function copyAll() {
  const text = state.results.map(x => `[${x.language}]\n제목: ${x.translatedTitle}\n\n${x.translatedDescription}`).join('\n\n====================\n\n');
  copyText(text);
}

function saveLocal() {
  const payload = {
    url: $('youtubeUrl')?.value || '',
    title: $('sourceTitle')?.value || '',
    description: $('sourceDescription')?.value || '',
    selected: Array.from(state.selected),
    results: state.results,
    sourceMeta: state.sourceMeta,
  };
  localStorage.setItem('youtubeTranslatorLocalState', JSON.stringify(payload));
}

function restoreLocal() {
  try {
    const payload = JSON.parse(localStorage.getItem('youtubeTranslatorLocalState') || 'null');
    if (!payload) return;
    $('youtubeUrl').value = payload.url || '';
    $('sourceTitle').value = payload.title || '';
    $('sourceDescription').value = payload.description || '';
    if (Array.isArray(payload.selected)) state.selected = new Set(payload.selected);
    if (Array.isArray(payload.results)) state.results = payload.results;
    state.sourceMeta = payload.sourceMeta || null;
    setSourceMeta(state.sourceMeta);
    updateTitleCount();
    renderResults();
  } catch { /* ignore corrupted local storage */ }
}

function setupEvents() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === tab));
      const target = tab.dataset.tab;
      $('urlTab').classList.toggle('active', target === 'url');
      $('manualTab').classList.toggle('active', target === 'manual');
    });
  });
  $('extractBtn').addEventListener('click', extractVideo);
  $('youtubeUrl').addEventListener('keydown', event => { if (event.key === 'Enter') extractVideo(); });
  $('sourceTitle').addEventListener('input', () => { updateTitleCount(); saveLocal(); });
  $('sourceDescription').addEventListener('input', saveLocal);
  document.querySelectorAll('[data-copy-target]').forEach(button => {
    button.addEventListener('click', () => copyText($(button.dataset.copyTarget).value));
  });
  $('selectAllBtn').addEventListener('click', () => { state.selected = new Set(LANGUAGES); renderLanguages($('languageSearch').value); saveLocal(); });
  $('clearAllBtn').addEventListener('click', () => { state.selected.clear(); renderLanguages($('languageSearch').value); saveLocal(); });
  $('corePresetBtn').addEventListener('click', () => { state.selected = new Set(CORE_LANGUAGES); renderLanguages($('languageSearch').value); saveLocal(); });
  $('languageSearch').addEventListener('input', event => renderLanguages(event.target.value));
  $('translateBtn').addEventListener('click', translateSelected);
  $('exportCsvBtn').addEventListener('click', exportCsv);
  $('exportJsonBtn').addEventListener('click', exportJson);
  $('copyAllBtn').addEventListener('click', copyAll);
  window.addEventListener('beforeunload', saveLocal);
  window.addEventListener('creator-studio:key-updated', loadStatus);
}

restoreLocal();
renderLanguages();
setupEvents();
loadStatus();

/* ------------------------------------------------------------------ *
 * TASK CS-v1.6 — 유튜브에 번역 자동 등록 (videos.update: localizations)
 *
 * The write path is deliberately two-step (미리보기 → 등록), like the
 * timeline tool's rename: this publishes to a live public channel, and the
 * language-code resolution (한국어 라벨 → BCP-47) can legitimately fall back
 * or drop a language, so the user sees exactly what will land before it does.
 * ------------------------------------------------------------------ */

const publishState = { oauth: null, plan: null };

async function loadOAuthStatus() {
  try {
    const status = await api('/api/yt/oauth/status');
    publishState.oauth = status;
    $('redirectUriBox').textContent = status.redirectUri;
    if (status.clientIdPreview && !$('clientIdInput').value) $('clientIdInput').placeholder = status.clientIdPreview;

    const badges = [];
    badges.push(`<span class="badge ${status.hasClient ? 'ok' : 'warn'}">OAuth 클라이언트 ${status.hasClient ? '설정됨' : '필요'}</span>`);
    if (status.connected) {
      const expiring = status.probablyExpired;
      badges.push(`<span class="badge ${expiring ? 'warn' : 'ok'}">${escapeHtml(status.channelTitle || '연결됨')}${
        status.connectionAgeDays !== null ? ` · ${status.connectionAgeDays}일 전 연결` : ''}</span>`);
      if (expiring) {
        badges.push(`<span class="badge warn">${status.testingTokenDays}일 만료 가능 · 재연결 권장</span>`);
      }
    } else {
      badges.push('<span class="badge warn">계정 미연결</span>');
    }
    $('oauthBadges').innerHTML = badges.join('');
    if (!status.hasClient) $('oauthSetup').open = true;
  } catch (error) {
    $('oauthBadges').innerHTML = '<span class="badge warn">연결 상태 확인 실패</span>';
  }
}

async function saveOAuthClient() {
  setError('publishError');
  try {
    await api('/api/yt/oauth/credentials', {
      method: 'POST',
      body: JSON.stringify({
        clientId: $('clientIdInput').value.trim(),
        clientSecret: $('clientSecretInput').value.trim(),
      }),
    });
    $('clientSecretInput').value = '';
    showToast('클라이언트 정보를 저장했습니다. 이제 [유튜브 계정 연결]을 눌러 주세요.');
    await loadOAuthStatus();
  } catch (error) {
    setError('publishError', error.message);
  }
}

function connectYoutube() {
  if (!publishState.oauth?.hasClient) {
    $('oauthSetup').open = true;
    return setError('publishError', '먼저 구글 OAuth 클라이언트 ID와 보안 비밀번호를 저장해 주세요.');
  }
  setError('publishError');
  // A popup, not a redirect: this tool runs inside the Creator Studio shell's
  // iframe and would otherwise navigate the whole app away to Google.
  window.open('/api/yt/oauth/start', 'creator-studio-yt-oauth', 'width=520,height=680');
}

async function disconnectYoutube() {
  try {
    await api('/api/yt/oauth/disconnect', { method: 'POST' });
    $('myVideoSelect').classList.add('hidden');
    showToast('연결을 해제했습니다.');
    await loadOAuthStatus();
  } catch (error) {
    setError('publishError', error.message);
  }
}

async function loadMyVideos() {
  setError('publishError');
  const button = $('refreshVideosBtn');
  button.disabled = true;
  try {
    const data = await api('/api/yt/my-videos?maxResults=50');
    const select = $('myVideoSelect');
    if (!data.videos.length) {
      select.classList.add('hidden');
      return setError('publishError', '채널에서 영상을 찾지 못했습니다.');
    }
    select.innerHTML = '<option value="">— 내 영상에서 고르기 —</option>' + data.videos.map((video) =>
      `<option value="${escapeHtml(video.videoId)}">${escapeHtml(video.title)}</option>`).join('');
    select.classList.remove('hidden');
    showToast(`${data.videos.length}개 영상을 불러왔습니다.`);
  } catch (error) {
    setError('publishError', error.message);
  } finally {
    button.disabled = false;
  }
}

function currentTranslationsForPublish() {
  return state.results
    .filter((result) => (result.translatedTitle || '').trim())
    .map((result) => ({
      language: result.language,
      translatedTitle: result.translatedTitle,
      translatedDescription: result.translatedDescription,
    }));
}

function renderPublishReport(data, applied) {
  const box = $('publishReport');
  const rows = (applied ? data.published : data.planned) || [];
  const overwriting = new Set(data.overwriting || []);
  const parts = [];

  parts.push(`<h4>${applied ? '등록 완료' : '미리보기 — 아직 아무것도 등록되지 않았습니다'}</h4>`);
  parts.push(`<p>영상: <strong>${escapeHtml(data.videoTitle || data.videoId)}</strong> · 원문 언어 <code>${escapeHtml(data.defaultLanguage)}</code>` +
    (applied ? ` · 현재 등록된 언어 ${data.totalLocalizations}개` : '') + '</p>');

  if (rows.length) {
    parts.push(`<p class="ok">${applied ? '등록됨' : '등록 예정'} ${rows.length}개 언어</p><ul>` + rows.map((row) => {
      const isOverwrite = overwriting.has(row.code);
      return `<li><code>${escapeHtml(row.code)}</code> ${escapeHtml(row.language)}` +
        (isOverwrite ? ' <span class="warn">(기존 번역 덮어씀)</span>' : '') +
        (row.note ? ` <span class="warn">— ${escapeHtml(row.note)}</span>` : '') +
        (row.title ? `<br /><span style="color:#cfe0f6">${escapeHtml(row.title)}</span>` : '') + '</li>';
    }).join('') + '</ul>');
  }

  if (data.skipped?.length) {
    parts.push(`<p class="bad">건너뜀 ${data.skipped.length}개</p><ul>` + data.skipped.map((row) =>
      `<li>${escapeHtml(row.language)} — ${escapeHtml(row.reason)}</li>`).join('') + '</ul>');
  }
  if (!applied && data.currentDefaultLanguage && data.currentDefaultLanguage !== data.defaultLanguage) {
    parts.push(`<p class="warn">이 영상의 원문 언어가 현재 <code>${escapeHtml(data.currentDefaultLanguage)}</code>로 설정돼 있습니다. 등록하면 <code>${escapeHtml(data.defaultLanguage)}</code>로 바뀝니다.</p>`);
  }
  if (applied) parts.push(`<p class="hint">유튜브 스튜디오 &gt; 자막/번역 메뉴에서도 확인할 수 있습니다. 반영까지 몇 분 걸릴 수 있습니다. (${escapeHtml(data.quotaNote || '')})</p>`);

  box.innerHTML = parts.join('');
  box.classList.remove('hidden');
}

async function previewPublish() {
  setError('publishError');
  const translations = currentTranslationsForPublish();
  if (!translations.length) return setError('publishError', '먼저 위에서 번역을 실행해 주세요. 등록할 번역 결과가 없습니다.');
  const videoId = $('publishVideoId').value.trim() || $('myVideoSelect').value;
  if (!videoId) return setError('publishError', '대상 영상 URL 또는 ID를 입력해 주세요.');

  $('previewPublishBtn').disabled = true;
  try {
    const data = await api('/api/yt/publish-localizations', {
      method: 'POST',
      body: JSON.stringify({
        videoId,
        defaultLanguage: $('defaultLanguageSelect').value,
        translations,
        dryRun: true,
      }),
    });
    publishState.plan = { videoId, defaultLanguage: data.defaultLanguage, translations };
    renderPublishReport(data, false);
    $('applyPublishBtn').disabled = !data.planned?.length;
  } catch (error) {
    setError('publishError', error.message);
    publishState.plan = null;
    $('applyPublishBtn').disabled = true;
  } finally {
    $('previewPublishBtn').disabled = false;
  }
}

async function applyPublish() {
  if (!publishState.plan) return setError('publishError', '먼저 미리보기를 실행해 주세요.');
  setError('publishError');
  const button = $('applyPublishBtn');
  button.disabled = true;
  button.textContent = '등록 중…';
  try {
    // Publishes exactly the plan that was previewed, never a freshly rebuilt one.
    const data = await api('/api/yt/publish-localizations', {
      method: 'POST',
      body: JSON.stringify({ ...publishState.plan, dryRun: false }),
    });
    renderPublishReport(data, true);
    showToast(`${data.publishedCount}개 언어를 유튜브에 등록했습니다.`);
  } catch (error) {
    setError('publishError', error.message);
  } finally {
    button.disabled = false;
    button.textContent = '✅ 유튜브에 등록';
  }
}

function setupPublishEvents() {
  $('saveClientBtn').addEventListener('click', saveOAuthClient);
  $('connectYoutubeBtn').addEventListener('click', connectYoutube);
  $('disconnectYoutubeBtn').addEventListener('click', disconnectYoutube);
  $('refreshVideosBtn').addEventListener('click', loadMyVideos);
  $('previewPublishBtn').addEventListener('click', previewPublish);
  $('applyPublishBtn').addEventListener('click', applyPublish);
  $('copyRedirectBtn').addEventListener('click', () => copyText($('redirectUriBox').textContent));
  $('myVideoSelect').addEventListener('change', (event) => {
    if (event.target.value) $('publishVideoId').value = event.target.value;
    $('applyPublishBtn').disabled = true;
  });
  // Any change to the target invalidates the previewed plan.
  ['publishVideoId', 'defaultLanguageSelect'].forEach((id) => {
    $(id).addEventListener('input', () => { publishState.plan = null; $('applyPublishBtn').disabled = true; });
  });
  // The OAuth popup posts back here when Google finishes the round trip.
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'creator-studio:yt-oauth') loadOAuthStatus();
  });
}

setupPublishEvents();
loadOAuthStatus();
