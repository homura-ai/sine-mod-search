// Sine Mod Search — runs in each Sine settings document.
(() => {
  "use strict";
  if (!/^about:(preferences|settings)(?:[?#]|$)/.test(window.location.href)) return;
  const key = "__sineModSearch";
  window[key]?.destroy();
  const document = window.document;
  const hiddenAttribute = "data-sine-search-hidden";
  const highlightName = "sine-mod-search";
  const normalize = value => String(value ?? "").normalize("NFKD")
    .replace(/\p{M}/gu, "").toLowerCase().replace(/[*~]/g, "");
  // Only declared settings text; never read users' current preference values.
  function preferenceText(value) {
    if (Array.isArray(value)) return value.map(preferenceText).join(" ");
    if (!value || typeof value !== "object") return "";
    return Object.entries(value).map(([name, item]) => {
      if (["label", "description", "placeholder", "property", "preference", "value"].includes(name)
          && ["string", "number"].includes(typeof item)) return String(item);
      return item && typeof item === "object" ? preferenceText(item) : "";
    }).join(" ");
  }

  let destroyed = false;
  let timer;
  let revision = 0;
  let list;
  let bar;
  let input;
  let status;
  let style;
  let index = new Map();
  let loading = false;
  let failed = false;
  const listeners = [];
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }
  function element(tag, attributes = {}) {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }
  // Ranges for each query word in a card's text, including its settings dialog.
  // A highlight registry paints them without changing Sine's elements.
  function matchRanges(card, words) {
    const ranges = [];
    const walker = document.createTreeWalker(card, window.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.data;
      let text = "";
      const starts = [];
      const ends = [];
      for (let i = 0; i < value.length;) {
        const char = String.fromCodePoint(value.codePointAt(i));
        const part = normalize(char);
        text += part;
        // One entry per UTF-16 unit, matching indexOf offsets.
        for (let unit = 0; unit < part.length; unit++) {
          starts.push(i);
          ends.push(i + char.length);
        }
        i += char.length;
      }
      for (const word of words) {
        for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
          const range = document.createRange();
          range.setStart(node, starts[at]);
          range.setEnd(node, ends[at + word.length - 1]);
          ranges.push(range);
        }
      }
    }
    return ranges;
  }
  function highlight(ranges) {
    const registry = window.CSS?.highlights;
    if (!registry || typeof window.Highlight !== "function") return;
    if (ranges.length) registry.set(highlightName, new window.Highlight(...ranges));
    else registry.delete(highlightName);
  }
  function apply() {
    if (destroyed || !list || !input) return;
    const words = normalize(input.value).trim().split(/\s+/).filter(Boolean);
    const cards = [...list.children].filter(card => card.matches(".sineItem[mod-id]"));
    let matches = 0;
    const ranges = [];
    for (const card of cards) {
      const text = normalize(`${index.get(card.getAttribute("mod-id")) ?? ""} ${card.textContent}`);
      const matched = words.every(word => text.includes(word));
      card.toggleAttribute(hiddenAttribute, !matched);
      if (matched) matches++;
      if (matched && words.length) ranges.push(...matchRanges(card, words));
    }
    highlight(ranges);
    const message = loading ? "Indexing settings…" :
      words.length ? (matches ? `${matches} of ${cards.length} mods match` : "No matching mods") :
      `${cards.length} installed ${cards.length === 1 ? "mod" : "mods"}`;
    const text = message + (failed ? " — Some settings could not be indexed." : "");
    if (status.textContent !== text) status.textContent = text;
  }
  async function refresh() {
    const current = ++revision;
    loading = true;
    apply();
    const next = new Map();
    let hadError = false;
    try {
      const utils = ChromeUtils.importESModule("chrome://userscripts/content/core/utils.sys.mjs").default;
      const mods = await utils.getMods();
      await Promise.all(Object.entries(mods).map(async ([id, mod]) => {
        let prefs = "";
        if (mod.preferences) {
          try {
            // Read directly: Sine's helper displays a toast on malformed JSON.
            const data = await IOUtils.readJSON(PathUtils.join(utils.getModFolder(id), ...mod.preferences.split("/")));
            prefs = preferenceText(data);
          } catch (error) {
            hadError = true;
            console.warn(`[Sine Mod Search] Could not index settings for ${id}`, error);
          }
        }
        next.set(id, `${mod.name ?? ""} ${mod.description ?? ""} ${id} ${prefs}`);
      }));
    } catch (error) {
      hadError = true;
      console.warn("[Sine Mod Search] Could not read installed mods", error);
    }
    if (destroyed || current !== revision) return;
    index = next;
    loading = false;
    failed = hadError;
    apply();
  }
  function scheduleRefresh() {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 100);
  }
  function mount() {
    const candidate = document.getElementById("sineModsList");
    if (!candidate || (candidate === list && bar?.isConnected)) return;
    if (list) for (const card of list.children) card.removeAttribute(hiddenAttribute);
    bar?.remove();
    const previousQuery = input?.value ?? "";
    list = candidate;
    bar = element("div", { id: "sine-mod-search", role: "search", "aria-label": "Installed mods" });
    const label = element("label", { for: "sine-mod-search-input" });
    label.textContent = "Search installed mods";
    input = element("input", {
      id: "sine-mod-search-input", type: "search", placeholder: "Mod names and settings…",
      "aria-describedby": "sine-mod-search-status", autocomplete: "off"
    });
    input.value = previousQuery;
    status = element("div", { id: "sine-mod-search-status", role: "status", "aria-live": "polite" });
    listen(input, "input", apply);
    listen(input, "keydown", event => {
      if (event.key === "Escape" && input.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        apply();
      }
    });
    bar.append(label, input, status);
    list.before(bar);
    scheduleRefresh();
  }
  const observer = new window.MutationObserver(records => {
    mount();
    // Reindex only when Sine rebuilds the cards, not when our status changes.
    if (records.some(record => record.target === list)) scheduleRefresh();
    if (records.some(record => list?.contains(record.target))) apply();
  });
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    revision++;
    window.clearTimeout(timer);
    observer.disconnect();
    for (const remove of listeners) remove();
    if (list) for (const card of list.children) card.removeAttribute(hiddenAttribute);
    bar?.remove();
    style?.remove();
    highlight([]);
    if (window[key]?.destroy === destroy) delete window[key];
  }
  style = element("style");
  style.textContent = `
    #sine-mod-search { display: flex; flex-direction: column; gap: 6px; margin: 12px 0 16px; }
    #sine-mod-search label { font-weight: 600; }
    #sine-mod-search input { box-sizing: border-box; width: 100%; margin: 0; font: inherit; }
    #sine-mod-search-status { font-size: 0.9em; opacity: 0.75; }
    #sineModsList > [${hiddenAttribute}] { display: none !important; }
    ::highlight(${highlightName}) { background-color: Mark; color: MarkText; }
  `;
  document.documentElement.append(style);
  window[key] = { destroy };
  listen(window, "unload", destroy);
  listen(window, "focus", scheduleRefresh);
  window.addUnloadListener?.(destroy);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  mount();
})();
