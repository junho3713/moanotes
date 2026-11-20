import { relatedText, relatedCandidates } from "./semantic-search.js?v=18";

export function createRelatedNotes({ root, toggle, queryInput, getNotes, getWorker, openNote, delay = 700 }) {
  const status = root.querySelector("[data-related-status]");
  const find = root.querySelector("[data-related-find]");
  const retry = root.querySelector("[data-related-retry]");
  const results = root.querySelector("[data-related-results]");
  let enabled = false;
  let worker;
  let sequence = 0;
  let activeRequest = null;
  let timer;
  let timeout;
  let composing = false;
  let corpus = "";
  let suspended = true;

  function say(message, busy = false) {
    status.textContent = message;
    // Announce status updates without hiding the off switch during a long first index.
    results.setAttribute("aria-busy", String(busy));
    find.disabled = busy || composing;
  }

  function clearResults() {
    results.replaceChildren();
    results.hidden = true;
  }

  function cancel() {
    clearTimeout(timer);
    clearTimeout(timeout);
    timer = undefined;
    timeout = undefined;
    if (activeRequest !== null) worker?.postMessage({ task: "related-cancel", request: activeRequest });
    activeRequest = null;
    find.disabled = composing;
  }

  function idleMessage() {
    return "찾고 싶은 생각을 네 글자 이상 적어보세요.";
  }

  function fail() {
    cancel();
    clearResults();
    retry.hidden = false;
    say("관련 메모를 찾지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.");
  }

  function draw(matches) {
    clearResults();
    const notes = new Map(getNotes().map((note) => [note.id, note]));
    for (const { id } of matches.slice(0, 3)) {
      const note = notes.get(id);
      if (!note) continue;
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "related-note";
      const heading = document.createElement("span");
      heading.className = "related-note-title";
      heading.textContent = note.title || note.body.split(/\r?\n/u)[0] || "메모";
      const preview = document.createElement("span");
      preview.className = "related-note-preview";
      preview.textContent = note.body.slice(0, 180);
      button.append(heading, preview);
      button.addEventListener("click", () => {
        const current = getNotes().find((entry) => entry.id === id);
        if (current) openNote(current);
      });
      item.append(button);
      results.append(item);
    }
    results.hidden = !results.children.length;
    say(results.children.length ? "이전에 적어둔 생각과 연결해 보세요." : "지금 내용과 가까운 메모가 없어요.");
  }

  function search() {
    timer = undefined;
    if (!enabled || suspended || composing) return;
    const query = relatedText("", queryInput.value);
    const candidates = relatedCandidates(getNotes());
    if (query.length < 4 || !candidates.length) {
      say(!candidates.length ? "텍스트 메모를 저장하면 여기서 찾아볼 수 있어요." : "네 글자 이상 적으면 찾아드려요.");
      return;
    }
    retry.hidden = true;
    const request = "related-" + ++sequence;
    activeRequest = request;
    say("AI를 준비하고 관련 메모를 찾고 있어요.", true);
    try {
      worker = getWorker();
      worker.postMessage({ task: "related", request, query, notes: candidates });
      timeout = setTimeout(() => {
        if (activeRequest === request) fail();
      }, 180000);
    } catch {
      fail();
    }
  }

  function schedule() {
    cancel();
    clearResults();
    retry.hidden = true;
    if (!enabled || suspended || composing) {
      say(idleMessage());
      return;
    }
    timer = setTimeout(search, delay);
    say("입력을 멈추면 관련 메모를 찾아요.");
  }

  function receive({ data }) {
    if (data.task !== "related" || data.request !== activeRequest || !enabled || suspended) return;
    if (data.type === "progress") {
      say("메모를 비교하고 있어요. " + data.completed + " / " + data.total + "개", true);
      return;
    }
    if (data.type === "ready") {
      say("저장된 메모와 비교하고 있어요.", true);
      return;
    }
    if (data.type === "error") {
      fail();
      return;
    }
    if (data.type !== "result") return;
    clearTimeout(timeout);
    activeRequest = null;
    draw(data.matches);
  }

  toggle.addEventListener("click", () => {
    enabled = !enabled;
    toggle.setAttribute("aria-pressed", String(enabled));
    updatePanel();
    schedule();
    if (enabled && !suspended) queryInput.focus();
  });

  function findNow() {
    cancel();
    clearResults();
    retry.hidden = true;
    search();
  }

  find.addEventListener("click", findNow);
  retry.addEventListener("click", findNow);

  for (const input of [queryInput]) {
    input.addEventListener("input", schedule);
    input.addEventListener("compositionstart", () => { composing = true; schedule(); });
    input.addEventListener("compositionend", () => { composing = false; schedule(); });
  }

  function updatePanel() {
    root.hidden = !enabled || suspended;
    toggle.setAttribute("aria-expanded", String(!root.hidden));
  }

  updatePanel();
  say(idleMessage());
  return {
    receive,
    workerReset() {
      worker = undefined;
      if (activeRequest !== null) fail();
    },
    notesChanged() {
      const next = JSON.stringify(relatedCandidates(getNotes()));
      if (next === corpus) return;
      corpus = next;
      schedule();
    },
    setVisible(visible) {
      if (suspended === !visible) return;
      suspended = !visible;
      updatePanel();
      schedule();
    },
    reset() {
      cancel();
      worker = undefined;
      enabled = false;
      retry.hidden = true;
      composing = false;
      suspended = true;
      corpus = "";
      toggle.setAttribute("aria-pressed", "false");
      queryInput.value = "";
      updatePanel();
      clearResults();
      say(idleMessage());
    },
  };
}
