const COSMETIC_KEY = 'aegis_cosmetic';
const STYLE_ID = '__aegis_cosmetics';
const HIDDEN_ATTR = 'data-aegis-hidden';
const YT_PROTECTED_SELECTORS = [
  '#movie_player',
  '.html5-video-player',
  'ytd-watch-flexy',
  'ytd-app',
  '#player',
  'ytd-player',
  '#player-container-outer',
  '#player-container-inner'
];
const BLOCKED_GLOBAL_SELECTORS = new Set(['[role="banner"]']);
const HEURISTIC_KEYWORDS = [
  'ad',
  'ads',
  'advert',
  'advertisement',
  'sponsor',
  'sponsored',
  'promo',
  'promoted',
  'banner',
  'brandvoice'
];
const HEURISTIC_PATTERNS = HEURISTIC_KEYWORDS.map((keyword) => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
});
const HEURISTIC_SELECTORS = [
  '[class*=\"ad-\"]',
  '[class*=\"-ad\"]',
  '[class*=\"advert\"]',
  '[class*=\"promo\"]',
  '[id*=\"ad-\"]',
  '[id*=\"-ad\"]',
  '[id*=\"advert\"]',
  '[data-ad]',
  '[data-ad-slot]',
  '[aria-label=\"advertisement\"]',
  'iframe[src*=\"ad\"]',
  'iframe[src*=\"doubleclick\"]'
];

const hiddenNodes = new WeakSet();
let ytSkipperInterval = null;
let ytLastVolume = null;
let sameDomainOnly = false;
let popupGuardInitialized = false;
const POPUP_GUARD_DISABLED_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'watchseries.im',
  'www.watchseries.im',
  'desicinemas.pk',
  'www.desicinemas.pk'
];
const NORMALIZED_POPUP_GUARD_DISABLED_HOSTS = POPUP_GUARD_DISABLED_HOSTS.map((host) =>
  host.replace(/^www\./, '').toLowerCase()
);

function getStorageValue(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (items) => {
      resolve(items[key] || null);
    });
  });
}

function domainMatches(hostname, requirement) {
  if (!hostname || !requirement) return false;
  return hostname === requirement || hostname.endsWith(`.${requirement}`);
}

function buildCss(selectors) {
  if (!selectors.length) return '';
  return selectors
    .map((selector) => `${selector} { display: none !important; }`)
    .join('\n');
}

function ensureStyleElement() {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  return style;
}

function applyCosmetics(config) {
  if (!config) return;
  const hostname = location.hostname.toLowerCase();
  const selectors = new Set((config.global || []).filter((sel) => !BLOCKED_GLOBAL_SELECTORS.has(sel)));

  const perDomain = config.perDomain || {};
  for (const [domain, domainSelectors] of Object.entries(perDomain)) {
    if (domainMatches(hostname, domain)) {
      for (const selector of domainSelectors) {
        if (!BLOCKED_GLOBAL_SELECTORS.has(selector)) {
          selectors.add(selector);
        }
      }
    }
  }

  const css = buildCss(Array.from(selectors));
  const style = ensureStyleElement();
  style.textContent = css;
  return Boolean(config.heuristicsEnabled);
}

function shouldHideElement(el) {
  if (!el || !(el instanceof Element)) return false;
  if (hiddenNodes.has(el)) return false;
  if (el.closest('[data-aegis-allow]')) return false;
  if (el.id === STYLE_ID) return false;

  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'head') return false;

  const attributePayloadRaw = [
    typeof el.className === 'string' ? el.className : '',
    el.id || '',
    el.getAttribute('aria-label') || '',
    el.getAttribute('data-testid') || '',
    el.getAttribute('data-tracking') || '',
    el.getAttribute('data-slot') || '',
    el.getAttribute('data-ad') || ''
  ]
    .join(' ')
    .toLowerCase();

  const attributePayload = ` ${attributePayloadRaw} `;

  if (isYouTubeHost(location.hostname)) {
    if (YT_PROTECTED_SELECTORS.some((selector) => el.closest(selector))) {
      return false;
    }
  }

  return HEURISTIC_PATTERNS.some((pattern) => pattern.test(attributePayload));
}

function hideElement(el, reason = 'cosmetic') {
  if (!el) return;
  el.style.setProperty('display', 'none', 'important');
  el.setAttribute(HIDDEN_ATTR, reason);
  hiddenNodes.add(el);
}

