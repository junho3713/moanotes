import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const categoriesSource = await source("categories.js");
const categories = await import("data:text/javascript," + encodeURIComponent(categoriesSource));

test("account-scoped manual order, pins, rename and validation", () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const prefs = categories.createCategoryPreferences({ getStorage: () => storage });
  const entries = [["AI", 6], ["일정", 1], ["대화", 1]];
  prefs.use("alice");
  const initial = prefs.ordered(entries).map(([name]) => name);
  assert.equal(prefs.move(entries, initial.at(-1), initial[0]), true);
  const manual = [initial.at(-1), ...initial.slice(0, -1)];
  assert.deepEqual(prefs.ordered(entries).map(([name]) => name), manual);
  prefs.togglePin("대화");
  assert.deepEqual(prefs.ordered(entries).map(([name]) => name), ["대화", ...manual.filter((name) => name !== "대화")]);
  assert.equal(prefs.move(entries, "대화", "AI"), false, "pinned group stays above unpinned");
  prefs.use("bob");
  assert.equal(prefs.isPinned("대화"), false, "other account cannot inherit pins");
  prefs.use("alice");
  assert.equal(prefs.isPinned("대화"), true, "preferences survive account reload");
  prefs.rename("대화", "대화 잘하는 법");
  assert.equal(prefs.isPinned("대화 잘하는 법"), true, "rename preserves pin");
  assert.equal(prefs.isPinned("대화"), false);
  assert.deepEqual(categories.replaceCategory(["AI", "일정", "AI"], "AI", "개발"), ["개발", "일정"]);
  assert.equal(categories.validateCategoryName("  개발  ", ["AI"], "AI"), "개발");
  assert.throws(() => categories.validateCategoryName("", [], "AI"));
  assert.throws(() => categories.validateCategoryName("가".repeat(21), [], "AI"));
  assert.throws(() => categories.validateCategoryName("ai", ["AI", "일정"], "일정"), /같은 이름/);
  prefs.use(null);
  assert.equal(prefs.isPinned("대화 잘하는 법"), false);
  let errors = 0;
  const broken = categories.createCategoryPreferences({
    getStorage: () => ({ getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } }),
    onError: () => errors++,
  });
  broken.use("alice");
  broken.togglePin("AI");
  assert.equal(broken.isPinned("AI"), true, "memory fallback still works");
  assert.equal(errors, 2);
});

test("cloud rename preserves concurrent tags and reports partial completion", async () => {
  function cloud(items, failAt = Infinity) {
    const rows = new Map(items.map((tags, index) => [String(index), { tags, body: "unchanged", updatedAt: 123 }]));
    let calls = 0;
    const sdk = {
      query(collection, filter) { return filter; },
      where(field, operator, value) { return { field, operator, value }; },
      async getDocsFromServer(filter) {
        assert.equal(filter.operator, "array-contains");
        return { docs: [...rows].filter(([, note]) => note.tags.includes(filter.value)).map(([id]) => ({ id })) };
      },
      doc(collection, id) { return id; },
      async runTransaction(db, action) {
        calls++;
        if (calls === failAt) throw Error("network");
        // A concurrent tag was added after the query but before transactional reads.
        if (calls === 1 && rows.has("0")) rows.get("0").tags.push("동시 추가");
        const writes = [];
        const value = await action({
          async get(id) { return { exists: () => rows.has(id), data: () => rows.get(id) }; },
          update(id, patch) { writes.push([id, patch]); },
        });
        for (const [id, patch] of writes) rows.set(id, { ...rows.get(id), ...patch });
        return value;
      },
    };
    return { rows, sdk, get calls() { return calls; } };
  }
  const first = cloud([["AI", "일정"], ["자료"], ["AI"]]);
  assert.equal(await categories.renameCloudCategory({}, first.sdk, {}, "AI", "개발"), 2);
  assert.deepEqual(first.rows.get("0"), { tags: ["개발", "일정", "동시 추가"], body: "unchanged", updatedAt: 123 });
  assert.deepEqual(first.rows.get("1").tags, ["자료"]);
  const partial = cloud(Array.from({ length: 101 }, () => ["AI"]), 2);
  await assert.rejects(categories.renameCloudCategory({}, partial.sdk, {}, "AI", "개발"), (error) => error.renamedCount === 100);
  assert.equal(partial.rows.get("100").tags[0], "AI", "failed group keeps its old category");
  assert.equal(partial.rows.get("0").tags[0], "개발", "successful group is retained");
  const failed = cloud([["AI"]], 1);
  await assert.rejects(categories.renameCloudCategory({}, failed.sdk, {}, "AI", "개발"), /network/);
  assert.deepEqual(failed.rows.get("0").tags, ["AI"]);
});

