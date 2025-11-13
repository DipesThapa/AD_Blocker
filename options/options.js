const refreshBtn = document.getElementById('refresh-button');
const listView = document.getElementById('list-view');
const heuristicsToggle = document.getElementById('heuristics-toggle');
const sameDomainToggle = document.getElementById('same-domain-toggle');
const allowlistEl = document.getElementById('allowlist');
const statusMsg = document.getElementById('status-message');

const summary = {
  status: document.getElementById('summary-status'),
  rules: document.getElementById('summary-rules'),
  blocked: document.getElementById('summary-blocked'),
  updated: document.getElementById('summary-updated')
};

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

function formatTime(timestamp) {
  if (!timestamp) return 'Never';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return 'Unknown';
  }
}

function setStatus(message, isError = false) {
  statusMsg.textContent = message || '';
  statusMsg.style.color = isError ? '#c62828' : '#5f6368';
}

function renderSummary(state) {
  summary.status.textContent = state.enabled ? 'Active' : 'Paused';
  summary.rules.textContent = (state.compiledRuleCount || 0).toLocaleString();
  summary.blocked.textContent = (state.stats?.blocked || 0).toLocaleString();
  summary.updated.textContent = formatTime(state.lastFullCompile);
  heuristicsToggle.checked = Boolean(state.heuristicsEnabled);
  sameDomainToggle.checked = Boolean(state.sameDomainOnly);
}

function renderLists(lists) {
  listView.innerHTML = '';
  if (!lists?.length) {
    listView.innerHTML = '<li>No filter lists configured.</li>';
    return;
  }

  for (const list of lists) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = list.title || list.source;
    if (list.builtin) {
      const badge = document.createElement('span');
      badge.textContent = 'built-in';
      badge.style.cssText = 'margin-left:8px;font-size:0.75rem;color:#1565c0;';
      title.appendChild(badge);
    }
    const desc = document.createElement('p');
    desc.textContent = list.source;
    const meta = document.createElement('small');
    meta.textContent = `Last fetched: ${formatTime(list.lastFetched)}${list.cacheTooLarge ? ' • not cached' : ''}`;
    info.appendChild(title);
    info.appendChild(desc);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'list-actions';

    const toggleWrapper = document.createElement('label');
    toggleWrapper.className = 'switch';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = list.enabled;
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await sendMessage('OPTIONS_TOGGLE_LIST', { id: list.id, enabled: toggle.checked });
        await loadState();
        setStatus(`List "${list.title}" ${toggle.checked ? 'enabled' : 'disabled'}.`);
      } catch (err) {
        toggle.checked = !toggle.checked;
        setStatus(err.message, true);
      } finally {
        toggle.disabled = false;
      }
    });
    const slider = document.createElement('span');
    slider.className = 'slider';
    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(slider);
    actions.appendChild(toggleWrapper);

    if (!list.builtin) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.className = 'danger';
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        try {
          await sendMessage('OPTIONS_REMOVE_LIST', { id: list.id });
          await loadState();
          setStatus(`Removed list "${list.title}".`);
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          removeBtn.disabled = false;
        }
      });
      actions.appendChild(removeBtn);
    }

    li.appendChild(info);
    li.appendChild(actions);
    listView.appendChild(li);
  }
}

function renderAllowlist(domains) {
  allowlistEl.innerHTML = '';
  if (!domains?.length) {
    allowlistEl.innerHTML = '<li>No sites are allowlisted.</li>';
    return;
  }
  for (const domain of domains) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = domain;
    const button = document.createElement('button');
    button.textContent = 'Remove';
    button.className = 'danger';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await sendMessage('POPUP_TOGGLE_SITE', { hostname: domain });
        await loadState();
        setStatus(`Removed ${domain} from allowlist.`);
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
    li.appendChild(span);
    li.appendChild(button);
    allowlistEl.appendChild(li);
  }
}

async function loadState() {
  try {
    const state = await sendMessage('OPTIONS_STATE');
    renderSummary(state);
    renderLists(state.filterLists);
    renderAllowlist(state.allowlist);
  } catch (err) {
    setStatus(err.message, true);
  }
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  setStatus('Refreshing filter lists…');
  try {
    await sendMessage('OPTIONS_REFRESH', { force: true });
    await loadState();
    setStatus('Filter lists updated.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    refreshBtn.disabled = false;
  }
});

heuristicsToggle.addEventListener('change', async (event) => {
  heuristicsToggle.disabled = true;
  try {
    await sendMessage('OPTIONS_SET_HEURISTICS', { enabled: event.target.checked });
    setStatus(`Heuristic hiding ${event.target.checked ? 'enabled' : 'disabled'}.`);
  } catch (err) {
    setStatus(err.message, true);
    event.target.checked = !event.target.checked;
  } finally {
    heuristicsToggle.disabled = false;
  }
});

sameDomainToggle.addEventListener('change', async (event) => {
  sameDomainToggle.disabled = true;
  try {
    await sendMessage('OPTIONS_SET_SAME_DOMAIN', { enabled: event.target.checked });
    setStatus(`Same-domain popup guard ${event.target.checked ? 'enabled' : 'disabled'}.`);
  } catch (err) {
    setStatus(err.message, true);
    event.target.checked = !event.target.checked;
  } finally {
    sameDomainToggle.disabled = false;
  }
});

loadState();
