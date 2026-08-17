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
  // TASK CS-v1.8 — which title+description state.results was generated for.
  // "이어서 번역"/hasResultFor() trust state.results as "already translated",
  // but unlike the server cache (keyed by title+description+language, so an
  // edit is automatically a cache miss) a plain in-memory array has no such
  // check. Without this, editing the title after translating and then
  // hitting "이어서 번역" would treat the pre-edit translations as done and
  // leave them stale instead of re-fetching for the new text.
  resultsSourceKey: null,
  sourceMeta: null,
  translating: false,
  geminiConfigured: false,
  // TASK CS-v2.1 작업 C — 설명까지 번역할 언어. state.selected의 부분집합
  // (그 안에서만 의미가 있다). 기본값은 비어있음 = 전 언어 제목만.
  descriptionScope: new Set(),
  // TASK CS-v2.1 후속 버그 [1] — 언어별 연속 실패 횟수. missingLanguages에
  // 나올 때마다 늘고, 그 언어가 실제로 성공하면(upsertResults) 0으로
  // 돌아간다(Map에서 삭제). 새로고침 시 초기화되는 건 의도됨 — 세션을
  // 새로 시작하면 "몇 번 실패했었는지"보다 "지금 다시 해보자"가 맞다.
  languageFailCounts: new Map(),
  // TASK CS-v1.8 follow-up — drives the confirm-box/regenerate-button
  // wording: "비용이 발생합니다" only makes sense when a paid key is
  // actually configured. Set from /api/yt/status in loadStatus().
  paidKeyConfigured: false,
};

const $ = (id) => document.getElementById(id);

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
  if (!response.ok) {
    const error = new Error(data.error || `요청 실패 (${response.status})`);
    // TASK CS-v2.0 — /api/yt/translate의 429 응답은 error 문자열 말고도
    // quotaExhausted/missingLanguages/paidKeyConfigured/quotaScope/results 같은
    // 구조화된 필드를 함께 보낸다(routes/yt.js). 여기서 실려 보내야 호출부가
    // error.message 말고 이 필드들도 읽을 수 있다.
    Object.assign(error, data);
    throw error;
  }
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

/** e.g. 45230 -> "약 4.5만", 3000 -> "3,000" — Korean "만" (10,000) grouping for the cost badge. */
function formatTokensMan(tokens) {
  if (!tokens) return '0';
  if (tokens < 10000) return tokens.toLocaleString('ko-KR');
  return `약 ${(tokens / 10000).toFixed(1)}만`;
}

async function loadStatus() {
  try {
    const status = await api('/api/yt/status');
    state.geminiConfigured = Boolean(status.geminiConfigured);
    state.paidKeyConfigured = Boolean(status.paidKeyConfigured);
    const usage = status.geminiUsageToday;
    // TASK CS-v1.7 — reference-only badge: this PC's 5 tools combined, today.
    // Doesn't gate anything (lib/geminiUsage.js is display-only by design);
    // the actual limit is whatever Google AI Studio's dashboard says.
    const usageBadge = usage
      ? `<span class="badge" title="오늘 이 PC의 5개 도구 합산 호출 수 · 참고용, 실제 한도는 Google AI Studio 대시보드 기준">오늘 Gemini 호출 ${usage.total}회${usage.failed ? ` (실패 ${usage.failed})` : ''}</span>`
      : '';
    // TASK CS-v1.8 — this tool's 번역/재생성 calls go through the paid slot
    // whenever a paid key is configured (lib/keyStore.js's currentKey('paid')
    // fallback), so make that visible right where the cost is actually incurred.
    const tierBadge = status.paidKeyConfigured
      ? `<span class="badge warn" title="이 화면의 번역·재생성 호출만 유료 키로 나갑니다. 다른 4개 도구는 무료 키를 그대로 씁니다.">번역: 유료 키 사용 중</span>`
      : `<span class="badge" title="유료 키를 설정하지 않아 무료 키로 동작합니다.">번역: 무료 키 사용 중</span>`;
    // TASK CS-v1.8 task D.7 — cost only stays managed if it's visible.
    // TASK CS-v1.8 follow-up — was `paidCalls ? ... : ''`, which lit up as
    // "유료 호출 N회" even with no paid key configured, because
    // byTier.paid used to count every request routed to the paid SLOT
    // (i.e. every /translate·/regenerate call), not every request that
    // actually spent a paid KEY (lib/gemini.js's currentKey('paid')
    // silently falls back to the free key when unset). That counting bug
    // is fixed at the source now, but a day's worth of already-recorded
    // byTier.paid from before the fix stays mislabeled in
    // .gemini_usage.json (left as-is, see the fix commit) until it ages
    // out at midnight — so gate the "유료" framing on paidKeyConfigured
    // itself, not just a nonzero count, rather than trusting stale data.
    const paidCalls = usage?.byTier?.paid || 0;
    const paidOutputTokens = usage?.tokens?.paid?.output || 0;
    const costBadge = (status.paidKeyConfigured && paidCalls)
      ? `<span class="badge warn" title="유튜브 번역기의 번역·재생성 호출만 집계 · 참고용, 실제 청구는 Google Cloud 콘솔 기준">오늘 유료 호출 ${paidCalls}회 · 출력 ${formatTokensMan(paidOutputTokens)} 토큰</span>`
      : '';
    $('statusBadges').innerHTML = `
      <span class="badge ${status.geminiConfigured ? 'ok' : 'warn'}">Gemini ${status.geminiConfigured ? '설정됨' : '키 필요'}</span>
      <span class="badge ${status.youtubeApiConfigured ? 'ok' : 'warn'}">YouTube API ${status.youtubeApiConfigured ? '설정됨' : '선택 사항'}</span>
      <span class="badge">${escapeHtml(status.model)}</span>
      ${tierBadge}
      ${costBadge}
      ${usageBadge}`;
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

function currentSourceKey() {
  return `${$('sourceTitle').value.trim()}\u0000${$('sourceDescription').value}`;
}

/** Called on every title/description edit — drops results that no longer match what's in the textareas. */
function invalidateResultsIfSourceChanged() {
  if (!state.results.length || state.resultsSourceKey === null) return;
  if (state.resultsSourceKey === currentSourceKey()) return;
  state.results = [];
  state.resultsSourceKey = null;
  renderResults();
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
      updateContinueButton();
      pruneDescriptionScope();
      renderDescScopeGrid();
    });
  });
  updateSelectedCount();
  updateContinueButton();
  pruneDescriptionScope();
  renderDescScopeGrid();
}

