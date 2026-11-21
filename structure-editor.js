import {
  emptyStructure, encodeStructure, decodeStructure, structureHasContent,
  addStructureNode, removeStructureNodes, swipeDirection,
} from "./structure-model.js?v=28";

export function createStructureEditor({ root, onChange = () => {}, onSubmit = () => {} }) {
  root.innerHTML = `<div class="structure-toolbar">
      <div class="structure-format"><label>크기 <select class="structure-font-size" aria-label="선택한 칸 글자 크기"><option>10</option><option>11</option><option>12</option><option>13</option><option>14</option><option>16</option><option>18</option><option>20</option><option>24</option><option>28</option></select></label><button type="button" class="structure-bold" aria-label="선택한 칸 굵게" aria-pressed="false" title="굵게">B</button></div>
      <div class="structure-actions"><button type="button" class="plain-btn structure-undo" disabled>실행 취소</button><button type="button" class="plain-btn structure-delete-toggle" aria-pressed="false">칸 삭제</button><button type="button" class="danger structure-delete-confirm" hidden disabled>선택 삭제</button></div>
    </div>
    <div class="structure-selection-bar" hidden><span>삭제할 칸을 체크해 주세요.</span><button type="button" class="plain-btn structure-select-all">전체 선택</button></div>
    <p class="structure-help">칸을 선택하면 글자 크기와 굵기를 바꿀 수 있어요.</p>
    <p class="structure-touch-help">칸을 선택한 뒤 오른쪽·아래로 밀어도 추가돼요. 한 번 더 누르면 글을 쓸 수 있어요.</p>
    <div class="structure-scroll" tabindex="0" aria-label="구조 메모 작업 공간"><div class="structure-stage"><svg class="structure-links" aria-hidden="true"></svg><div class="structure-nodes"></div><div class="structure-preview" hidden></div></div></div>
    <p class="structure-status" role="status" aria-live="polite"></p>`;
  const scroll = root.querySelector(".structure-scroll");
  const stage = root.querySelector(".structure-stage");
  const layer = root.querySelector(".structure-nodes");
  const svg = root.querySelector(".structure-links");
  const ghost = root.querySelector(".structure-preview");
  const undo = root.querySelector(".structure-undo");
  const fontSize = root.querySelector(".structure-font-size");
  const bold = root.querySelector(".structure-bold");
  const deleteToggle = root.querySelector(".structure-delete-toggle");
  const deleteConfirm = root.querySelector(".structure-delete-confirm");
  const selectionBar = root.querySelector(".structure-selection-bar");
  const selectAll = root.querySelector(".structure-select-all");
  const status = root.querySelector(".structure-status");
  const ns = "http://www.w3.org/2000/svg";
  let documentValue = emptyStructure();
  let history = [];
  let selected = null;
  let editing = null;
  let textGroup = null;
  let gesture = null;
  let firstTouch = null;
  let ignoreClickUntil = 0;
  let disabled = false;
  let deleteMode = false;
  const deleteSelection = new Set();
  let metrics;

  function message(text = "") { status.textContent = text; }
  function syncControls() {
    const node = documentValue.nodes.find(({ id }) => id === selected);
    undo.disabled = disabled || !history.length;
    fontSize.disabled = bold.disabled = disabled || deleteMode || !node;
    fontSize.value = String(node?.fontSize ?? (window.matchMedia("(max-width: 740px)").matches ? 12 : 13));
    bold.setAttribute("aria-pressed", String(Boolean(node?.bold)));
    deleteToggle.disabled = disabled;
    deleteToggle.setAttribute("aria-pressed", String(deleteMode));
    deleteToggle.textContent = deleteMode ? "삭제 취소" : "칸 삭제";
    deleteConfirm.hidden = !deleteMode;
    deleteConfirm.disabled = disabled || !deleteSelection.size;
    deleteConfirm.textContent = "선택 삭제" + (deleteSelection.size ? " (" + deleteSelection.size + ")" : "");
    selectionBar.hidden = !deleteMode;
    selectAll.textContent = deleteSelection.size === documentValue.nodes.length ? "전체 선택 해제" : "전체 선택";
    root.classList.toggle("is-delete-mode", deleteMode);
  }
  function changed() { syncControls(); onChange(); }
  function remember() {
    history.push(structuredClone(documentValue));
    if (history.length > 40) history.shift();
    textGroup = null;
  }
  function measure() {
    const compact = window.matchMedia("(max-width: 740px)").matches;
    metrics = { w: compact ? 60 : 100, h: (compact ? 110 : 120) / 2, x: (compact ? 48 : 64) * 2 / 3, y: 56 * 2 / 3, pad: 36 };
    return metrics;
  }
  function position(node) {
    return { x: metrics.pad + node.col * (metrics.w + metrics.x), y: metrics.pad + node.row * (metrics.h + metrics.y) };
  }
  function connector(from, to, direction) {
    const a = position(from), b = position(to);
    if (direction === "right") {
      const x1 = a.x + metrics.w, y1 = a.y + metrics.h / 2, x2 = b.x, y2 = b.y + metrics.h / 2;
      const mid = (x1 + x2) / 2;
      return `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
    }
    const x1 = a.x + metrics.w / 2, y1 = a.y + metrics.h, x2 = b.x + metrics.w / 2, y2 = b.y;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`;
  }
  function layout(extra = null) {
    measure();
    const nodes = extra ? [...documentValue.nodes, extra] : documentValue.nodes;
    const width = Math.max(scroll.clientWidth || 0, ...nodes.map((node) => position(node).x + metrics.w + metrics.pad));
    const height = Math.max(380, ...nodes.map((node) => position(node).y + metrics.h + metrics.pad));
    stage.style.width = width + "px";
    stage.style.height = height + "px";
    stage.style.setProperty("--structure-node-width", metrics.w + "px");
    stage.style.setProperty("--structure-node-height", metrics.h + "px");
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    for (const node of documentValue.nodes) {
      const card = [...layer.children].find((card) => card.dataset.id === node.id);
      if (!card) continue;
      const p = position(node);
      card.style.left = p.x + "px";
      card.style.top = p.y + "px";
    }
    svg.replaceChildren();
    for (const edge of documentValue.edges) {
      const from = documentValue.nodes.find(({ id }) => id === edge.from);
      const to = documentValue.nodes.find(({ id }) => id === edge.to);
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", connector(from, to, edge.direction));
      svg.append(path);
    }
  }
  function preview(id, direction) {
    if (!direction) { ghost.hidden = true; layout(); return; }
    const from = documentValue.nodes.find((node) => node.id === id);
    const next = { ...from, col: from.col + (direction === "right" ? 1 : 0), row: from.row + (direction === "down" ? 1 : 0) };
    layout(next);
    const p = position(next);
    ghost.style.left = p.x + "px";
    ghost.style.top = p.y + "px";
    ghost.hidden = false;
    const path = document.createElementNS(ns, "path");
    path.classList.add("structure-preview-link");
    path.setAttribute("d", connector(from, next, direction));
    svg.append(path);
  }
  function select(id) {
    selected = id;
    for (const card of layer.children) {
      card.classList.toggle("is-selected", card.dataset.id === id);
      card.querySelector(".structure-text").setAttribute("aria-pressed", String(card.dataset.id === id));
    }
    syncControls();
  }
  function finishEdit(id) {
    const card = [...layer.children].find((card) => card.dataset.id === id);
    if (!card) return;
    const read = card.querySelector(".structure-text");
    const node = documentValue.nodes.find((node) => node.id === id);
    read.querySelector(".structure-read-label").textContent = node.text || "내용을 적어보세요";
    read.hidden = false;
    card.querySelector("textarea").hidden = true;
    card.classList.remove("is-editing");
    if (editing === id) editing = null;
    textGroup = null;
  }
  function beginEdit(id) {
    if (disabled || deleteMode) return;
    if (editing && editing !== id) finishEdit(editing);
    select(id);
    const card = [...layer.children].find((card) => card.dataset.id === id);
    card.querySelector(".structure-text").hidden = true;
    const input = card.querySelector("textarea");
    input.hidden = false;
    card.classList.add("is-editing");
    editing = id;
    input.focus({ preventScroll: true });
  }
  function add(id, direction) {
    if (disabled || deleteMode) return;
    try {
      const result = addStructureNode(documentValue, id, direction);
      remember();
      documentValue = result.document;
      selected = result.addedId;
      render();
      const card = [...layer.children].find((card) => card.dataset.id === selected);
      card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      card.querySelector(".structure-text").focus({ preventScroll: true });
      changed();
      message(direction === "right" ? "오른쪽에 칸을 추가했어요." : "아래에 칸을 추가했어요.");
    } catch (error) { message(error.message); }
  }
  function removeSelected() {
    if (disabled || !deleteMode || !deleteSelection.size) return;
    const count = deleteSelection.size;
    const next = removeStructureNodes(documentValue, deleteSelection);
    remember();
    documentValue = next;
    selected = null;
    deleteMode = false;
    deleteSelection.clear();
    render();
    changed();
    message(count + "개 칸을 삭제했어요. 실행 취소로 되돌릴 수 있어요.");
    undo.focus({ preventScroll: true });
  }
  function action(label, className, handler, symbol) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.structureAction = "true";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (symbol) {
      const icon = document.createElementNS(ns, "svg");
      icon.setAttribute("class", "icon"); icon.setAttribute("aria-hidden", "true");
      const use = document.createElementNS(ns, "use"); use.setAttribute("href", "#i-" + symbol);
      icon.append(use); button.append(icon);
    }
    button.addEventListener("click", (event) => { event.stopPropagation(); if (!disabled) handler(); });
    return button;
  }
  function render() {
    editing = null; gesture = null; firstTouch = null; ghost.hidden = true;
    layer.replaceChildren(...documentValue.nodes.map((node, index) => {
      const card = document.createElement("div");
      card.className = "structure-node" + (node.row === 0 ? " is-main" : "");
      card.dataset.id = node.id;
      if (node.fontSize !== undefined) card.style.setProperty("--structure-font-size", node.fontSize + "px");
      card.style.setProperty("--structure-font-weight", node.bold ? "700" : "400");
      card.setAttribute("role", "group"); card.setAttribute("aria-label", (index + 1) + "번째 칸");
      const read = document.createElement("button");
      read.type = "button"; read.className = "structure-text";
      const label = document.createElement("span");
      label.className = "structure-read-label";
      label.textContent = node.text || "내용을 적어보세요";
      read.append(label);
      read.setAttribute("aria-label", "칸 편집: " + (node.text.slice(0, 80) || "빈 칸"));
      read.addEventListener("click", (event) => {
        if (disabled) return;
        if (deleteMode) { toggleDelete(node.id); return; }
        if (Date.now() < ignoreClickUntil) return;
        if (firstTouch === node.id) { firstTouch = null; select(node.id); return; }
        beginEdit(node.id);
      });
      const input = document.createElement("textarea");
      input.className = "structure-input"; input.value = node.text;
      input.maxLength = 1000; input.hidden = true; input.setAttribute("aria-label", (index + 1) + "번째 칸 내용");
      input.addEventListener("input", () => {
        const current = documentValue.nodes.find(({ id }) => id === node.id);
        const next = structuredClone(documentValue);
        next.nodes.find(({ id }) => id === node.id).text = input.value;
        try { encodeStructure(next); } catch (error) { input.value = current.text; message(error.message); return; }
        if (textGroup !== node.id) { remember(); textGroup = node.id; }
        documentValue = next;
        read.setAttribute("aria-label", "칸 편집: " + (input.value.slice(0, 80) || "빈 칸"));
        changed(); message();
      });
      input.addEventListener("blur", () => finishEdit(node.id));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); finishEdit(node.id); read.focus(); }
        if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSubmit(); }
      });
      const right = action("오른쪽 칸 추가", "structure-arrow structure-right", () => add(node.id, "right"));
      const down = action("아래 칸 추가", "structure-arrow structure-down", () => add(node.id, "down"));
      const check = document.createElement("input");
      check.type = "checkbox"; check.className = "structure-delete-check";
      check.checked = deleteSelection.has(node.id); check.hidden = !deleteMode;
      check.setAttribute("aria-label", (index + 1) + "번째 칸 삭제 선택");
      check.addEventListener("change", () => toggleDelete(node.id, check.checked));
      card.append(read, input, right, down, check);
      card.classList.toggle("is-delete-selected", deleteSelection.has(node.id));
      card.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" || disabled || deleteMode || editing || event.target.closest("[data-structure-action]") || event.target.tagName === "TEXTAREA") return;
        const wasSelected = selected === node.id;
        firstTouch = wasSelected ? null : node.id;
        select(node.id);
        if (wasSelected) gesture = { id: node.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
      });
      card.addEventListener("pointermove", (event) => {
        if (!gesture || gesture.pointer !== event.pointerId) return;
        gesture.dx = event.clientX - gesture.x; gesture.dy = event.clientY - gesture.y;
        if (Math.hypot(gesture.dx, gesture.dy) < 12) return;
        event.preventDefault();
        try { card.setPointerCapture(event.pointerId); } catch {}
        preview(node.id, swipeDirection(gesture.dx, gesture.dy, 20));
      }, { passive: false });
      card.addEventListener("pointerup", (event) => {
        if (!gesture || gesture.pointer !== event.pointerId) return;
        const direction = swipeDirection(gesture.dx, gesture.dy);
        if (Math.hypot(gesture.dx, gesture.dy) >= 12) ignoreClickUntil = Date.now() + 500;
        gesture = null; preview(node.id, null);
        if (direction) add(node.id, direction);
      });
      card.addEventListener("pointercancel", () => { gesture = null; preview(node.id, null); });
      return card;
    }));
    select(selected);
    layout();
    syncControls();
  }
  function toggleDelete(id, checked = !deleteSelection.has(id)) {
    if (!deleteMode || disabled) return;
    if (checked) deleteSelection.add(id); else deleteSelection.delete(id);
    for (const card of layer.children) {
      const selectedForDeletion = deleteSelection.has(card.dataset.id);
      card.classList.toggle("is-delete-selected", selectedForDeletion);
      card.querySelector(".structure-delete-check").checked = selectedForDeletion;
    }
    syncControls();
  }
  function setDeleteMode(value) {
    if (disabled) return;
    if (editing) finishEdit(editing);
    deleteMode = value;
    deleteSelection.clear();
    render();
    message(value ? "삭제할 칸을 체크한 뒤 선택 삭제를 눌러 주세요." : "");
  }
  function applyFormat(patch) {
    if (disabled || deleteMode || !selected) return;
    if (editing) finishEdit(editing);
    const next = structuredClone(documentValue);
    Object.assign(next.nodes.find(({ id }) => id === selected), patch);
    try { encodeStructure(next); } catch (error) { message(error.message); syncControls(); return; }
    remember(); documentValue = next;
    render(); changed(); message("선택한 칸의 글자 모양을 바꿨어요.");
  }
  fontSize.addEventListener("change", () => applyFormat({ fontSize: Number(fontSize.value) }));
  bold.addEventListener("click", () => {
    const node = documentValue.nodes.find(({ id }) => id === selected);
    if (node) applyFormat({ bold: !node.bold });
  });
  deleteToggle.addEventListener("click", () => setDeleteMode(!deleteMode));
  deleteConfirm.addEventListener("click", removeSelected);
  selectAll.addEventListener("click", () => {
    const select = deleteSelection.size !== documentValue.nodes.length;
    for (const node of documentValue.nodes) toggleDelete(node.id, select);
  });
  undo.addEventListener("click", () => {
    if (disabled || !history.length) return;
    documentValue = history.pop(); textGroup = null; selected = null; deleteMode = false; deleteSelection.clear();
    render(); changed(); message("이전 상태로 되돌렸어요.");
  });
  scroll.addEventListener("keydown", (event) => {
    if (event.target.tagName === "TEXTAREA") return;
    if (event.key === "Delete" && selected) { event.preventDefault(); setDeleteMode(true); }
    if (event.key === "Escape" && deleteMode) { event.preventDefault(); setDeleteMode(false); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo.click(); }
  });
  window.addEventListener("resize", () => { if (!root.hidden) layout(); });
  render();
  return {
    getBody: () => encodeStructure(documentValue),
    getDocument: () => structuredClone(documentValue),
    hasContent: () => structureHasContent(documentValue),
    refresh: () => layout(),
    setDisabled(value) { disabled = value; root.inert = value; if (value && editing) finishEdit(editing); syncControls(); },
    load(value) {
      const parsed = typeof value === "string" ? decodeStructure(value) : decodeStructure(encodeStructure(value));
      if (!parsed) throw new Error("구조 메모를 읽을 수 없어요.");
      documentValue = parsed; history = []; selected = null; textGroup = null; deleteMode = false; deleteSelection.clear();
      render(); message(); changed();
    },
    reset() { documentValue = emptyStructure(); history = []; selected = null; textGroup = null; deleteMode = false; deleteSelection.clear(); render(); message(); changed(); },
  };
}
