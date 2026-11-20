import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const semanticSource = await source("semantic-search.js");
const helpers = await import("data:text/javascript," + encodeURIComponent(semanticSource));
// Inject browser APIs and a deterministic clock.
const controllerBody = (await source("related-notes.js"))
  .replace(/^import .*;\n/m, "").replaceAll("export ", "");
// Stub only the network/model boundary.
const workerCode = (await source("classifier-worker.js"))
  .replace(/^import .*;\n/m, "").replace("await import(libraryUrl)", "await mockLibrary()");

test("semantic ranking and composer lifecycle", () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message + ": " + JSON.stringify(actual));
  class Element {
    constructor() { this.children = []; this.events = new Map(); this.attributes = {}; this.value = ""; this.textContent = ""; this.hidden = false; }
    querySelector(selector) { return this.elements[selector]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { const handlers = this.events.get(name) || []; handlers.push(handler); this.events.set(name, handlers); }
    fire(name) { for (const handler of this.events.get(name) || []) handler({}); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
  }
  function clock() {
    let id = 0;
    const jobs = new Map();
    return {
      setTimeout(fn, ms) { const key = ++id; jobs.set(key, { fn, ms }); return key; },
      clearTimeout(key) { jobs.delete(key); },
      run(ms) { for (const [key, job] of [...jobs]) if (job.ms === ms) { jobs.delete(key); job.fn(); } },
      count(ms) { return [...jobs.values()].filter((job) => job.ms === ms).length; },
    };
  }
  const output = [];
  same(helpers.relatedCandidates([{ id: "photo", body: "" }, { id: "text", title: "여행", body: "오사카\n 숙소" }]), [{ id: "text", text: "여행 오사카 숙소" }], "all text notes are candidates");
  assert(helpers.relatedText("", "x".repeat(2000)).length === 1000, "bounded text");
  const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "bad" }, { id: "invalid" }];
  const vectors = new Map([["a", { vector: [0.9, 0] }], ["b", { vector: [1, 0] }], ["c", { vector: [0.85, 0] }], ["bad", { vector: [0.2, 0] }], ["invalid", { vector: [NaN, 0] }]]);
  same(helpers.rankRelated([1, 0], candidates, vectors).map(({ id }) => id), ["b", "a", "c"], "top three by similarity, weak/invalid results excluded");
  same(helpers.rankRelated([0, 1], candidates, vectors), [], "no forced matches");
  output.push("semantic ranking: limits, ordering, weak matches, empty text");
  
  const root = new Element();
  const toggle = new Element(), status = new Element(), results = new Element(), retry = new Element();
  root.elements = { "[data-related-toggle]": toggle, "[data-related-status]": status, "[data-related-retry]": retry, "[data-related-results]": results };
  const title = new Element(), body = new Element();
  const timers = clock();
  const sent = [];
  let notes = [{ id: "a", title: "<script>draft</script>", body: "여행 메모" }, { id: "b", title: "운동", body: "달리기" }];
  let opened;
  let calls = 0;
  const worker = { postMessage(data) { sent.push(data); } };
  const makeController = new Function("relatedText", "relatedCandidates", "document", "setTimeout", "clearTimeout", controllerBody + "\nreturn createRelatedNotes;")(helpers.relatedText, helpers.relatedCandidates, { createElement: () => new Element() }, timers.setTimeout, timers.clearTimeout);
  const controller = makeController({
    root, titleInput: title, bodyInput: body, getNotes: () => notes,
    getWorker: () => { calls++; return worker; }, openNote: (note) => { opened = note; },
  });
  controller.setVisible(true);
  body.value = "오사카에 가고 싶어";
  body.fire("input");
  timers.run(700);
  same(calls, 0, "no download before opt-in");
  toggle.fire("click");
  same(timers.count(700), 1, "debounced search");
  timers.run(700);
  const first = sent.find((message) => message.task === "related");
  same(first.notes.map(({ id }) => id), ["a", "b"], "unfiltered corpus");
  assert(first.query.includes("오사카"), "draft used as query");
  body.value = "운동하고 싶어";
  body.fire("input");
  assert(sent.some((message) => message.task === "related-cancel" && message.request === first.request), "input cancels old search");
  controller.receive({ data: { task: "related", request: first.request, type: "result", matches: [{ id: "a" }] } });
  same(results.children.length, 0, "stale results ignored");
  timers.run(700);
  const second = sent.filter((message) => message.task === "related").at(-1);
  controller.receive({ data: { task: "related", request: second.request, type: "result", matches: [{ id: "a" }, { id: "b" }] } });
  same(results.children.length, 2, "results rendered");
  same(results.children[0].children[0].children[0].textContent, "<script>draft</script>", "titles rendered as text");
  results.children[0].children[0].fire("click");
  same(opened.id, "a", "result opens existing memo");
  same(body.value, "운동하고 싶어", "opening result preserves draft");
  output.push("composer: opt-in, debounce, full corpus, cancellation, stale results, safe text and preserved draft");
  
  body.fire("compositionstart");
  body.value = "여행 준비하는 중";
  body.fire("input");
  timers.run(700);
  same(sent.filter((message) => message.task === "related").length, 2, "no search during Korean IME composition");
  body.fire("compositionend");
  timers.run(700);
  const third = sent.filter((message) => message.task === "related").at(-1);
  controller.receive({ data: { task: "related", request: third.request, type: "result", matches: [] } });
  assert(status.textContent.includes("가까운 메모가 없어요"), "empty match state");
  controller.notesChanged();
  timers.run(700);
  let newest = sent.filter((message) => message.task === "related").at(-1);
  controller.receive({ data: { task: "related", request: newest.request, type: "result", matches: [{ id: "b" }] } });
  notes = notes.filter(({ id }) => id !== "b");
  controller.notesChanged();
  same(results.children.length, 0, "deleted results removed immediately");
  timers.run(700);
  newest = sent.filter((message) => message.task === "related").at(-1);
  same(newest.notes.map(({ id }) => id), ["a"], "updated corpus sent");
  controller.workerReset();
  assert(status.textContent.includes("다시 시도"), "worker errors recoverable");
  retry.fire("click");
  timers.run(700);
  assert(sent.filter((message) => message.task === "related").length >= 6, "retry available");
  timers.run(180000);
  assert(retry.hidden === false, "timeout enables retry");
  assert(toggle.textContent === "관련 메모 끄기", "off switch remains available after failure");
  controller.reset();
  same(toggle.attributes["aria-pressed"], "false", "logout disables related search");
  same(results.children.length, 0, "logout clears displayed notes");
  newest = sent.filter((message) => message.task === "related").at(-1);
  controller.receive({ data: { task: "related", request: newest.request, type: "result", matches: [{ id: "a" }] } });
  same(results.children.length, 0, "previous account results ignored");
  output.push("lifecycle: Korean input, no matches, edit/delete refresh, worker error/retry, timeout and account reset");
  return output;
});

