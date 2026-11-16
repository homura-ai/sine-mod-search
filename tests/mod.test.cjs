const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../sine-mod-search.uc.js"), "utf8");
const pause = () => new Promise(resolve => setTimeout(resolve, 160));

function setup(t, { late = false, broken = false, deferred = false } = {}) {
  const dom = new JSDOM("<html><body></body></html>", {
    url: "about:preferences#paneSineMods", runScripts: "outside-only"
  });
  const w = dom.window;
  t.after(() => w.close());
  const mods = {
    alpha: { name: "Café Tabs", description: "Tab layout", preferences: "preferences.json", enabled: true,
      dialog: "🎨 Accent colour for café tabs" },
    beta: { name: "Sidebar", preferences: "config/preferences.json", enabled: false },
    gamma: { name: "Plain Mod" }
  };
  let finish;
  w.ChromeUtils = { importESModule: () => ({ default: {
    getMods: () => deferred ? new Promise(resolve => { finish = () => resolve(mods); }) : Promise.resolve(mods),
    getModFolder: id => `/mods/${id}`
  } }) };
  w.PathUtils = { join: (...parts) => parts.join("/") };
  w.IOUtils = { readJSON: async file => {
    if (broken && file.includes("beta")) throw Error("bad JSON");
    return file.includes("alpha") ? [{ label: "**Accent** colour", property: "uc.tabs.accent" }] :
      [{ label: "Position", property: "uc.sidebar.position", options: [{ label: "Bottom edge", value: "bottom" }] }];
  } };
  w.console.warn = () => {};
  w.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
  w.CSS = { highlights: new Map() };
  let unload;
  w.addUnloadListener = callback => { unload = callback; };
  function render() {
    let list = w.document.getElementById("sineModsList");
    if (!list) {
      list = w.document.createElement("div");
      list.id = "sineModsList";
      w.document.body.append(list);
    }
    list.innerHTML = Object.entries(mods).map(([id, mod]) =>
      `<div class="sineItem" mod-id="${id}"><h3>${mod.name}</h3><button>Configure</button>` +
      (mod.dialog ? `<dialog class="sineItemPreferenceDialog"><div class="sineItemPreferenceDialogContent">` +
        `<label class="sineItemPreferenceLabel">${mod.dialog}</label></div></dialog>` : "") + `</div>`).join("");
    return list;
  }
  if (!late) render();
  w.eval(source);
  const query = value => {
    const input = w.document.getElementById("sine-mod-search-input");
    input.value = value;
    input.dispatchEvent(new w.Event("input"));
  };
  const visible = () => [...w.document.querySelectorAll(".sineItem:not([data-sine-search-hidden])")]
    .map(card => card.getAttribute("mod-id"));
  const highlighted = () => [...(w.CSS.highlights.get("sine-mod-search")?.ranges ?? [])]
    .map(range => `${range.startContainer.parentElement.tagName.toLowerCase()}:${range.toString()}`);
  return { w, query, visible, highlighted, render, mods, unload: () => unload(), finish: () => finish() };
}

test("finds names, formatted settings, preference keys and disabled-mod dropdown options", async t => {
  const s = setup(t);
  await pause();
  for (const [query, expected] of [
    ["CAFE", ["alpha"]], ["accent", ["alpha"]], ["uc.tabs.accent", ["alpha"]],
    ["bottom edge", ["beta"]], ["sidebar position", ["beta"]], ["missing", []], ["  ", ["alpha", "beta", "gamma"]]
  ]) {
    s.query(query);
    assert.deepEqual(s.visible(), expected, query);
  }
});

test("highlights matched words in visible cards and their settings dialogs", async t => {
  const s = setup(t);
  await pause();
  s.query("CAFE accent");
  assert.deepEqual(s.highlighted(), ["h3:Café", "label:café", "label:Accent"]);
  s.query("tabs");
  assert.deepEqual(s.highlighted(), ["h3:Tabs", "label:tabs"]);
  s.query("bottom");
  assert.deepEqual(s.highlighted(), [], "a settings-only match in a closed, unloaded dialog has no text to mark");
  s.query("");
  assert.equal(s.w.CSS.highlights.has("sine-mod-search"), false);
  s.query("cafe");
  s.unload();
  assert.equal(s.w.CSS.highlights.has("sine-mod-search"), false);
});

test("Escape clears and no-match status is accessible", async t => {
  const s = setup(t);
  await pause();
  s.query("nothing matches");
  assert.equal(s.w.document.querySelector('[role="status"]').textContent, "No matching mods");
  s.w.document.querySelector("input").dispatchEvent(new s.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(s.visible().length, 3);
});

test("mounts after Sine and preserves query across card rebuilds", async t => {
  const s = setup(t, { late: true });
  assert.equal(s.w.document.querySelector("input"), null);
  s.render();
  await pause();
  s.query("bottom");
  s.mods.gamma = { name: "Bottom bar" };
  s.render();
  await pause();
  assert.deepEqual(s.visible(), ["beta", "gamma"]);
  assert.equal(s.w.document.querySelectorAll("#sine-mod-search").length, 1);
});

test("a damaged preference file leaves names searchable and reports incomplete indexing", async t => {
  const s = setup(t, { broken: true });
  await pause();
  s.query("sidebar");
  assert.deepEqual(s.visible(), ["beta"]);
  assert.match(s.w.document.querySelector('[role="status"]').textContent, /could not be indexed/);
});

test("disable restores cards and removes UI, styles and pending work", async t => {
  const s = setup(t);
  await pause();
  s.query("cafe");
  s.unload();
  assert.equal(s.visible().length, 3);
  assert.equal(s.w.document.querySelector("#sine-mod-search"), null);
  assert.equal(s.w.document.querySelector("style"), null);
  s.render();
  await pause();
  assert.equal(s.w.document.querySelector("input"), null);
});

test("unloading during an async read cannot restore the UI", async t => {
  const s = setup(t, { deferred: true });
  await pause();
  s.unload();
  s.finish();
  await pause();
  assert.equal(s.w.document.querySelector("input"), null);
  assert.equal(s.visible().length, 3);
});

test("reload replaces the old instance without duplicate controls", async t => {
  const s = setup(t);
  await pause();
  s.w.eval(source);
  await pause();
  assert.equal(s.w.document.querySelectorAll("#sine-mod-search").length, 1);
  assert.equal(s.w.document.querySelectorAll("style").length, 1);
  s.query("bottom");
  assert.deepEqual(s.visible(), ["beta"]);
});

test("metadata names existing files and a valid update repository", () => {
  const root = path.join(__dirname, "..");
  const theme = JSON.parse(fs.readFileSync(path.join(root, "theme.json")));
  for (const field of ["id", "name", "description", "homepage", "version", "createdAt", "updatedAt", "style", "fork"]) assert.ok(theme[field]);
  assert.match(theme.homepage, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.ok(Number.isFinite(Date.parse(theme.updatedAt)));
  for (const file of [theme.style, ...Object.keys(theme.scripts)]) assert.ok(fs.existsSync(path.join(root, file)));
});
