export function replaceCategory(tags, from, to) {
  return [...new Set(tags.map((tag) => tag === from ? to : tag))];
}

export function validateCategoryName(value, names, previous) {
  const name = value.trim().normalize("NFC");
  if (!name || name.length > 20) throw new Error("분류 이름은 1~20자로 입력해 주세요.");
  const normalized = (text) => text.normalize("NFKC").toLocaleLowerCase("ko-KR");
  if (names.some((tag) => tag !== previous && normalized(tag) === normalized(name))) {
    throw new Error("같은 이름의 분류가 있어요. 다른 이름을 입력해 주세요.");
  }
  return name;
}

export function createCategoryPreferences({ getStorage = () => localStorage, onError = () => {} } = {}) {
  let scope = null;
  let data = { order: [], pinned: [] };
  const clean = (value) => Array.isArray(value) ? [...new Set(value.filter((name) => typeof name === "string" && name.length > 0))] : [];
  function persist() {
    if (!scope) return;
    try { getStorage().setItem("moa.categories.v1:" + scope, JSON.stringify(data)); }
    catch { onError(); }
  }
  return {
    use(nextScope) {
      scope = nextScope;
      data = { order: [], pinned: [] };
      if (!scope) return;
      try {
        const saved = JSON.parse(getStorage().getItem("moa.categories.v1:" + scope) || "null");
        if (saved && typeof saved === "object") data = { order: clean(saved.order), pinned: clean(saved.pinned) };
      } catch { onError(); }
    },
    isPinned(name) { return data.pinned.includes(name); },
    ordered(entries) {
      const positions = new Map(data.order.map((name, index) => [name, index]));
      return [...entries].sort(([a], [b]) =>
        Number(data.pinned.includes(b)) - Number(data.pinned.includes(a))
        || (positions.get(a) ?? Infinity) - (positions.get(b) ?? Infinity)
        || a.localeCompare(b, "ko"));
    },
    togglePin(name) {
      data.pinned = data.pinned.includes(name) ? data.pinned.filter((entry) => entry !== name) : [...data.pinned, name];
      persist();
    },
    move(entries, from, to) {
      if (from === to || data.pinned.includes(from) !== data.pinned.includes(to)) return false;
      const names = this.ordered(entries).map(([name]) => name);
      const start = names.indexOf(from), end = names.indexOf(to);
      if (start < 0 || end < 0) return false;
      names.splice(start, 1);
      names.splice(end, 0, from);
      data.order = [...names, ...data.order.filter((name) => !names.includes(name))];
      persist();
      return true;
    },
    rename(from, to) {
      data.order = replaceCategory(data.order, from, to);
      data.pinned = replaceCategory(data.pinned, from, to);
      persist();
    },
  };
}

// Read the latest tags inside each transaction to preserve concurrent tag edits.
export async function renameCloudCategory(db, sdk, collection, from, to) {
  const snapshot = await sdk.getDocsFromServer(sdk.query(collection, sdk.where("tags", "array-contains", from)));
  const ids = snapshot.docs.map((item) => item.id);
  let renamedCount = 0;
  try {
    for (let start = 0; start < ids.length; start += 100) {
      const refs = ids.slice(start, start + 100).map((id) => sdk.doc(collection, id));
      const count = await sdk.runTransaction(db, async (transaction) => {
        const current = await Promise.all(refs.map((ref) => transaction.get(ref)));
        let changed = 0;
        current.forEach((item, index) => {
          if (!item.exists() || !item.data().tags?.includes(from)) return;
          transaction.update(refs[index], { tags: replaceCategory(item.data().tags, from, to) });
          changed++;
        });
        return changed;
      });
      renamedCount += count;
    }
    return renamedCount;
  } catch (error) {
    if (!renamedCount) throw error;
    throw Object.assign(new Error("Partial category rename", { cause: error }), { renamedCount });
  }
}
