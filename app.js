import { firebaseConfig } from "./firebase-config.js";
import { localStore, openCloud } from "./storage.js?v=6";
import { maxPhotoBytes, maxThumbnailBytes, photoParts, preparePhoto } from "./images.js?v=6";

const byId = (id) => document.getElementById(id);
const maxTags = 20;
const maxBatch = 400;
const maxTitleLength = 120;
const maxBackupBytes = 32 * 1024 * 1024;
const state = {
  notes: [], view: "all", query: "", oldestFirst: false,
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
const dateLabel = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "long", day: "numeric", weekday: "long" });
const noteDate = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "numeric", day: "numeric" });
const fullDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
let toastTimer;
const dialogFocus = new WeakMap();
let capturePending = false;
let batchDeleteIds = [];
let photoViewerRequest = 0;
let backupRequest = 0;
const backupUrls = [];

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

function chooseView(id) {
  state.view = id;
  state.selected.clear();
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
  const desktop = [], mobile = [];
  for (const folder of folders) {
    const count = state.notes.filter(folder.test).length;
    desktop.push(navigationItem(folder.id, folder.text, count, icon(folder.icon), false));
    mobile.push(navigationItem(folder.id, folder.text, count, undefined, true));
  }
  byId("folders").replaceChildren(...desktop);
  const topicItems = [];
  for (const [tag, count] of tags) {
    topicItems.push(navigationItem("tag:" + tag, tag, count, node("span", "topic-dot " + palette(tag)), false));
    mobile.push(navigationItem("tag:" + tag, tag, count, undefined, true));
  }
  byId("topics").replaceChildren(...topicItems);
  byId("topics").closest(".rail-topics").hidden = tags.length === 0;
  byId("mobile-nav").replaceChildren(...mobile);
}

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

function showNewCategoryForm(show) {
  byId("quick-form").hidden = !show;
  byId("quick-new").setAttribute("aria-expanded", String(show));
  if (show) byId("quick-name").focus();
  else byId("quick-name").value = "";
}

function viewCategory(category) {
  const dialog = byId("capture-categories");
  if (dialog.open) dialog.close();
  state.query = "";
  byId("search").value = "";
  chooseView("tag:" + category);
  byId("list-title").scrollIntoView({ block: "nearest" });
}