function runHeuristics(root = document) {
  const selector = HEURISTIC_SELECTORS.join(',');
  let candidates = [];
  try {
    candidates = root.querySelectorAll(selector);
  } catch (err) {
    candidates = [];
  }
  for (const el of candidates) {
    if (shouldHideElement(el)) {
      hideElement(el, 'heuristic-selector');
    }
  }

  const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  while (treeWalker.nextNode()) {
    const node = treeWalker.currentNode;
    if (shouldHideElement(node)) {
      hideElement(node, 'heuristic-walker');
    }
  }
}

function isYouTubeHost(hostname) {
  return /(^|\.)youtube\.com$/.test(hostname);
}

function clickIfExists(selector) {
  const el = document.querySelector(selector);
  if (el) {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.click();
    return true;
  }
  return false;
}

function fastForwardVideo(video) {
  if (!video) return;
  try {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.duration;
    } else {
      video.playbackRate = 16;
    }
  } catch {
    video.playbackRate = 16;
  }
}

function restoreVideoState(video) {
  if (!video) return;
  video.playbackRate = 1;
  if (ytLastVolume !== null) {
    video.volume = ytLastVolume;
    video.muted = false;
    ytLastVolume = null;
  }
}

function dampenVideo(video) {
  if (!video) return;
  if (ytLastVolume === null) {
    ytLastVolume = video.volume;
  }
  video.muted = true;
  fastForwardVideo(video);
}

function cleanYouTubeOverlayAds() {
  document.querySelectorAll('.ytp-ad-overlay-slot, .ytp-ad-overlay-image').forEach((node) => {
    hideElement(node, 'yt-overlay');
  });
  document.querySelectorAll('.ytp-ad-overlay-close-button').forEach((btn) => btn.click());
}

function initYouTubeAdSkipper() {
  if (!isYouTubeHost(location.hostname)) {
    return;
  }
  if (ytSkipperInterval) {
    return;
  }

  ytSkipperInterval = setInterval(() => {
    const player = document.querySelector('.html5-video-player');
    const video = document.querySelector('video.html5-main-video');
    if (!player || !video) {
      return;
    }

    const adShowing =
      player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');

    if (!adShowing) {
      restoreVideoState(video);
      return;
    }

    cleanYouTubeOverlayAds();
    clickIfExists('.ytp-ad-skip-button');
    clickIfExists('.ytp-ad-skip-button-modern');
    clickIfExists('.ytp-ad-skip-button.ytp-button');
    clickIfExists('.ytp-ad-overlay-close-button');

    dampenVideo(video);
  }, 400);
}

function injectExternalScript(path, dataset = {}) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(path);
  Object.entries(dataset).forEach(([key, value]) => {
    script.dataset[key] = value;
  });
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function initGlobalPopupGuard(config) {
  if (popupGuardInitialized) {
    return;
  }
  popupGuardInitialized = true;
  const guardDisabled = shouldDisablePopupGuard(location.hostname);
  if (guardDisabled) {
    return;
  }
  injectExternalScript('content/popupGuard.js', {
    siteHost: location.hostname,
    sameDomainOnly: String(!!config?.sameDomainOnly)
  });
}

function initYouTubeFixes() {
  if (!isYouTubeHost(location.hostname)) {
    return;
  }
  injectExternalScript('content/youtubeFixes.js');
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = chrome.runtime.getURL('content/youtubeStyle.css');
  (document.head || document.documentElement).appendChild(style);
}

async function initialize() {
  if (document.contentType === 'text/plain') {
    return;
  }

  const config = await getStorageValue(COSMETIC_KEY);
  sameDomainOnly = Boolean(config?.sameDomainOnly);
  let heuristicsActive = applyCosmetics(config);
  if (heuristicsActive) {
    runHeuristics(document);
  }
  initYouTubeAdSkipper();
  initGlobalPopupGuard({ sameDomainOnly });
  initYouTubeFixes();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (heuristicsActive) {
            runHeuristics(node);
          }
        }
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  } else {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[COSMETIC_KEY]) return;
    const newConfig = changes[COSMETIC_KEY].newValue;
    sameDomainOnly = Boolean(newConfig?.sameDomainOnly);
    heuristicsActive = applyCosmetics(newConfig);
    if (heuristicsActive) {
      runHeuristics(document);
    }
    injectExternalScript('content/updatePopupGuard.js', {
      sameDomainOnly: String(sameDomainOnly)
    });
  });
}

initialize().catch((err) => console.error('content-script init failed', err));
function shouldDisablePopupGuard(hostname) {
  if (!hostname) return false;
  const normalized = hostname.replace(/^www\./, '').toLowerCase();
  return NORMALIZED_POPUP_GUARD_DISABLED_HOSTS.some(
    (target) => normalized === target || normalized.endsWith(`.${target}`)
  );
}
