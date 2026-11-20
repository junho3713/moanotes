// Keep embeddings bounded to the model's short-text use case.
export const relatedTextLimit = 1000;
export const relatedMinScore = 0.82; // A conservative starting heuristic, not a probability.

export function relatedText(title, body) {
  return [title, body].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim().slice(0, relatedTextLimit);
}

export function relatedCandidates(notes) {
  return notes.flatMap((note) => {
    const text = relatedText(note.title, note.body);
    return text ? [{ id: note.id, text }] : [];
  });
}

export function rankRelated(queryVector, candidates, vectors, limit = 3) {
  return candidates.flatMap(({ id }) => {
    const vector = vectors.get(id)?.vector;
    if (!vector || vector.length !== queryVector.length) return [];
    const score = queryVector.reduce((sum, value, index) => sum + value * vector[index], 0);
    return Number.isFinite(score) && score >= relatedMinScore ? [{ id, score }] : [];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
