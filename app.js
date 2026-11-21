import { firebaseConfig } from "./firebase-config.js";
import { createStructureEditor } from "./structure-editor.js?v=25";
import { decodeStructure, structureText, structurePrefix } from "./structure-model.js?v=25";
import { createCategoryPreferences, replaceCategory, validateCategoryName } from "./categories.js?v=22";
import { createRelatedNotes } from "./related-notes.js?v=21";
import { localStore, openCloud } from "./storage.js?v=22";
import { maxPhotoBytes, maxThumbnailBytes, photoParts, preparePhoto } from "./images.js?v=6";

const byId = (id) => document.getElementById(id);
const maxTags = 20;
const maxBatch = 400;
const maxTitleLength = 120;
const maxBackupBytes = 32 * 1024 * 1024;
const workspaceButtons = [...document.querySelectorAll("[data-workspace-panel]")];
const classificationButtons = [...document.querySelectorAll("[data-classification-mode]")];
const classificationPreference = "moa.classification.mode";
let classificationMode = "manual";
let classificationWorker;
let classifierReady = false;
let classificationRequest = 0;
try {
  if (localStorage.getItem(classificationPreference) === "auto") classificationMode = "auto";
} catch {
  // The current session can still use the mode when browser storage is disabled.
}
const state = {
  notes: [], view: "all", query: "", sort: "newest",
  selecting: false, selected: new Set(), store: null,
  editingId: null, tagIds: [], draftTags: new Set(),
  recentCapture: null,
};
const folders = [
  { id: "all", text: "모든 메모", icon: "notes", test: () => true },
  { id: "inbox", text: "미분류", icon: "inbox", test: (note) => note.tags.length === 0 },
  { id: "pinned", text: "고정", icon: "pin", test: (note) => note.pinned },
];
const collator = new Intl.Collator("ko");
const newestFirst = (a, b) => b.createdAt - a.createdAt;
const byNoteName = (a, b) => collator.compare(noteHeading(a), noteHeading(b));
const noteSorts = {
  newest: newestFirst,
  oldest: (a, b) => newestFirst(b, a),
  name: byNoteName,
  "name-reverse": (a, b) => byNoteName(b, a),
};
const dateLabel = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "long", day: "numeric", weekday: "long" });
const noteDate = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "numeric", day: "numeric" });
const fullDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
let toastTimer;
const dialogFocus = new WeakMap();
let capturePending = false;
let captureMode = "text";
let editingStructure = false;
let batchDeleteIds = [];
let photoViewerRequest = 0;
let backupRequest = 0;
const backupUrls = [];
let categoryMenuTag = null;
let categoryMenuAnchor = null;
let renameCategoryFrom = null;
let categoryRenameBusy = false;
let categoryDrag = null;
let categorySortMode = false;
const categoryPreferences = createCategoryPreferences({
  onError: () => toast("분류 설정을 저장하지 못해 현재 창에서만 적용돼요.", true),
});
const relatedNotes = createRelatedNotes({
  root: byId("related-notes"),
  toggle: byId("ai-explore"),
  queryInput: byId("related-query"),
  getNotes: () => state.notes.map((note) => ({ ...note, body: structureText(note.body) })),
  getWorker: ensureClassificationWorker,
  openNote: (note) => {
    // Search uses readable text, but editing must retain the original structure body.
    const current = state.notes.find(({ id }) => id === note.id);
    if (current) showEditor(current);
  },
});

function node(name, className, content) {
  const item = document.createElement(name);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

function button(className, label, action) {
  const item = node("button", className, label);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

function toast(message, warning = false) {
  const item = byId("toast");
  item.textContent = message;
  item.dataset.tone = warning ? "warn" : "";
  item.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { item.hidden = true; }, warning ? 6500 : 2800);
}

function setConnection(message, warning = false) {
  byId("connection").textContent = message;
  byId("connection").dataset.tone = warning ? "warn" : "";
}

function palette(text) {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) % 5;
  return "tag-" + hash;
}

