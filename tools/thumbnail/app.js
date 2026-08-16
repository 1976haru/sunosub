import * as idb from './idb.js';
import {
  FONT_OPTIONS, TEXT_COLORS, SHADOW_COLORS, BASE_STYLE_PRESETS, TEXT_POSITIONS,
  composeImage, downloadCanvas, loadImage,
} from './canvas.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SAMPLE_COPY = '그시절 그노래\n올드팝송';
const THUMB_SIZE = { width: 1920, height: 1080 };
const COVER_SIZE = { width: 3000, height: 3000 };

const BANNED_WORDS = ['충격', '소름', '경악', '헐', '대박사건', '치료', '완치', '효능', '효과', '부작용', '질병', '질환', '처방'];
const FORBIDDEN_PATTERNS = [/https?:\/\//i, /www\./i, /\d{1,3}(,\d{3})*\s?원/, /[$₩]\s?\d/, /@[a-zA-Z0-9_]{2,}/];

function defaultTemplate() {
  const preset = BASE_STYLE_PRESETS[0];
  return {
    presetId: preset.id,
    fontId: preset.fontId,
    textColor: preset.textColor,
    shadowColor: preset.shadowColor,
    shadowWidth: preset.shadowWidth,
    strokeOn: preset.strokeOn,
    position: 'bottom-center',
    badge: { icon: '🎵', tag: '', position: 'bottom-right' },
    locked: false,
  };
}

const state = {
  step: 'brand',
  channelName: '',
  channels: [],
  template: defaultTemplate(),
  overrideOnce: false,
  copyConcept: '',
  copyCandidates: [],
  copyUsedFallback: false,
  selectedCopyText: '',
  copyHistory: [],
  scenePresets: [],
  targets: {
    thumb: { sourceTab: 'upload', prompt: '', imageUrl: null, season: '전체', presetId: null },
    cover: { sourceTab: 'upload', prompt: '', imageUrl: null, season: '전체', presetId: null },
  },
  composeText: { thumb: '', cover: '' },
  showBadge: { thumb: true, cover: false },
  ownershipConfirmed: localStorage.getItem('thumbnailStudioOwnershipConfirmed') === 'true',
};

const views = {
  brand: $('#view-brand'),
  copy: $('#view-copy'),
  background: $('#view-background'),
  compose: $('#view-compose'),
};

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

function setLoading(on, title = '처리 중입니다', text = '결과를 기다리고 있습니다.') {
  $('#loadingTitle').textContent = title;
  $('#loadingText').textContent = text;
  $('#loading').classList.toggle('hidden', !on);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data;
}

function postJson(url, body) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

function normalizeConcept(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function validateCopy(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, reason: '문구를 입력해 주세요.' };
  if (BANNED_WORDS.some((w) => value.includes(w))) return { ok: false, reason: '과장된 클릭베이트 표현은 사용할 수 없습니다.' };
  if (FORBIDDEN_PATTERNS.some((p) => p.test(value))) return { ok: false, reason: 'URL·가격·계정 표기는 사용할 수 없습니다.' };
  return { ok: true };
}

function switchStep(step) {
  if (!views[step]) return;
  state.step = step;
  Object.entries(views).forEach(([name, el]) => el.classList.toggle('active', name === step));
  $$('.step').forEach((button) => button.classList.toggle('active', button.dataset.step === step));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function activeTemplate() {
  return state.template;
}

/* ---------------- STEP 1: brand template ---------------- */

async function refreshChannelList() {
  state.channels = await idb.listChannelNames();
}

async function loadScenePresets() {
  try {
    const data = await api('/api/thumbnail/scene-presets');
    state.scenePresets = data.presets || [];
  } catch { state.scenePresets = []; }
}

function renderBrand() {
  const t = activeTemplate();
  const locked = t.locked && !state.overrideOnce;
  views.brand.innerHTML = `
    <div class="hero-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">STEP 1 · BRAND TEMPLATE</div>
          <h2>채널 브랜드 템플릿</h2>
          <p>채널마다 폰트·색상·위치·배지를 한 번 설정하고 잠그면, 이후 모든 제작에서 배경과 문구만 바뀝니다.</p>
        </div>
        <span class="lock-badge ${t.locked ? 'locked' : 'unlocked'}">${t.locked ? '🔒 잠김' : '🔓 설정 중'}</span>
      </div>
      <div class="channel-picker">
        <div class="field">
          <label for="channelName">채널 이름</label>
          <input id="channelName" list="channelList" placeholder="예: 올드팝 라디오" value="${escapeHtml(state.channelName)}" />
          <datalist id="channelList">${state.channels.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
        </div>
        <button id="loadChannelBtn" class="button ghost">불러오기</button>
      </div>
      <div style="height:18px"></div>
      <div class="grid two">
        <div>
          <h3>베이스 스타일</h3>
          <div class="preset-grid">
            ${BASE_STYLE_PRESETS.map((p) => `
              <button class="preset-card ${t.presetId === p.id ? 'selected' : ''}" data-preset="${p.id}" ${locked ? 'disabled' : ''}>
                <b>${escapeHtml(p.label)}</b>
              </button>`).join('')}
          </div>

          <div style="height:16px"></div>
          <div class="field">
            <label for="fontSelect">폰트</label>
            <select id="fontSelect" ${locked ? 'disabled' : ''}>
              ${FONT_OPTIONS.map((f) => `<option value="${f.id}" ${t.fontId === f.id ? 'selected' : ''}>${escapeHtml(f.family)}</option>`).join('')}
            </select>
          </div>

          <div style="height:12px"></div>
          <label>텍스트 색</label>
          <div class="color-swatches" id="textColorSwatches">
            ${TEXT_COLORS.map((c) => `<span class="swatch ${t.textColor === c ? 'selected' : ''}" data-color="${c}" style="background:${c}"></span>`).join('')}
          </div>

          <div style="height:12px"></div>
          <label>그림자 색</label>
          <div class="color-swatches" id="shadowColorSwatches">
            ${SHADOW_COLORS.map((c) => `<span class="swatch ${t.shadowColor === c ? 'selected' : ''}" data-color="${c}" style="background:${c}"></span>`).join('')}
          </div>

          <div style="height:12px"></div>
          <div class="grid two">
            <div class="field">
              <label for="shadowWidth">그림자 두께</label>
              <select id="shadowWidth" ${locked ? 'disabled' : ''}>
                ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${t.shadowWidth === n ? 'selected' : ''}>${n}px</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="strokeOn">테두리</label>
              <select id="strokeOn" ${locked ? 'disabled' : ''}>
                <option value="on" ${t.strokeOn ? 'selected' : ''}>ON</option>
                <option value="off" ${!t.strokeOn ? 'selected' : ''}>OFF</option>
              </select>
            </div>
          </div>

          <div style="height:12px"></div>
          <label>텍스트 위치</label>
          <div class="position-grid" id="positionGrid">
            ${TEXT_POSITIONS.map((p) => `<button data-position="${p.id}" class="${t.position === p.id ? 'selected' : ''}" ${locked ? 'disabled' : ''}>${escapeHtml(p.label)}</button>`).join('')}
          </div>

          <div style="height:16px"></div>
          <h3>브랜드 배지</h3>
          <div class="grid two">
            <div class="field"><label for="badgeIcon">아이콘</label><input id="badgeIcon" maxlength="4" value="${escapeHtml(t.badge.icon)}" ${locked ? 'disabled' : ''} /></div>
            <div class="field"><label for="badgeTag">채널 태그</label><input id="badgeTag" maxlength="16" value="${escapeHtml(t.badge.tag)}" placeholder="예: 올드팝라디오" ${locked ? 'disabled' : ''} /></div>
          </div>

          <div class="actions">
            ${t.locked ? `<button id="overrideOnceBtn" class="button ghost">${state.overrideOnce ? '이번만 다르게: 켜짐' : '이번만 다르게'}</button>
              <button id="unlockBtn" class="button danger">설정 잠금 해제</button>` : `<button id="saveLockBtn" class="button primary">저장 및 잠금</button>`}
          </div>
        </div>
        <div>
          <h3>실시간 미리보기</h3>
          <div class="brand-preview"><canvas id="brandPreviewCanvas"></canvas></div>
          <p class="help">샘플 문구 "${SAMPLE_COPY.replace('\n', ' / ')}"로 미리보기 중입니다. 실제 제작에서는 선택한 카피와 배경이 반영됩니다.</p>
        </div>
      </div>
    </div>`;

  $('#loadChannelBtn').addEventListener('click', loadChannel);
  $('#channelName').addEventListener('change', (e) => { state.channelName = e.target.value.trim(); });

  if (!locked) {
    $$('.preset-card', views.brand).forEach((btn) => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));
    $('#fontSelect').addEventListener('change', (e) => { t.fontId = e.target.value; renderBrandPreview(); });
    $$('#textColorSwatches .swatch').forEach((sw) => sw.addEventListener('click', () => { t.textColor = sw.dataset.color; renderBrand(); }));
    $$('#shadowColorSwatches .swatch').forEach((sw) => sw.addEventListener('click', () => { t.shadowColor = sw.dataset.color; renderBrand(); }));
    $('#shadowWidth').addEventListener('change', (e) => { t.shadowWidth = Number(e.target.value); renderBrandPreview(); });
    $('#strokeOn').addEventListener('change', (e) => { t.strokeOn = e.target.value === 'on'; renderBrandPreview(); });
    $$('#positionGrid button').forEach((btn) => btn.addEventListener('click', () => { t.position = btn.dataset.position; renderBrand(); }));
    $('#badgeIcon').addEventListener('input', (e) => { t.badge.icon = e.target.value; renderBrandPreview(); });
    $('#badgeTag').addEventListener('input', (e) => { t.badge.tag = e.target.value; renderBrandPreview(); });
  }

  if (t.locked) {
    $('#overrideOnceBtn')?.addEventListener('click', () => { state.overrideOnce = !state.overrideOnce; renderBrand(); });
    $('#unlockBtn')?.addEventListener('click', () => {
      if (!confirm('템플릿 잠금을 해제하면 이 채널의 모든 향후 제작물 스타일이 바뀔 수 있습니다. 계속할까요?')) return;
      t.locked = false;
      state.overrideOnce = false;
      renderBrand();
    });
  } else {
    $('#saveLockBtn')?.addEventListener('click', saveAndLockTemplate);
  }

  renderBrandPreview();
}

function applyPreset(presetId) {
  const preset = BASE_STYLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  const t = activeTemplate();
  Object.assign(t, {
    presetId: preset.id,
    fontId: preset.fontId,
    textColor: preset.textColor,
    shadowColor: preset.shadowColor,
    shadowWidth: preset.shadowWidth,
    strokeOn: preset.strokeOn,
  });
  renderBrand();
}

async function renderBrandPreview() {
  const canvas = $('#brandPreviewCanvas');
  if (!canvas) return;
  const t = activeTemplate();
  const composed = await composeImage({
    width: THUMB_SIZE.width,
    height: THUMB_SIZE.height,
    backgroundImage: null,
    copyText: SAMPLE_COPY,
    textStyle: t,
    badge: t.badge,
    showBadge: true,
  });
  canvas.width = composed.width;
  canvas.height = composed.height;
  canvas.getContext('2d').drawImage(composed, 0, 0);
}

async function loadChannel() {
  const name = $('#channelName').value.trim();
  if (!name) return toast('채널 이름을 입력해 주세요.', true);
  state.channelName = name;
  try {
    const saved = await idb.getChannel(name);
    state.template = saved || defaultTemplate();
    state.overrideOnce = false;
    state.copyHistory = await idb.getCopyHistory(name);
    renderBrand();
    toast(saved ? '저장된 템플릿을 불러왔습니다.' : '새 채널입니다. 스타일을 설정해 주세요.');
  } catch (error) { toast(error.message, true); }
}

async function saveAndLockTemplate() {
  const name = state.channelName || $('#channelName')?.value.trim();
  if (!name) return toast('채널 이름을 먼저 입력해 주세요.', true);
  state.channelName = name;
  const t = activeTemplate();
  t.locked = true;
  state.overrideOnce = false;
  try {
    await idb.saveChannel(name, t);
    await refreshChannelList();
    renderBrand();
    toast(`"${name}" 채널 템플릿을 저장하고 잠갔습니다.`);
  } catch (error) { toast(error.message, true); }
}

/* ---------------- STEP 2: copy candidates ---------------- */

function renderCopy() {
  views.copy.innerHTML = `
    <div class="hero-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">STEP 2 · COPY CANDIDATES</div>
          <h2>썸네일 카피 후보</h2>
          <p>채널/시즌/세트 컨셉이나 자유 키워드를 입력하면 스타일 태그별 후보 3~5개를 만듭니다.</p>
        </div>
      </div>
      <div class="field wide">
        <label for="copyConcept">채널/시즌/세트 컨셉 또는 키워드</label>
        <textarea id="copyConcept" placeholder="예: 60~70대 청취자용 올드팝 감성 플레이리스트">${escapeHtml(state.copyConcept)}</textarea>
      </div>
      <div class="actions">
        <button id="generateCopyBtn" class="button primary">카피 후보 생성</button>
        <button id="regenerateCopyBtn" class="button ghost" ${state.copyCandidates.length ? '' : 'disabled'}>다시 생성 (겹침 회피)</button>
      </div>
      ${state.copyUsedFallback ? '<div class="notice">Gemini 키가 없어 로컬 템플릿 뱅크로 후보를 만들었습니다. 키를 등록하면 더 다양한 문구가 생성됩니다.</div>' : ''}
      <div style="height:16px"></div>
      <div class="copy-grid">
        ${state.copyCandidates.length ? state.copyCandidates.map((c, i) => `
          <label class="copy-card ${state.selectedCopyText === c.text ? 'selected' : ''}" data-index="${i}">
            <span class="tag">${escapeHtml(c.styleTag)}</span>
            <pre>${escapeHtml(c.text)}</pre>
          </label>`).join('') : '<div class="empty">아직 생성된 카피 후보가 없습니다.</div>'}
      </div>
    </div>`;

  $('#copyConcept').addEventListener('input', (e) => { state.copyConcept = e.target.value; });
  $('#generateCopyBtn').addEventListener('click', () => generateCopy(false));
  $('#regenerateCopyBtn').addEventListener('click', () => generateCopy(true));
  $$('.copy-card', views.copy).forEach((card) => card.addEventListener('click', () => selectCopy(Number(card.dataset.index))));
}

async function generateCopy(isRegenerate) {
  setLoading(true, '카피 후보 생성 중', '스타일 태그별로 서로 다른 문구를 만들고 있습니다.');
  try {
    const avoid = [...state.copyHistory, ...(isRegenerate ? state.copyCandidates.map((c) => c.text) : [])];
    const data = await postJson('/api/thumbnail/copy', { concept: normalizeConcept(state.copyConcept), avoid, count: 5 });
    state.copyCandidates = data.candidates || [];
    state.copyUsedFallback = Boolean(data.usedFallback);
    state.selectedCopyText = '';
    renderCopy();
    toast('카피 후보가 생성되었습니다.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function selectCopy(index) {
  const candidate = state.copyCandidates[index];
  if (!candidate) return;
  state.selectedCopyText = candidate.text;
  state.composeText.thumb = candidate.text;
  state.composeText.cover = candidate.text.split(/\r?\n/)[0]; // TASK CS-v1.8 follow-up — match the project's CRLF-safe split convention (see socialPost.js:90)
  if (state.channelName) {
    await idb.addCopyHistory(state.channelName, candidate.text);
    state.copyHistory = await idb.getCopyHistory(state.channelName);
  }
  renderCopy();
}

/* ---------------- STEP 3: background images ---------------- */

function targetLabel(key) {
  return key === 'thumb' ? '썸네일 (16:9)' : '커버 (1:1)';
}

function renderBackground() {
  views.background.innerHTML = `
    <div class="hero-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">STEP 3 · BACKGROUND</div>
          <h2>배경 이미지 준비</h2>
          <p>썸네일(16:9)과 커버(1:1)는 각각 별도로 배경을 준비합니다. 업로드, Gemini 생성, 외부 툴용 프롬프트 복사 중 선택하세요.</p>
        </div>
      </div>
      <div class="grid two" id="backgroundTargets">
        ${bgTargetCard('thumb')}
        ${bgTargetCard('cover')}
      </div>
    </div>`;

  ['thumb', 'cover'].forEach(wireBgTarget);
}

function bgTargetCard(key) {
  const target = state.targets[key];
  return `
    <div class="card" data-target="${key}">
      <h3>${targetLabel(key)}</h3>
      <div class="source-tabs">
        <button class="button small ${target.sourceTab === 'upload' ? 'active' : 'ghost'}" data-source="upload">업로드+텍스트제거</button>
        <button class="button small ${target.sourceTab === 'gemini' ? 'active' : 'ghost'}" data-source="gemini">Gemini 생성</button>
        <button class="button small ${target.sourceTab === 'promptcopy' ? 'active' : 'ghost'}" data-source="promptcopy">프롬프트 복사</button>
      </div>
      <div class="bg-body">${bgSourceBody(key, target)}</div>
      <div class="bg-preview" style="margin-top:12px">${target.imageUrl ? `<img src="${target.imageUrl}" alt="배경">` : '배경 없음'}</div>
    </div>`;
}

function scenePresetPicker(target) {
  if (!state.scenePresets.length) return '';
  const seasons = [...new Set(state.scenePresets.map((p) => p.season))];
  const filtered = target.season === '전체' ? state.scenePresets : state.scenePresets.filter((p) => p.season === target.season);
  const selected = state.scenePresets.find((p) => p.id === target.presetId);
  return `
    <div class="scene-preset-picker">
      <label>시즌·컨셉 프리셋</label>
      <div class="season-filter">
        <button type="button" class="chip ${target.season === '전체' ? 'selected' : ''}" data-season="전체">전체</button>
        ${seasons.map((s) => `<button type="button" class="chip ${target.season === s ? 'selected' : ''}" data-season="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
      </div>
      <div class="preset-grid scene-preset-grid">
        ${filtered.map((p) => `
          <button type="button" class="preset-card scene-preset-card ${target.presetId === p.id ? 'selected' : ''}" data-scene-preset="${p.id}">
            <b>${escapeHtml(p.labelKo)}</b>
          </button>`).join('')}
      </div>
      ${selected ? `<p class="help preset-hint">추천 텍스트 색 <span class="swatch-inline" style="background:${selected.recommendedTextColor}"></span> · 그림자 색 <span class="swatch-inline" style="background:${selected.recommendedShadowColor}"></span> (브랜드 템플릿 단계에서 직접 적용해 보세요)</p>` : ''}
    </div>`;
}

function bgSourceBody(key, target) {
  if (target.sourceTab === 'upload') {
    return `
      <label class="button ghost small">이미지 선택<input class="bg-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
      <label class="help" style="display:flex;align-items:center;gap:6px;margin-top:8px">
        <input type="checkbox" class="bg-remove-text-toggle"> 업로드 후 기존 텍스트 자동 제거
      </label>`;
  }
  if (target.sourceTab === 'gemini') {
    return `
      ${scenePresetPicker(target)}
      <div class="field"><label>배경 생성 프롬프트</label><textarea class="bg-prompt" placeholder="예: warm golden-hour cafe window, vintage vinyl records, soft bokeh, no people, no text">${escapeHtml(target.prompt)}</textarea></div>
      <button class="button primary small bg-generate">Gemini로 배경 생성</button>`;
  }
  return `
    ${scenePresetPicker(target)}
    <div class="field"><label>외부 툴(Midjourney 등)용 프롬프트</label><textarea class="bg-prompt" placeholder="예: warm golden-hour cafe window, vintage vinyl records, soft bokeh, no people, no text">${escapeHtml(target.prompt)}</textarea></div>
    <button class="button ghost small bg-copy-prompt">프롬프트 복사</button>
    <p class="help">복사한 프롬프트로 외부 툴에서 만든 이미지를 "업로드" 탭으로 가져오세요.</p>`;
}

function applyScenePreset(key, presetId) {
  const preset = state.scenePresets.find((p) => p.id === presetId);
  if (!preset) return;
  const target = state.targets[key];
  target.presetId = preset.id;
  target.prompt = preset.promptSeed;
  renderBackground();

  const concept = normalizeConcept(`${preset.labelKo} 감성`);
  if (concept && concept !== normalizeConcept(state.copyConcept)) {
    state.copyConcept = concept;
    renderCopy();
    toast(`카피 컨셉에도 "${concept}"을(를) 반영했습니다.`);
  }
}

function wireBgTarget(key) {
  const card = $(`.card[data-target="${key}"]`, views.background);
  const target = state.targets[key];
  $$('.source-tabs button', card).forEach((btn) => btn.addEventListener('click', () => {
    target.sourceTab = btn.dataset.source;
    renderBackground();
  }));

  $$('.season-filter .chip', card).forEach((btn) => btn.addEventListener('click', () => {
    target.season = btn.dataset.season;
    renderBackground();
  }));
  $$('.scene-preset-card', card).forEach((btn) => btn.addEventListener('click', () => applyScenePreset(key, btn.dataset.scenePreset)));

  const uploadInput = $('.bg-upload', card);
  uploadInput?.addEventListener('change', () => handleBackgroundUpload(key, uploadInput.files[0], $('.bg-remove-text-toggle', card)?.checked));

  const promptBox = $('.bg-prompt', card);
  promptBox?.addEventListener('input', (e) => { target.prompt = e.target.value; });

  $('.bg-generate', card)?.addEventListener('click', () => generateBackground(key));
  $('.bg-copy-prompt', card)?.addEventListener('click', () => copyPrompt(target.prompt));
}

function requestOwnershipConfirmation() {
  return new Promise((resolve) => {
    if (state.ownershipConfirmed) { resolve(true); return; }
    const dialog = $('#ownershipDialog');
    dialog.showModal();
    const onConfirm = () => { cleanup(); state.ownershipConfirmed = true; localStorage.setItem('thumbnailStudioOwnershipConfirmed', 'true'); dialog.close(); resolve(true); };
    const onCancel = () => { cleanup(); dialog.close(); resolve(false); };
    function cleanup() {
      $('#ownershipConfirmBtn').removeEventListener('click', onConfirm);
      $('#ownershipCancelBtn').removeEventListener('click', onCancel);
    }
    $('#ownershipConfirmBtn').addEventListener('click', onConfirm);
    $('#ownershipCancelBtn').addEventListener('click', onCancel);
  });
}

async function handleBackgroundUpload(key, file, removeText) {
  if (!file) return;
  const confirmed = await requestOwnershipConfirmation();
  if (!confirmed) return;
  setLoading(true, '이미지 업로드 중', file.name);
  try {
    const form = new FormData();
    form.append('image', file);
    form.append('projectId', 'thumbnail-studio');
    form.append('name', `${key}-upload`);
    form.append('ownershipConfirmed', 'true');
    const data = await api('/api/thumbnail/upload', { method: 'POST', body: form });
    let url = data.url;
    if (removeText) {
      setLoading(true, '기존 텍스트 제거 중', 'Gemini로 인페인팅하고 있습니다.');
      const cleaned = await postJson('/api/thumbnail/remove-text', {
        projectId: 'thumbnail-studio',
        imageUrl: url,
        expand: key === 'thumb',
        aspectRatio: key === 'thumb' ? '16:9' : '1:1',
        name: `${key}-cleaned`,
      });
      url = cleaned.url;
    }
    state.targets[key].imageUrl = url;
    renderBackground();
    toast('배경 이미지를 준비했습니다.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function generateBackground(key) {
  const target = state.targets[key];
  if (!target.prompt.trim()) return toast('배경 프롬프트를 입력해 주세요.', true);
  setLoading(true, '배경 이미지 생성 중', 'Gemini가 배경을 만들고 있습니다.');
  try {
    const data = await postJson('/api/thumbnail/generate-background', {
      projectId: 'thumbnail-studio',
      prompt: target.prompt,
      aspectRatio: key === 'thumb' ? '16:9' : '1:1',
      name: `${key}-bg`,
    });
    target.imageUrl = data.url;
    renderBackground();
    toast('배경 이미지가 생성되었습니다.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function copyPrompt(text) {
  if (!text?.trim()) return toast('복사할 프롬프트가 없습니다.', true);
  try {
    await navigator.clipboard.writeText(text);
    toast('프롬프트를 클립보드에 복사했습니다.');
  } catch {
    toast('클립보드 복사에 실패했습니다. 직접 선택해 복사해 주세요.', true);
  }
}

/* ---------------- STEP 4: compose & download ---------------- */

function renderCompose() {
  views.compose.innerHTML = `
    <div class="hero-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">STEP 4 · COMPOSE &amp; DOWNLOAD</div>
          <h2>합성 및 다운로드</h2>
          <p>선택한 카피와 브랜드 템플릿을 배경에 합성해 PNG로 저장합니다.</p>
        </div>
      </div>
      <div class="compose-grid">
        ${composeCard('thumb')}
        ${composeCard('cover')}
      </div>
      <div style="height:22px"></div>
      <div class="card">
        <h3>세트 단위 일괄 생성</h3>
        <p class="help">한 줄에 하나씩 문구를 입력하면 같은 배경·템플릿으로 썸네일(16:9)을 여러 장 만들어 순서대로 다운로드합니다.</p>
        <div class="field"><label for="batchLines">문구 목록 (세트 사이는 빈 줄로 구분)</label><textarea id="batchLines" placeholder="${'그시절 그노래\n올드팝송\n\n듣기좋은\n추억의 올드팝 음악'}"></textarea></div>
        <button id="batchGenerateBtn" class="button cyan">일괄 썸네일 생성·다운로드</button>
      </div>
    </div>`;

  ['thumb', 'cover'].forEach(wireComposeTarget);
  $('#batchGenerateBtn').addEventListener('click', runBatchGenerate);
}

function composeCard(key) {
  const size = key === 'thumb' ? THUMB_SIZE : COVER_SIZE;
  return `
    <div class="compose-card ${key}" data-compose="${key}">
      <h3>${targetLabel(key)} · ${size.width}×${size.height}</h3>
      <canvas></canvas>
      <div class="field"><label>문구</label><textarea class="compose-text">${escapeHtml(state.composeText[key])}</textarea></div>
      ${key === 'cover' ? `<label class="help" style="display:flex;align-items:center;gap:6px"><input type="checkbox" class="show-badge-toggle" ${state.showBadge.cover ? 'checked' : ''}> 브랜드 배지 표시</label>` : ''}
      <div class="actions">
        <button class="button primary render-btn">미리보기 갱신</button>
        <button class="button success download-btn">PNG 다운로드</button>
      </div>
    </div>`;
}

function wireComposeTarget(key) {
  const card = $(`.compose-card[data-compose="${key}"]`, views.compose);
  $('.compose-text', card).addEventListener('input', (e) => { state.composeText[key] = e.target.value; });
  $('.show-badge-toggle', card)?.addEventListener('change', (e) => { state.showBadge.cover = e.target.checked; });
  $('.render-btn', card).addEventListener('click', () => renderComposeCanvas(key));
  $('.download-btn', card).addEventListener('click', () => downloadCompose(key));
  renderComposeCanvas(key, { silent: true });
}

async function renderComposeCanvas(key, { silent = false } = {}) {
  const card = $(`.compose-card[data-compose="${key}"]`, views.compose);
  const canvasEl = $('canvas', card);
  const size = key === 'thumb' ? THUMB_SIZE : COVER_SIZE;
  const target = state.targets[key];
  const text = state.composeText[key];
  const check = validateCopy(text);
  if (!check.ok) { if (!silent) toast(check.reason, true); return; }
  let bgImage = null;
  if (target.imageUrl) {
    try { bgImage = await loadImage(target.imageUrl); } catch { /* fall back to solid background */ }
  }
  const showBadge = key === 'thumb' ? state.showBadge.thumb : state.showBadge.cover;
  const composed = await composeImage({
    width: size.width,
    height: size.height,
    backgroundImage: bgImage,
    copyText: text,
    textStyle: activeTemplate(),
    badge: activeTemplate().badge,
    showBadge,
  });
  canvasEl.width = composed.width;
  canvasEl.height = composed.height;
  canvasEl.getContext('2d').drawImage(composed, 0, 0);
  canvasEl._composed = composed;
}

async function downloadCompose(key) {
  const card = $(`.compose-card[data-compose="${key}"]`, views.compose);
  const canvasEl = $('canvas', card);
  if (!canvasEl._composed) await renderComposeCanvas(key);
  if (!canvasEl._composed) return;
  const filename = `${state.channelName || 'thumbnail'}-${key}-${Date.now()}.png`;
  await downloadCanvas(canvasEl._composed, filename);
  toast('PNG를 다운로드했습니다.');
}

async function runBatchGenerate() {
  const lines = $('#batchLines').value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return toast('생성할 문구를 입력해 주세요.', true);
  const target = state.targets.thumb;
  let bgImage = null;
  if (target.imageUrl) {
    try { bgImage = await loadImage(target.imageUrl); } catch { /* ignore */ }
  }
  setLoading(true, '일괄 썸네일 생성 중', `0 / ${lines.length} 완료`);
  let done = 0;
  for (const text of lines) {
    const check = validateCopy(text);
    if (!check.ok) { toast(`건너뜀: ${check.reason}`, true); continue; }
    const composed = await composeImage({
      width: THUMB_SIZE.width,
      height: THUMB_SIZE.height,
      backgroundImage: bgImage,
      copyText: text,
      textStyle: activeTemplate(),
      badge: activeTemplate().badge,
      showBadge: true,
    });
    await downloadCanvas(composed, `${state.channelName || 'thumbnail'}-set${done + 1}-${Date.now()}.png`);
    done += 1;
    $('#loadingText').textContent = `${done} / ${lines.length} 완료`;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  setLoading(false);
  toast(`${done}개 썸네일을 생성했습니다.`);
}

/* ---------------- boot ---------------- */

async function renderAll() {
  renderBrand();
  renderCopy();
  renderBackground();
  renderCompose();
}

async function checkStatus() {
  try {
    const status = await api('/api/thumbnail/status');
    const el = $('#apiStatus');
    el.textContent = status.hasApiKey ? `API 준비 · ${status.models.text}` : 'API 키 미설정 (로컬 카피 폴백 사용 가능)';
    el.className = `status-pill ${status.hasApiKey ? 'ok' : 'bad'}`;
  } catch {
    $('#apiStatus').textContent = '서버 연결 오류';
    $('#apiStatus').className = 'status-pill bad';
  }
}

async function boot() {
  await Promise.all([refreshChannelList(), loadScenePresets()]);
  await renderAll();
  switchStep('brand');
  checkStatus();
}

boot();

$$('.step').forEach((button) => button.addEventListener('click', () => switchStep(button.dataset.step)));
$('#ownershipDialog').addEventListener('click', (event) => {
  if (event.target === $('#ownershipDialog')) $('#ownershipDialog').close();
});
window.addEventListener('creator-studio:key-updated', checkStatus);
