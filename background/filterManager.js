import {
  getState,
  saveState,
  saveCosmeticCache,
  getCosmeticCache
} from './storage.js';
import {
  parseFilterText,
  compileNetworkRules,
  mergeCosmeticCollections,
  buildAllowlistRules
} from './ruleCompiler.js';

const FILTER_RULE_START = 1;
const FILTER_RULE_MAX = 650000;
const ALLOW_RULE_START = 700000;
const ALLOW_RULE_MAX = 5000;
const DISABLE_RULE_ID = 900000;
const MAX_CACHE_SIZE = 900_000; // chars
const AUTO_UPDATE_ALARM = 'aegis::auto-update';

const DEFAULT_SUPPORT_LINKS = [];
const DEPRECATED_SUPPORT_URLS = new Set([
  'https://github.com/sponsors/aegisadshield',
  'https://www.buymeacoffee.com/aegisadshield'
]);
const SUPPORT_AUTOCONFIG_FALLBACKS = {
  github: ['adblockultra'],
  buymeacoffee: ['adblockultra']
};
const SUPPORT_PROVIDERS = {
  github: {
    id: 'github-sponsors',
    label: 'GitHub Sponsors',
    buildUrl: (handle) => `https://github.com/sponsors/${handle}`
  },
  buymeacoffee: {
    id: 'buymeacoffee',
    label: 'Buy Me a Coffee',
    buildUrl: (handle) => `https://www.buymeacoffee.com/${handle}`
  }
};

const DEFAULT_LISTS = [
  {
    id: 'builtin-network',
    title: 'Built-in network filters',
    type: 'network',
    source: chrome.runtime.getURL('filters/default_network.txt'),
    builtin: true,
    enabled: true,
    cache: null
  },
  {
    id: 'builtin-cosmetic',
    title: 'Built-in cosmetic filters',
    type: 'cosmetic',
    source: chrome.runtime.getURL('filters/default_cosmetic.txt'),
    builtin: true,
    enabled: true,
    cache: null
  }
];

let stateCache = null;
let rebuildPromise = null;

function createDefaultState() {
  return {
    version: 1,
    enabled: true,
    heuristicsEnabled: true,
    autoUpdateHours: 24,
    filterLists: structuredClone(DEFAULT_LISTS),
    allowlist: [],
    supportLinks: structuredClone(DEFAULT_SUPPORT_LINKS),
    supportAutoconfigChecked: false,
    sameDomainOnly: false,
    stats: {
      blocked: 0,
      updatedAt: Date.now()
    },
    compiledRuleCount: 0,
    lastFullCompile: null
  };
}