function drawQuickCategories() {
  const capture = state.recentCapture;
  if (!capture) return;
  const categories = [...new Set([...capture.newCategories, ...recentCategories()])];
  const status = byId("capture-category-status");
  const message = capture.saving ? "분류에 추가하는 중이에요." : "메모를 저장했어요.";
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

async function saveQuickCategories(categories, destination) {
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
    viewCategory(destination);
    toast("‘" + destination + "’에 추가했어요.");
  } else {
    dialog.close();
    chooseView("all");
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
  capture.multiple = multiple;
  byId("capture-categories").querySelector(".dialog-feedback")?.remove();
  drawQuickCategories();
}

function visibleNotes() {
  const folder = folders.find(({ id }) => id === state.view);
  const matchesView = folder ? folder.test : (note) => note.tags.includes(state.view.slice(4));
  const terms = normalize(state.query).split(/\s+/u).filter(Boolean);
  return state.notes.filter((note) => {
    if (!matchesView(note)) return false;
    const haystack = normalize([note.title, note.body, note.thumbnail ? "사진" : "", ...note.tags].join(" "));
    return terms.every((term) => haystack.includes(term));
  }).sort((a, b) => (state.oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt)
    || a.id.localeCompare(b.id));
}

function drawNote(note) {
  const article = node("article", "note");
  const checked = state.selecting && state.selected.has(note.id);
  article.classList.toggle("checked", checked);
  const meta = node("div", "note-meta");
  const date = node("time", "", noteDate.format(note.createdAt));
  date.dateTime = new Date(note.createdAt).toISOString();
  date.title = fullDate.format(note.createdAt);
  const [firstLine, ...rest] = note.body.split(/\r?\n/u);
  const title = note.title || firstLine || "사진 메모";
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
  const preview = (note.title ? note.body : rest.join("\n")).trim();
  if (preview) content.append(node("span", "note-snippet", preview));
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
  article.append(meta, content, foot);
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

function showEditor(note) {
  state.editingId = note.id;
  byId("edit-title").value = note.title ?? "";
  byId("edit-body").value = note.body;
  editPhoto.reset(photoParts(note.thumbnail, maxThumbnailBytes) ? { id: note.id, thumbnail: note.thumbnail } : null);
  byId("delete-confirm").hidden = true;
  openDialog("editor");
  byId("edit-body").focus();
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
    || (!byId("capture-body").value.trim() && !capturePhoto.attachment);
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
  void photo.choose(file);
});

byId("today").textContent = dateLabel.format(new Date());
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
  const draft = input.value;
  const body = draft.trim();
  const photo = capturePhoto.attachment;
  if ((!body && !photo) || byId("capture-submit").disabled) return;
  capturePending = true;
  const store = state.store;
  let id;
  const saved = await save(async () => { id = await store.add(noteData(body, titleDraft.trim()), photo); }, event.currentTarget);
  capturePending = false;
  if (saved && state.store === store) {
    if (input.value === draft) input.value = "";
    if (titleInput.value === titleDraft) titleInput.value = "";
    capturePhoto.reset();
    showNewCategoryForm(false);
    state.recentCapture = {
      id, multiple: false, selected: new Set(), newCategories: [], saving: false, expanded: false,
    };
    state.query = "";
    byId("search").value = "";
    chooseView("all");
    openDialog("capture-categories");
  }
  updateCaptureButton();
});
byId("quick-new").addEventListener("click", () => showNewCategoryForm(byId("quick-form").hidden));
byId("category-single").addEventListener("click", () => changeQuickMode(false));
byId("category-multiple").addEventListener("click", () => changeQuickMode(true));
byId("quick-apply").addEventListener("click", () => {
  if (state.recentCapture?.multiple) void saveQuickCategories([...state.recentCapture.selected]);
});
byId("quick-more").addEventListener("click", () => {
  const capture = state.recentCapture;
  if (!capture) return;
  capture.expanded = !capture.expanded;
  drawQuickCategories();
});
byId("quick-dismiss").addEventListener("click", () => byId("capture-categories").close());
byId("capture-categories").addEventListener("cancel", (event) => {
  if (state.recentCapture?.saving) event.preventDefault();
});
byId("capture-categories").addEventListener("close", () => {
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
byId("sort").addEventListener("click", (event) => {
  state.oldestFirst = !state.oldestFirst;
  const label = state.oldestFirst ? "최근 메모부터 보기" : "오래된 메모부터 보기";
  event.currentTarget.setAttribute("aria-label", label);
  event.currentTarget.setAttribute("aria-pressed", String(state.oldestFirst));
  event.currentTarget.title = label;
  render();
  byId("announcement").textContent = state.oldestFirst ? "오래된 순으로 정렬했어요." : "최근 순으로 정렬했어요.";
});
byId("select").addEventListener("click", () => {
  state.selecting = !state.selecting;
  state.selected.clear();
  render();
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
byId("editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = byId("edit-title").value.trim();
  const body = byId("edit-body").value.trim();
  if (editPhoto.pending || event.currentTarget.querySelector("button[type='submit']").disabled) return;
  if (!body && !editPhoto.attachment) {
    announce("내용을 적거나 사진을 추가해 주세요.", byId("editor"));
    return;
  }
  if (await save(() => state.store.update(state.editingId, { title, body, updatedAt: Date.now() }, editPhoto.change), event.currentTarget)) {
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
byId("editor").addEventListener("close", () => editPhoto.reset());
byId("backup-dialog").addEventListener("close", () => {
  backupRequest += 1;
  setBackupBusy(false);
  clearBackupParts();
});
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
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
  byId("rail-content").hidden = !show;
  byId("rail-footer").hidden = !show;
  byId("auth").hidden = show;
}

function onNotes(notes, metadata) {
  const recentId = state.recentCapture?.id;
  if (recentId && state.notes.some(({ id }) => id === recentId) && !notes.some(({ id }) => id === recentId)) {
    state.recentCapture = null;
    showNewCategoryForm(false);
    if (byId("capture-categories").open) byId("capture-categories").close();
  }
  state.notes = notes;
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

async function start() {
  if (!firebaseConfig) {
    state.store = localStore(onNotes, onStorageError);
    setConnection("이 기기에서 체험");
    showWorkspace(true);
    return;
  }
  try {
    const cloud = await openCloud(firebaseConfig);
    for (const id of ["signout", "mobile-signout"]) {
      byId(id).hidden = false;
      byId(id).addEventListener("click", () => cloud.signOut().catch(() => toast("로그아웃을 다시 시도해 주세요.", true)));
    }
    byId("login").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector("button");
      submit.disabled = true;
      byId("auth-caption").textContent = "로그인하는 중이에요.";
      try {
        await cloud.signIn(byId("email").value.trim(), byId("password").value);
        byId("password").value = "";
      } catch (error) {
        byId("auth-caption").textContent = error.code === "auth/network-request-failed"
          ? "인터넷 연결을 확인해 주세요." : "이메일과 비밀번호를 확인해 주세요.";
      } finally {
        submit.disabled = false;
      }
    });
    cloud.observeAuth((user) => {
      state.store?.disconnect();
      state.store = null;
      state.notes = [];
      state.recentCapture = null;
      showNewCategoryForm(false);
      state.selected.clear();
      state.view = "all";
      state.query = "";
      byId("search").value = "";
      byId("capture-body").value = "";
      byId("capture-title").value = "";
      capturePhoto.reset();
      editPhoto.reset();
      updateCaptureButton();
      for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
      if (!user) {
        showWorkspace(false);
        byId("auth-caption").textContent = "로그인하면 폰과 PC에서 같은 메모를 볼 수 있어요.";
        byId("login").hidden = false;
        return;
      }
      state.store = cloud.getStore(user.uid, onNotes, onStorageError);
      render();
      setConnection("메모 불러오는 중");
      showWorkspace(true);
    }, () => { byId("auth-caption").textContent = "로그인 연결을 확인해 주세요."; });
  } catch {
    byId("auth-caption").textContent = "로그인 화면을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 열어 주세요.";
  }
}

capturePhoto.reset();
editPhoto.reset();
void start();