function updateSelectedCount() {
  $('selectedCount').textContent = `${state.selected.size}개 선택`;
}

/*
 * TASK CS-v2.1 작업 C 요구사항 1+2 — 설명까지 번역할 언어를 고르는 영역.
 * state.selected(메인 선택)의 부분집합만 보여준다 — 번역 대상이 아닌
 * 언어를 설명 대상으로 고르는 건 의미가 없다. CORE_LANGUAGES 프리셋을
 * 재사용한다(요구사항 2).
 */
function renderDescScopeGrid() {
  const selectedList = currentSelectedLanguages();
  const grid = $('descScopeGrid');
  if (!selectedList.length) {
    grid.innerHTML = '<p class="hint">먼저 위에서 번역할 언어를 선택하세요.</p>';
  } else {
    grid.innerHTML = selectedList.map(lang => `
      <label class="language-item">
        <input type="checkbox" value="${escapeHtml(lang)}" ${state.descriptionScope.has(lang) ? 'checked' : ''} />
        <span>${escapeHtml(lang)}</span>
      </label>`).join('');
    grid.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) state.descriptionScope.add(input.value);
        else state.descriptionScope.delete(input.value);
        updateDescScopeCount();
        updateCostEstimate();
        saveLocal();
      });
    });
  }
  updateDescScopeCount();
  updateCostEstimate();
}

function updateDescScopeCount() {
  $('descScopeCount').textContent = `${state.descriptionScope.size}개 선택`;
}

/*
 * TASK CS-v2.1 작업 C 요구사항 4 — 선택할 때마다 예상 호출 수를 갱신한다.
 * 캐시 히트는 감안하지 않은 상한 추정치다(추정이라고 명시적으로 표기) —
 * 금액은 절대 표시하지 않는다(단가는 변동되고, 추정값을 코드에 박지
 * 않는다는 geminiConfig.json 원칙과 같은 이유).
 */
