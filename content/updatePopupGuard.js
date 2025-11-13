(() => {
  const script = document.currentScript;
  const sameDomainOnly = script?.dataset?.sameDomainOnly === 'true';
  if (window.__AEGIS_POPUP_GUARD__) {
    window.__AEGIS_POPUP_GUARD__.updateConfig({ sameDomainOnly });
  }
})();
