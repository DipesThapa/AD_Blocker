(() => {
  const script = document.currentScript;

  const normalize = (host) => (host || '').replace(/^www\./i, '').toLowerCase();
  const siteHost = normalize(script?.dataset?.siteHost || location.hostname);
  const matchesSite = (host) => host === siteHost || host.endsWith(`.${siteHost}`);
  const gestureWindowMs = Number(script?.dataset?.gestureWindowMs || 1500);
  let sameDomainOnly = script?.dataset?.sameDomainOnly === 'true';
  let guardDisabled = script?.dataset?.disabled === 'true';
  const trustedHosts = new Set(
    (script?.dataset?.trustedHosts || 'googleadservices.com')
      .split(',')
      .map((host) => normalize(host.trim()))
      .filter(Boolean)
  );
  const trustedHostArray = Array.from(trustedHosts);
  const trustedHostPatterns = trustedHostArray.map(
    (host) => new RegExp(`(^|\\.)${escapeRegex(host)}$`, 'i')
  );
  const trustedUrlPatterns = trustedHostArray.map(
    (host) => new RegExp(escapeRegex(host), 'i')
  );

  if (window.__AEGIS_POPUP_GUARD__) {
    window.__AEGIS_POPUP_GUARD__.updateConfig({
      sameDomainOnly,
      disabled: guardDisabled
    });
    return;
  }

  let lastGestureHost = siteHost;
  let lastGestureAt = 0;

  const setGestureHost = (host) => {
    lastGestureHost = host || siteHost;
    lastGestureAt = Date.now();
  };

  const updateFromAnchor = (anchor) => {
    try {
      const url = new URL(anchor.href, location.href);
      setGestureHost(normalize(url.hostname));
    } catch {
      setGestureHost(siteHost);
    }
  };

  const baseHandler = (event) => {
    const anchor = event.target.closest && event.target.closest('a[href]');
    if (anchor) {
      updateFromAnchor(anchor);
      return;
    }
    setGestureHost(siteHost);
  };

  ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown'].forEach((type) => {
    document.addEventListener(type, baseHandler, true);
  });

  const isTrustedHost = (host) => Boolean(host) && trustedHostPatterns.some((re) => re.test(host));

  const isTrustedValue = (value) => {
    if (!value) return false;
    const str = String(value);
    return trustedUrlPatterns.some((re) => re.test(str));
  };

  const isSafePseudoUrl = (value) => {
    if (!value) return false;
    const trimmed = String(value).trim().toLowerCase();
    return /^javascript:\s*(void\(0\)|void\(0\);?|;)?\s*$/.test(trimmed);
  };

  const shouldAllow = (url) => {
    if (guardDisabled) {
      return true;
    }
    if (!url || url === 'about:blank') {
      return false;
    }
    if (isSafePseudoUrl(url)) {
      return true;
    }
    let host = siteHost;
    try {
      host = normalize(new URL(url, location.href).hostname);
    } catch {
      // ignore
    }
    if (isTrustedHost(host) || isTrustedValue(url)) {
      return true;
    }
    if (sameDomainOnly) {
      return matchesSite(host);
    }
    const withinGesture = Date.now() - lastGestureAt <= gestureWindowMs;
    if (!withinGesture) {
      return matchesSite(host);
    }
    return host === lastGestureHost;
  };

  const nativeOpen = window.open.bind(window);
  const guardedOpen = function (...args) {
    const url = args[0];
    if (guardDisabled || isTrustedValue(url) || isSafePseudoUrl(url)) {
      return nativeOpen.apply(window, args);
    }
    if (!shouldAllow(url)) {
      console.warn('[AdBlock Ultra] blocked popup', url);
      return null;
    }
    return nativeOpen.apply(window, args);
  };

  Object.defineProperty(window, 'open', {
    configurable: false,
    enumerable: true,
    get() {
      return guardedOpen;
    },
    set() {},
  });

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (guardDisabled || isTrustedValue(this.href) || isSafePseudoUrl(this.href)) {
      return originalAnchorClick.apply(this, args);
    }
    try {
      const host = normalize(new URL(this.href, location.href).hostname);
      if (isTrustedHost(host) || isTrustedValue(this.href)) {
        return originalAnchorClick.apply(this, args);
      }
      if (matchesSite(host)) {
        return originalAnchorClick.apply(this, args);
      }
    } catch (err) {
      // fall through to shouldAllow
    }
    if (!shouldAllow(this.href)) {
      console.warn('[AdBlock Ultra] blocked anchor click', this.href);
      return;
    }
    return originalAnchorClick.apply(this, args);
  };

  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (
      this instanceof HTMLAnchorElement &&
      typeof name === 'string' &&
      name.toLowerCase() === 'href' &&
      !guardDisabled &&
      !isSafePseudoUrl(value) &&
      !isTrustedValue(value) &&
      !isTrustedHost(normalizeSafeHost(value)) &&
      !matchesSite(normalizeSafeHost(value)) &&
      !shouldAllow(value)
    ) {
      console.warn('[AdBlock Ultra] blocked href assignment attempt', value);
      return;
    }
    return originalSetAttribute.call(this, name, value);
  };

  function normalizeSafeHost(value) {
    try {
      return normalize(new URL(value, location.href).hostname);
    } catch (err) {
      return '';
    }
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  window.__AEGIS_POPUP_GUARD__ = {
    sameDomainOnly,
    disabled: guardDisabled,
    updateConfig(config = {}) {
      if (typeof config.sameDomainOnly === 'boolean') {
        sameDomainOnly = config.sameDomainOnly;
        this.sameDomainOnly = sameDomainOnly;
      }
      if (typeof config.disabled === 'boolean') {
        guardDisabled = config.disabled;
        this.disabled = guardDisabled;
      }
    }
  };
})();
