const libraryUrl = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const model = "Xenova/multilingual-e5-small";
const revision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const exampleVectors = new Map();
let encoder;
let work = Promise.resolve();

async function loadEncoder() {
  if (encoder) return encoder;
  const { env, pipeline } = await import(libraryUrl);
  env.allowLocalModels = false;
  env.backends.onnx.wasm.numThreads = 1;
  encoder = await pipeline("feature-extraction", model, { device: "wasm", dtype: "q8", revision });
  return encoder;
}

async function rankCategories(request, query, examples) {
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

self.addEventListener("message", ({ data: { request, query, examples } }) => {
  work = work.then(() => rankCategories(request, query, examples)).catch(() => {
    self.postMessage({ request, type: "error" });
  });
});
