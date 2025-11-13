const RESOURCE_TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  font: 'font',
  media: 'media',
  subdocument: 'sub_frame',
  document: 'main_frame',
  object: 'object',
  ping: 'ping',
  websocket: 'websocket',
  csp_report: 'csp_report',
  other: 'other'
};

const STOP_WORDS = new Set(['badfilter', 'rewrite', 'redirect', 'popup', 'important', 'permissions']);

function sanitizeSelector(selector) {
  return selector
    .replace(/[<>]/g, '')
    .trim();
}

function normalizeDomains(rawDomains) {
  return rawDomains
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => domain.toLowerCase());
}

function parseOptionString(optionString) {
  const data = {
    resourceTypes: [],
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    requestDomains: [],
    excludedRequestDomains: [],
    domainType: null,
    matchCase: false
  };

  if (!optionString) {
    return data;
  }

  const tokens = optionString.split(',');
  for (const tokenRaw of tokens) {
    const token = tokenRaw.trim();
    if (!token) continue;

    if (token === 'third-party') {
      data.domainType = 'thirdParty';
      continue;
    }
    if (token === '~third-party') {
      data.domainType = 'firstParty';
      continue;
    }
    if (token === 'match-case') {
      data.matchCase = true;
      continue;
    }
    if (token.startsWith('domain=')) {
      const value = token.slice('domain='.length);
      const pieces = value.split('|');
      for (const piece of pieces) {
        const domain = piece.trim();
        if (!domain) continue;
        if (domain.startsWith('~')) {
          data.excludedInitiatorDomains.push(domain.slice(1));
        } else {
          data.initiatorDomains.push(domain);
        }
      }
      continue;
    }
    if (token.startsWith('from-domain=')) {
      const value = token.slice('from-domain='.length);
      const pieces = value.split('|');
      for (const piece of pieces) {
        const domain = piece.trim();
        if (!domain) continue;
        if (domain.startsWith('~')) {
          data.excludedInitiatorDomains.push(domain.slice(1));
        } else {
          data.initiatorDomains.push(domain);
        }
      }
      continue;
    }
    if (token.startsWith('to-domain=')) {
      const value = token.slice('to-domain='.length);
      const pieces = value.split('|');
      for (const piece of pieces) {
        const domain = piece.trim();
        if (!domain) continue;
        if (domain.startsWith('~')) {
          data.excludedRequestDomains.push(domain.slice(1));
        } else {
          data.requestDomains.push(domain);
        }
      }
      continue;
    }

    const normalizedToken = token.replace('-', '_');
    if (RESOURCE_TYPE_MAP[normalizedToken]) {
      data.resourceTypes.push(RESOURCE_TYPE_MAP[normalizedToken]);
      continue;
    }

    if (!STOP_WORDS.has(normalizedToken)) {
      data[normalizedToken] = true;
    }
  }

  data.initiatorDomains = normalizeDomains(data.initiatorDomains);
  data.excludedInitiatorDomains = normalizeDomains(data.excludedInitiatorDomains);
  data.requestDomains = normalizeDomains(data.requestDomains);
  data.excludedRequestDomains = normalizeDomains(data.excludedRequestDomains);

  return data;
}

