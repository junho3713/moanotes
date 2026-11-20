// Scores express similarity, not a probability. Use the reference score as a label only.
export const relatedTextLimit = 1000;
export const relatedReferenceScore = 0.82;

export function relatedText(title, body) {
  const original = [title, body].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  // Link-heavy notes should be represented by their meaningful text, not URL IDs/query strings.
  const text = original.replace(/(?:https?:\/\/|www\.)[^\s<>"']+/giu, " ").replace(/\s+/gu, " ").trim();
  // Keep titleless URL-only notes searchable instead of silently omitting them.
  return (text || original).slice(0, relatedTextLimit);
}

export function relatedCandidates(notes) {
  return notes.flatMap((note) => {
    const tags = note.tags?.length ? "분류: " + note.tags.join(", ") : "";
    const text = relatedText(note.title, [tags, note.body].filter(Boolean).join(" "));
    return text ? [{ id: note.id, text }] : [];
  });
}

export function rankRelated(queryVector, candidates, vectors, limit = Infinity) {
  return candidates.flatMap(({ id }) => {
    const vector = vectors.get(id)?.vector;
    if (!vector || vector.length !== queryVector.length) return [];
    const score = queryVector.reduce((sum, value, index) => sum + value * vector[index], 0);
    return Number.isFinite(score) ? [{ id, score }] : [];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