function normalizeHost(input) {
  if (!input) {
    return null;
  }
  try {
    if (input.includes('://')) {
      const url = new URL(input);
      input = url.hostname;
    }
  } catch (err) {
    // ignore
  }
  return input.replace(/[:?#].*$/, '').replace(/^www\./, '').toLowerCase();
}

async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureState() {
  let state = await getState();
  let dirty = false;
  if (!state) {
    state = createDefaultState();
    dirty = true;
  }
  if (!Array.isArray(state.filterLists)) {
    state.filterLists = [];
    dirty = true;
  }
  if (!Array.isArray(state.allowlist)) {
    state.allowlist = [];
    dirty = true;
  }
  if (!Array.isArray(state.supportLinks)) {
    state.supportLinks = structuredClone(DEFAULT_SUPPORT_LINKS);
    dirty = true;
  }
  if (typeof state.supportAutoconfigChecked !== 'boolean') {
    state.supportAutoconfigChecked = false;
    dirty = true;
  }
  if (typeof state.sameDomainOnly !== 'boolean') {
    state.sameDomainOnly = false;
    dirty = true;
  }
  if (!state.stats) {
    state.stats = { blocked: 0, updatedAt: Date.now() };
    dirty = true;
  }
  const ids = new Set(state.filterLists?.map((l) => l.id));
  for (const builtin of DEFAULT_LISTS) {
    if (!ids.has(builtin.id)) {
      state.filterLists.push(structuredClone(builtin));
      dirty = true;
    }
  }
  if (await normalizeSupportLinks(state)) {
    dirty = true;
  }
  if (dirty) {
    await saveState(state);
  }
  stateCache = state;
  return state;
}

async function fetchListContent(list, { forceNetwork = false } = {}) {
  if (!list) return '';
  if (list.builtin) {
    const res = await fetch(list.source);
    return res.text();
  }

  if (!forceNetwork && list.cache) {
    return list.cache;
  }

  const res = await fetch(list.source, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to download ${list.title || list.source}: ${res.status}`);
  }
  const text = await res.text();
  list.lastFetched = Date.now();
  list.hash = await hashText(text);
  list.size = text.length;

  if (text.length <= MAX_CACHE_SIZE) {
    list.cache = text;
    list.cacheTooLarge = false;
  } else {
    list.cache = null;
    list.cacheTooLarge = true;
  }

  return text;
}

async function replaceRuleRange(startId, endId, rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const toRemove = existing
    .filter((rule) => rule.id >= startId && rule.id <= endId)
    .map((rule) => rule.id);

  if (!rules?.length && !toRemove.length) {
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: rules || [],
    removeRuleIds: toRemove
  });
}

async function ensureDisableRule(disabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const hasDisableRule = existing.some((rule) => rule.id === DISABLE_RULE_ID);
  if (disabled && !hasDisableRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: DISABLE_RULE_ID,
          priority: 1_000_000,
          action: { type: 'allow' },
          condition: { regexFilter: '.*' }
        }
      ],
      removeRuleIds: []
    });
  } else if (!disabled && hasDisableRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [],
      removeRuleIds: [DISABLE_RULE_ID]
    });
  }
}

async function updateAllowlistRules(hosts) {
  const uniqueHosts = [...new Set(hosts.map(normalizeHost).filter(Boolean))];
  const rules = buildAllowlistRules(uniqueHosts, {
    startId: ALLOW_RULE_START,
    maxRules: ALLOW_RULE_MAX
  });
  await replaceRuleRange(ALLOW_RULE_START, ALLOW_RULE_START + ALLOW_RULE_MAX, rules);
}

async function rebuildFilters({ forceFetch = false } = {}) {
  if (rebuildPromise) {
    return rebuildPromise;
  }
  rebuildPromise = (async () => {
    const state = stateCache || (await ensureState());
    const combinedCosmetics = {
      global: new Set(),
      perDomain: new Map()
    };
    const networkEntries = [];

    for (const list of state.filterLists) {
      if (!list.enabled) continue;
      try {
        const text = await fetchListContent(list, { forceNetwork: forceFetch });
        const parsed = parseFilterText(text);
        if (parsed.network.length) {
          networkEntries.push(...parsed.network);
        }
        mergeCosmeticCollections(combinedCosmetics, parsed.cosmetics);
      } catch (err) {
        console.warn('Failed to load list', list, err);
      }
    }

    const { rules } = compileNetworkRules(networkEntries, {
      startId: FILTER_RULE_START,
      maxRules: FILTER_RULE_MAX
    });

    await replaceRuleRange(FILTER_RULE_START, FILTER_RULE_START + FILTER_RULE_MAX, rules);
    await ensureDisableRule(!state.enabled);
    await updateAllowlistRules(state.allowlist || []);

    const cosmeticPayload = {
      global: Array.from(combinedCosmetics.global),
      perDomain: Object.fromEntries(
        Array.from(combinedCosmetics.perDomain.entries()).map(([domain, selectors]) => [
          domain,
          Array.from(selectors)
        ])
      ),
      heuristicsEnabled: state.heuristicsEnabled,
      sameDomainOnly: state.sameDomainOnly,
      updatedAt: Date.now()
    };
    await saveCosmeticCache(cosmeticPayload);

    state.compiledRuleCount = rules.length;
    state.lastFullCompile = Date.now();
    await saveState(state);
    stateCache = state;
  })()
    .catch((err) => {
      console.error('Failed to rebuild filters', err);
      throw err;
    })
    .finally(() => {
      rebuildPromise = null;
    });

  return rebuildPromise;
}

async function ensureRulePresence() {
  const state = stateCache || (await ensureState());
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const hasFilterRules = existing.some(
    (rule) => rule.id >= FILTER_RULE_START && rule.id <= FILTER_RULE_START + FILTER_RULE_MAX
  );
  if (!hasFilterRules) {
    await rebuildFilters({ forceFetch: false });
  } else {
    await ensureDisableRule(!state.enabled);
    await updateAllowlistRules(state.allowlist || []);
    const cosmeticCache = await getCosmeticCache();
    if (!cosmeticCache) {
      await rebuildFilters({ forceFetch: false });
    }
  }
}

function formatBadge(count) {
  if (count > 9999) {
    return `${Math.floor(count / 1000)}k`;
  }
  return String(count);
}

async function incrementBlockedStat() {
  const state = stateCache || (await ensureState());
  state.stats = state.stats || { blocked: 0, updatedAt: Date.now() };
  state.stats.blocked += 1;
  state.stats.updatedAt = Date.now();
  await saveState(state);
  stateCache = state;

  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  chrome.action.setBadgeText({ text: formatBadge(state.stats.blocked) });
}

export async function bootstrap() {
  await ensureState();
  await ensureRulePresence();

  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  if (stateCache?.stats?.blocked) {
    chrome.action.setBadgeText({ text: formatBadge(stateCache.stats.blocked) });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }

  chrome.alarms.create(AUTO_UPDATE_ALARM, {
    periodInMinutes: (stateCache.autoUpdateHours || 24) * 60,
    when: Date.now() + 5 * 60 * 1000
  });

  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((details) => {
    if (details.rule.ruleId >= FILTER_RULE_START && details.rule.ruleId <= FILTER_RULE_START + FILTER_RULE_MAX) {
      incrementBlockedStat().catch(console.error);
    }
  });
}

export async function getPopupState(tab) {
  const state = stateCache || (await ensureState());
  const hostname = normalizeHost(tab?.url);
  const allowlist = state.allowlist || [];
  const allowed = hostname ? allowlist.includes(hostname) : false;
  return {
    enabled: state.enabled,
    hostname,
    siteAllowed: allowed,
    blocked: state.stats?.blocked || 0,
    compiledRuleCount: state.compiledRuleCount || 0,
    supportLinks: (state.supportLinks || []).slice(0, 3)
  };
}

export async function setEnabled(enabled) {
  const state = stateCache || (await ensureState());
  state.enabled = enabled;
  await saveState(state);
  stateCache = state;
  await ensureDisableRule(!enabled);
  return state;
}

export async function toggleSite(domain) {
  const state = stateCache || (await ensureState());
  const normalized = normalizeHost(domain);
  if (!normalized) return state;
  const allowlist = new Set(state.allowlist || []);
  if (allowlist.has(normalized)) {
    allowlist.delete(normalized);
  } else {
    allowlist.add(normalized);
  }
  state.allowlist = Array.from(allowlist);
  await saveState(state);
  stateCache = state;
  await updateAllowlistRules(state.allowlist);
  return state;
}

export async function addFilterList({ url, title }) {
  const state = stateCache || (await ensureState());
  const id = `remote-${Date.now()}`;
  state.filterLists.push({
    id,
    title: title || url,
    type: 'network',
    source: url,
    builtin: false,
    enabled: true,
    cache: null,
    lastFetched: null
  });
  await saveState(state);
  stateCache = state;
  await rebuildFilters({ forceFetch: true });
  return state;
}

export async function removeFilterList(id) {
  const state = stateCache || (await ensureState());
  state.filterLists = state.filterLists.filter((l) => l.id !== id || l.builtin);
  await saveState(state);
  stateCache = state;
  await rebuildFilters({ forceFetch: false });
  return state;
}

export async function toggleFilterList(id, enabled) {
  const state = stateCache || (await ensureState());
  const target = state.filterLists.find((l) => l.id === id);
  if (!target) {
    return state;
  }
  target.enabled = enabled;
  await saveState(state);
  stateCache = state;
  await rebuildFilters({ forceFetch: false });
  return state;
}

export async function refreshFilters(opts = {}) {
  await rebuildFilters({ forceFetch: opts.forceFetch });
  return stateCache;
}

export async function getOptionsState() {
  const state = stateCache || (await ensureState());
  return {
    enabled: state.enabled,
    heuristicsEnabled: state.heuristicsEnabled,
    sameDomainOnly: state.sameDomainOnly,
    autoUpdateHours: state.autoUpdateHours,
    stats: state.stats,
    compiledRuleCount: state.compiledRuleCount,
    lastFullCompile: state.lastFullCompile,
    filterLists: state.filterLists.map((list) => ({
      id: list.id,
      title: list.title,
      type: list.type,
      source: list.source,
      builtin: list.builtin,
      enabled: list.enabled,
      lastFetched: list.lastFetched,
      cacheTooLarge: list.cacheTooLarge || false,
      size: list.size || (list.cache ? list.cache.length : null)
    })),
    allowlist: state.allowlist,
    supportLinks: state.supportLinks
  };
}

export async function setHeuristicsEnabled(enabled) {
  const state = stateCache || (await ensureState());
  state.heuristicsEnabled = enabled;
  await saveState(state);
  stateCache = state;
  const cosmetic = await getCosmeticCache();
  if (cosmetic) {
    cosmetic.heuristicsEnabled = enabled;
    await saveCosmeticCache(cosmetic);
  }
  return state;
}

export async function setSameDomainOnly(enabled) {
  const state = stateCache || (await ensureState());
  state.sameDomainOnly = !!enabled;
  await saveState(state);
  stateCache = state;
  const cosmetic = await getCosmeticCache();
  if (cosmetic) {
    cosmetic.sameDomainOnly = state.sameDomainOnly;
    await saveCosmeticCache(cosmetic);
  }
  return state;
}

export async function saveSupportLinks(links = []) {
  const state = stateCache || (await ensureState());
  const timestamp = Date.now();
  state.supportLinks = links
    .map((link, index) => sanitizeSupportLink(link, `support-${timestamp}-${index}`))
    .filter(Boolean);
  state.supportAutoconfigChecked = true;
  await saveState(state);
  stateCache = state;
  return state;
}

async function normalizeSupportLinks(state) {
  let dirty = false;
  const beforeLength = state.supportLinks.length;
  state.supportLinks = state.supportLinks
    .map((link) => sanitizeSupportLink(link, link?.id))
    .filter(Boolean);
  if (state.supportLinks.length !== beforeLength) {
    dirty = true;
  }
  if (!state.supportLinks.length && !state.supportAutoconfigChecked) {
    const detected = await autoDetectSupportLinks();
    if (detected.length) {
      state.supportLinks = detected;
    }
    state.supportAutoconfigChecked = true;
    dirty = true;
  }
  return dirty;
}

function sanitizeSupportLink(link, fallbackId) {
  if (!link) return null;
  const label = (link.label || '').trim();
  const url = (link.url || '').trim();
  if (!isValidHttpUrl(url) || DEPRECATED_SUPPORT_URLS.has(url)) {
    return null;
  }
  return {
    id: link.id || fallbackId || `support-${Date.now()}`,
    label: label || 'Support',
    url
  };
}

function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function extractRepoMeta() {
  try {
    const manifest = chrome.runtime.getManifest?.();
    const homepage = manifest?.homepage_url;
    if (!homepage) {
      return null;
    }
    const url = new URL(homepage);
    if (url.hostname !== 'github.com') {
      return null;
    }
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (owner && repo) {
      return { owner, repo };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function normalizeGithubHandle(handle) {
  if (!handle) return null;
  return handle.trim().replace(/^@/, '').replace(/\/.*/, '').toLowerCase();
}

function normalizeCoffeeHandle(handle) {
  if (!handle) return null;
  return handle.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function autoDetectSupportLinks() {
  const meta = extractRepoMeta();
  const owner = meta?.owner;
  const repo = meta?.repo;
  const githubHandles = unique([
    normalizeGithubHandle(owner),
    normalizeGithubHandle(repo),
    ...SUPPORT_AUTOCONFIG_FALLBACKS.github.map(normalizeGithubHandle)
  ]);
  const coffeeHandles = unique([
    normalizeCoffeeHandle(owner),
    normalizeCoffeeHandle(repo),
    ...SUPPORT_AUTOCONFIG_FALLBACKS.buymeacoffee.map(normalizeCoffeeHandle)
  ]);
  const links = [];
  const sponsorLink = await resolveProviderLink('github', githubHandles);
  if (sponsorLink) {
    links.push(sponsorLink);
  }
  const coffeeLink = await resolveProviderLink('buymeacoffee', coffeeHandles);
  if (coffeeLink) {
    links.push(coffeeLink);
  }
  return links;
}

async function resolveProviderLink(providerKey, handles) {
  const provider = SUPPORT_PROVIDERS[providerKey];
  if (!provider) {
    return null;
  }
  for (const handle of handles) {
    if (!handle) continue;
    const url = provider.buildUrl(handle);
    if (await isUrlReachable(url)) {
      return {
        id: provider.id,
        label: provider.label,
        url
      };
    }
  }
  return null;
}

async function isUrlReachable(url) {
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow'
    });
    if (headRes.ok) {
      return true;
    }
    if (headRes.status === 405 || headRes.status === 501) {
      const getRes = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow'
      });
      return getRes.ok;
    }
  } catch (err) {
    console.warn('Support link reachability check failed', url, err);
  }
  return false;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_UPDATE_ALARM) {
    rebuildFilters({ forceFetch: true }).catch(console.error);
  }
});