export function parseFilterText(text) {
  const network = [];
  const cosmetics = {
    global: new Set(),
    perDomain: new Map()
  };
  const diagnostics = {
    skipped: 0
  };

  if (!text) {
    return { network, cosmetics, diagnostics };
  }

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('!')) {
      continue;
    }

    if (line.includes('#@#')) {
      // Cosmetic exception, ignore for now.
      continue;
    }

    if (/#[$@%]/.test(line)) {
      // Scriptlet or advanced cosmetic directive not supported yet.
      continue;
    }

    if (line.includes('##')) {
      line = line.replace(/#{3,}/, '##');
      const [domainPart, selectorPart] = line.split('##');
      const selector = sanitizeSelector(selectorPart || '');
      if (!selector) {
        continue;
      }

      if (!domainPart) {
        cosmetics.global.add(selector);
        continue;
      }

      const domains = domainPart.split(',').map((d) => d.trim()).filter(Boolean);
      if (!domains.length) {
        cosmetics.global.add(selector);
        continue;
      }

      for (const domain of domains) {
        const normalized = domain.toLowerCase();
        if (!cosmetics.perDomain.has(normalized)) {
          cosmetics.perDomain.set(normalized, new Set());
        }
        cosmetics.perDomain.get(normalized).add(selector);
      }
      continue;
    }

    if (line.startsWith('@@||') && line.endsWith('$badfilter')) {
      continue;
    }

    if (line.endsWith('$badfilter')) {
      continue;
    }

    let exception = false;
    if (line.startsWith('@@')) {
      exception = true;
      line = line.slice(2);
    }

    if (!line) {
      continue;
    }

    let optionString = null;
    if (line.includes('$')) {
      const parts = line.split('$');
      line = parts.shift();
      optionString = parts.join('$');
    }

    const pattern = line.trim();
    if (!pattern) {
      continue;
    }

    network.push({
      pattern,
      exception,
      options: parseOptionString(optionString),
      raw: rawLine
    });
  }

  return { network, cosmetics, diagnostics };
}

export function compileNetworkRules(entries, { startId = 1, maxRules = 200000 } = {}) {
  const rules = [];
  const errors = [];
  let id = startId;

  for (const entry of entries) {
    if (!entry.pattern) {
      continue;
    }
    if (id > startId + maxRules) {
      errors.push({ type: 'limit', entry });
      break;
    }

    const condition = {};
    if (entry.pattern.startsWith('/') && entry.pattern.endsWith('/')) {
      const body = entry.pattern.slice(1, -1);
      if (!body) {
        continue;
      }
      if (body.length > 200) {
        errors.push({ type: 'regex-too-long', entry });
        continue;
      }
      condition.regexFilter = body;
    } else {
      condition.urlFilter = entry.pattern;
    }

    if (entry.options.resourceTypes?.length) {
      condition.resourceTypes = [...new Set(entry.options.resourceTypes)];
    }
    if (entry.options.initiatorDomains?.length) {
      condition.initiatorDomains = entry.options.initiatorDomains;
    }
    if (entry.options.excludedInitiatorDomains?.length) {
      condition.excludedInitiatorDomains = entry.options.excludedInitiatorDomains;
    }
    if (entry.options.requestDomains?.length) {
      condition.domains = entry.options.requestDomains;
    }
    if (entry.options.excludedRequestDomains?.length) {
      condition.excludedDomains = entry.options.excludedRequestDomains;
    }
    if (entry.options.domainType) {
      condition.domainType = entry.options.domainType;
    }
    if (entry.options.matchCase && condition.urlFilter) {
      condition.isUrlFilterCaseSensitive = true;
    }

    const rule = {
      id,
      priority: entry.exception ? 20000 : 1,
      action: {
        type: entry.exception ? 'allow' : 'block'
      },
      condition
    };

    rules.push(rule);
    id += 1;
  }

  return { rules, nextId: id, errors };
}

export function mergeCosmeticCollections(target, source) {
  for (const selector of source.global) {
    target.global.add(selector);
  }
  for (const [domain, selectors] of source.perDomain.entries()) {
    if (!target.perDomain.has(domain)) {
      target.perDomain.set(domain, new Set());
    }
    for (const selector of selectors) {
      target.perDomain.get(domain).add(selector);
    }
  }
}

export function buildAllowlistRules(hosts, { startId, maxRules }) {
  const rules = [];
  let id = startId;

  for (const host of hosts) {
    if (!host) continue;
    if (id > startId + maxRules) break;

    rules.push({
      id,
      priority: 100000,
      action: { type: 'allow' },
      condition: {
        regexFilter: '.*',
        initiatorDomains: [host]
      }
    });
    id += 1;
  }

  return rules;
}
