# AdBlock Ultra

> Repository: `AD_Blocker`

AdBlock Ultra is a Manifest V3 browser extension that fuses dynamic network rules with cosmetic and heuristic filtering to aggressively block ads, trackers, and sponsored widgets on every site.

## Highlights

- **Dynamic blocking (MV3-safe):** Converts EasyList-style syntax into `declarativeNetRequest` rules and manages them automatically.
- **Cosmetic filtering:** Ships with curated selectors and keeps them synced in `chrome.storage` for instant use by the content script.
- **Heuristic cleaner:** Detects suspicious DOM containers (classes such as `ad`/`sponsor`) and hides them when lists miss something.
- **YouTube ad skipper:** Detects video/overlay ads on youtube.com, clicks skip buttons instantly, and fast-forwards muted pre-rolls.
- **Per-site allowlist & global pause:** Quickly disable blocking everywhere or on the current domain without losing compiled rules.
- **Extensible filter lists:** Add/remove remote text lists from the dashboard; built-in lists cover top ad/analytics domains.
- **Support-friendly:** Built-in donor links so users can sponsor ongoing development without invasive ads or trackers.

## Project layout

```
manifest.json
background/
  background.js        - entry service worker (module) wiring
  filterManager.js     - state, filter hydration, DNR orchestration
  ruleCompiler.js      - ABP syntax parser + DNR rule builder
  storage.js           - chrome.storage helpers
content/
  contentScript.js     - cosmetic + heuristic DOM hider
filters/
  default_*.txt        - bundled network/cosmetic filter seeds
options/
  options.html|css|js  - management dashboard
popup/
  popup.html|css|js    - quick controls
assets/
  icon*.png            - extension icons
```

## Running the extension

1. Build step is not required; the extension is pure JS/CSS/HTML.
2. In Chrome/Edge: open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository folder.
3. Pin “AdBlock Ultra” and open the popup to confirm status and per-site controls.
4. Use the Options page (link in popup or `chrome://extensions` → Details → Extension options) to add remote lists, trigger updates, or manage the allowlist.

## Filter list management

- Built-in lists (`filters/default_*`) load immediately on install. You can edit or extend them as needed.
- Add remote lists by pasting their URL (HTTPS) in the dashboard. The service worker caches payloads smaller than ~900 KB; larger lists are compiled on demand without caching to respect storage quotas.
- A background alarm refreshes all lists every 24 hours by default. Trigger **Update filters** anytime from the dashboard to force a fetch/compile.

## Development tips

- Dynamic rules live entirely in Chrome’s DNR store. When you change lists or heuristics, click “Update filters” to rebuild rules (or reload the extension to let the service worker do it automatically).
- Watch the console (chrome://extensions → Inspect views → Service worker) for diagnostics such as skipped rules or fetch failures.
- The content script listens to `chrome.storage` changes, so editing `filters/default_cosmetic.txt` and reloading the extension immediately updates cosmetic coverage.

## Testing checklist

1. Load the extension and visit ad-heavy sites (news, blogs). Ads should disappear and the popup counter should increment.
2. Toggle **Pause on this site** from the popup and reload: ads should return only on that domain.
3. Add a dummy remote list (e.g., a gist with `||example.com^`) and verify that requests to that domain are blocked (network tab → blocked by extension).
4. Disable heuristics in the Options page; elements without list coverage should remain, then re-enable to ensure heuristic hiding resumes (watch DOM for elements gaining `data-aegis-hidden`).
5. On Chrome, inspect `chrome://net-export` or DevTools → Network filter `blocked: aegi` to ensure DNR rules execute as expected.

## Limitations / next steps

- MV3 imposes a 300 k dynamic-rule cap; extremely large custom lists may be truncated. Add only the lists you need.
- Regex-heavy ABP syntax is partially supported. Unsupported tokens (`redirect`, `scriptlet`, etc.) are skipped.
- Storage caching is skipped for lists > ~900 KB to avoid quota errors, so those lists re-download on each forced rebuild.

Contributions welcome—extend the parser, add stats per tab, or ship preset list bundles.
## Supporting development

Open the Options page and scroll to **Support AdBlock Ultra** to configure donation or sponsorship links (GitHub Sponsors, Buy Me a Coffee, etc.). On first run the background worker inspects the extension’s GitHub `homepage_url` and only seeds links that respond successfully (it tries the repo owner first, then the AdBlock Ultra handles and the Buy Me a Coffee profile `hackmedipeo`); otherwise the list stays empty until you add your own URLs. Those links also surface in the popup so grateful users can chip in. No telemetry or data sharing is involved—just opt-in support.