test("local rename and browser wiring", async () => {
  const memory = new Map();
  const storageSource = (await source("storage.js")).replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  let notes;
  const store = new Function("replaceCategory", "renameCloudCategory", "localStorage", "window",
    storageSource + "\nreturn localStore;"
  )(categories.replaceCategory, categories.renameCloudCategory, {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  }, { addEventListener() {} })((items) => { notes = items; }, (error) => { throw error; });
  const count = notes.filter((note) => note.tags.includes("아이디어")).length;
  const original = notes.map((note) => ({ ...note }));
  await store.renameTag("아이디어", "생각");
  assert.equal(notes.filter((note) => note.tags.includes("생각")).length, count);
  assert.equal(notes.some((note) => note.tags.includes("아이디어")), false);
  assert.deepEqual(notes.map((note) => note.body), original.map((note) => note.body));
  for (const path of ["app.js", "storage.js", "categories.js"]) {
    const code = (await source(path)).replace(/^import .*;\n/gm, "").replaceAll("export ", "")
      .replace(/import\.meta\.url/g, '"https://example.test/app.js"');
    assert.doesNotThrow(() => new Function(code), path);
  }
  const html = await source("index.html");
  for (const id of ["category-menu", "category-sort", "category-pin", "category-rename", "category-order-dialog", "rename-category-dialog", "rename-category-form", "rename-category-name"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  const app = await source("app.js");
  assert.ok(app.includes("categoryPreferences.use(user.uid)"));
  assert.ok(app.includes("categoryPreferences.use(null)"));
  assert.ok(app.includes('button("mobile-chip", "분류 관리", openCategoryOrder)'));
  assert.ok(app.includes('for (const close of dialog.querySelectorAll("[data-close]"))'));
});

test("category menu keyboard, pin and rename actions", async () => {
  const elements = new Map();
  const document = { activeElement: null };
  class Element {
    constructor() {
      this.children = []; this.events = new Map(); this.attributes = {}; this.dataset = {};
      this.style = {}; this.value = ""; this.open = false; this.isConnected = true;
      this.offsetWidth = 170; this.offsetHeight = 90;
      this.classList = { add() {}, remove() {} };
    }
    addEventListener(type, handler) { const list = this.events.get(type) || []; list.push(handler); this.events.set(type, list); }
    async fire(type, extra = {}) {
      const event = { currentTarget: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
      for (const handler of this.events.get(type) || []) await handler(event);
      return event;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    matches() { return this.open; }
    showPopover() { this.open = true; }
    hidePopover() { this.open = false; }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    close() { this.open = false; }
    closest() { return this.ownerDialog ?? null; }
    getBoundingClientRect() { return { left: 12, bottom: 50 }; }
    querySelector() { return anchor; }
    querySelectorAll() { return [byId("category-pin"), byId("category-rename")]; }
  }
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.body = new Element();
  document.querySelector = () => anchor;
  const anchor = new Element();
  const prefs = categories.createCategoryPreferences({ getStorage: () => ({ getItem: () => null, setItem() {} }) });
  prefs.use("alice");
  let writes = 0, rendered = 0;
  const messages = [];
  const state = {
    view: "tag:AI",
    notes: [{ id: "1", tags: ["AI", "일정"], body: "메모" }],
  };
  state.store = {
    async renameTag(from, to) {
      writes++;
      state.notes = state.notes.map((note) => ({ ...note, tags: categories.replaceCategory(note.tags, from, to) }));
    },
  };
  const counts = () => [...new Set(state.notes.flatMap((note) => note.tags))].map((name) => [name, 1]);
  const app = await source("app.js");
  const start = app.indexOf("function categoryMenuButton(");
  const end = app.indexOf("function normalize(", start);
  const functions = app.slice(start, end);
  const factory = new Function("document", "window", "CSS", "byId", "node", "button", "icon",
    "categoryPreferences", "counts", "render", "openDialog", "save", "toast", "announce", "dialogFocus",
    "validateCategoryName", "replaceCategory", "relatedNotes", "state",
    "let categoryMenuTag = null, categoryMenuAnchor = null, renameCategoryFrom = null, categoryRenameBusy = false, categoryDrag = null;\n"
    + functions + "\nreturn { showCategoryMenu, closeCategoryMenu };");
  const node = (name, className, text) => Object.assign(new Element(), { textContent: text });
  const button = (className, text, handler) => { const result = node("button", className, text); result.addEventListener("click", handler); return result; };
  const api = factory(document, { innerWidth: 1200, innerHeight: 800, addEventListener() {} }, { escape: (text) => text },
    byId, node, button, () => new Element(), prefs, counts, () => rendered++,
    (id) => { byId(id).open = true; }, async (action) => { await action(); return true; },
    (message) => messages.push(message), (message) => messages.push(message), new Map(),
    categories.validateCategoryName, categories.replaceCategory, { notesChanged() {} }, state);
  api.showCategoryMenu("AI", anchor);
  assert.equal(byId("category-menu").open, true);
  assert.equal(byId("category-pin").textContent, "고정");
  await byId("category-menu").fire("keydown", { key: "ArrowDown" });
  assert.equal(document.activeElement, byId("category-rename"));
  await byId("category-menu").fire("keydown", { key: "Escape" });
  assert.equal(document.activeElement, anchor);
  assert.equal(byId("category-menu").open, false);
  api.showCategoryMenu("AI", anchor);
  await byId("category-pin").fire("click");
  assert.equal(prefs.isPinned("AI"), true);
  api.showCategoryMenu("AI", anchor);
  assert.equal(byId("category-pin").textContent, "고정 해제");
  await byId("category-rename").fire("click");
  assert.equal(byId("rename-category-dialog").open, true);
  assert.equal(byId("rename-category-name").value, "AI");
  byId("rename-category-name").value = "일정";
  await byId("rename-category-form").fire("submit");
  assert.equal(writes, 0, "duplicate category cannot modify notes");
  byId("rename-category-name").value = "개발";
  await byId("rename-category-form").fire("submit");
  assert.equal(writes, 1);
  assert.deepEqual(state.notes[0].tags, ["개발", "일정"]);
  assert.equal(state.notes[0].body, "메모");
  assert.equal(prefs.isPinned("개발"), true);
  assert.equal(state.view, "tag:개발", "active category follows its new name");
  assert.equal(byId("rename-category-dialog").open, false);
  assert.ok(rendered >= 2);
  await byId("category-sort").fire("click");
  assert.equal(byId("category-order-dialog").open, true);
  assert.equal(byId("category-order-list").children.length, 2);
});