function counts() {
  const tags = new Map();
  for (const note of state.notes) {
    for (const tag of note.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  return [...tags].sort(([a], [b]) => collator.compare(a, b));
}

function showPanel(writing) {
  const composer = byId("write-panel");
  if (composer.hidden === !writing) return;
  setSortOpen(false);
  composer.hidden = !writing;
  byId("browse-panel").hidden = writing;
  updateAIExploreView();
  for (const button of workspaceButtons) {
    button.setAttribute("aria-pressed", String((button.dataset.workspacePanel === "write") === writing));
  }
  window.scrollTo(0, 0);
}

function updateAIExploreView() {
  const allNotes = state.view === "all";
  byId("ai-explore").hidden = !allNotes;
  relatedNotes.setVisible(allNotes && !byId("workspace").hidden && !byId("browse-panel").hidden);
}

function chooseView(id) {
  state.view = id;
  state.selected.clear();
  showPanel(false);
  render();
}

function navigationItem(id, label, count, marker, mobile) {
  const item = button(mobile ? "mobile-chip" : "rail-button", undefined, () => chooseView(id));
  item.dataset.focusKey = (mobile ? "mobile-" : "rail-") + id;
  item.setAttribute("aria-pressed", String(state.view === id));
  if (marker && !mobile) item.append(marker);
  item.append(node("span", "label", label), node("span", "number", count));
  return item;
}

function renderNavigation(tags) {
  closeCategoryMenu();
  const desktop = [], mobile = [];
  for (const folder of folders) {
    const count = state.notes.filter(folder.test).length;
    desktop.push(navigationItem(folder.id, folder.text, count, icon(folder.icon), false));
    mobile.push(navigationItem(folder.id, folder.text, count, undefined, true));
  }
  byId("folders").replaceChildren(...desktop);
  const topicItems = [];
  const ordered = categoryPreferences.ordered(tags);
  for (const [index, [tag, count]] of ordered.entries()) {
    const row = node("div", "topic-row" + (categorySortMode ? " is-sorting" : ""));
    row.dataset.category = tag;
    row.title = "드래그해 분류 순서 바꾸기";
    bindCategoryDrag(row, tag, "rail");
    row.addEventListener("keydown", (event) => {
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        moveCategory(tag, ordered[index + (event.key === "ArrowUp" ? -1 : 1)]?.[0], "rail");
      } else if (event.key === "Escape" && categorySortMode) {
        event.preventDefault();
        setCategorySortMode(false);
        render();
        byId("category-sort").focus();
      }
    });
    const item = navigationItem("tag:" + tag, tag, count, node("span", "topic-dot " + palette(tag)), false);
    const chip = navigationItem("tag:" + tag, tag, count, undefined, true);
    if (categoryPreferences.isPinned(tag)) {
      const pin = icon("pin");
      pin.classList.add("topic-pin");
      item.append(pin);
      chip.append(icon("pin"));
    }
    if (categorySortMode) {
      const grip = icon("grip");
      grip.classList.add("topic-grip");
      const actions = node("div", "topic-sort-actions");
      const { up, down } = categoryMoveButtons(tag, ordered, index);
      actions.append(up, down);
      row.append(grip, item, categoryMenuButton(tag), actions);
    } else {
      row.append(item, categoryMenuButton(tag));
    }
    topicItems.push(row);
    mobile.push(chip);
  }
  if (tags.length) mobile.push(button("mobile-chip", "분류 관리", openCategoryOrder));
  byId("topics").replaceChildren(...topicItems);
  byId("topics").closest(".rail-topics").hidden = tags.length === 0;
  byId("mobile-nav").replaceChildren(...mobile);
  if (byId("category-order-dialog").open) renderCategoryOrder();
}


function categoryMenuButton(tag) {
  const item = button("icon-btn topic-menu-button", undefined, (event) => showCategoryMenu(tag, event.currentTarget));
  item.append(icon("more"));
  item.setAttribute("aria-label", tag + " 분류 메뉴");
  item.setAttribute("aria-haspopup", "menu");
  item.setAttribute("aria-expanded", "false");
  item.setAttribute("aria-controls", "category-menu");
  item.dataset.focusKey = "category-menu-" + tag;
  return item;
}

function closeCategoryMenu(restoreFocus = false) {
  const menu = byId("category-menu");
  if (menu.matches(":popover-open")) menu.hidePopover();
  categoryMenuAnchor?.setAttribute("aria-expanded", "false");
  if (restoreFocus && categoryMenuAnchor?.isConnected) categoryMenuAnchor.focus();
  categoryMenuAnchor = null;
  categoryMenuTag = null;
}

function showCategoryMenu(tag, anchor) {
  closeCategoryMenu();
  const menu = byId("category-menu");
  (anchor.closest("dialog") || document.body).append(menu);
  categoryMenuTag = tag;
  categoryMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  byId("category-pin").textContent = categoryPreferences.isPinned(tag) ? "고정 해제" : "고정";
  menu.showPopover();
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + "px";
  byId("category-pin").focus();
}

function moveCategory(from, to, focusAction = "up") {
  if (!categoryPreferences.move(counts(), from, to)) return;
  render();
  const status = byId("category-order-dialog").open ? byId("category-order-status") : byId("category-inline-status");
  status.textContent = "‘" + from + "’ 분류의 순서를 바꿨어요.";
  const key = focusAction === "rail" ? "rail-tag:" + from : "category-" + focusAction + "-" + from;
  const host = byId("category-order-dialog").open ? byId("category-order-dialog") : byId("topics");
  const control = host.querySelector("[data-focus-key='" + CSS.escape(key) + "']");
  if (control && !control.disabled) control.focus();
  else focusCategoryAction(from);
}

function focusCategoryAction(tag) {
  const host = byId("category-order-dialog").open ? byId("category-order-dialog") : byId("topics");
  host.querySelector("[data-focus-key='" + CSS.escape("category-menu-" + tag) + "']")?.focus();
}


function setCategorySortMode(active) {
  categorySortMode = active;
  const toggle = byId("category-sort");
  toggle.setAttribute("aria-pressed", String(active));
  toggle.setAttribute("aria-label", active ? "분류 정렬 완료" : "분류 수동 정렬");
  toggle.title = active ? "정렬 완료" : "수동 정렬";
  toggle.replaceChildren(icon(active ? "check" : "adjustments"));
  byId("category-inline-hint").hidden = !active;
}

function categoryMoveButtons(tag, ordered, index) {
  const sameGroup = (other) => other && categoryPreferences.isPinned(other[0]) === categoryPreferences.isPinned(tag);
  const up = button("icon-btn category-move", undefined, () => moveCategory(tag, ordered[index - 1]?.[0], "up"));
  const down = button("icon-btn category-move", undefined, () => moveCategory(tag, ordered[index + 1]?.[0], "down"));
  up.append(icon("arrow-up"));
  down.append(icon("arrow-down"));
  up.disabled = !sameGroup(ordered[index - 1]);
  down.disabled = !sameGroup(ordered[index + 1]);
  up.setAttribute("aria-label", tag + " 위로 이동");
  down.setAttribute("aria-label", tag + " 아래로 이동");
  up.dataset.focusKey = "category-up-" + tag;
  down.dataset.focusKey = "category-down-" + tag;
  return { up, down };
}

function bindCategoryDrag(row, tag, focusAction) {
  row.draggable = true;
  row.addEventListener("dragstart", (event) => {
    categoryDrag = tag;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tag);
    row.classList.add("dragging");
  });
  row.addEventListener("dragover", (event) => {
    if (!categoryDrag || categoryDrag === tag || categoryPreferences.isPinned(categoryDrag) !== categoryPreferences.isPinned(tag)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    row.classList.add("drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("drag-over");
    if (categoryDrag) moveCategory(categoryDrag, tag, focusAction);
    categoryDrag = null;
  });
  row.addEventListener("dragend", () => {
    categoryDrag = null;
    row.classList.remove("dragging", "drag-over");
  });
}

function renderCategoryOrder() {
  const ordered = categoryPreferences.ordered(counts());
  byId("category-order-list").replaceChildren(...ordered.map(([tag, count], index) => {
    const row = node("div", "category-order-row");
    row.draggable = true;
    row.dataset.category = tag;
    const handle = icon("grip");
    handle.classList.add("category-drag");
    row.append(handle);
    const label = node("span", "category-order-label", tag);
    label.title = tag;
    row.append(label, node("span", "category-order-count", String(count)));
    if (categoryPreferences.isPinned(tag)) {
      const pin = icon("pin");
      pin.classList.add("topic-pin");
      row.append(pin);
    }
    const { up, down } = categoryMoveButtons(tag, ordered, index);
    row.append(up, down, categoryMenuButton(tag));
    bindCategoryDrag(row, tag, "up");
    return row;
  }));
}

function openCategoryOrder() {
  renderCategoryOrder();
  openDialog("category-order-dialog");
}

byId("category-sort").addEventListener("click", () => {
  setCategorySortMode(!categorySortMode);
  render();
  byId("category-sort").focus();
});
byId("category-pin").addEventListener("click", () => {
  const tag = categoryMenuTag;
  if (!tag) return;
  const pinned = categoryPreferences.isPinned(tag);
  closeCategoryMenu();
  categoryPreferences.togglePin(tag);
  render();
  focusCategoryAction(tag);
  toast(pinned ? "분류 고정을 해제했어요." : "분류를 위에 고정했어요.");
});
byId("category-rename").addEventListener("click", () => {
  const tag = categoryMenuTag;
  const anchor = categoryMenuAnchor;
  if (!tag) return;
  closeCategoryMenu();
  renameCategoryFrom = tag;
  byId("rename-category-copy").textContent = "‘" + tag + "’에 속한 메모들의 분류 이름도 함께 바뀝니다.";
  const input = byId("rename-category-name");
  input.disabled = false;
  input.value = tag;
  openDialog("rename-category-dialog");
  if (anchor) dialogFocus.set(byId("rename-category-dialog"), anchor);
  input.focus();
  input.select();
});
byId("category-menu").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeCategoryMenu(true);
  } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const options = [...byId("category-menu").querySelectorAll("button")];
    const index = options.indexOf(document.activeElement);
    options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length].focus();
  }
});
byId("category-menu").addEventListener("toggle", (event) => {
  if (event.newState === "closed" && !byId("category-menu").matches(":popover-open")) closeCategoryMenu();
});
window.addEventListener("resize", () => closeCategoryMenu());
byId("category-order-dialog").addEventListener("close", () => { closeCategoryMenu(); categoryDrag = null; });
byId("rename-category-dialog").addEventListener("cancel", (event) => {
  if (categoryRenameBusy) event.preventDefault();
});
byId("rename-category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (categoryRenameBusy || !renameCategoryFrom || !state.store) return;
  const from = renameCategoryFrom;
  const input = byId("rename-category-name");
  const dialog = byId("rename-category-dialog");
  let name;
  try { name = validateCategoryName(input.value, counts().map(([tag]) => tag), from); }
  catch (error) { announce(error.message, dialog); input.focus(); return; }
  if (name === from) { dialog.close(); return; }
  if (!state.notes.some((note) => note.tags.includes(from))) {
    announce("이 분류가 이미 변경되었어요. 창을 닫고 다시 확인해 주세요.", dialog);
    return;
  }
  const store = state.store;
  const wasCurrent = state.view === "tag:" + from;
  categoryRenameBusy = true;
  input.disabled = true;
  const saved = await save(() => store.renameTag(from, name), event.currentTarget);
  categoryRenameBusy = false;
  input.disabled = false;
  if (state.store !== store || !saved) return;
  categoryPreferences.rename(from, name);
  state.notes = state.notes.map((note) => note.tags.includes(from)
    ? { ...note, tags: replaceCategory(note.tags, from, name) } : note);
  if (wasCurrent) state.view = "tag:" + name;
  relatedNotes.notesChanged();
  render();
  dialog.close();
  focusCategoryAction(name);
  toast("분류 이름을 ‘" + name + "’(으)로 바꿨어요.");
});

function normalize(text) {
  return text.normalize("NFKC").toLocaleLowerCase("ko-KR").trim();
}

function recentCategories() {
  const categories = new Set();
  for (const note of [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    for (const category of note.tags) categories.add(category);
  }
  return [...categories];
}

function renderClassificationMode() {
  for (const control of classificationButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.classificationMode === classificationMode));
  }
  byId("classification-download").hidden = classificationMode !== "auto" || classifierReady;
}

function classificationText(title, body) {
  return [title, structureText(body)].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim().slice(0, 360);
}