test("worker caching, cancellation and existing classification", async () => {
  const events = [];
  let onMessage;
  let pipelineCalls = 0;
  const encodedTexts = [];
  let afterBatch;
  const encoder = async (texts) => {
    encodedTexts.push(...texts);
    if (afterBatch) { const fn = afterBatch; afterBatch = null; fn(); }
    return { tolist: () => texts.map((text) => text.includes("여행") ? [1, 0] : [0, 1]) };
  };
  const fakeSelf = { postMessage: (message) => events.push(message), addEventListener: (name, listener) => { onMessage = listener; } };
  const library = async () => ({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => { pipelineCalls++; return encoder; },
  });
  const api = new Function("rankRelated", "self", "mockLibrary", "setTimeout",
    workerCode + "\nreturn { get busy() { return processing; }, get cache() { return noteVectors; } };"
  )(helpers.rankRelated, fakeSelf, library, (fn) => { fn(); });
  const send = (data) => onMessage({ data });
  async function drain() {
    for (let i = 0; i < 1000 && api.busy; i++) await Promise.resolve();
    if (api.busy) throw new Error("Worker did not finish");
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  send({ task: "related", request: "one", query: "여행 준비", notes: [{ id: "trip", text: "여행 계획" }, { id: "run", text: "운동" }] });
  await drain();
  assert(events.find((e) => e.request === "one" && e.type === "result").matches[0].id === "trip", "semantic ranking");
  assert(pipelineCalls === 1, "one model loaded");
  const oldCount = encodedTexts.length;
  send({ task: "related", request: "two", query: "여행", notes: [{ id: "trip", text: "여행 계획" }, { id: "run", text: "운동" }] });
  await drain();
  assert(encodedTexts.length === oldCount + 1, "document embeddings cached");
  send({ task: "related", request: "three", query: "운동", notes: [{ id: "trip", text: "운동으로 수정" }] });
  await drain();
  assert(!api.cache.has("run") && api.cache.get("trip").text === "운동으로 수정", "edit/delete invalidates cache");
  afterBatch = () => send({ request: 50, query: "여행", examples: [{ category: "여행", text: "여행 준비" }] });
  send({ task: "related", request: "four", query: "여행", notes: Array.from({ length: 10 }, (_, i) => ({ id: "n" + i, text: "여행 " + i })) });
  await drain();
  const classificationIndex = events.findIndex((e) => e.request === 50 && e.type === "result");
  const relatedIndex = events.findIndex((e) => e.request === "four" && e.type === "result");
  assert(classificationIndex >= 0 && relatedIndex > classificationIndex, "classification priority");
  assert(pipelineCalls === 1, "classification reuses the model");
  afterBatch = () => send({ task: "related-cancel", request: "five" });
  send({ task: "related", request: "five", query: "여행", notes: [{ id: "cancel", text: "여행 취소" }] });
  await drain();
  assert(!events.some((e) => e.request === "five" && e.type === "result"), "cancelled search suppressed");
  afterBatch = () => send({ task: "related", request: "seven", query: "운동", notes: [{ id: "new", text: "운동" }] });
  send({ task: "related", request: "six", query: "여행", notes: [{ id: "old", text: "여행" }] });
  await drain();
  assert(!events.some((e) => e.request === "six" && e.type === "result"), "superseded search suppressed");
  assert(events.find((e) => e.request === "seven" && e.type === "result").matches[0].id === "new", "latest search completed");
  return ["shared model", "cache reuse and invalidation", "classification priority", "cancellation and superseded searches"];
  
});

test("browser modules parse and composer IDs are present", async () => {
  const html = await source("index.html");
  const app = await source("app.js");
  for (const path of ["app.js", "classifier-worker.js", "semantic-search.js", "related-notes.js"]) {
    const code = (await source(path)).replace(/^import .*;\n/gm, "").replaceAll("export ", "")
      .replace(/import\.meta\.url/g, '"https://example.test/app.js"');
    assert.doesNotThrow(() => new Function(code), path);
  }
  for (const id of ["related-notes", "related-title", "related-results", "capture-title", "capture-body"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(app.includes("relatedNotes.reset();"));
  assert.ok(app.includes("relatedNotes.notesChanged();"));
  assert.ok(app.includes("relatedNotes.setVisible(writing);"));
});
