import {
  emptyStructure, encodeStructure, decodeStructure, structureHasContent,
  addStructureNode, removeStructureNode, swipeDirection,
} from "./structure-model.js?v=25";

export function createStructureEditor({ root, onChange = () => {}, onSubmit = () => {} }) {
  root.innerHTML = `<div class="structure-toolbar"><span class="structure-help">칸을 눌러 입력하고, 화살표로 생각을 이어보세요.</span><button type="button" class="plain-btn structure-undo" disabled>실행 취소</button></div>
    <p class="structure-touch-help">칸을 선택한 뒤 오른쪽·아래로 밀어도 추가돼요. 한 번 더 누르면 글을 쓸 수 있어요.</p>
    <div class="structure-scroll" tabindex="0" aria-label="구조 메모 작업 공간"><div class="structure-stage"><svg class="structure-links" aria-hidden="true"></svg><div class="structure-nodes"></div><div class="structure-preview" hidden></div></div></div>
    <p class="structure-status" role="status" aria-live="polite"></p>`;
  const scroll = root.querySelector(".structure-scroll");
  const stage = root.querySelector(".structure-stage");
  const layer = root.querySelector(".structure-nodes");
  const svg = root.querySelector(".structure-links");
  const ghost = root.querySelector(".structure-preview");
  const undo = root.querySelector(".structure-undo");
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
  let metrics;

  function message(text = "") { status.textContent = text; }
  function changed() { undo.disabled = disabled || !history.length; onChange(); }
  function remember() {
    history.push(structuredClone(documentValue));
    if (history.length > 40) history.shift();
    textGroup = null;
  }
  function measure() {
    const compact = window.matchMedia("(max-width: 740px)").matches;
    metrics = { w: (compact ? 180 : 220) / 3, h: (compact ? 110 : 120) / 2, x: (compact ? 48 : 64) * 2 / 3, y: 56 * 2 / 3, pad: 36 };
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
      if (card.dataset.id !== id) card.querySelector(".structure-node-menu").hidden = true;
    }
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
    if (disabled) return;
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
    if (disabled) return;
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
  function remove(id) {
    if (disabled) return;
    const next = removeStructureNode(documentValue, id);
    remember();
    documentValue = next;
    selected = null;
    render();
    changed();
    message("칸을 삭제했어요. 실행 취소로 되돌릴 수 있어요.");
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
      card.setAttribute("role", "group"); card.setAttribute("aria-label", (index + 1) + "번째 칸");
      const read = document.createElement("button");
      read.type = "button"; read.className = "structure-text";
      const label = document.createElement("span");
      label.className = "structure-read-label";
      label.textContent = node.text || "내용을 적어보세요";
      read.append(label);
      read.setAttribute("aria-label", "칸 편집: " + (node.text.slice(0, 80) || "빈 칸"));
      read.addEventListener("click", (event) => {
        if (disabled || Date.now() < ignoreClickUntil) return;
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
      const menu = document.createElement("div"); menu.className = "structure-node-menu"; menu.hidden = true;
      const removeButton = action("이 칸만 삭제", "structure-remove", () => remove(node.id)); removeButton.textContent = "칸 삭제";
      menu.append(removeButton);
      const more = action("칸 메뉴", "icon-btn structure-more", () => { select(node.id); menu.hidden = !menu.hidden; more.setAttribute("aria-expanded", String(!menu.hidden)); }, "more");
      more.setAttribute("aria-expanded", "false");
      card.append(read, input, right, down, more, menu);
      card.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" || disabled || editing || event.target.closest("[data-structure-action]") || event.target.tagName === "TEXTAREA") return;
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
    undo.disabled = disabled || !history.length;
  }
  undo.addEventListener("click", () => {
    if (disabled || !history.length) return;
    documentValue = history.pop(); textGroup = null; selected = null;
    render(); changed(); message("이전 상태로 되돌렸어요.");
  });
  scroll.addEventListener("keydown", (event) => {
    if (event.target.tagName === "TEXTAREA") return;
    if (event.key === "Delete" && selected) { event.preventDefault(); remove(selected); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo.click(); }
  });
  window.addEventListener("resize", () => { if (!root.hidden) layout(); });
  render();
  return {
    getBody: () => encodeStructure(documentValue),
    getDocument: () => structuredClone(documentValue),
    hasContent: () => structureHasContent(documentValue),
    refresh: () => layout(),
    setDisabled(value) { disabled = value; root.inert = value; if (value && editing) finishEdit(editing); undo.disabled = value || !history.length; },
    load(value) {
      const parsed = typeof value === "string" ? decodeStructure(value) : decodeStructure(encodeStructure(value));
      if (!parsed) throw new Error("구조 메모를 읽을 수 없어요.");
      documentValue = parsed; history = []; selected = null; textGroup = null;
      render(); message(); changed();
    },
    reset() { documentValue = emptyStructure(); history = []; selected = null; textGroup = null; render(); message(); changed(); },
  };
}
