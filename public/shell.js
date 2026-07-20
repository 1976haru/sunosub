const $ = (id) => document.getElementById(id);

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add('hidden'), 2400);
}

function switchTab(tool) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tool;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  // display toggling only — the iframe already has its src set, so this
  // never reloads it, which keeps whatever the user typed intact.
  document.querySelectorAll('.tool-frame').forEach((frame) => {
    frame.classList.toggle('active', frame.dataset.tool === tool);
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data;
}

function applyKeyStatus(status) {
  const badge = $('keyBadge');
  const notice = $('keyNotice');
  if (status.geminiConfigured) {
    badge.textContent = 'Gemini 키 연결됨';
    badge.className = 'key-badge ok';
    notice.classList.add('hidden');
  } else {
    badge.textContent = 'Gemini 키 미설정';
    badge.className = 'key-badge warn';
    notice.classList.remove('hidden');
  }
}

async function refreshKeyStatus() {
  try {
    const status = await api('/api/status');
    applyKeyStatus(status);
  } catch {
    $('keyBadge').textContent = '서버 연결 오류';
    $('keyBadge').className = 'key-badge warn';
  }
}

function notifyToolsKeyUpdated() {
  document.querySelectorAll('.tool-frame').forEach((frame) => {
    try {
      frame.contentWindow?.dispatchEvent(new Event('creator-studio:key-updated'));
    } catch { /* tool not loaded yet, ignore */ }
  });
}

function setupKeyDialog() {
  const dialog = $('keyDialog');
  const input = $('keyInput');
  const error = $('keyDialogError');

  $('keyChangeBtn').addEventListener('click', () => {
    input.value = '';
    error.classList.add('hidden');
    dialog.showModal();
    input.focus();
  });
  $('keyCancelBtn').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  const submit = async () => {
    const apiKey = input.value.trim();
    if (!apiKey) {
      error.textContent = '키를 입력해 주세요.';
      error.classList.remove('hidden');
      return;
    }
    try {
      const status = await api('/api/key', { method: 'POST', body: JSON.stringify({ apiKey }) });
      applyKeyStatus(status);
      notifyToolsKeyUpdated();
      dialog.close();
      showToast('Gemini 키를 저장했습니다.');
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  };
  $('keySaveBtn').addEventListener('click', submit);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

setupKeyDialog();
refreshKeyStatus();