function updateCostEstimate() {
  const el = $('costEstimate');
  if (!el) return;
  const selected = currentSelectedLanguages();
  const { full, titleOnly } = splitByDescriptionScope(selected);
  const title = $('sourceTitle').value.trim();
  const description = $('sourceDescription').value;
  const callsFor = (scope, list) => {
    if (!list.length) return 0;
    return Math.ceil(list.length / estimateBatchSize(scope, title, description, list.length));
  };
  const totalCalls = callsFor('title', titleOnly) + callsFor('full', full);
  el.textContent = selected.length
    ? `제목만 ${titleOnly.length}개 + 설명 ${full.length}개 → 예상 호출 ${totalCalls}회 (캐시 히트 제외한 상한 추정치)`
    : '';
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

/*
 * TASK CS-v1.7 — a fixed batch size of 8 always split 50 languages into 7
 * calls, whether the description was 300 characters or 4000. Size the batch
 * to the description instead: budget a per-call output token ceiling
 * (12000, comfortably under the 16384 maxOutputTokens routes/yt.js's
 * /translate sets) and estimate tokens per language as roughly half the
 * character count (title + description translated, ko/ja-heavy text) plus a
 * fixed overhead for the language label and JSON structure. Short
 * descriptions collapse to a single call; only very long ones (~4000+
 * chars) end up needing more than 7.
 */
const TRANSLATE_TOKEN_BUDGET = 12000;

// TASK CS-v2.1 작업 A 요구사항 3 — scope:'title'이면 언어당 출력량을
// description이 아니라 title 길이로 추정한다. routes/yt.js의
// estimateMaxBatchSize()와 반드시 같은 공식을 유지할 것(CLAUDE.md 3.3).
function estimateBatchSize(scope, title, description, totalSelected) {
  const baseLength = Array.from((scope === 'title' ? title : description) || '').length;
  const perLanguageTokens = (baseLength + 100) / 2;
  const size = Math.floor(TRANSLATE_TOKEN_BUDGET / perLanguageTokens);
  return Math.max(1, Math.min(totalSelected, size));
}

/*
 * TASK CS-v2.1 후속 버그 [2] — 결과가 있다는 것과 "그 언어에 필요한 만큼
 * 다 됐다"는 것은 다르다. 설명 대상(state.descriptionScope)으로 고른
 * 언어인데 결과가 scope:'title'로만 있으면(설명 번역 전) 아직 안 끝난
 * 것으로 봐야 한다 — 안 그러면 "이어서 번역"이 그 언어를 영원히
 * 건너뛴다. upsertResults()가 이미 결과마다 실제 적용된 scope를 저장해
 * 두므로 그걸 그대로 쓴다.
 */
function hasResultFor(language) {
  const result = state.results.find(r => r.language === language);
  if (!result) return false;
  if (state.descriptionScope.has(language) && result.scope !== 'full') return false;
  return true;
}

/*
 * TASK CS-v1.8 — "이어서 번역" and "언어를 아직 시도 안 함" are the same
 * question asked two ways: anything selected that isn't already sitting in
 * state.results, whether it was never attempted or got dropped by a
 * truncated batch (server's `missingLanguages`). Either way it never made
 * it into state.results, so one filter answers both — no separate tracking
 * of "missing" vs "untried" needed on the client.
 */
function pendingLanguages(selectedList) {
  return selectedList.filter(lang => !hasResultFor(lang));
}

// TASK CS-v2.1 작업 C — 실제 적용된 scope를 결과에 함께 저장한다(요구사항 4의
// 화면 반영). scope는 배치(호출) 단위 응답값이라 그 배치의 모든 결과에 같이 붙인다.
function upsertResults(newResults, scope) {
  for (const result of newResults) {
    const withScope = scope ? { ...result, scope } : result;
    const index = state.results.findIndex(r => r.language === result.language);
    if (index >= 0) state.results[index] = withScope;
    else state.results.push(withScope);
    state.languageFailCounts.delete(result.language); // TASK CS-v2.1 후속 버그 [1] — 성공하면 연속 실패 카운트 초기화
  }
}

// TASK CS-v2.1 후속 버그 [1] — missingLanguages(성공 응답의 일부 누락이든,
// 429 실패 응답의 미처리 언어든)에 나온 언어의 연속 실패 횟수를 늘린다.
function recordMissing(languages) {
  for (const lang of languages || []) {
    state.languageFailCounts.set(lang, (state.languageFailCounts.get(lang) || 0) + 1);
  }
}

/*
 * TASK CS-v2.1 작업 C — 설명 대상 언어는 state.selected의 부분집합으로만
 * 의미가 있다. 메인 선택이 줄어들면(체크 해제) 같이 정리해, 이미 선택
 * 해제한 언어가 설명 대상에는 남아 예상 표시가 어긋나는 일을 막는다.
 */
function pruneDescriptionScope() {
  for (const lang of [...state.descriptionScope]) {
    if (!state.selected.has(lang)) state.descriptionScope.delete(lang);
  }
}

function splitByDescriptionScope(languages) {
  const full = languages.filter(lang => state.descriptionScope.has(lang));
  const titleOnly = languages.filter(lang => !state.descriptionScope.has(lang));
  return { full, titleOnly };
}

function currentSelectedLanguages() {
  return LANGUAGES.filter(lang => state.selected.has(lang));
}

function updateContinueButton() {
  const btn = $('continueTranslateBtn');
  const pending = pendingLanguages(currentSelectedLanguages());
  if (!state.results.length || !pending.length) {
    btn.classList.add('hidden');
    renderPendingLanguages();
    return;
  }
  btn.classList.remove('hidden');
  btn.disabled = state.translating;
  btn.textContent = `이어서 번역 (${pending.length}개 남음)`;
  renderPendingLanguages();
}

/*
 * TASK CS-v2.1 후속 버그 [1] — 개수만이 아니라 실제 언어 이름을 보여준다.
 * 접었다 펼 수 있게 하고(요구사항), 반복 실패한 언어는 몇 번 실패했는지도
 * 같이 표시한다. updateContinueButton()이 부르는 것과 별개로
 * runOneScopeGroup()이 배치마다 직접 불러 진행 중에도 갱신되게 한다.
 */
function renderPendingLanguages() {
  const box = $('pendingLanguagesBox');
  const pending = pendingLanguages(currentSelectedLanguages());
  if (!state.results.length || !pending.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const listEl = $('pendingLanguagesList');
  const expanded = !listEl.classList.contains('hidden');
  $('pendingToggleBtn').textContent = `${expanded ? '남은 언어 접기' : '남은 언어 보기'} (${pending.length}개)`;
  listEl.innerHTML = pending.map(lang => {
    const failCount = state.languageFailCounts.get(lang) || 0;
    return `<div>${escapeHtml(lang)}${failCount > 0 ? ` <span class="fail-note">(${failCount}회 연속 실패)</span>` : ''}</div>`;
  }).join('');
}

/**
 * TASK CS-v2.1 작업 C 요구사항 3 — 처리할 언어를 설명 대상(scope:'full')과
 * 나머지(scope:'title')로 나눠 별도 요청으로 보낸다. 두 그룹은 각자 자기
 * scope에 맞는 묶음 크기로 나뉜다(estimateBatchSize). state.translating과
 * 버튼 상태는 이 함수가 그룹 전체에 걸쳐 한 번만 관리한다 — 그룹 사이에
 * 버튼이 깜빡이며 잠깐 풀리는 걸 막기 위해.
 */
// TASK CS-v2.1 후속 버그 [1] — "N개 완료, M개 남음: (언어명 나열)"을 한
// 줄로 만든다. overallLanguages는 이번 실행 전체의 대상(그룹 하나가
// 아니라)이라 "완료/남음"이 그룹이 바뀌어도 계속 같은 기준으로 보인다.
function describeProgress(overallLanguages) {
  const stillPending = pendingLanguages(overallLanguages);
  const doneCount = overallLanguages.length - stillPending.length;
  if (!stillPending.length) return `${doneCount}개 완료 — 전부 끝났습니다`;
  const preview = stillPending.slice(0, 8).join(', ') + (stillPending.length > 8 ? ` 외 ${stillPending.length - 8}개` : '');
  return `${doneCount}개 완료, ${stillPending.length}개 남음: ${preview}`;
}

async function runOneScopeGroup(overallLanguages, languages, scope, { forcePaid }) {
  const title = $('sourceTitle').value.trim();
  const description = $('sourceDescription').value;
  const scopeLabel = scope === 'full' ? '제목+설명' : '제목만';
  const batchSize = estimateBatchSize(scope, title, description, languages.length);
  const batches = chunk(languages, batchSize);
  let cacheHitCount = 0;
  const missing = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const data = await api('/api/yt/translate', {
      method: 'POST',
      body: JSON.stringify({ title, description, languages: batch, scope, ...(forcePaid ? { forcePaid: true } : {}) }),
    });
    cacheHitCount += data.fromCache?.length || 0;
    if (data.missingLanguages?.length) {
      missing.push(...data.missingLanguages);
      recordMissing(data.missingLanguages);
    }
    upsertResults(data.results, data.scope || scope);
    renderResults();
    saveLocal();
    // TASK CS-v2.1 후속 버그 [1] 요구사항 — 번역이 끝날 때마다(묶음 하나가
    // 끝날 때마다) 완료/남음을 알린다. [${scopeLabel}] 접두는 지금 어느
    // 그룹(제목만/제목+설명)을 처리 중인지 구분하기 위해 유지한다.
    $('progressText').textContent = `[${scopeLabel} · 묶음 ${i + 1}/${batches.length}] ${describeProgress(overallLanguages)}`;
    renderPendingLanguages();
    // TASK CS-v1.7 — no client-side sleep here anymore; lib/gemini.js's
    // process-wide queue paces every call (including these), and pacing
    // it from two places would just have them fight each other.
  }
  return { cacheHitCount, missing };
}

/** Shared by both the "번역" and "이어서 번역" buttons — only which languages get sent, and whether prior results are wiped first, differs. */
async function runScopedTranslate(languagesToProcess, { resetResults, forcePaid = false }) {
  if (state.translating || !state.geminiConfigured) return;
  hideTranslateConfirm();
  hideQuotaChoice();
  const title = $('sourceTitle').value.trim();
  if (!title) return setError('translateError', '원문 제목을 입력해 주세요.');
  if (!languagesToProcess.length) return setError('translateError', '번역할 언어가 없습니다.');
  setError('translateError');
  state.translating = true;
  state.resultsSourceKey = currentSourceKey();
  if (resetResults) {
    state.results = [];
    $('resultsList').innerHTML = '';
    $('resultsPanel').classList.add('hidden');
  }
  $('translateBtn').disabled = true;
  $('continueTranslateBtn').disabled = true;
  $('translateBtn').textContent = '번역 중…';
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = '0%';

  const { full, titleOnly } = splitByDescriptionScope(languagesToProcess);
  const groups = [];
  if (titleOnly.length) groups.push({ scope: 'title', languages: titleOnly });
  if (full.length) groups.push({ scope: 'full', languages: full });

  let cacheHitTotal = 0;
  let missingTotal = [];
  let quotaError = null;
  try {
    for (let g = 0; g < groups.length; g++) {
      const { cacheHitCount, missing } = await runOneScopeGroup(languagesToProcess, groups[g].languages, groups[g].scope, { forcePaid });
      cacheHitTotal += cacheHitCount;
      missingTotal.push(...missing);
      $('progressBar').style.width = `${Math.round(((g + 1) / groups.length) * 100)}%`;
    }
    const cacheNote = cacheHitTotal ? ` (캐시에서 ${cacheHitTotal}개 불러옴)` : '';
    $('progressText').textContent = `${languagesToProcess.length}개 언어 처리 완료${cacheNote}`;
    showToast(missingTotal.length
      ? `번역 완료. ${missingTotal.length}개 언어는 출력이 잘려 받지 못했습니다 — "이어서 번역"으로 다시 시도하세요.`
      : `번역이 완료되었습니다.${cacheNote}`);
  } catch (error) {
    // TASK CS-v2.0 작업 A 요구사항 2 — 429로 멈춘 것과 그 외 오류(네트워크
    // 끊김, 서버 오류 등)는 다르게 다룬다: 무료 한도 소진은 "재시도 선택지"를
    // 보여줄 수 있는 상황이지 그냥 실패가 아니다. error.results는 이번에
    // 실패한 배치 안에서도 캐시로 이미 맞춘 언어들이므로 먼저 반영한다 —
    // 그렇지 않으면 이 배치의 캐시 히트가 화면에서 사라진다.
    if (error.quotaExhausted) {
      quotaError = error;
      upsertResults(error.results || [], error.scope);
      recordMissing(error.missingLanguages); // TASK CS-v2.1 후속 버그 [1] — 429로 못 받은 언어도 연속 실패로 집계
      renderResults();
      renderPendingLanguages();
      saveLocal();
      setError('translateError');
      // TASK CS-v2.1 — 두 그룹 중 하나가 429로 막히면 나머지 그룹(예: 아직
      // 시도 안 한 설명-대상 그룹)도 이어서 부르지 않는다 — 남은 전체를
      // pendingLanguages로 다시 계산해 선택지에 보여준다.
      showQuotaChoice(pendingLanguages(languagesToProcess), quotaError);
    } else {
      const remaining = pendingLanguages(languagesToProcess).length;
      setError('translateError', `${languagesToProcess.length - remaining}개 언어까지 저장되었습니다. 처리 중 오류가 발생했습니다: ${error.message}`);
    }
  } finally {
    state.translating = false;
    $('translateBtn').disabled = !state.geminiConfigured;
    $('translateBtn').textContent = '선택 언어 번역 시작';
    updateContinueButton();
  }
}

/*
 * TASK CS-v1.8 — an inline confirm box instead of window.confirm(): this
 * page runs inside the shell's iframe, and a native blocking dialog there
 * freezes input to the whole tab (not just this iframe) until dismissed,
 * with no visual cue elsewhere in the shell that anything is waiting. A
 * dark-themed alert box matching translateGate/mainError's existing style
 * doesn't have that problem and looks like it belongs on this page.
 */
// TASK CS-v1.8 follow-up — "비용이 발생합니다" only makes sense when a paid
// key is actually configured (translate/regenerate run on the free key
// otherwise — see lib/gemini.js's effectiveTier()); showing a cost warning
// on a free call just confused users who hadn't set one up.
function costPhrase() {
  return state.paidKeyConfigured ? '비용이 발생합니다' : '무료 한도를 사용합니다';
}
function costActionLabel() {
  return state.paidKeyConfigured ? '비용 발생' : '무료 한도 사용';
}

function showTranslateConfirm(count, selected) {
  $('translateConfirmText').textContent = `${count}개 언어를 다시 번역합니다. ${costPhrase()}. 계속할까요?`;
  $('translateConfirmYesBtn').textContent = `계속 진행 (${costActionLabel()})`;
  $('translateConfirm').dataset.pendingSelected = JSON.stringify(selected);
  $('translateConfirm').classList.remove('hidden');
}

function hideTranslateConfirm() {
  $('translateConfirm').classList.add('hidden');
}

/*
 * TASK CS-v2.0 작업 A 요구사항 2 — 무료 한도 초과로 멈췄을 때 뜨는 선택지.
 * 유료 키 유무에 따라 문구와 버튼이 달라진다. 유료 키가 없으면 "유료로
 * 이어서" 버튼 자체를 숨긴다 — 눌러도 무료 키로 폴백되어 또 429가 날
 * 뿐이므로, 누를 수 있게 보여주는 것 자체가 오해를 만든다(지시서 요구사항
 * 2의 명시적 요구).
 */
function quotaScopeNote(error) {
  // TASK CS-v2.0 — dailyLimitReached는 우리 앱 자체의 .gemini_limits.json
  // 상한(유료 키가 있어도 걸림)이라 quotaScope(구글 쪽 RPM/RPD 추정)와
  // 별개로 먼저 확인한다 — 이 경우 "유료로 이어서"를 눌러도 똑같이 즉시
  // 막히므로 다른 안내가 필요하다.
  if (error.dailyLimitReached) {
    return ' 이 도구에 설정된 유료 일일 상한(.gemini_limits.json)에 도달했습니다 — 내일 다시 시도하거나 상한 값을 늘려주세요.';
  }
  if (error.quotaScope === 'daily') return ' 하루 요청 한도로 보입니다.';
  if (error.quotaScope === 'per-minute') return ' 분당 요청 한도로 보입니다 — 1~2분 후 다시 시도하면 무료로 계속할 수 있습니다.';
  return ' 분당 한도인지 하루 한도인지 이번 응답만으로는 확인되지 않았습니다 — 1~2분 후 다시 시도해 보고, 계속 실패하면 하루 한도일 가능성이 큽니다.';
}

function showQuotaChoice(pendingList, error) {
  const box = $('quotaChoice');
  const n = pendingList.length;
  const note = quotaScopeNote(error);
  const offerPaidRetry = state.paidKeyConfigured && !error.dailyLimitReached;

  $('quotaChoicePaidBtn').classList.toggle('hidden', !offerPaidRetry);
  $('quotaChoiceSetupBtn').classList.toggle('hidden', state.paidKeyConfigured || error.dailyLimitReached);

  $('quotaChoiceText').textContent = offerPaidRetry
    ? `무료 한도를 모두 썼습니다.${note} 남은 ${n}개 언어를 유료 키로 이어서 번역할까요? 비용이 발생합니다.`
    : state.paidKeyConfigured
      ? `무료·유료 모두 오늘 한도에 도달했습니다.${note} 남은 언어는 ${n}개입니다.`
      : `무료 한도를 모두 썼습니다.${note} 남은 ${n}개 언어는 내일 다시 시도하거나, 유료 키를 설정하면 지금 바로 이어서 할 수 있습니다.`;

  box.dataset.pendingLanguages = JSON.stringify(pendingList);
  box.classList.remove('hidden');
}

function hideQuotaChoice() {
  $('quotaChoice').classList.add('hidden');
}

async function onTranslateClick() {
  const selected = currentSelectedLanguages();
  if (!selected.length) return setError('translateError', '번역 언어를 하나 이상 선택해 주세요.');
  // TASK CS-v1.8 — re-running the full selection can still hit cache under
  // the hood (unchanged title/description), but we can't promise that up
  // front, so warn every time there's overlap with existing results rather
  // than silently re-spend on whichever ones did change.
  const alreadyDone = selected.filter(hasResultFor);
  if (alreadyDone.length > 0) {
    showTranslateConfirm(alreadyDone.length, selected);
    return;
  }
  await runScopedTranslate(selected, { resetResults: true });
}

async function onContinueTranslateClick() {
  const pending = pendingLanguages(currentSelectedLanguages());
  if (!pending.length) { showToast('이어서 번역할 언어가 없습니다.'); return; }
  await runScopedTranslate(pending, { resetResults: false });
}

const REGEN_BUTTON_LABELS = { 'regen-title': '제목 재생성', 'regen-description': '설명 재생성' };

function renderResults() {
  if (!state.results.length) {
    $('resultsPanel').classList.add('hidden');
    updateContinueButton();
    return;
  }
  $('resultsPanel').classList.remove('hidden');
  $('resultsList').innerHTML = state.results.map((result, index) => {
    const titleCount = Array.from(result.translatedTitle || '').length;
    return `
      <article class="result-card" data-index="${index}">
        <div class="result-title-row">
          <div style="display:flex;align-items:center;gap:10px">
            <h3>${escapeHtml(result.language)}</h3>
            <span class="pill" title="이 언어에 실제로 적용된 번역 범위">${result.scope === 'full' ? '제목+설명' : '제목만'}</span>
          </div>
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
        const label = REGEN_BUTTON_LABELS[action];

        /*
         * TASK CS-v1.8 task D — regenerate is a real paid call every click.
         * If this exact language+field was already regenerated for the
         * CURRENT title/description text (unchanged since), require an
         * extra click before spending another one — a plain click that
         * only requests a new random phrasing of the same thing is the
         * abuse case this guards against. A lightweight arm-then-confirm
         * on the button itself, not window.confirm() (see onTranslateClick
         * above — a native dialog in this iframe'd page is worse than a
         * button that just needs a second click), and not a full alert box
         * per card, since there can be up to 50 of these on screen at once.
         */
        const sourceKey = currentSourceKey();
        result._regenSourceKey = result._regenSourceKey || {};
        const alreadyRegeneratedForThisText = result._regenSourceKey[field] === sourceKey;
        if (alreadyRegeneratedForThisText && button.dataset.confirmArmed !== '1') {
          button.dataset.confirmArmed = '1';
          button.textContent = `다시 누르면 재생성 (${costActionLabel()})`;
          clearTimeout(button._confirmTimer);
          button._confirmTimer = setTimeout(() => {
            delete button.dataset.confirmArmed;
            button.textContent = label;
          }, 4000);
          return;
        }
        delete button.dataset.confirmArmed;
        clearTimeout(button._confirmTimer);

        button.disabled = true;
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
          result._regenSourceKey[field] = sourceKey;
          renderResults();
          saveLocal();
          showToast('재생성했습니다.');
        } catch (error) {
          setError('translateError', error.message);
        } finally {
          button.disabled = false;
          button.textContent = label;
        }
      });
    });
  });
  updateContinueButton();
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
    // _regenSourceKey is internal regenerate-confirm bookkeeping (CS-v1.8 task D) — not part of the exported data.
    translations: state.results.map(({ language, translatedTitle, translatedDescription, scope }) => ({ language, translatedTitle, translatedDescription, scope })),
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
    descriptionScope: Array.from(state.descriptionScope),
    results: state.results,
    resultsSourceKey: state.resultsSourceKey,
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
    if (Array.isArray(payload.descriptionScope)) state.descriptionScope = new Set(payload.descriptionScope);
    if (Array.isArray(payload.results)) state.results = payload.results;
    // TASK CS-v1.8 — payload.resultsSourceKey is missing on state saved
    // before this field existed; title/description were saved in the same
    // snapshot as results, so currentSourceKey() (now that both are set
    // above) is the correct value for that older data too.
    state.resultsSourceKey = payload.resultsSourceKey ?? (state.results.length ? currentSourceKey() : null);
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
  $('sourceTitle').addEventListener('input', () => { invalidateResultsIfSourceChanged(); updateTitleCount(); updateCostEstimate(); saveLocal(); });
  $('sourceDescription').addEventListener('input', () => { invalidateResultsIfSourceChanged(); updateCostEstimate(); saveLocal(); });
  document.querySelectorAll('[data-copy-target]').forEach(button => {
    button.addEventListener('click', () => copyText($(button.dataset.copyTarget).value));
  });
  $('selectAllBtn').addEventListener('click', () => { state.selected = new Set(LANGUAGES); renderLanguages($('languageSearch').value); saveLocal(); });
  $('clearAllBtn').addEventListener('click', () => { state.selected.clear(); renderLanguages($('languageSearch').value); saveLocal(); });
  $('corePresetBtn').addEventListener('click', () => { state.selected = new Set(CORE_LANGUAGES); renderLanguages($('languageSearch').value); saveLocal(); });
  $('languageSearch').addEventListener('input', event => renderLanguages(event.target.value));
  // TASK CS-v2.1 작업 C 요구사항 2 — CORE_LANGUAGES를 설명 대상 프리셋으로도
  // 재사용. state.selected와의 교집합만 적용한다(번역 대상이 아닌 언어를
  // 설명 대상으로 넣는 건 의미가 없다).
  $('descCorePresetBtn').addEventListener('click', () => {
    state.descriptionScope = new Set([...CORE_LANGUAGES].filter(lang => state.selected.has(lang)));
    renderDescScopeGrid();
    saveLocal();
  });
  $('descClearBtn').addEventListener('click', () => {
    state.descriptionScope.clear();
    renderDescScopeGrid();
    saveLocal();
  });
  $('translateBtn').addEventListener('click', onTranslateClick);
  $('continueTranslateBtn').addEventListener('click', onContinueTranslateClick);
  $('pendingToggleBtn').addEventListener('click', () => {
    $('pendingLanguagesList').classList.toggle('hidden');
    renderPendingLanguages();
  });
  $('translateConfirmYesBtn').addEventListener('click', async () => {
    const selected = JSON.parse($('translateConfirm').dataset.pendingSelected || '[]');
    hideTranslateConfirm();
    await runScopedTranslate(selected, { resetResults: true });
  });
  $('translateConfirmNoBtn').addEventListener('click', hideTranslateConfirm);
  // TASK CS-v2.0 작업 A — 남은 언어(quotaChoice에 저장해둔 목록)만 forcePaid로
  // 다시 보낸다. resetResults:false — 이미 성공한 언어는 그대로 둔다.
  $('quotaChoicePaidBtn').addEventListener('click', async () => {
    const pending = JSON.parse($('quotaChoice').dataset.pendingLanguages || '[]');
    hideQuotaChoice();
    await runScopedTranslate(pending, { resetResults: false, forcePaid: true });
  });
  // TASK CS-v2.0 — 셸의 키 다이얼로그는 이 iframe과 다른 문서다
  // (public/index.html). CLAUDE.md 3.4대로 postMessage로 부모(셸)에 요청하고
  // origin을 명시한다 — 같은 오리진에서만 서빙되는 앱이지만, 관례를 그대로
  // 따른다.
  $('quotaChoiceSetupBtn').addEventListener('click', () => {
    hideQuotaChoice();
    window.parent.postMessage({ type: 'creator-studio:open-paid-key-dialog' }, window.location.origin);
  });
  $('quotaChoiceLaterBtn').addEventListener('click', hideQuotaChoice);
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

/*
 * TASK CS-v2.0 작업 B — publishedCount는 "보낸 개수"지 "저장된 개수"가
 * 아니다. /localizations는 videos.list(1유닛)로 유튜브에 실제로 저장된
 * 값을 그대로 되읽으므로, videos.update(50유닛)를 또 쓰는 게 아니라
 * 부담 없이 매 등록 뒤에 호출할 수 있다(routes/yt.js의 /localizations
 * 주석 참고).
 */
function renderPublishVerification(sentPublished, verifyData) {
  const box = $('publishVerify');
  const existing = verifyData.existing || [];
  const savedCodes = new Set(existing.map((e) => e.code));
  const sentCodes = sentPublished.map((p) => p.code);
  const missingAfterSave = sentCodes.filter((code) => !savedCodes.has(code));

  const parts = [];
  parts.push('<h4>유튜브에서 실제로 되읽은 결과</h4>');
  parts.push(`<p class="hint">보낸 언어 ${sentCodes.length}개 · 방금 videos.list로 다시 읽은 결과 유튜브에 저장된 언어 ${existing.length}개</p>`);

  if (missingAfterSave.length) {
    parts.push(`<p class="bad">⚠ 보냈지만 되읽기에는 없는 언어 ${missingAfterSave.length}개: ${missingAfterSave.map(escapeHtml).join(', ')}` +
      ' — 유튜브가 조용히 거부했거나 반영에 시간이 걸리는 중일 수 있습니다. 잠시 후 새로고침해 다시 확인하세요.</p>');
  } else if (sentCodes.length) {
    parts.push('<p class="ok">보낸 언어가 모두 유튜브에 저장된 것으로 확인됩니다.</p>');
  }

  if (existing.length) {
    parts.push('<ul>' + existing.map((e) =>
      `<li><code>${escapeHtml(e.code)}</code>${sentCodes.includes(e.code) ? '' : ' <span class="hint">(이번에 보내지 않은, 기존 등록)</span>'}` +
      `<br /><span style="color:#cfe0f6">${escapeHtml(e.title)}</span></li>`
    ).join('') + '</ul>');
  }

  parts.push('<p class="hint">직접 확인: YouTube Studio → 콘텐츠 → 이 영상 → 세부정보 → "번역 추가(다른 언어)" 섹션에서 언어별 제목을 볼 수 있습니다. ' +
    '또는 유튜브 자체의 표시 언어 설정을 등록한 언어로 바꾼 뒤 영상 페이지를 열어 확인하세요. ' +
    '이 등록은 Gemini 번역 한도와는 무관한 별도 기능입니다(유튜브 쿼터, 하루 10,000유닛) — 여기서 발생하는 비용은 없습니다.</p>');

  box.innerHTML = parts.join('');
  box.classList.remove('hidden');
}

async function applyPublish() {
  if (!publishState.plan) return setError('publishError', '먼저 미리보기를 실행해 주세요.');
  setError('publishError');
  $('publishVerify').classList.add('hidden');
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
    showToast(`${data.publishedCount}개 언어를 유튜브로 보냈습니다. 실제 저장 여부 확인 중…`);

    // TASK CS-v2.0 작업 B 요구사항 1 — 등록 응답(보낸 개수) 말고, 되읽은 값이 진짜다.
    try {
      const verify = await api(`/api/yt/localizations?videoId=${encodeURIComponent(data.videoId)}`);
      renderPublishVerification(data.published || [], verify);
    } catch (verifyError) {
      $('publishVerify').innerHTML = `<p class="bad">등록 후 확인 조회 실패: ${escapeHtml(verifyError.message)} — YouTube Studio에서 직접 확인해 주세요.</p>`;
      $('publishVerify').classList.remove('hidden');
    }
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
