import { rankRelated } from "./semantic-search.js?v=18";

const libraryUrl = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const model = "Xenova/multilingual-e5-small";
const revision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const exampleVectors = new Map();
const noteVectors = new Map();
const classificationQueue = [];
let encoder;
let processing = false;
let pendingRelated;
let latestRelated;

async function loadEncoder() {
  if (!encoder) {
    encoder = (async () => {
      const { env, pipeline } = await import(libraryUrl);
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      return pipeline("feature-extraction", model, { device: "wasm", dtype: "q8", revision });
    })().catch((error) => {
      encoder = undefined;
      throw error;
    });
  }
  return encoder;
}

async function rankCategories({ request, query, examples }) {
  const encode = await loadEncoder();
  self.postMessage({ request, type: "ready" });
  const passages = examples.map(({ text }) => "passage: " + text);
  const missing = [...new Set(passages)].filter((text) => !exampleVectors.has(text));
  const encoded = await encode(["query: " + query, ...missing], { pooling: "mean", normalize: true });
  const [queryVector, ...newVectors] = encoded.tolist();
  missing.forEach((text, index) => exampleVectors.set(text, newVectors[index]));

  const scores = new Map();
  examples.forEach(({ category }, index) => {
    const vector = exampleVectors.get(passages[index]);
    const similarity = queryVector.reduce((sum, value, i) => sum + value * vector[i], 0);
    scores.set(category, Math.max(scores.get(category) ?? -1, similarity));
  });
  while (exampleVectors.size > 100) exampleVectors.delete(exampleVectors.keys().next().value);
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  self.postMessage({ request, type: "result", ranked });
}

async function rankNotes(data) {
  const { request, query, notes } = data;
  const current = () => latestRelated === request;
  const send = (message) => self.postMessage({ task: "related", request, ...message });
  const encode = await loadEncoder();
  if (!current()) return;
  send({ type: "ready" });
  const texts = new Map(notes.map(({ id, text }) => [id, text]));
  for (const [id, cached] of noteVectors) {
    if (texts.get(id) !== cached.text) noteVectors.delete(id);
  }
  const missing = notes.filter(({ id }) => !noteVectors.has(id));
  let completed = notes.length - missing.length;
  send({ type: "progress", completed, total: notes.length });
  for (let start = 0; start < missing.length; start += 8) {
    if (!current()) return;
    if (classificationQueue.length) {
      if (!pendingRelated) pendingRelated = data;
      return;
    }
    const batch = missing.slice(start, start + 8);
    const encoded = await encode(batch.map(({ text }) => "passage: " + text), { pooling: "mean", normalize: true });
    if (!current()) return;
    const vectors = encoded.tolist();
    batch.forEach(({ id, text }, index) => noteVectors.set(id, { text, vector: vectors[index] }));
    completed += batch.length;
    send({ type: "progress", completed, total: notes.length });
    // Allow cancellation/new input to replace a long initial index between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!current()) return;
  if (classificationQueue.length) {
    if (!pendingRelated) pendingRelated = data;
    return;
  }
  const encoded = await encode(["query: " + query], { pooling: "mean", normalize: true });
  if (!current()) return;
  send({ type: "result", matches: rankRelated(encoded.tolist()[0], notes, noteVectors) });
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (classificationQueue.length || pendingRelated) {
      const data = classificationQueue.length ? classificationQueue.shift() : pendingRelated;
      if (data.task === "related") pendingRelated = undefined;
      try {
        if (data.task === "related") await rankNotes(data);
        else await rankCategories(data);
      } catch {
        self.postMessage({ request: data.request, task: data.task, type: "error" });
      }
    }
  } finally {
    processing = false;
  }
}

self.addEventListener("message", ({ data }) => {
  if (data.task === "related-cancel") {
    if (latestRelated === data.request) latestRelated = null;
    if (pendingRelated?.request === data.request) pendingRelated = undefined;
    return;
  }
  if (data.task === "related") {
    latestRelated = data.request;
    pendingRelated = data;
  } else {
    classificationQueue.push(data);
  }
  void processQueue();
});
