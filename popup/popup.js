const globalToggle = document.getElementById('global-toggle');
const statusText = document.getElementById('extension-status');
const hostLabel = document.getElementById('host-label');
const blockedValue = document.getElementById('blocked-count');
const ruleValue = document.getElementById('rule-count');
const siteToggleBtn = document.getElementById('site-toggle');
const optionsBtn = document.getElementById('options-button');
const messageEl = document.getElementById('message');
const supportButtons = document.getElementById('support-buttons');
const supportSection = document.getElementById('support-section');

let activeTab = null;
let snapshot = null;

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]);
    });
  });
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.message || 'Unexpected error'));
        return;
      }
      resolve(response.result);
    });
  });
}

function setMessage(text, isError = false) {
  messageEl.textContent = text || '';
  messageEl.style.color = isError ? '#c62828' : '#5f6368';
}

function renderState(state) {
  snapshot = state;
  const enabled = Boolean(state.enabled);
  globalToggle.checked = enabled;
  statusText.textContent = enabled ? 'Protection active' : 'Protection paused';
  hostLabel.textContent = state.hostname ? `on ${state.hostname}` : 'All sites';
  blockedValue.textContent = (state.blocked || 0).toLocaleString();
  ruleValue.textContent = (state.compiledRuleCount || 0).toLocaleString();
  siteToggleBtn.disabled = !state.hostname;
  siteToggleBtn.textContent = state.siteAllowed ? 'Resume on this site' : 'Pause on this site';
  renderSupport(state.supportLinks || []);
}

function renderSupport(links) {
  if (!supportButtons || !supportSection) return;
  supportButtons.innerHTML = '';
  if (!links.length) {
    supportSection.style.display = 'none';
    return;
  }
  supportSection.style.display = 'block';
  for (const link of links) {
    if (!link?.url) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = link.label || 'Support';
    button.addEventListener('click', () => {
      chrome.tabs.create({ url: link.url, active: true });
    });
    supportButtons.appendChild(button);
  }
}

async function refreshState() {
  activeTab = await queryActiveTab();
  const state = await sendMessage('POPUP_STATE', { tabId: activeTab?.id });
  renderState(state);
}

async function handleGlobalToggle(event) {
  const enabled = event.target.checked;
  try {
    await sendMessage('POPUP_TOGGLE_ENABLED', { enabled });
    await refreshState();
    setMessage(enabled ? 'Blocking resumed' : 'Blocking paused');
  } catch (err) {
    setMessage(err.message, true);
    event.target.checked = !enabled;
  }
}

async function handleSiteToggle() {
  if (!snapshot?.hostname) return;
  siteToggleBtn.disabled = true;
  try {
    await sendMessage('POPUP_TOGGLE_SITE', { hostname: snapshot.hostname });
    await refreshState();
    setMessage(snapshot.siteAllowed ? 'Site paused' : 'Site resumed');
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    siteToggleBtn.disabled = false;
  }
}

async function init() {
  try {
    await refreshState();
  } catch (err) {
    setMessage(err.message, true);
  }

  globalToggle.addEventListener('change', handleGlobalToggle);
  siteToggleBtn.addEventListener('click', handleSiteToggle);
  optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

document.addEventListener('DOMContentLoaded', init);
