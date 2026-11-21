// Structure data uses the existing body field, so old notes and backups remain compatible.
export const structurePrefix = "[moa-structure:v1]\n";
export const maxStructureNodes = 64;
export const maxStructureBody = 20000;

export function emptyStructure() {
  return { version: 1, nodes: [{ id: crypto.randomUUID(), col: 0, row: 0, text: "" }], edges: [] };
}

export function validStructure(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || !value.nodes.length || value.nodes.length > maxStructureNodes || value.edges.length > maxStructureNodes * 2) return false;
  const ids = new Set(), cells = new Set(), edges = new Set();
  for (const node of value.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || node.id.length > 80 || ids.has(node.id)
      || !Number.isInteger(node.col) || !Number.isInteger(node.row) || node.col < 0 || node.row < 0
      || node.col >= maxStructureNodes || node.row >= maxStructureNodes
      || typeof node.text !== "string" || node.text.length > 1000) return false;
    const cell = node.col + ":" + node.row;
    if (cells.has(cell)) return false;
    ids.add(node.id); cells.add(cell);
  }
  for (const edge of value.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to
      || !["right", "down"].includes(edge.direction)) return false;
    const key = edge.from + ":" + edge.to;
    if (edges.has(key)) return false;
    edges.add(key);
  }
  return true;
}

export function encodeStructure(value) {
  if (!validStructure(value)) throw new Error("구조 메모를 확인해 주세요.");
  const canonical = {
    version: 1,
    nodes: value.nodes.map(({ id, col, row, text }) => ({ id, col, row, text })),
    edges: value.edges.map(({ from, to, direction }) => ({ from, to, direction })),
  };
  const body = structurePrefix + JSON.stringify(canonical);
  if (body.length > maxStructureBody) throw new Error("구조 메모의 내용이 너무 길어요. 일부를 줄여 주세요.");
  return body;
}

export function decodeStructure(body) {
  if (typeof body !== "string" || !body.startsWith(structurePrefix) || body.length > maxStructureBody) return null;
  try {
    const value = JSON.parse(body.slice(structurePrefix.length));
    return validStructure(value) ? JSON.parse(encodeStructure(value).slice(structurePrefix.length)) : null;
  } catch { return null; }
}

export function structureText(body) {
  const value = decodeStructure(body);
  return value ? [...value.nodes].sort((a, b) => a.row - b.row || a.col - b.col).map(({ text }) => text).filter(Boolean).join("\n") : body;
}

export function structureHasContent(value) {
  return value.nodes.length > 1 || value.nodes.some(({ text }) => text.trim());
}

export function addStructureNode(value, parentId, direction) {
  if (!validStructure(value) || !["right", "down"].includes(direction)) throw new Error("구조 메모를 확인해 주세요.");
  if (value.nodes.length >= maxStructureNodes) throw new Error("칸은 64개까지 만들 수 있어요.");
  const next = structuredClone(value);
  let parent = next.nodes.find(({ id }) => id === parentId);
  if (!parent) throw new Error("선택한 칸을 찾을 수 없어요.");
  const visited = new Set();
  // Repeated additions on the same arrow extend that line instead of overlapping edges.
  while (!visited.has(parent.id)) {
    visited.add(parent.id);
    const edge = next.edges.find((edge) => edge.from === parent.id && edge.direction === direction);
    if (!edge || visited.has(edge.to)) break;
    parent = next.nodes.find(({ id }) => id === edge.to);
  }
  const col = parent.col + (direction === "right" ? 1 : 0);
  const row = parent.row + (direction === "down" ? 1 : 0);
  if (next.nodes.some((node) => node.col === col && node.row === row)) {
    const axis = direction === "right" ? "col" : "row";
    const at = direction === "right" ? col : row;
    for (const node of next.nodes) if (node[axis] >= at) node[axis]++;
  }
  const added = { id: crypto.randomUUID(), col, row, text: "" };
  next.nodes.push(added);
  next.edges.push({ from: parent.id, to: added.id, direction });
  encodeStructure(next);
  return { document: next, addedId: added.id };
}

export function removeStructureNode(value, id) {
  const next = structuredClone(value);
  next.nodes = next.nodes.filter((node) => node.id !== id);
  next.edges = next.edges.filter((edge) => edge.from !== id && edge.to !== id);
  if (!next.nodes.length) return emptyStructure();
  const cols = [...new Set(next.nodes.map(({ col }) => col))].sort((a, b) => a - b);
  const rows = [...new Set(next.nodes.map(({ row }) => row))].sort((a, b) => a - b);
  for (const node of next.nodes) { node.col = cols.indexOf(node.col); node.row = rows.indexOf(node.row); }
  encodeStructure(next);
  return next;
}

export function swipeDirection(dx, dy, threshold = 64) {
  if (dx >= threshold && dx > Math.abs(dy) * 1.3) return "right";
  if (dy >= threshold && dy > Math.abs(dx) * 1.3) return "down";
  return null;
}
