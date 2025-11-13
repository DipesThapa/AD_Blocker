import {
  bootstrap,
  getPopupState,
  setEnabled,
  toggleSite,
  refreshFilters,
  addFilterList,
  removeFilterList,
  toggleFilterList,
  getOptionsState,
  setHeuristicsEnabled,
  setSameDomainOnly,
  saveSupportLinks
} from './filterManager.js';

function getTab(tabId) {
  if (!tabId) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

const ready = bootstrap().catch((error) => {
  console.error('Failed to bootstrap AdBlock Ultra', error);
  throw error;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    ready
      .then(() => refreshFilters({ forceFetch: true }))
      .catch((err) => console.error('Initial refresh failed', err));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};
  let handlerPromise = ready;

  switch (type) {
    case 'POPUP_STATE': {
      handlerPromise = handlerPromise.then(() =>
        getTab(sender.tab?.id || payload?.tabId)
          .catch(() => sender.tab)
          .then((tab) => getPopupState(tab))
      );
      break;
    }
    case 'POPUP_TOGGLE_ENABLED': {
      handlerPromise = handlerPromise.then(() => setEnabled(Boolean(payload?.enabled)));
      break;
    }
    case 'POPUP_TOGGLE_SITE': {
      handlerPromise = handlerPromise.then(() => toggleSite(payload?.hostname));
      break;
    }
    case 'OPTIONS_STATE': {
      handlerPromise = handlerPromise.then(() => getOptionsState());
      break;
    }
    case 'OPTIONS_ADD_LIST': {
      handlerPromise = handlerPromise.then(() => addFilterList(payload));
      break;
    }
    case 'OPTIONS_REMOVE_LIST': {
      handlerPromise = handlerPromise.then(() => removeFilterList(payload?.id));
      break;
    }
    case 'OPTIONS_TOGGLE_LIST': {
      handlerPromise = handlerPromise.then(() =>
        toggleFilterList(payload?.id, Boolean(payload?.enabled))
      );
      break;
    }
    case 'OPTIONS_REFRESH': {
      handlerPromise = handlerPromise.then(() =>
        refreshFilters({ forceFetch: Boolean(payload?.force) })
      );
      break;
    }
    case 'OPTIONS_SET_HEURISTICS': {
      handlerPromise = handlerPromise.then(() =>
        setHeuristicsEnabled(Boolean(payload?.enabled))
      );
      break;
    }
    case 'OPTIONS_SET_SAME_DOMAIN': {
      handlerPromise = handlerPromise.then(() =>
        setSameDomainOnly(Boolean(payload?.enabled))
      );
      break;
    }
    case 'OPTIONS_SAVE_SUPPORT_LINKS': {
      handlerPromise = handlerPromise.then(() =>
        saveSupportLinks(payload?.links || [])
      );
      break;
    }
    default:
      handlerPromise = handlerPromise.then(() => null);
  }

  handlerPromise
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, message: error?.message || 'Unknown error' });
    });

  return true;
});
