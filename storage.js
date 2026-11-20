import { maxPhotoBytes, photoParts } from "./images.js?v=6";

const demoKey = "moa.demo.notes.v1";
const localPhoto = (image) => ({ thumbnail: image?.thumbnail ?? "", imageData: image?.data ?? "" });
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
    async add(note, image) {
      const id = crypto.randomUUID();
      write((items) => [...items, { ...note, ...(image ? localPhoto(image) : {}), id }]);
      return id;
    },
    async update(id, patch, image) {
      const attachment = image === undefined ? {} : localPhoto(image);
      write((items) => items.map((note) => note.id === id ? { ...note, ...patch, ...attachment } : note));
    },
    async getPhoto(id) { return read().find((note) => note.id === id)?.imageData ?? ""; },
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
  auth.languageCode = "ko";
  const google = new authSdk.GoogleAuthProvider();
  google.setCustomParameters({ prompt: "select_account" });
  const db = dbSdk.getFirestore(app);
  return {
    observeAuth: (next, error) => authSdk.onAuthStateChanged(auth, next, error),
    currentUser: () => auth.currentUser,
    signIn: (email, password) => authSdk.signInWithEmailAndPassword(auth, email, password),
    signInWithGoogle: () => authSdk.signInWithPopup(auth, google),
    signUp: (email, password) => authSdk.createUserWithEmailAndPassword(auth, email, password),
    sendVerification: (user) => authSdk.sendEmailVerification(user),
    async refreshVerification(user) {
      await authSdk.reload(user);
      if (user.emailVerified) await authSdk.getIdToken(user, true);
    },
    async hasMemoAccess(uid) {
      const notes = dbSdk.collection(db, "users", uid, "notes");
      try {
        await dbSdk.getDocsFromServer(dbSdk.query(notes, dbSdk.limit(1)));
        return true;
      } catch (error) {
        if (error.code === "permission-denied") return false;
        throw error;
      }
    },
    signOut: () => authSdk.signOut(auth),
    getStore(uid, onChange, onError) {
      const collection = dbSdk.collection(db, "users", uid, "notes");
      const images = dbSdk.collection(db, "users", uid, "noteImages");
      const ref = (id) => dbSdk.doc(collection, id);
      const photoRef = (id) => dbSdk.doc(images, id);
      function writePhoto(batch, id, url) {
        const image = photoParts(url, maxPhotoBytes);
        if (!image) throw new Error("Invalid photo");
        batch.set(photoRef(id), { mime: image.mime, data: dbSdk.Bytes.fromBase64String(image.base64) });
      }
      async function removeMany(ids) {
        let deletedCount = 0;
        try {
          for (let start = 0; start < ids.length; start += 200) {
            const group = ids.slice(start, start + 200);
            const batch = dbSdk.writeBatch(db);
            for (const id of group) {
              batch.delete(ref(id));
              batch.delete(photoRef(id));
            }
            await batch.commit();
            deletedCount += group.length;
          }
        } catch (error) {
          if (!deletedCount) throw error;
          throw Object.assign(new Error("Partial deletion", { cause: error }), { deletedCount });
        }
      }
      const disconnect = dbSdk.onSnapshot(collection, { includeMetadataChanges: true }, (snapshot) => {
        const notes = snapshot.docs.map((item) => ({ ...item.data(), id: item.id }));
        onChange(notes, snapshot.metadata);
      }, onError);
      return {
        disconnect,
        async add(note, image) {
          if (!image) return (await dbSdk.addDoc(collection, note)).id;
          const created = dbSdk.doc(collection);
          const batch = dbSdk.writeBatch(db);
          batch.set(created, { ...note, thumbnail: image.thumbnail });
          writePhoto(batch, created.id, image.data);
          await batch.commit();
          return created.id;
        },
        async update(id, patch, image) {
          if (image === undefined) return dbSdk.updateDoc(ref(id), patch);
          const batch = dbSdk.writeBatch(db);
          batch.update(ref(id), { ...patch, thumbnail: image?.thumbnail ?? "" });
          if (image) writePhoto(batch, id, image.data);
          else batch.delete(photoRef(id));
          await batch.commit();
        },
        async getPhoto(id) {
          const photo = (await dbSdk.getDoc(photoRef(id))).data();
          if (!photo || !["image/webp", "image/jpeg"].includes(photo.mime)) return "";
          return "data:" + photo.mime + ";base64," + photo.data.toBase64();
        },
        remove: (id) => removeMany([id]),
        removeMany,
        async addTags(ids, tags, updatedAt) {
          const batch = dbSdk.writeBatch(db);
          for (const id of ids) {
            batch.update(ref(id), { tags: dbSdk.arrayUnion(...tags), updatedAt });
          }
          await batch.commit();
        },
        async importNotes(rows) {
          const batch = dbSdk.writeBatch(db);
          for (const { imageData, ...note } of rows) {
            const created = dbSdk.doc(collection);
            batch.set(created, note);
            if (imageData) writePhoto(batch, created.id, imageData);
          }
          await batch.commit();
        },
      };
    },
  };
}