function classificationExamples(skipId) {
  const groups = new Map();
  for (const note of [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (note.id === skipId || !note.tags.length) continue;
    const text = classificationText(note.title, note.body);
    if (!text) continue;
    for (const category of note.tags) {
      if (!groups.has(category) && groups.size < 16) groups.set(category, new Set());
      const samples = groups.get(category);
      if (samples && samples.size < 2) samples.add(category + " " + text);
    }
  }
  return [...groups].flatMap(([category, texts]) => [...texts].map((text) => ({ category, text })));
}

function setClassificationStatus(capture, message) {
  capture.aiMessage = message;
  if (!capture.saving) byId("capture-category-status").textContent = message || "메모를 저장했어요.";
}

function cancelAutomaticCategory(capture) {
  if (!capture?.aiRequest) return;
  clearTimeout(capture.aiTimeout);
  capture.aiRequest = null;
  capture.aiMessage = "";
}

function classificationFailed(capture) {
  cancelAutomaticCategory(capture);
  setClassificationStatus(capture, "AI를 준비하지 못했어요. 분류를 직접 골라 주세요.");
}

function resetClassificationWorker() {
  classificationWorker?.terminate();
  classificationWorker = undefined;
  classifierReady = false;
  relatedNotes.workerReset();
  renderClassificationMode();
}

function ensureClassificationWorker() {
  if (!classificationWorker) {
    classificationWorker = new Worker(new URL("./classifier-worker.js?v=21", import.meta.url), { type: "module" });
    classificationWorker.addEventListener("message", (event) => {
      if (event.data.type === "ready") {
        classifierReady = true;
        renderClassificationMode();
      }
      if (event.data.task === "related") relatedNotes.receive(event);
      else handleClassification(event);
    });
    classificationWorker.addEventListener("error", () => {
      resetClassificationWorker();
      if (state.recentCapture?.aiRequest) classificationFailed(state.recentCapture);
    });
  }
  return classificationWorker;
}

function handleClassification({ data: { request, type, ranked } }) {
  if (type === "ready") {
    classifierReady = true;
    renderClassificationMode();
  }
  const capture = state.recentCapture;
  if (!capture?.aiRequest || capture.aiRequest !== request || !byId("capture-categories").open) return;
  if (type === "ready") {
    setClassificationStatus(capture, "AI가 기존 메모와 비교하고 있어요.");
    return;
  }
  if (type === "error") {
    classificationFailed(capture);
    return;
  }
  if (type !== "result") return;

  cancelAutomaticCategory(capture);
  const current = state.notes.find(({ id }) => id === capture.id);
  if (current?.tags.length) {
    finishCaptureInView("tag:" + current.tags[0]);
    return;
  }
  const available = new Set(recentCategories());
  const [category] = ranked.find(([name, score]) => available.has(name) && Number.isFinite(score)) ?? [];
  if (!category) {
    setClassificationStatus(capture, "분류할 곳을 찾지 못했어요. 직접 골라 주세요.");
    return;
  }
  void saveQuickCategories([category], category, true);
}

function startAutomaticCategory(capture, title, body) {
  if (classificationMode !== "auto") return;
  const query = classificationText(title, body);
  const examples = query ? classificationExamples(capture.id) : [];
  if (!examples.length) {
    setClassificationStatus(capture, query ? "분류해 둔 메모가 생기면 AI가 참고해요." : "사진 메모는 분류를 직접 골라 주세요.");
    return;
  }
  try {
    ensureClassificationWorker();
    capture.aiRequest = ++classificationRequest;
    setClassificationStatus(capture, classifierReady ? "AI가 기존 메모와 비교하고 있어요." : "AI 모델을 준비하고 있어요. 먼저 분류를 골라도 돼요.");
    capture.aiTimeout = setTimeout(() => {
      if (state.recentCapture !== capture || !capture.aiRequest) return;
      resetClassificationWorker();
      classificationFailed(capture);
    }, 180000);
    classificationWorker.postMessage({ request: capture.aiRequest, query, examples });
  } catch {
    classificationFailed(capture);
  }
}

function showNewCategoryForm(show) {
  byId("quick-form").hidden = !show;
  byId("quick-new").setAttribute("aria-expanded", String(show));
  if (show) byId("quick-name").focus();
  else byId("quick-name").value = "";
}

function finishCaptureInView(view) {
  const dialog = byId("capture-categories");
  state.query = "";
  byId("search").value = "";
  chooseView(view);
  dialogFocus.set(dialog, byId("list-title"));
  dialog.close();
}

function drawQuickCategories() {
  const capture = state.recentCapture;
  if (!capture) return;
  const categories = [...new Set([...capture.newCategories, ...recentCategories()])];
  const status = byId("capture-category-status");
  const message = capture.saving ? "분류에 추가하는 중이에요." : capture.aiMessage || "메모를 저장했어요.";
  if (status.textContent !== message) status.textContent = message;
  byId("capture-mode-hint").textContent = !categories.length
    ? "새 분류를 만들거나 나중에 분류할 수 있어요."
    : capture.multiple ? "원하는 분류를 고른 뒤 아래 버튼을 눌러 주세요."
      : "분류를 누르면 해당 목록으로 바로 이동해요.";

  for (const [id, pressed] of [["category-single", !capture.multiple], ["category-multiple", capture.multiple]]) {
    const control = byId(id);
    control.setAttribute("aria-pressed", String(pressed));
    control.disabled = capture.saving;
  }

  const visibleCategories = capture.expanded ? categories : categories.slice(0, 4);
  byId("quick-options").replaceChildren(...visibleCategories.map((category) => {
    const selected = capture.selected.has(category);
    const choice = button("quick-button quick-option " + palette(category), undefined, () => {
      cancelAutomaticCategory(capture);
      if (capture.multiple) {
        if (selected) capture.selected.delete(category);
        else selectQuickCategory(capture, category);
        drawQuickCategories();
        focusQuickCategory(category);
      } else {
        void saveQuickCategories([category], category);
      }
    });
    choice.dataset.focusKey = "quick-" + category;
    choice.disabled = capture.saving;
    if (capture.multiple) {
      choice.setAttribute("aria-pressed", String(selected));
      const marker = node("span", "quick-check");
      marker.setAttribute("aria-hidden", "true");
      if (selected) marker.append(icon("check"));
      choice.append(marker);
    }
    choice.append(category);
    return choice;
  }));
  byId("quick-new").disabled = capture.saving;
  byId("quick-more").hidden = categories.length <= 4;
  byId("quick-more").disabled = capture.saving;
  byId("quick-more").setAttribute("aria-expanded", String(capture.expanded));
  byId("quick-more").textContent = capture.expanded ? "분류 접기" : "모든 분류";
  byId("quick-dismiss").disabled = capture.saving;
  byId("quick-name").disabled = capture.saving;
  byId("quick-create").disabled = capture.saving;
  byId("quick-create").textContent = capture.multiple ? "만들고 선택" : "만들고 추가";
  const apply = byId("quick-apply");
  apply.hidden = !capture.multiple;
  apply.disabled = !capture.selected.size || capture.saving;
  apply.textContent = capture.selected.size ? capture.selected.size + "곳에 추가" : "선택한 분류에 추가";
}

function focusQuickCategory(category) {
  document.querySelector("[data-focus-key='" + CSS.escape("quick-" + category) + "']")?.focus({ preventScroll: true });
}

function selectQuickCategory(capture, category) {
  const dialog = byId("capture-categories");
  dialog.querySelector(".dialog-feedback")?.remove();
  if (!capture.selected.has(category) && capture.selected.size >= maxTags) {
    announce("메모 하나에 분류를 20개까지 붙일 수 있어요.", dialog);
    return false;
  }
  capture.selected.add(category);
  return true;
}

async function saveQuickCategories(categories, destination, automatic = false) {
  const capture = state.recentCapture;
  if (!capture || capture.saving || !categories.length) return;
  const dialog = byId("capture-categories");
  dialog.querySelector(".dialog-feedback")?.remove();
  const note = state.notes.find(({ id }) => id === capture.id);
  const attached = new Set(note?.tags ?? []);
  const additions = categories.filter((category) => !attached.has(category));
  if (attached.size + additions.length > maxTags) {
    announce("메모 하나에 분류를 20개까지 붙일 수 있어요.", dialog);
    return;
  }
  const focused = document.activeElement;
  capture.saving = true;
  drawQuickCategories();
  const saved = !additions.length || await save(() => state.store.addTags([capture.id], additions, Date.now()), undefined, dialog);
  if (state.recentCapture !== capture) return;
  capture.saving = false;
  if (!saved) {
    drawQuickCategories();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    else if (destination) focusQuickCategory(destination);
    return;
  }
  if (destination) {
    finishCaptureInView("tag:" + destination);
    toast(automatic ? "AI가 ‘" + destination + "’에 분류했어요." : "‘" + destination + "’에 추가했어요.");
  } else {
    finishCaptureInView("all");
    toast("메모를 " + categories.length + "곳에 추가했어요.");
  }
}

function createQuickCategory() {
  const capture = state.recentCapture;
  if (!capture || capture.saving) return;
  const input = byId("quick-name");
  const dialog = byId("capture-categories");
  const name = input.value.trim().normalize("NFC");
  if (!name) {
    announce("분류 이름을 입력해 주세요.", dialog);
    input.focus();
    return;
  }
  const known = [...capture.newCategories, ...recentCategories()];
  const existing = known.find((category) => normalize(category) === normalize(name));
  const category = existing ?? name;
  if (!capture.multiple) {
    void saveQuickCategories([category], category);
    return;
  }
  if (!selectQuickCategory(capture, category)) return;
  if (!existing) capture.newCategories.unshift(category);
  if (existing && known.indexOf(existing) >= 4) capture.expanded = true;
  showNewCategoryForm(false);
  drawQuickCategories();
  focusQuickCategory(category);
}

function changeQuickMode(multiple) {
  const capture = state.recentCapture;
  if (!capture || capture.saving || capture.multiple === multiple) return;
  cancelAutomaticCategory(capture);
  capture.multiple = multiple;
  byId("capture-categories").querySelector(".dialog-feedback")?.remove();
  drawQuickCategories();
}

function visibleNotes() {
  const folder = folders.find(({ id }) => id === state.view);
  const matchesView = folder ? folder.test : (note) => note.tags.includes(state.view.slice(4));
  const terms = normalize(state.query).split(/\s+/u).filter(Boolean);
  const compare = noteSorts[state.sort];
  return state.notes.filter((note) => {
    if (!matchesView(note)) return false;
    const haystack = normalize([note.title, structureText(note.body), note.thumbnail ? "사진" : "", ...note.tags].join(" "));
    return terms.every((term) => haystack.includes(term));
  }).sort((a, b) => compare(a, b) || newestFirst(a, b) || a.id.localeCompare(b.id));
}

function noteHeading(note, firstLine) {
  return note.title || (firstLine ?? structureText(note.body).split(/\r?\n/u, 1)[0]) || (decodeStructure(note.body) ? "구조 메모" : "사진 메모");
}

function makeMemoLinks(title, body, limit = Infinity) {
  const links = [];
  const seen = new Set();
  const text = (title ?? "") + "\n" + structureText(body);
  const pattern = /(?<![\p{L}\p{N}_@./])(?:https?:\/\/|www\.)[^\s<>"'\\\x60“”‘’]+/giu;
  for (const [match] of text.matchAll(pattern)) {
    let address = match.replace(/[.,!?;:，。！？、…]+$/u, "");
    const trailing = address.match(/\)+$/u)?.[0].length ?? 0;
    if (trailing) {
      const extra = address.split(")").length - address.split("(").length;
      address = address.slice(0, address.length - Math.max(0, Math.min(extra, trailing)));
    }
    let url;
    try {
      url = new URL(/^www\./iu.test(address) ? "https://" + address : address);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    const link = node("a", "memo-link", address.replace(/^https?:\/\//iu, ""));
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = address;
    links.push(link);
    if (links.length === limit) break;
  }
  return links;
}

function drawNote(note) {
  const article = node("article", "note");
  const checked = state.selecting && state.selected.has(note.id);
  article.classList.toggle("checked", checked);
  const meta = node("div", "note-meta");
  const date = node("time", "", noteDate.format(note.createdAt));
  date.dateTime = new Date(note.createdAt).toISOString();
  date.title = fullDate.format(note.createdAt);
  const plainBody = structureText(note.body);
  const [firstLine, ...rest] = plainBody.split(/\r?\n/u);
  const title = noteHeading(note, firstLine);
  if (state.selecting) {
    const check = node("input", "note-check");
    check.type = "checkbox";
    check.checked = checked;
    check.dataset.focusKey = "select-" + note.id;
    check.setAttribute("aria-label", title.slice(0, 60) + " 선택");
    check.addEventListener("change", () => toggleSelection(note.id));
    meta.append(check);
  }
  const pinLabel = note.pinned ? "고정 해제" : "메모 고정";
  const pin = button("icon-btn", undefined, async () => {
    if (await save(() => state.store.update(note.id, { pinned: !note.pinned, updatedAt: Date.now() }))) {
      toast(note.pinned ? "고정을 해제했어요." : "메모를 고정했어요.");
    }
  });
  pin.title = pinLabel;
  pin.setAttribute("aria-label", pinLabel);
  pin.setAttribute("aria-pressed", String(note.pinned));
  pin.dataset.focusKey = "pin-" + note.id;
  pin.append(icon("pin"));
  meta.append(date, pin);
  const content = button("note-content", undefined, () => (
    state.selecting ? toggleSelection(note.id) : showEditor(note)
  ));
  content.dataset.focusKey = "note-" + note.id;
  content.append(node("span", "note-title", title));
  const preview = (note.title ? plainBody : rest.join("\n")).trim();
  if (preview) content.append(node("span", "note-snippet", preview));
  if (decodeStructure(note.body)) content.append(node("span", "note-kind", "구조 메모"));
  if (photoParts(note.thumbnail, maxThumbnailBytes)) {
    const image = node("img", "note-photo");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = note.thumbnail;
    content.append(image);
  }
  const foot = node("div", "note-foot");
  for (const tag of note.tags) foot.append(button("chip " + palette(tag), tag, () => chooseView("tag:" + tag)));
  const edit = button("tag-edit", undefined, () => showTags([note.id]));
  edit.dataset.focusKey = "tags-" + note.id;
  edit.append(icon(note.tags.length ? "tag" : "plus"), note.tags.length ? "분류 편집" : "분류 추가");
  foot.append(edit);
  article.append(meta, content);
  const links = makeMemoLinks(note.title, note.body, 2);
  if (links.length) {
    const destinations = node("div", "memo-links");
    links.forEach((link, index) => { link.dataset.focusKey = "link-" + note.id + "-" + index; });
    destinations.append(...links);
    article.append(destinations);
  }
  article.append(foot);
  return article;
}

function render() {
  const focusKey = document.activeElement?.dataset.focusKey;
  const tags = counts();
  const activeFolder = folders.find(({ id }) => id === state.view);
  const activeTag = state.view.startsWith("tag:") ? state.view.slice(4) : null;
  if (activeTag && !tags.some(([tag]) => tag === activeTag)) state.view = "all";
  const visible = visibleNotes();
  const visibleIds = new Set(visible.map(({ id }) => id));
  state.selected = new Set([...state.selected].filter((id) => visibleIds.has(id)));
  byId("list-title").textContent = activeFolder?.text || (state.view === "all" ? "모든 메모" : activeTag);
  byId("note-count").textContent = visible.length + "개";
  renderNavigation(tags);
  byId("notes").replaceChildren(...visible.map(drawNote));
  drawQuickCategories();
  byId("empty").hidden = visible.length > 0;
  byId("empty-title").textContent = state.query ? "검색 결과가 없어요." : "이 보기에 메모가 없어요.";
  byId("clear-search").hidden = !state.query;
  byId("selection").hidden = !state.selecting;
  byId("selected-count").textContent = state.selected.size + "개 선택";
  byId("select-all").disabled = !visible.length;
  byId("select-all").textContent = visible.length && state.selected.size === visible.length
    ? "전체 선택 해제" : "표시된 메모 모두 선택";
  byId("batch-tags").disabled = !state.selected.size;
  byId("batch-delete").disabled = !state.selected.size;
  byId("select").setAttribute("aria-pressed", String(state.selecting));
  updateAIExploreView();
  if (focusKey) document.querySelector("[data-focus-key='" + CSS.escape(focusKey) + "']")?.focus({ preventScroll: true });
}

function toggleSelection(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

async function save(action, form, errorDialog = form?.closest("dialog")) {
  if (!state.store) {
    const message = "메모 저장소에 연결한 뒤 다시 시도해 주세요.";
    if (errorDialog) announce(message, errorDialog);
    else toast(message, true);
    return false;
  }
  const controls = form ? [...form.querySelectorAll("button")].filter((item) => !item.disabled) : [];
  controls.forEach((item) => { item.disabled = true; });
  try {
    if (firebaseConfig && !navigator.onLine) throw new Error("offline");
    await action();
    return true;
  } catch (error) {
    const message = error.deletedCount ? "메모 " + error.deletedCount + "개를 삭제했어요. 창을 닫고 남은 메모를 다시 선택해 주세요."
      : error.renamedCount ? "메모 " + error.renamedCount + "개의 분류를 변경했어요. 남은 메모는 이전 분류에서 다시 시도해 주세요."
      : error.message === "offline" ? "인터넷 연결을 확인해 주세요."
      : error.code === "permission-denied" ? "이 계정의 메모 저장 권한을 확인해 주세요."
      : "저장하지 못했어요. 잠시 후 다시 시도해 주세요.";
    if (errorDialog) announce(message, errorDialog);
    else toast(message, true);
    return false;
  } finally {
    controls.forEach((item) => { item.disabled = false; });
    if (form === byId("capture-form")) updateCaptureButton();
  }
}

function announce(message, dialog) {
  let feedback = dialog.querySelector(".dialog-feedback");
  if (!feedback) {
    feedback = node("p", "dialog-feedback");
    feedback.setAttribute("role", "alert");
    dialog.append(feedback);
  }
  feedback.textContent = message;
}

function openDialog(id) {
  const dialog = byId(id);
  dialog.querySelector(".dialog-feedback")?.remove();
  dialogFocus.set(dialog, document.activeElement);
  dialog.showModal();
}

function createPhotoField(id, onChange = () => {}) {
  const field = byId(id);
  const find = (name) => field.querySelector("[data-photo-" + name + "]");
  const fileInput = find("file");
  const add = find("add");
  const preview = find("preview");
  const view = find("view");
  const image = view.querySelector("img");
  const remove = find("remove");
  const status = find("status");
  let pending = false;
  let attachment = null;
  let changed = false;
  let request = 0;

  function draw(error) {
    add.querySelector("span").textContent = attachment ? "사진 바꾸기" : "사진 추가";
    add.disabled = pending;
    view.disabled = pending;
    remove.disabled = pending;
    preview.hidden = !attachment;
    if (attachment) image.src = attachment.thumbnail;
    else image.removeAttribute("src");
    status.textContent = error || (pending ? "사진을 줄이는 중이에요." : attachment
      ? (attachment.size ? "압축 후 약 " + Math.ceil(attachment.size / 1024) + "KB" : "사진 1장")
      : id === "capture-photo" ? "캡처를 붙여넣을 수도 있어요." : "");
    status.dataset.tone = error ? "warn" : "";
    onChange(pending);
  }

  async function choose(file) {
    if (!file || add.disabled) return;
    const attempt = ++request;
    pending = true;
    draw();
    let error;
    try {
      const ready = await preparePhoto(file);
      if (request !== attempt) return;
      attachment = ready;
      changed = true;
    } catch (failure) {
      error = failure instanceof Error
        ? failure.message : "사진을 준비하지 못했어요. 다른 사진을 골라 주세요.";
    }
    if (request !== attempt) return;
    pending = false;
    draw(error);
  }

  add.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    void choose(file);
  });
  remove.addEventListener("click", () => {
    attachment = null;
    changed = true;
    draw();
    add.focus({ preventScroll: true });
  });
  view.addEventListener("click", () => {
    if (attachment) void showPhoto(attachment);
  });
  return {
    choose,
    get attachment() { return attachment; },
    get pending() { return pending; },
    get change() { return changed ? attachment : undefined; },
    reset(photo = null) {
      request += 1;
      pending = false;
      attachment = photo;
      changed = false;
      draw();
    },
  };
}

async function showPhoto(attachment) {
  const request = ++photoViewerRequest;
  const dialog = byId("photo-viewer");
  const image = byId("photo-viewer-image");
  const status = byId("photo-viewer-status");
  status.textContent = "사진을 불러오는 중이에요.";
  status.hidden = false;
  image.hidden = true;
  image.removeAttribute("src");
  openDialog("photo-viewer");
  try {
    const data = attachment.data || await state.store?.getPhoto(attachment.id);
    if (request !== photoViewerRequest || !dialog.open) return;
    if (!photoParts(data, maxPhotoBytes)) throw new Error("Photo unavailable");
    image.src = data;
    image.hidden = false;
    status.hidden = true;
  } catch {
    if (request === photoViewerRequest && dialog.open) status.textContent = "사진을 불러오지 못했어요. 연결을 확인하고 다시 열어 주세요.";
  }
}

const capturePhoto = createPhotoField("capture-photo", () => updateCaptureButton());
const editPhoto = createPhotoField("edit-photo", (pending) => {
  byId("editor-form").querySelector("button[type='submit']").disabled = pending;
});

const captureStructure = createStructureEditor({
  root: byId("capture-structure"),
  onChange: () => updateCaptureButton(),
  onSubmit: () => { if (!byId("capture-submit").disabled) byId("capture-form").requestSubmit(); },
});
const editStructure = createStructureEditor({
  root: byId("edit-structure"),
  onChange: () => {
    if (editingStructure) { byId("edit-body").value = editStructure.getBody(); updateEditorLinks(); }
  },
  onSubmit: () => {
    if (!byId("editor-form").querySelector("button[type='submit']").disabled) byId("editor-form").requestSubmit();
  },
});

function setCaptureMode(mode) {
  if (capturePending) return;
  captureMode = mode;
  const structure = mode === "structure";
  byId("capture-body").hidden = structure;
  byId("capture-structure").hidden = !structure;
  for (const button of document.querySelectorAll("[data-capture-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.captureMode === mode));
  }
  if (structure) captureStructure.refresh();
  updateCaptureButton();
}
for (const button of document.querySelectorAll("[data-capture-mode]")) {
  button.addEventListener("click", () => setCaptureMode(button.dataset.captureMode));
}

function updateEditorLinks() {
  const destinations = byId("edit-links");
  const links = makeMemoLinks(byId("edit-title").value, byId("edit-body").value);
  destinations.replaceChildren(...links);
  destinations.hidden = links.length === 0;
}

function showEditor(note) {
  state.editingId = note.id;
  byId("edit-title").value = note.title ?? "";
  byId("edit-body").value = note.body;
  const structure = decodeStructure(note.body);
  editingStructure = Boolean(structure);
  byId("editor").classList.toggle("is-structure", editingStructure);
  byId("edit-body").hidden = editingStructure;
  byId("edit-body-label").hidden = editingStructure;
  byId("edit-structure").hidden = !editingStructure;
  if (structure) editStructure.load(structure);
  updateEditorLinks();
  editPhoto.reset(photoParts(note.thumbnail, maxThumbnailBytes) ? { id: note.id, thumbnail: note.thumbnail } : null);
  byId("delete-confirm").hidden = true;
  openDialog("editor");
  if (editingStructure) editStructure.refresh();
  else byId("edit-body").focus();
}

function showTags(ids) {
  state.tagIds = ids;
  state.draftTags = new Set(ids.length === 1 ? state.notes.find((note) => note.id === ids[0])?.tags : []);
  byId("tag-title").textContent = ids.length === 1 ? "분류 편집" : ids.length + "개 메모에 분류 추가";
  byId("new-tag").value = "";
  drawTagOptions();
  openDialog("tag-dialog");
}

function drawTagOptions() {
  const tags = [...new Set([...counts().map(([tag]) => tag), ...state.draftTags])].sort(collator.compare);
  byId("tag-options").replaceChildren(...tags.map((tag) => {
    const item = button("chip " + palette(tag), undefined, () => {
      if (state.draftTags.has(tag)) state.draftTags.delete(tag);
      else if (state.draftTags.size < maxTags) state.draftTags.add(tag);
      drawTagOptions();
      [...byId("tag-options").children].find((option) => option.dataset.tag === tag)?.focus();
    });
    item.dataset.tag = tag;
    item.setAttribute("aria-pressed", String(state.draftTags.has(tag)));
    if (state.draftTags.has(tag)) item.append(icon("check"));
    item.append(tag);
    return item;
  }));
}

function addDraftTag() {
  const input = byId("new-tag");
  const entered = input.value.trim().normalize("NFC");
  if (!entered || state.draftTags.size >= maxTags) return;
  const match = [...counts().map(([tag]) => tag), ...state.draftTags].find((tag) => normalize(tag) === normalize(entered));
  state.draftTags.add(match || entered);
  input.value = "";
  drawTagOptions();
}

function noteData(body, title) {
  const now = Date.now();
  return { title, body, tags: [], pinned: false, createdAt: now, updatedAt: now };
}

function clearBackupParts() {
  for (const url of backupUrls.splice(0)) URL.revokeObjectURL(url);
  byId("backup-parts").replaceChildren();
  byId("backup-parts").hidden = true;
}

function setBackupBusy(busy) {
  byId("download").disabled = busy;
  byId("download").textContent = busy ? "백업 준비 중…" : "백업 내려받기";
  byId("upload").disabled = busy;
}

async function exportNotes() {
  const store = state.store;
  if (!store) return;
  const request = ++backupRequest;
  const dialog = byId("backup-dialog");
  dialog.querySelector(".dialog-feedback")?.remove();
  clearBackupParts();
  setBackupBusy(true);
  try {
    const bundles = [];
    let entries = [];
    let bytes = 64;
    const bundle = () => new Blob(['{"version":2,"notes":[', entries.join(","), "]}"], { type: "application/json" });
    for (const { id, imageData, ...note } of state.notes) {
      if (note.thumbnail) {
        const data = await store.getPhoto(id);
        if (request !== backupRequest) return;
        if (!photoParts(data, maxPhotoBytes)) throw new Error("사진을 가져오지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
        note.imageData = data;
      }
      const entry = JSON.stringify(note);
      const size = new Blob([entry]).size + 1;
      if (bytes + size > maxBackupBytes && entries.length) {
        bundles.push(bundle());
        entries = [];
        bytes = 64;
      }
      entries.push(entry);
      bytes += size;
    }
    bundles.push(bundle());
    const links = bundles.map((file, index) => {
      const link = node("a", "soft-btn", "파일 " + (index + 1) + " 내려받기");
      link.href = URL.createObjectURL(file);
      link.download = "moa-backup-" + new Date().toISOString().slice(0, 10)
        + (bundles.length > 1 ? "-" + (index + 1) : "") + ".json";
      return link;
    });
    if (links.length === 1) {
      const [link] = links;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 3000);
    } else {
      const parts = byId("backup-parts");
      parts.append(node("p", "dialog-copy", "백업을 " + links.length + "개로 나눴어요. 각 파일을 내려받아 주세요."), ...links);
      parts.hidden = false;
      backupUrls.push(...links.map(({ href }) => href));
    }
  } catch {
    if (request === backupRequest) announce("백업을 만들지 못했어요. 사진을 불러올 수 있도록 연결을 확인해 주세요.", dialog);
  } finally {
    if (request === backupRequest) setBackupBusy(false);
  }
}

function fingerprint(note) {
  return String(note.createdAt) + ":" + JSON.stringify([note.body.trim(), note.thumbnail || ""]);
}

function validateNote(note) {
  const validDate = (value) => Number.isSafeInteger(value) && value > 0 && value < 8.64e15;
  if (!note || typeof note.body !== "string") return false;
  if (note.body.startsWith(structurePrefix) && !decodeStructure(note.body)) return false;
  const thumbnail = note.thumbnail ?? "";
  const data = note.imageData ?? "";
  const hasPhoto = thumbnail !== "" || data !== "";
  return (note.body.trim() || hasPhoto) && note.body.length <= 20000
    && (!hasPhoto || (photoParts(thumbnail, maxThumbnailBytes) && photoParts(data, maxPhotoBytes)))
    && (!Object.hasOwn(note, "title") || (typeof note.title === "string" && note.title.length <= maxTitleLength))
    && Array.isArray(note.tags) && note.tags.length <= maxTags
    && note.tags.every((tag) => typeof tag === "string" && tag.trim() && tag.length <= 20)
    && typeof note.pinned === "boolean" && validDate(note.createdAt) && validDate(note.updatedAt);
}

function nextRestoreBatch(notes, start) {
  const batch = [];
  let bytes = 0;
  let writes = 0;
  for (let index = start; index < notes.length; index += 1) {
    const note = notes[index];
    const cost = note.imageData ? 2 : 1;
    const estimated = new Blob([JSON.stringify(note)]).size + 512;
    if (writes + cost > maxBatch || bytes + estimated > 6 * 1024 * 1024) break;
    batch.push(note);
    writes += cost;
    bytes += estimated;
  }
  return batch;
}

async function importNotes(file) {
  const dialog = byId("backup-dialog");
  try {
    if (file.size > maxBackupBytes) throw new Error("백업 파일은 32MB까지 가져올 수 있어요.");
    const backup = JSON.parse(await file.text());
    if (![1, 2].includes(backup?.version) || !Array.isArray(backup.notes) || !backup.notes.every(validateNote)) {
      throw new Error("모아에서 내려받은 백업 파일을 선택해 주세요.");
    }
    const known = new Set(state.notes.map(fingerprint));
    const fresh = [];
    for (const note of backup.notes) {
      const key = fingerprint(note);
      if (known.has(key)) continue;
      known.add(key);
      fresh.push({
        title: note.title?.trim() ?? "",
        body: note.body.trim(), tags: [...new Set(note.tags.map((tag) => tag.trim()))],
        pinned: note.pinned, createdAt: note.createdAt, updatedAt: note.updatedAt,
        ...(note.thumbnail ? { thumbnail: note.thumbnail, imageData: note.imageData } : {}),
      });
    }
    let imported = 0;
    if (fresh.length && !state.store) throw new Error("메모 저장소에 연결한 뒤 다시 시도해 주세요.");
    if (firebaseConfig && !navigator.onLine) throw new Error("인터넷 연결을 확인해 주세요.");
    try {
      while (imported < fresh.length) {
        const batch = nextRestoreBatch(fresh, imported);
        await state.store.importNotes(batch);
        imported += batch.length;
      }
    } catch {
      announce(imported + "개를 가져왔어요. 남은 메모는 저장 연결을 확인한 뒤 같은 파일로 다시 시도해 주세요.", dialog);
      return;
    }
    dialog.close();
    toast(imported ? imported + "개 메모를 가져왔어요." : "새로 가져올 메모가 없어요.");
  } catch (error) {
    announce(error instanceof SyntaxError ? "백업 파일을 읽을 수 없어요." : error.message, dialog);
  }
}

function updateCaptureButton() {
  byId("capture-submit").disabled = capturePending || capturePhoto.pending || !state.store
    || (!(captureMode === "structure" ? captureStructure.hasContent() : byId("capture-body").value.trim()) && !capturePhoto.attachment);
}

document.addEventListener("paste", (event) => {
  if (byId("workspace").hidden) return;
  const file = [...(event.clipboardData?.items ?? [])]
    .find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
  if (!file) return;
  const dialog = [...document.querySelectorAll("dialog[open]")];
  const photo = !dialog.length ? capturePhoto : dialog.length === 1 && dialog[0].id === "editor" ? editPhoto : null;
  if (!photo) return;
  event.preventDefault();
  if (photo === capturePhoto) showPanel(true);
  void photo.choose(file);
});

byId("today").textContent = dateLabel.format(new Date());
for (const control of classificationButtons) {
  control.addEventListener("click", () => {
    classificationMode = control.dataset.classificationMode;
    try {
      localStorage.setItem(classificationPreference, classificationMode);
    } catch {
      // Keep the chosen mode for this session when browser storage cannot be written.
    }
    renderClassificationMode();
  });
}
renderClassificationMode();
for (const button of workspaceButtons) {
  button.addEventListener("click", () => showPanel(button.dataset.workspacePanel === "write"));
}
byId("capture-body").addEventListener("input", updateCaptureButton);
byId("capture-body").addEventListener("keydown", (event) => {
  if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!byId("capture-submit").disabled) byId("capture-form").requestSubmit();
  }
});
byId("capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("capture-body");
  const titleInput = byId("capture-title");
  const titleDraft = titleInput.value;
  const mode = captureMode;
  const draft = mode === "structure" ? captureStructure.getBody() : input.value;
  const body = mode === "structure" ? draft : draft.trim();
  const photo = capturePhoto.attachment;
  if ((!body && !photo) || byId("capture-submit").disabled) return;
  capturePending = true;
  captureStructure.setDisabled(true);
  const store = state.store;
  let id;
  const saved = await save(async () => { id = await store.add(noteData(body, titleDraft.trim()), photo); }, event.currentTarget);
  capturePending = false;
  captureStructure.setDisabled(false);
  if (saved && state.store === store) {
    if (mode === "structure") {
      if (captureStructure.getBody() === draft) captureStructure.reset();
    } else if (input.value === draft) input.value = "";
    if (titleInput.value === titleDraft) titleInput.value = "";
    capturePhoto.reset();
    showNewCategoryForm(false);
    const capture = {
      id, multiple: false, selected: new Set(), newCategories: [], saving: false, expanded: false,
    };
    state.recentCapture = capture;
    drawQuickCategories();
    openDialog("capture-categories");
    startAutomaticCategory(capture, titleDraft.trim(), body);
  }
  updateCaptureButton();
});
byId("quick-new").addEventListener("click", () => {
  if (state.recentCapture?.aiRequest) {
    cancelAutomaticCategory(state.recentCapture);
    drawQuickCategories();
  }
  showNewCategoryForm(byId("quick-form").hidden);
});
byId("category-single").addEventListener("click", () => changeQuickMode(false));
byId("category-multiple").addEventListener("click", () => changeQuickMode(true));
byId("quick-apply").addEventListener("click", () => {
  if (state.recentCapture?.multiple) void saveQuickCategories([...state.recentCapture.selected]);
});
byId("quick-more").addEventListener("click", () => {
  const capture = state.recentCapture;
  if (!capture) return;
  cancelAutomaticCategory(capture);
  capture.expanded = !capture.expanded;
  drawQuickCategories();
});
byId("quick-dismiss").addEventListener("click", () => finishCaptureInView("all"));
byId("capture-categories").addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!state.recentCapture?.saving) finishCaptureInView("all");
});
byId("capture-categories").addEventListener("close", () => {
  cancelAutomaticCategory(state.recentCapture);
  state.recentCapture = null;
  showNewCategoryForm(false);
});
byId("quick-form").addEventListener("submit", (event) => {
  event.preventDefault();
  createQuickCategory();
});
byId("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});
byId("clear-search").addEventListener("click", () => {
  byId("search").value = state.query = "";
  render();
  byId("search").focus();
});
const sortButton = byId("sort");
const sortOptions = byId("sort-options");
const sortChoices = [...sortOptions.querySelectorAll("[data-sort]")];

function setSortOpen(open, restoreFocus = false) {
  sortButton.setAttribute("aria-expanded", String(open));
  sortOptions.hidden = !open;
  if (restoreFocus) sortButton.focus({ preventScroll: true });
}

sortButton.addEventListener("click", () => setSortOpen(sortOptions.hidden));
for (const choice of sortChoices) {
  choice.addEventListener("click", () => {
    state.sort = choice.dataset.sort;
    for (const option of sortChoices) option.setAttribute("aria-pressed", String(option === choice));
    setSortOpen(false, true);
    render();
    byId("announcement").textContent = choice.textContent.trim() + "으로 정렬했어요.";
  });
}
const sortControl = byId("sort-control");
sortControl.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || sortOptions.hidden) return;
  event.preventDefault();
  setSortOpen(false, true);
});
sortControl.addEventListener("focusout", (event) => {
  if (event.relatedTarget && !sortControl.contains(event.relatedTarget)) setSortOpen(false);
});
document.addEventListener("click", (event) => {
  if (!sortOptions.hidden && !sortControl.contains(event.target)) setSortOpen(false);
});
byId("select").addEventListener("click", () => {
  state.selecting = !state.selecting;
  state.selected.clear();
  render();
});
byId("grid-view").addEventListener("click", (event) => {
  const compact = byId("notes").classList.toggle("is-compact");
  event.currentTarget.setAttribute("aria-pressed", String(compact));
});
byId("select-all").addEventListener("click", () => {
  const visible = visibleNotes();
  state.selected = state.selected.size === visible.length ? new Set() : new Set(visible.map(({ id }) => id));
  render();
});
byId("batch-tags").addEventListener("click", () => showTags([...state.selected]));
byId("batch-delete").addEventListener("click", () => {
  if (!state.selected.size) return;
  if (state.selected.size > maxBatch) {
    toast("한 번에 메모 400개까지 삭제할 수 있어요.", true);
    return;
  }
  batchDeleteIds = [...state.selected];
  byId("batch-delete-title").textContent = "선택한 메모 " + batchDeleteIds.length + "개를 삭제할까요?";
  openDialog("batch-delete-dialog");
});
byId("batch-delete-cancel").addEventListener("click", () => byId("batch-delete-dialog").close());
byId("batch-delete-dialog").addEventListener("cancel", (event) => {
  if (byId("batch-delete-cancel").disabled) event.preventDefault();
});
byId("batch-delete-dialog").addEventListener("close", () => { batchDeleteIds = []; });
byId("batch-delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!batchDeleteIds.length || form.querySelector("[type=submit]").disabled) return;
  const ids = batchDeleteIds;
  const store = state.store;
  const deleted = await save(() => store.removeMany(ids), form);
  if (!deleted || state.store !== store) return;
  const dialog = byId("batch-delete-dialog");
  state.selected.clear();
  render();
  dialog.close();
  byId("select").focus({ preventScroll: true });
  toast("메모 " + ids.length + "개를 삭제했어요.");
});
byId("add-tag").addEventListener("click", addDraftTag);
byId("new-tag").addEventListener("keydown", (event) => {
  if (!event.isComposing && event.key === "Enter" && event.currentTarget.value.trim()) {
    event.preventDefault();
    addDraftTag();
  }
});
byId("tag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dialog = byId("tag-dialog");
  addDraftTag();
  const changes = [...state.draftTags];
  const ids = state.tagIds;
  if (ids.length > maxBatch) {
    announce("한 번에 메모 400개까지 편집할 수 있어요.", dialog);
    return;
  }
  if (ids.length > 1 && state.notes.some((note) => ids.includes(note.id) && new Set([...note.tags, ...changes]).size > maxTags)) {
    announce("메모 하나에 분류를 20개까지 붙일 수 있어요.", dialog);
    return;
  }
  const result = await save(() => ids.length === 1
    ? state.store.update(ids[0], { tags: changes, updatedAt: Date.now() })
    : changes.length && state.store.addTags(ids, changes, Date.now()), event.currentTarget);
  if (result) {
    dialog.close();
    toast("분류를 적용했어요.");
  }
});
for (const id of ["edit-title", "edit-body"]) byId(id).addEventListener("input", updateEditorLinks);
byId("editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = byId("edit-title").value.trim();
  const body = editingStructure ? editStructure.getBody() : byId("edit-body").value.trim();
  if (editPhoto.pending || event.currentTarget.querySelector("button[type='submit']").disabled) return;
  if (!body && !editPhoto.attachment) {
    announce("내용을 적거나 사진을 추가해 주세요.", byId("editor"));
    return;
  }
  editStructure.setDisabled(true);
  const saved = await save(() => state.store.update(state.editingId, { title, body, updatedAt: Date.now() }, editPhoto.change), event.currentTarget);
  editStructure.setDisabled(false);
  if (saved) {
    byId("editor").close();
    toast("메모를 수정했어요.");
  }
});
byId("delete-note").addEventListener("click", () => {
  byId("delete-confirm").hidden = false;
  byId("cancel-delete").focus();
});
byId("cancel-delete").addEventListener("click", () => {
  byId("delete-confirm").hidden = true;
  byId("delete-note").focus();
});
byId("confirm-delete").addEventListener("click", async () => {
  if (await save(() => state.store.remove(state.editingId), byId("editor-form"))) {
    byId("editor").close();
    toast("메모를 삭제했어요.");
  }
});
for (const id of ["backup", "mobile-backup"]) {
  byId(id).addEventListener("click", () => openDialog("backup-dialog"));
}
byId("download").addEventListener("click", exportNotes);
byId("upload").addEventListener("click", () => byId("backup-file").click());
byId("backup-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  byId("upload").disabled = true;
  try { await importNotes(file); } finally { byId("upload").disabled = false; }
});
byId("photo-viewer-image").addEventListener("error", () => {
  byId("photo-viewer-image").hidden = true;
  const status = byId("photo-viewer-status");
  status.textContent = "이 사진을 표시할 수 없어요.";
  status.hidden = false;
});
byId("photo-viewer").addEventListener("close", () => {
  photoViewerRequest += 1;
  byId("photo-viewer-image").removeAttribute("src");
});
byId("editor").addEventListener("close", () => {
  editPhoto.reset();
  editingStructure = false;
  editStructure.reset();
});
byId("backup-dialog").addEventListener("close", () => {
  backupRequest += 1;
  setBackupBusy(false);
  clearBackupParts();
});
for (const dialog of document.querySelectorAll("dialog")) {
  for (const close of dialog.querySelectorAll("[data-close]")) close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const lastFocus = dialogFocus.get(dialog);
    if (lastFocus?.isConnected) lastFocus.focus();
    else if (lastFocus?.dataset.focusKey) {
      document.querySelector("[data-focus-key='" + CSS.escape(lastFocus.dataset.focusKey) + "']")?.focus();
    }
  });
}

