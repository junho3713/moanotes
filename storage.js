const demoKey = "moa.demo.notes.v1";
const demoRows = [
  ["카페 홈페이지에 예약 기능 넣기", "첫 화면에서 시간대를 고를 수 있게. 예약 확인은 문자로 보내는 방식도 살펴보기.", ["웹사이트", "아이디어"], false],
  ["마음에 드는 웹사이트 모아보기", "여백이 넉넉하고 글을 읽기 편한 곳 위주로 저장해 두기.", ["웹사이트", "자료"], true],
  ["주말에 읽을 책 정리", "책장 위에 아직 읽지 않은 에세이가 두 권.", ["일상"], false],
  ["메모가 쌓이면 금요일마다 한 번씩 정리하기", "", [], false],
  ["다음 프로젝트에 쓸 색 조합 찾아보기", "짙은 초록색에 따뜻한 미색을 더해 보기.", ["아이디어", "디자인"], false],
  ["저녁 산책할 때 들을 음악 모아두기", "", [], false],
];

export function localStore(onChange, onError) {
  const seed = demoRows.map(([title, detail, tags, pinned], index) => {
    const createdAt = Date.now() - index * 72000000;
    return {
      id: "sample-" + index,
      body: [title, detail].filter(Boolean).join("\n"),
      tags, pinned, createdAt, updatedAt: createdAt,
    };
  });
  let notes = seed;
  function read() {
    const saved = localStorage.getItem(demoKey);
    return saved === null ? seed : JSON.parse(saved);
  }
  function refresh() {
    try {
      notes = read();
      onChange(notes);
    } catch (error) {
      onError(error);
    }
  }
  function write(apply) {
    const updated = apply(read());
    localStorage.setItem(demoKey, JSON.stringify(updated));
    notes = updated;
    onChange(notes);
  }
  window.addEventListener("storage", (event) => {
    if (event.key === demoKey || event.key === null) refresh();
  });
  refresh();
  return {
    async add(note) {
      const id = crypto.randomUUID();
      write((items) => [...items, { ...note, id }]);
      return id;
    },
    async update(id, patch) { write((items) => items.map((note) => note.id === id ? { ...note, ...patch } : note)); },
    async remove(id) { write((items) => items.filter((note) => note.id !== id)); },
    async removeMany(ids) {
      const targets = new Set(ids);
      write((items) => items.filter(({ id }) => !targets.has(id)));
    },
    async addTags(ids, tags, updatedAt) {
      write((items) => items.map((note) => ids.includes(note.id)
        ? { ...note, tags: [...new Set([...note.tags, ...tags])], updatedAt }
        : note));
    },
    async importNotes(rows) { write((items) => [...items, ...rows.map((note) => ({ ...note, id: crypto.randomUUID() }))]); },
  };
}

const sdkUrl = "https://www.gstatic.com/firebasejs/13.4.0/";

export async function openCloud(config) {
  const [appSdk, authSdk, dbSdk] = await Promise.all([
    import(sdkUrl + "firebase-app.js"),
    import(sdkUrl + "firebase-auth.js"),
    import(sdkUrl + "firebase-firestore.js"),
  ]);
  const app = appSdk.initializeApp(config);
  const auth = authSdk.getAuth(app);
  const db = dbSdk.getFirestore(app);
  return {
    observeAuth: (next, error) => authSdk.onAuthStateChanged(auth, next, error),
    signIn: (email, password) => authSdk.signInWithEmailAndPassword(auth, email, password),
    signOut: () => authSdk.signOut(auth),
    getStore(uid, onChange, onError) {
      const collection = dbSdk.collection(db, "users", uid, "notes");
      const ref = (id) => dbSdk.doc(collection, id);
      const disconnect = dbSdk.onSnapshot(collection, { includeMetadataChanges: true }, (snapshot) => {
        const notes = snapshot.docs.map((item) => ({ ...item.data(), id: item.id }));
        onChange(notes, snapshot.metadata);
      }, onError);
      return {
        disconnect,
        async add(note) {
          const created = await dbSdk.addDoc(collection, note);
          return created.id;
        },
        update: (id, patch) => dbSdk.updateDoc(ref(id), patch),
        remove: (id) => dbSdk.deleteDoc(ref(id)),
        async removeMany(ids) {
          const batch = dbSdk.writeBatch(db);
          for (const id of ids) batch.delete(ref(id));
          await batch.commit();
        },
        async addTags(ids, tags, updatedAt) {
          const batch = dbSdk.writeBatch(db);
          for (const id of ids) {
            batch.update(ref(id), { tags: dbSdk.arrayUnion(...tags), updatedAt });
          }
          await batch.commit();
        },
        async importNotes(rows) {
          const batch = dbSdk.writeBatch(db);
          for (const note of rows) batch.set(dbSdk.doc(collection), note);
          await batch.commit();
        },
      };
    },
  };
}
