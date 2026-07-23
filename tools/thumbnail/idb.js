const DB_NAME = 'creator-studio-thumbnail';
const DB_VERSION = 1;
const STORE_CHANNELS = 'channels';
const STORE_HISTORY = 'copyHistory';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CHANNELS)) db.createObjectStore(STORE_CHANNELS);
      if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

export async function listChannelNames() {
  return withStore(STORE_CHANNELS, 'readonly', (store) => store.getAllKeys());
}

export async function getChannel(name) {
  if (!name) return undefined;
  return withStore(STORE_CHANNELS, 'readonly', (store) => store.get(name));
}

export async function saveChannel(name, template) {
  if (!name) throw new Error('채널 이름이 필요합니다.');
  await withStore(STORE_CHANNELS, 'readwrite', (store) => store.put(template, name));
}

export async function deleteChannel(name) {
  if (!name) return;
  await withStore(STORE_CHANNELS, 'readwrite', (store) => store.delete(name));
}

export async function getCopyHistory(channel) {
  if (!channel) return [];
  const history = await withStore(STORE_HISTORY, 'readonly', (store) => store.get(channel));
  return Array.isArray(history) ? history : [];
}

export async function addCopyHistory(channel, text, cap = 40) {
  if (!channel || !text) return;
  const current = await getCopyHistory(channel);
  const next = [text, ...current.filter((t) => t !== text)].slice(0, cap);
  await withStore(STORE_HISTORY, 'readwrite', (store) => store.put(next, channel));
}