function showWorkspace(show) {
  byId("workspace").hidden = !show;
  byId("capture-classification").hidden = !show;
  byId("rail-content").hidden = !show;
  byId("rail-footer").hidden = !show;
  byId("auth").hidden = show;
  updateAIExploreView();
}

function onNotes(notes, metadata) {
  const recentId = state.recentCapture?.id;
  if (recentId && state.notes.some(({ id }) => id === recentId) && !notes.some(({ id }) => id === recentId)) {
    cancelAutomaticCategory(state.recentCapture);
    state.recentCapture = null;
    showNewCategoryForm(false);
    if (byId("capture-categories").open) byId("capture-categories").close();
  }
  state.notes = notes;
  relatedNotes.notesChanged();
  if (metadata) {
    if (metadata.hasPendingWrites) setConnection("저장 중");
    else if (metadata.fromCache) setConnection("연결 확인 중", true);
    else setConnection("동기화 완료");
  }
  render();
}

function onStorageError(error) {
  setConnection("저장소 연결 오류", true);
  toast(error.code === "permission-denied"
    ? "이 계정의 메모 접근 권한을 확인해 주세요."
    : "메모를 불러오지 못했어요. 새로고침해 다시 시도해 주세요.", true);
}

function resetWorkspaceSession() {
  closeCategoryMenu();
  categoryPreferences.use(null);
  setCategorySortMode(false);
  renameCategoryFrom = null;
  categoryDrag = null;
  relatedNotes.reset();
  state.store?.disconnect();
  state.store = null;
  state.notes = [];
  cancelAutomaticCategory(state.recentCapture);
  state.recentCapture = null;
  resetClassificationWorker();
  showNewCategoryForm(false);
  state.selected.clear();
  state.selecting = false;
  state.view = "all";
  state.query = "";
  byId("search").value = "";
  byId("capture-body").value = "";
  byId("capture-title").value = "";
  captureStructure.reset();
  editStructure.reset();
  editingStructure = false;
  setCaptureMode("text");
  capturePhoto.reset();
  editPhoto.reset();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  setSortOpen(false);
  showPanel(false);
}

