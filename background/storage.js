const KEY_STATE = 'aegis_state';
const KEY_COSMETIC = 'aegis_cosmetic';

function promisifyChrome(fn, context, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn.apply(context, [
        ...args,
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result);
        }
      ]);
    } catch (err) {
      reject(err);
    }
  });
}

async function storageGet(keys) {
  return promisifyChrome(chrome.storage.local.get, chrome.storage.local, keys);
}

async function storageSet(items) {
  return promisifyChrome(chrome.storage.local.set, chrome.storage.local, items);
}

export async function getState() {
  const data = await storageGet([KEY_STATE]);
  return data[KEY_STATE] || null;
}

export async function saveState(state) {
  return storageSet({ [KEY_STATE]: state });
}

export async function updateState(mutator) {
  const current = (await getState()) || null;
  const next = await mutator(structuredClone(current));
  if (typeof next === 'undefined') {
    return current;
  }
  await saveState(next);
  return next;
}

export async function getCosmeticCache() {
  const data = await storageGet([KEY_COSMETIC]);
  return data[KEY_COSMETIC] || null;
}

export async function saveCosmeticCache(payload) {
  return storageSet({ [KEY_COSMETIC]: payload });
}

export async function clearAll() {
  return promisifyChrome(chrome.storage.local.clear, chrome.storage.local);
}

export const STORAGE_KEYS = {
  STATE: KEY_STATE,
  COSMETIC: KEY_COSMETIC
};
