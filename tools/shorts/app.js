const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const defaultSettings = {
  concept: '',
  audience: '40~60대 시청자',
  genre: '휴먼 드라마',
  tone: '공감, 감동, 마지막 반전',
  visualStyle: '밝고 따뜻한 고품질 3D 애니메이션, 큰 눈과 친근한 캐릭터, 영화적인 조명',
  chapterCount: 8,
  targetDuration: 60,
  language: '한국어',
};

const state = {
  step: 'plan',
  settings: { ...defaultSettings },
  topics: [],
  selectedTopic: null,
  project: null,
  projectId: `story-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  assetMode: {},
  previewIndex: 0,
};

const views = {
  plan: $('#view-plan'),
  topics: $('#view-topics'),
  story: $('#view-story'),
  assets: $('#view-assets'),
  export: $('#view-export'),
};

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

function setLoading(on, title = '처리 중입니다', text = 'AI 결과를 기다리고 있습니다.') {
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
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

function downloadText(content, filename, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(value = 'story') {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '_').slice(0, 70) || 'story';
}

function saveLocal() {
  const snapshot = JSON.stringify(state);
  localStorage.setItem('storyShortsStudioState', snapshot);
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem('storyShortsStudioState'));
    if (!saved) return;
    Object.assign(state, saved);
    state.settings = { ...defaultSettings, ...(saved.settings || {}) };
    state.projectId ||= `story-${Date.now()}`;
    state.assetMode ||= {};
  } catch { /* ignore */ }
}

function switchStep(step) {
  if (!views[step]) return;
  state.step = step;
  Object.entries(views).forEach(([name, el]) => el.classList.toggle('active', name === step));
  $$('.step').forEach((button) => button.classList.toggle('active', button.dataset.step === step));
  saveLocal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPlan() {
  const s = state.settings;
  views.plan.innerHTML = `
    <div class="hero-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">STEP 1 · STORY PLAN</div>
          <h2>어떤 스토리 쇼츠를 만들까요?</h2>
          <p>한 줄 아이디어를 입력하면 클릭 가능한 주제 10개를 먼저 만듭니다.</p>
        </div>
        <span class="tag">프로젝트 ${escapeHtml(state.projectId)}</span>
      </div>
      <div class="form-grid">
        <div class="field wide">
          <label for="concept">스토리 아이디어 또는 만들고 싶은 내용</label>
          <textarea id="concept" placeholder="예: 평생 가족을 위해 희생한 60대 어머니가 자신의 꿈을 다시 찾는 이야기. 처음에는 가족이 반대하지만 마지막에 뜻밖의 응원을 받는다.">${escapeHtml(s.concept)}</textarea>
        </div>
        <div class="field">
          <label for="audience">대상 시청자</label>
          <input id="audience" value="${escapeHtml(s.audience)}" />
        </div>
        <div class="field">
          <label for="genre">장르</label>
          <select id="genre">
            ${['휴먼 드라마','가족','로맨스','코미디','반전 미스터리','교훈·감동','동물 의인화','직장 공감'].map(v => `<option ${v === s.genre ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="tone">분위기</label>
          <input id="tone" value="${escapeHtml(s.tone)}" />
        </div>
        <div class="field">
          <label for="language">출력 언어</label>
          <select id="language">
            ${['한국어','일본어','영어'].map(v => `<option ${v === s.language ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field wide">
          <label for="visualStyle">영상·이미지 스타일</label>
          <input id="visualStyle" value="${escapeHtml(s.visualStyle)}" />
        </div>
        <div class="field">
          <label for="chapterCount">장면 수</label>
          <select id="chapterCount">
            ${[6,8,10,12,15].map(v => `<option value="${v}" ${Number(s.chapterCount) === v ? 'selected' : ''}>${v}개 장면</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="targetDuration">목표 길이</label>
          <select id="targetDuration">
            ${[30,45,60,90,120].map(v => `<option value="${v}" ${Number(s.targetDuration) === v ? 'selected' : ''}>약 ${v}초</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="actions">
        <button id="generateTopicsBtn" class="button primary">주제 10개 생성</button>
        <button class="button ghost example" data-example="시골 장터에서 평생 국밥을 팔던 할머니가 마지막 장날에 숨겨둔 비밀을 공개하는 감동 이야기">장터 할머니 예시</button>
        <button class="button ghost example" data-example="은퇴 후 무시당하던 60대 아버지가 젊은 시절의 재능으로 가족을 놀라게 하는 통쾌한 반전 이야기">은퇴 아버지 예시</button>
        <button class="button ghost example" data-example="의인화된 시바견 직장인이 억울하게 해고되지만 작은 아이디어 하나로 회사를 구하는 코미디 이야기">시바견 직장인 예시</button>
      </div>
      <p class="help">생성된 모든 결과는 내 PC의 브라우저와 이 프로그램의 <code>output/projects</code> 폴더에 저장할 수 있습니다. AI 생성 기능은 인터넷과 Gemini API 키가 필요합니다.</p>
    </div>`;

  const sync = () => {
    state.settings.concept = $('#concept').value;
    state.settings.audience = $('#audience').value;
    state.settings.genre = $('#genre').value;
    state.settings.tone = $('#tone').value;
    state.settings.language = $('#language').value;
    state.settings.visualStyle = $('#visualStyle').value;
    state.settings.chapterCount = Number($('#chapterCount').value);
    state.settings.targetDuration = Number($('#targetDuration').value);
    saveLocal();
  };
  $$('input, textarea, select', views.plan).forEach((el) => el.addEventListener('input', sync));
  $$('.example', views.plan).forEach((button) => button.addEventListener('click', () => {
    $('#concept').value = button.dataset.example;
    sync();
  }));
  $('#generateTopicsBtn').addEventListener('click', generateTopics);
}

async function generateTopics() {
  const concept = $('#concept')?.value.trim();
  if (!concept) return toast('스토리 아이디어를 입력해 주세요.', true);
  state.settings.concept = concept;
  setLoading(true, '주제 10개를 만드는 중', '쇼츠에 맞는 후킹과 갈등, 결말 가능성을 설계하고 있습니다.');
  try {
    const data = await postJson('/api/shorts/topics', state.settings);
    state.topics = data.topics;
    state.selectedTopic = null;
    state.project = null;
    renderTopics();
    switchStep('topics');
    toast('주제 10개가 생성되었습니다.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    setLoading(false);
  }
}

function renderTopics() {
  views.topics.innerHTML = `
    <div class="section-head">
      <div>
        <div class="eyebrow">STEP 2 · SELECT TOPIC</div>
        <h2>마음에 드는 주제를 선택하세요</h2>
        <p>선택하면 쇼츠용 전체 각본과 장면 프롬프트를 생성합니다.</p>
      </div>
      <button id="backPlanBtn" class="button ghost">기획 수정</button>
    </div>
    ${state.topics.length ? `<div class="topic-grid">${state.topics.map((topic, index) => `
      <button class="topic-card" data-index="${index}">
        <span class="tag">주제 ${index + 1}</span>
        <h3>${escapeHtml(topic.title)}</h3>
        <p>${escapeHtml(topic.summary)}</p>
        <p class="hook"><b>후킹:</b> ${escapeHtml(topic.hook)}</p>
        <p><b>클릭 포인트:</b> ${escapeHtml(topic.appeal || '')}</p>
      </button>`).join('')}</div>` : '<div class="empty">아직 생성된 주제가 없습니다.</div>'}`;
  $('#backPlanBtn').addEventListener('click', () => switchStep('plan'));
  $$('.topic-card', views.topics).forEach((button) => button.addEventListener('click', () => chooseTopic(Number(button.dataset.index))));
}

async function chooseTopic(index) {
  const topic = state.topics[index];
  if (!topic) return;
  state.selectedTopic = topic;
  setLoading(true, '완성형 쇼츠 각본 생성 중', `${state.settings.chapterCount}개 장면의 내레이션·자막·이미지·영상 프롬프트를 작성하고 있습니다.`);
  try {
    const data = await postJson('/api/shorts/story', { ...state.settings, topic });
    state.project = data.project;
    state.project.characters = (state.project.characters || []).map((char, i) => ({
      ...char,
      id: char.id || `char-${i + 1}`,
      referenceImage: char.referenceImage || null,
    }));
    state.project.chapters = (state.project.chapters || []).map((chapter) => ({ ...chapter, imageUrl: chapter.imageUrl || null, videoUrl: chapter.videoUrl || null }));
    await saveProject(false);
    renderStory();
    renderAssets();
    renderExport();
    switchStep('story');
    toast('각본과 챕터가 완성되었습니다.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    setLoading(false);
  }
}

function storyHeader() {
  const p = state.project;
  if (!p) return '';
  const total = p.chapters.reduce((sum, c) => sum + Number(c.durationSec || 0), 0);
  return `
    <div class="hero-card">
      <div class="eyebrow">${escapeHtml(state.settings.genre)} · ${escapeHtml(state.settings.language)}</div>
      <h2>${escapeHtml(p.title)}</h2>
      <p class="muted">${escapeHtml(p.synopsis)}</p>
      <div class="summary-bar">
        <span class="tag">${p.chapters.length}개 장면</span>
        <span class="tag">예상 ${total}초</span>
        <span class="tag">9:16 세로</span>
        <span class="tag">후킹: ${escapeHtml(p.hook)}</span>
      </div>
      <div class="notice"><b>결말:</b> ${escapeHtml(p.ending || '')}</div>
    </div>`;
}

function renderStory() {
  const p = state.project;
  if (!p) {
    views.story.innerHTML = '<div class="empty">먼저 주제를 선택하고 각본을 생성해 주세요.</div>';
    return;
  }
  views.story.innerHTML = `
    ${storyHeader()}
    <div style="height:16px"></div>
    <div class="section-head">
      <div><h2>등장인물</h2><p>외형 설명과 기준 이미지 프롬프트를 수정할 수 있습니다.</p></div>
      <button id="goAssetsBtn" class="button primary">이미지·영상 만들기</button>
    </div>
    <div class="character-grid">
      ${p.characters.length ? p.characters.map((char, i) => `
        <article class="card character-card">
          <div class="thumb character">${char.referenceImage ? `<img src="${char.referenceImage}" alt="${escapeHtml(char.name)}">` : '기준 이미지 없음'}</div>
          <div>
            <div class="field"><label>이름</label><input data-char="${i}" data-key="name" value="${escapeHtml(char.name)}"></div>
            <p class="help"><b>${escapeHtml(char.role || '')}</b> · ${escapeHtml(char.age || '')}<br>${escapeHtml(char.personality || '')}</p>
            <div class="field"><label>외형·의상</label><textarea data-char="${i}" data-key="appearance">${escapeHtml(char.appearance || '')}</textarea></div>
            <details><summary class="help">영문 기준 이미지 프롬프트</summary><textarea data-char="${i}" data-key="portraitPrompt">${escapeHtml(char.portraitPrompt || '')}</textarea></details>
          </div>
        </article>`).join('') : '<div class="empty">등장인물이 없습니다.</div>'}
    </div>
    <div style="height:22px"></div>
    <div class="section-head"><div><h2>쇼츠 챕터·내레이션</h2><p>내레이션과 자막을 실제 영상 분량에 맞게 수정하세요.</p></div><button id="saveStoryBtn" class="button success">프로젝트 저장</button></div>
    <div class="chapter-list">
      ${p.chapters.map((chapter, i) => `
        <article class="card">
          <div class="chapter-title"><b>${i + 1}</b><input data-chapter="${i}" data-key="chapterTitle" value="${escapeHtml(chapter.chapterTitle)}"></div>
          <div class="grid two">
            <div class="field"><label>내레이션</label><textarea data-chapter="${i}" data-key="narration">${escapeHtml(chapter.narration)}</textarea></div>
            <div>
              <div class="field"><label>화면 자막</label><textarea data-chapter="${i}" data-key="subtitle">${escapeHtml(chapter.subtitle)}</textarea></div>
              <div class="inline-fields"><div class="field"><label>효과음·음악</label><input data-chapter="${i}" data-key="soundCue" value="${escapeHtml(chapter.soundCue || '')}"></div><div class="field"><label>초</label><input type="number" min="3" max="12" data-chapter="${i}" data-key="durationSec" value="${chapter.durationSec}"></div></div>
            </div>
          </div>
        </article>`).join('')}
    </div>`;

  $$('[data-char]', views.story).forEach((el) => el.addEventListener('input', () => {
    state.project.characters[Number(el.dataset.char)][el.dataset.key] = el.value;
    saveLocal();
  }));
  $$('[data-chapter]', views.story).forEach((el) => el.addEventListener('input', () => {
    const value = el.dataset.key === 'durationSec' ? Number(el.value) : el.value;
    state.project.chapters[Number(el.dataset.chapter)][el.dataset.key] = value;
    saveLocal();
  }));
  $('#goAssetsBtn').addEventListener('click', () => { renderAssets(); switchStep('assets'); });
  $('#saveStoryBtn').addEventListener('click', () => saveProject(true));
}

function renderAssets() {
  const p = state.project;
  if (!p) {
    views.assets.innerHTML = '<div class="empty">먼저 각본을 만들어 주세요.</div>';
    return;
  }
  views.assets.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">STEP 4 · CREATE ASSETS</div><h2>캐릭터와 장면 이미지·영상 만들기</h2><p>쇼츠용 기본 비율은 9:16입니다. 이미지 생성 후 각 장면을 Veo 영상 클립으로 만들 수 있습니다.</p></div>
      <div class="actions" style="margin-top:0"><button id="batchImagesBtn" class="button cyan">없는 장면 이미지 일괄 생성</button><button id="previewBtn" class="button ghost">스토리보드 미리보기</button></div>
    </div>
    <div class="notice">영상 생성은 장면당 API 비용과 대기 시간이 발생할 수 있습니다. 먼저 이미지와 전체 스토리 흐름을 확인한 뒤 필요한 장면만 영상으로 만드는 편이 안전합니다.</div>
    <div style="height:16px"></div>
    <h2>캐릭터 기준 이미지</h2>
    <div class="character-grid">
      ${p.characters.map((char, i) => `
        <article class="card character-card">
          <div class="thumb character">${char.referenceImage ? `<img src="${char.referenceImage}" alt="${escapeHtml(char.name)}">` : '미생성'}</div>
          <div>
            <h3>${escapeHtml(char.name)}</h3>
            <p class="help">${escapeHtml(char.appearance || '')}</p>
            <div class="actions">
              <button class="button primary small gen-char" data-index="${i}">${char.referenceImage ? '기준 이미지 재생성' : '기준 이미지 생성'}</button>
              <label class="button ghost small">내 이미지 업로드<input class="upload-char" data-index="${i}" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            </div>
          </div>
        </article>`).join('')}
    </div>
    <div style="height:24px"></div>
    <h2>장면별 제작</h2>
    <div class="chapter-list">
      ${p.chapters.map((chapter, i) => chapterAssetCard(chapter, i)).join('')}
    </div>`;

  $$('.gen-char', views.assets).forEach((button) => button.addEventListener('click', () => generateCharacterImage(Number(button.dataset.index))));
  $$('.upload-char', views.assets).forEach((input) => input.addEventListener('change', () => uploadImage(input.files[0], 'characters', `character-${Number(input.dataset.index) + 1}`, (url) => {
    state.project.characters[Number(input.dataset.index)].referenceImage = url;
  })));
  $$('.gen-scene', views.assets).forEach((button) => button.addEventListener('click', () => generateSceneImage(Number(button.dataset.index))));
  $$('.upload-scene', views.assets).forEach((input) => input.addEventListener('change', () => uploadImage(input.files[0], 'images', `chapter-${Number(input.dataset.index) + 1}`, (url) => {
    state.project.chapters[Number(input.dataset.index)].imageUrl = url;
  })));
  $$('.edit-scene', views.assets).forEach((button) => button.addEventListener('click', () => editSceneImage(Number(button.dataset.index))));
  $$('.gen-video', views.assets).forEach((button) => button.addEventListener('click', () => generateSceneVideo(Number(button.dataset.index))));
  $$('[data-asset-chapter]', views.assets).forEach((el) => el.addEventListener('input', () => {
    state.project.chapters[Number(el.dataset.assetChapter)][el.dataset.key] = el.value;
    saveLocal();
  }));
  $('#batchImagesBtn').addEventListener('click', batchGenerateImages);
  $('#previewBtn').addEventListener('click', openPreview);
}

function chapterAssetCard(chapter, i) {
  return `
    <article class="card chapter-card">
      <div class="chapter-media">
        <div class="thumb">
          ${chapter.videoUrl ? `<video src="${chapter.videoUrl}" controls playsinline></video>` : chapter.imageUrl ? `<img src="${chapter.imageUrl}" alt="장면 ${i + 1}">` : `장면 ${i + 1}<br>이미지 없음`}
        </div>
        <div class="actions">
          <button class="button primary small gen-scene" data-index="${i}">${chapter.imageUrl ? '이미지 재생성' : '이미지 생성'}</button>
          <label class="button ghost small">업로드<input class="upload-scene" data-index="${i}" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
          ${chapter.imageUrl ? `<button class="button ghost small edit-scene" data-index="${i}">AI 수정</button>` : ''}
        </div>
        ${chapter.imageUrl ? `<button class="button cyan gen-video" data-index="${i}">${chapter.videoUrl ? '영상 다시 생성' : 'Veo 영상 생성'}</button>` : '<button class="button" disabled>이미지 생성 후 영상 가능</button>'}
      </div>
      <div class="chapter-fields">
        <div class="chapter-title"><b>${i + 1}</b><h3>${escapeHtml(chapter.chapterTitle)}</h3><span class="tag">${chapter.durationSec}초</span></div>
        <p class="muted">${escapeHtml(chapter.narration)}</p>
        <div class="field"><label>이미지 프롬프트</label><textarea class="prompt-box" data-asset-chapter="${i}" data-key="imagePrompt">${escapeHtml(chapter.imagePrompt)}</textarea></div>
        <div class="field"><label>영상 움직임 프롬프트</label><textarea class="prompt-box" data-asset-chapter="${i}" data-key="videoPrompt">${escapeHtml(chapter.videoPrompt)}</textarea></div>
        <div class="actions">
          ${chapter.imageUrl ? `<a class="button ghost small" href="${chapter.imageUrl}" download>이미지 열기</a>` : ''}
          ${chapter.videoUrl ? `<a class="button success small" href="${chapter.videoUrl}" download>MP4 열기</a>` : ''}
        </div>
      </div>
    </article>`;
}

async function generateCharacterImage(index) {
  const char = state.project.characters[index];
  setLoading(true, `${char.name} 기준 이미지 생성 중`, '캐릭터 일관성에 사용할 정면 기준 이미지를 만들고 있습니다.');
  try {
    const prompt = char.portraitPrompt || `${char.name}, ${char.age}, ${char.appearance}, ${char.personality}. Front-facing neutral character reference portrait, full body or waist-up, simple studio background, highly consistent design, ${state.settings.visualStyle}`;
    const data = await postJson('/api/shorts/image', {
      projectId: state.projectId,
      prompt,
      referenceUrls: [],
      aspectRatio: '1:1',
      folder: 'characters',
      name: `character-${index + 1}-${slug(char.name)}`,
    });
    state.projectId = data.projectId;
    char.referenceImage = data.url;
    await saveProject(false);
    renderStory(); renderAssets(); renderExport();
    toast('캐릭터 기준 이미지가 생성되었습니다.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function generateSceneImage(index, silent = false) {
  const chapter = state.project.chapters[index];
  if (!silent) setLoading(true, `장면 ${index + 1} 이미지 생성 중`, '캐릭터 기준 이미지를 참고해 세로 쇼츠 장면을 만들고 있습니다.');
  try {
    const references = state.project.characters.map((char) => char.referenceImage).filter(Boolean);
    const data = await postJson('/api/shorts/image', {
      projectId: state.projectId,
      prompt: `${chapter.imagePrompt}\nVisual style: ${state.settings.visualStyle}`,
      referenceUrls: references,
      aspectRatio: '9:16',
      folder: 'images',
      name: `chapter-${String(index + 1).padStart(2, '0')}`,
    });
    state.projectId = data.projectId;
    chapter.imageUrl = data.url;
    chapter.videoUrl = null;
    await saveProject(false);
    if (!silent) { renderAssets(); renderExport(); toast(`장면 ${index + 1} 이미지가 생성되었습니다.`); }
    return true;
  } catch (error) {
    toast(`장면 ${index + 1}: ${error.message}`, true);
    return false;
  } finally {
    if (!silent) setLoading(false);
  }
}

async function batchGenerateImages() {
  const missing = state.project.chapters.map((c, i) => ({ c, i })).filter(({ c }) => !c.imageUrl);
  if (!missing.length) return toast('모든 장면 이미지가 이미 있습니다.');
  if (!confirm(`${missing.length}개 장면 이미지를 순서대로 생성합니다. API 사용량이 발생할 수 있습니다. 계속할까요?`)) return;
  setLoading(true, '장면 이미지 일괄 생성 중', `0 / ${missing.length} 완료`);
  let done = 0;
  for (const { i } of missing) {
    $('#loadingText').textContent = `${done} / ${missing.length} 완료 · 현재 장면 ${i + 1}`;
    const ok = await generateSceneImage(i, true);
    if (!ok) break;
    done += 1;
  }
  setLoading(false);
  await saveProject(false);
  renderAssets(); renderExport();
  toast(`${done}개 장면 이미지를 생성했습니다.`);
}

async function editSceneImage(index) {
  const chapter = state.project.chapters[index];
  const instruction = prompt('이미지를 어떻게 수정할까요?\n예: 인물 표정을 더 놀란 표정으로 바꾸고 배경을 저녁으로 변경');
  if (!instruction) return;
  setLoading(true, `장면 ${index + 1} 이미지 수정 중`, instruction);
  try {
    const data = await postJson('/api/shorts/edit-image', {
      projectId: state.projectId,
      imageUrl: chapter.imageUrl,
      instruction,
      aspectRatio: '9:16',
      name: `chapter-${String(index + 1).padStart(2, '0')}-edited-${Date.now()}`,
    });
    chapter.imageUrl = data.url;
    chapter.videoUrl = null;
    await saveProject(false);
    renderAssets(); renderExport();
    toast('이미지가 수정되었습니다.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function uploadImage(file, folder, name, apply) {
  if (!file) return;
  setLoading(true, '이미지 업로드 중', file.name);
  try {
    const form = new FormData();
    form.append('image', file);
    form.append('projectId', state.projectId);
    form.append('folder', folder);
    form.append('name', name);
    const data = await api('/api/shorts/upload', { method: 'POST', body: form });
    state.projectId = data.projectId;
    apply(data.url);
    await saveProject(false);
    renderStory(); renderAssets(); renderExport();
    toast('이미지를 업로드했습니다.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function generateSceneVideo(index) {
  const chapter = state.project.chapters[index];
  if (!chapter.imageUrl) return toast('먼저 장면 이미지를 만들어 주세요.', true);
  if (!confirm('Veo 영상 생성은 API 비용이 발생할 수 있고 몇 분 이상 걸릴 수 있습니다. 계속할까요?')) return;
  setLoading(true, `장면 ${index + 1} 영상 생성 중`, 'Veo가 영상을 만들고 있습니다. 창을 닫지 마세요.');
  try {
    const data = await postJson('/api/shorts/video', {
      projectId: state.projectId,
      imageUrl: chapter.imageUrl,
      prompt: chapter.videoPrompt,
      aspectRatio: '9:16',
      name: `chapter-${String(index + 1).padStart(2, '0')}`,
    });
    chapter.videoUrl = data.url;
    await saveProject(false);
    renderAssets(); renderExport();
    toast(`장면 ${index + 1} 영상이 생성되었습니다.`);
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function saveProject(showMessage = false) {
  saveLocal();
  if (!state.project) return;
  try {
    const data = await postJson('/api/shorts/projects/save', { projectId: state.projectId, project: state.project });
    state.projectId = data.projectId;
    if (showMessage) toast('프로젝트를 로컬 폴더에 저장했습니다.');
  } catch (error) {
    if (showMessage) toast(error.message, true);
  }
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(milli).padStart(3,'0')}`;
}

function createSrt() {
  let cursor = 0;
  return state.project.chapters.map((chapter, i) => {
    const start = cursor;
    cursor += Number(chapter.durationSec || 7);
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(cursor)}\n${chapter.subtitle || chapter.narration}\n`;
  }).join('\n');
}

function createCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['장면','제목','시작초','길이초','내레이션','자막','이미지프롬프트','영상프롬프트','효과음','이미지파일','영상파일'];
  let cursor = 0;
  const rows = state.project.chapters.map((c, i) => {
    const row = [i + 1, c.chapterTitle, cursor, c.durationSec, c.narration, c.subtitle, c.imagePrompt, c.videoPrompt, c.soundCue, c.imageUrl || '', c.videoUrl || ''];
    cursor += Number(c.durationSec || 7);
    return row;
  });
  return '﻿' + [header, ...rows].map((row) => row.map(q).join(',')).join('\r\n');
}

function renderExport() {
  const p = state.project;
  if (!p) {
    views.export.innerHTML = '<div class="empty">내보낼 프로젝트가 없습니다.</div>';
    return;
  }
  const images = p.chapters.filter((c) => c.imageUrl).length;
  const videos = p.chapters.filter((c) => c.videoUrl).length;
  views.export.innerHTML = `
    <div class="section-head"><div><div class="eyebrow">STEP 5 · EXPORT</div><h2>캡컷·유튜브용 결과 내보내기</h2><p>각본과 자막, 프롬프트, 생성 자산을 원하는 형식으로 저장합니다.</p></div><button id="saveBeforeExportBtn" class="button success">현재 상태 저장</button></div>
    <div class="summary-bar"><span class="tag">이미지 ${images}/${p.chapters.length}</span><span class="tag">영상 ${videos}/${p.chapters.length}</span><span class="tag">프로젝트 ${escapeHtml(state.projectId)}</span></div>
    <div class="export-grid">
      <article class="card export-card"><div><h3>프로젝트 JSON</h3><p>나중에 구조와 프롬프트를 확인하거나 다른 프로그램에서 사용할 전체 데이터입니다.</p></div><button id="exportJsonBtn" class="button primary">JSON 저장</button></article>
      <article class="card export-card"><div><h3>캡컷 작업표 CSV</h3><p>장면별 시작 시간, 내레이션, 이미지·영상 프롬프트와 자산 주소를 표로 저장합니다.</p></div><button id="exportCsvBtn" class="button cyan">CSV 저장</button></article>
      <article class="card export-card"><div><h3>자막 SRT</h3><p>각 장면의 설정 시간을 기준으로 캡컷이나 영상 편집기에 넣을 수 있는 자막 파일입니다.</p></div><button id="exportSrtBtn" class="button cyan">SRT 저장</button></article>
      <article class="card export-card"><div><h3>유튜브 설명</h3><p>제목, 설명, 해시태그를 TXT 파일로 저장합니다.</p></div><button id="exportYoutubeBtn" class="button ghost">TXT 저장</button></article>
      <article class="card export-card"><div><h3>전체 프로젝트 ZIP</h3><p>서버의 프로젝트 JSON과 캐릭터·장면 이미지·MP4를 한 압축파일로 받습니다.</p></div><button id="exportZipBtn" class="button success">전체 ZIP 받기</button></article>
      <article class="card export-card"><div><h3>스토리보드 미리보기</h3><p>이미지와 자막을 장면 순서대로 확인합니다.</p></div><button id="previewExportBtn" class="button ghost">미리보기</button></article>
    </div>
    <div style="height:18px"></div>
    <div class="card"><h3>유튜브 메타데이터</h3><div class="field"><label>제목</label><input id="youtubeTitle" value="${escapeHtml(p.youtube?.title || p.title)}"></div><div class="field"><label>설명</label><textarea id="youtubeDescription">${escapeHtml(p.youtube?.description || '')}</textarea></div><div class="field"><label>해시태그</label><input id="youtubeHashtags" value="${escapeHtml((p.youtube?.hashtags || []).join(' '))}"></div></div>`;

  $('#saveBeforeExportBtn').addEventListener('click', () => saveProject(true));
  $('#exportJsonBtn').addEventListener('click', () => downloadText(JSON.stringify({ ...p, projectId: state.projectId }, null, 2), `${slug(p.title)}-project.json`, 'application/json;charset=utf-8'));
  $('#exportCsvBtn').addEventListener('click', () => downloadText(createCsv(), `${slug(p.title)}-capcut.csv`, 'text/csv;charset=utf-8'));
  $('#exportSrtBtn').addEventListener('click', () => downloadText('﻿' + createSrt(), `${slug(p.title)}-subtitles.srt`, 'application/x-subrip;charset=utf-8'));
  $('#exportYoutubeBtn').addEventListener('click', () => {
    syncYoutube();
    const y = p.youtube;
    downloadText(`제목\n${y.title}\n\n설명\n${y.description}\n\n해시태그\n${y.hashtags.join(' ')}`, `${slug(p.title)}-youtube.txt`);
  });
  $('#exportZipBtn').addEventListener('click', async () => {
    syncYoutube();
    await saveProject(false);
    window.location.href = `/api/shorts/projects/${encodeURIComponent(state.projectId)}/bundle`;
  });
  $('#previewExportBtn').addEventListener('click', openPreview);
  ['youtubeTitle','youtubeDescription','youtubeHashtags'].forEach((id) => $(`#${id}`).addEventListener('input', syncYoutube));
}

function syncYoutube() {
  if (!state.project) return;
  state.project.youtube ||= {};
  state.project.youtube.title = $('#youtubeTitle')?.value ?? state.project.youtube.title;
  state.project.youtube.description = $('#youtubeDescription')?.value ?? state.project.youtube.description;
  state.project.youtube.hashtags = ($('#youtubeHashtags')?.value || '').split(/\s+/).filter(Boolean);
  saveLocal();
}

function openPreview() {
  if (!state.project?.chapters?.length) return;
  state.previewIndex = Math.min(state.previewIndex, state.project.chapters.length - 1);
  renderPreview();
  $('#previewDialog').showModal();
}

function renderPreview() {
  const chapter = state.project.chapters[state.previewIndex];
  const percent = ((state.previewIndex + 1) / state.project.chapters.length) * 100;
  $('#previewBody').innerHTML = `
    <div class="preview-stage">
      <div class="preview-image">${chapter.imageUrl ? `<img src="${chapter.imageUrl}" alt="장면">` : '<div class="empty">이미지 없음</div>'}</div>
      <div>
        <span class="tag">장면 ${state.previewIndex + 1} / ${state.project.chapters.length}</span>
        <h2>${escapeHtml(chapter.chapterTitle)}</h2>
        <p class="preview-subtitle">${escapeHtml(chapter.subtitle)}</p>
        <p class="muted">${escapeHtml(chapter.narration)}</p>
        <div class="progress"><span style="width:${percent}%"></span></div>
        <div class="actions"><button id="previewPrev" class="button ghost" ${state.previewIndex === 0 ? 'disabled' : ''}>이전</button><button id="previewNext" class="button primary" ${state.previewIndex === state.project.chapters.length - 1 ? 'disabled' : ''}>다음</button></div>
      </div>
    </div>`;
  $('#previewPrev').addEventListener('click', () => { state.previewIndex -= 1; renderPreview(); });
  $('#previewNext').addEventListener('click', () => { state.previewIndex += 1; renderPreview(); });
}

function newProject() {
  if (state.project && !confirm('현재 프로젝트를 지우고 새로 시작할까요? 먼저 전체 ZIP 또는 JSON으로 저장하는 것을 권장합니다.')) return;
  state.step = 'plan';
  state.settings = { ...defaultSettings };
  state.topics = [];
  state.selectedTopic = null;
  state.project = null;
  state.projectId = `story-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  state.assetMode = {};
  localStorage.removeItem('storyShortsStudioState');
  renderAll();
  switchStep('plan');
}

function renderAll() {
  renderPlan();
  renderTopics();
  renderStory();
  renderAssets();
  renderExport();
}

async function checkStatus() {
  try {
    const status = await api('/api/shorts/status');
    const el = $('#apiStatus');
    el.textContent = status.hasApiKey ? `API 준비 · ${status.models.text}` : 'API 키 설정 필요';
    el.className = `status-pill ${status.hasApiKey ? 'ok' : 'bad'}`;
    if (!status.hasApiKey) toast('상단 앱 셸에서 Gemini API 키를 입력해 주세요.', true);
  } catch {
    $('#apiStatus').textContent = '서버 연결 오류';
    $('#apiStatus').className = 'status-pill bad';
  }
}

loadLocal();
renderAll();
switchStep(state.step || 'plan');
checkStatus();

$$('.step').forEach((button) => button.addEventListener('click', () => switchStep(button.dataset.step)));
$('#newProjectBtn').addEventListener('click', newProject);
$('#closePreviewBtn').addEventListener('click', () => $('#previewDialog').close());
$('#previewDialog').addEventListener('click', (event) => {
  if (event.target === $('#previewDialog')) $('#previewDialog').close();
});
window.addEventListener('creator-studio:key-updated', checkStatus);