function showAccountScreen(screen, message) {
  byId("auth-title").textContent = screen === "verify-email" ? "이메일 인증" : "내 메모";
  byId("auth-caption").textContent = message;
  byId("login").hidden = screen !== "login";
  byId("verify-email").hidden = screen !== "verify-email";
}

function accountError(error, fallback) {
  if (error.code === "auth/network-request-failed") return "인터넷 연결을 확인해 주세요.";
  if (error.code === "auth/too-many-requests") return "요청이 많아요. 잠시 후 다시 시도해 주세요.";
  return fallback;
}

function connectAccounts(cloud) {
  const caption = byId("auth-caption");
  const verificationStatus = byId("verification-status");
  const send = byId("send-verification");
  const googleLogin = byId("google-login");
  const loginPrompt = "Google 계정으로 로그인하면 폰과 PC에서 같은 메모를 볼 수 있어요.";
  let session = 0;
  let activeUid;

  async function activateAccount(user) {
    const attempt = ++session;
    if (activeUid !== user?.uid) verificationStatus.textContent = "";
    activeUid = user?.uid;
    resetWorkspaceSession();
    showWorkspace(false);
    if (!user) {
      showAccountScreen("login", loginPrompt);
      return false;
    }
    if (!user.emailVerified) {
      showAccountScreen("loading", "계정을 확인하는 중이에요.");
      let allowed;
      try {
        allowed = await cloud.hasMemoAccess(user.uid);
      } catch {
        if (attempt === session) showAccountScreen("verify-email", "계정을 확인하지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
        return false;
      }
      if (attempt !== session) return false;
      if (!allowed) {
        showAccountScreen("verify-email", "인증 메일을 보내고 링크를 연 뒤 ‘인증했어요’를 눌러 주세요.");
        return false;
      }
    }
    categoryPreferences.use(user.uid);
    state.store = cloud.getStore(user.uid, onNotes, onStorageError);
    render();
    updateCaptureButton();
    setConnection("메모 불러오는 중");
    showWorkspace(true);
    return true;
  }

  async function sendVerification(user) {
    if (!user || send.disabled) return;
    send.disabled = true;
    verificationStatus.textContent = "인증 메일을 보내는 중이에요.";
    let message;
    try {
      await cloud.sendVerification(user);
      message = "인증 메일을 보냈어요. 보이지 않으면 스팸함을 확인해 주세요.";
    } catch (error) {
      message = accountError(error, "메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      send.disabled = false;
    }
    if (cloud.currentUser()?.uid === user.uid) verificationStatus.textContent = message;
  }

  googleLogin.addEventListener("click", async () => {
    googleLogin.disabled = true;
    caption.textContent = "Google 계정을 확인하는 중이에요.";
    try {
      await cloud.signInWithGoogle();
    } catch (error) {
      const messages = {
        "auth/popup-closed-by-user": "Google 로그인 창이 닫혔어요. 다시 시도해 주세요.",
        "auth/popup-blocked": "브라우저에서 팝업을 허용한 뒤 다시 눌러 주세요.",
        "auth/account-exists-with-different-credential": "기존 모아 계정에 연결하지 못했어요. 모아 문의처로 연락해 주세요.",
        "auth/unauthorized-domain": "Google 로그인을 사용할 수 있는 모아 메모장 주소인지 확인해 주세요.",
      };
      caption.textContent = accountError(error, messages[error.code] ?? "Google 로그인에 실패했어요. 다시 시도해 주세요.");
    } finally {
      googleLogin.disabled = false;
    }
  });

  send.addEventListener("click", () => void sendVerification(cloud.currentUser()));
  byId("check-verification").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const user = cloud.currentUser();
    if (!user) return;
    button.disabled = true;
    verificationStatus.textContent = "이메일 인증을 확인하고 있어요.";
    try {
      await cloud.refreshVerification(user);
      if (cloud.currentUser()?.uid !== user.uid) return;
      if (!await activateAccount(user) && cloud.currentUser()?.uid === user.uid) {
        verificationStatus.textContent = "아직 이메일 인증이 확인되지 않았어요.";
      }
    } catch (error) {
      if (cloud.currentUser()?.uid === user.uid) {
        verificationStatus.textContent = accountError(error, "인증 상태를 확인하지 못했어요. 다시 시도해 주세요.");
      }
    } finally {
      button.disabled = false;
    }
  });
  for (const id of ["signout", "mobile-signout", "verification-signout"]) {
    byId(id).hidden = false;
    byId(id).addEventListener("click", () => cloud.signOut().catch(() => toast("로그아웃을 다시 시도해 주세요.", true)));
  }
  cloud.observeAuth((user) => void activateAccount(user), () => {
    showAccountScreen("loading", "로그인 연결을 확인해 주세요.");
  });
}

async function start() {
  if (!firebaseConfig) {
    categoryPreferences.use("demo");
    state.store = localStore(onNotes, onStorageError);
    setConnection("이 기기에서 체험");
    showWorkspace(true);
    return;
  }
  try {
    connectAccounts(await openCloud(firebaseConfig));
  } catch {
    byId("auth-caption").textContent = "로그인 화면을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 열어 주세요.";
  }
}

capturePhoto.reset();
editPhoto.reset();
void start();

