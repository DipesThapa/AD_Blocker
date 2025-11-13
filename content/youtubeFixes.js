(() => {
  const host = location.hostname;
  if (!/youtube\.com$/i.test(host)) {
    return;
  }

  const ensureMastheadVisible = () => {
    const selectors = [
      '#masthead-container',
      '#masthead',
      'ytd-masthead',
      '#center',
      'ytd-searchbox',
      'form#search-form',
      '#player',
      'ytd-player',
      '#movie_player',
      '.html5-video-player'
    ];
    selectors.forEach((sel) => {
      const node = document.querySelector(sel);
      if (!node) return;
      node.style.removeProperty('display');
      node.style.removeProperty('visibility');
      node.style.setProperty('opacity', '1', 'important');
      node.hidden = false;
    });
  };

  ensureMastheadVisible();
  const observer = new MutationObserver(() => ensureMastheadVisible());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', ensureMastheadVisible, true);
})();
