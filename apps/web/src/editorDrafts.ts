/** IndexedDB is authoritative. Broadcast messages only discover concurrent branches. */
export interface EditorDraft {
  key: string;
  fileKey: string;
  branchId: string;
  revision: number;
  text: string;
  baseHash: string;
  baseContents: string;
  saveStatus: "dirty" | "saving" | "conflict" | "saved";
  updatedAt: number;
}

const memoryDrafts = new Map<string, EditorDraft>();
let storageAvailable = true;
export const editorDraftRecoveryAvailable = () => storageAvailable;
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database) {
    const opening: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("f5-editor-drafts", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("drafts", { keyPath: "key" });
        store.createIndex("fileKey", "fileKey");
      };
      request.onsuccess = () => {
        // The browser can close a connection itself, e.g. after evicting site
        // storage. Concurrent callers then share one fresh connection.
        request.result.onclose = () => {
          if (database === opening) database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Draft storage is blocked by another window."));
    }).catch((error) => {
      if (database === opening) database = undefined;
      throw error;
    });
    database = opening;
  }
  return database;
}

const isClosingConnection = (error: unknown) =>
  error instanceof DOMException && error.name === "InvalidStateError";

async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, complete: (value: T) => void) => void,
): Promise<T> {
  const options = mode === "readwrite" ? { durability: "strict" as const } : undefined;
  let connection = await db();
  let tx: IDBTransaction;
  try {
    tx = connection.transaction("drafts", mode, options);
  } catch (error) {
    // The close event can arrive after a transaction already sees the closing handle.
    if (!isClosingConnection(error)) throw error;
    const stale = database;
    if (stale && (await stale) === connection) database = undefined;
    connection.close();
    connection = await db();
    tx = connection.transaction("drafts", mode, options);
  }
  return new Promise((resolve, reject) => {
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Draft transaction failed."));
    work(tx.objectStore("drafts"), (result) => {
      value = result;
    });
  });
}

export const editorDrafts = {
  async list(fileKey: string, includeSaved = false): Promise<EditorDraft[]> {
    let persisted: EditorDraft[] = [];
    try {
      persisted = await transaction<EditorDraft[]>("readonly", (store, complete) => {
        const request = store.index("fileKey").getAll(fileKey);
        request.onsuccess = () => complete(request.result as EditorDraft[]);
      });
    } catch (error) {
      storageAvailable = false;
      if (![...memoryDrafts.values()].some((draft) => draft.fileKey === fileKey)) throw error;
    }
    const merged = new Map(persisted.map((draft) => [draft.key, draft]));
    for (const draft of memoryDrafts.values())
      if (draft.fileKey === fileKey && draft.revision >= (merged.get(draft.key)?.revision ?? -1))
        merged.set(draft.key, draft);
    return [...merged.values()].filter((draft) => includeSaved || draft.saveStatus !== "saved");
  },
  put(draft: EditorDraft): Promise<void> {
    if (draft.revision > (memoryDrafts.get(draft.key)?.revision ?? -1))
      memoryDrafts.set(draft.key, draft);
    return transaction<void>("readwrite", (store, complete) => {
      const request = store.get(draft.key);
      request.onsuccess = () => {
        const current = request.result as EditorDraft | undefined;
        if (!current || current.revision < draft.revision) store.put(draft);
        complete(undefined);
      };
    })
      .then(() => {
        const profile = JSON.parse(draft.fileKey)[0] as string;
        channels
          .get(profile)
          ?.postMessage({ type: "draft", fileKey: draft.fileKey, branch: draft.branchId });
      })
      .catch((error) => {
        storageAvailable = false;
        throw error;
      });
  },
  /** A receipt advances the base but can clear only the exact saved revision. */
  acknowledge(saved: EditorDraft, hash: string): Promise<void> {
    return transaction<void>("readwrite", (store, complete) => {
      const request = store.get(saved.key);
      request.onsuccess = () => {
        const current = request.result as EditorDraft | undefined;
        if (current?.revision === saved.revision)
          store.put({
            ...current,
            saveStatus: "saved",
            text: "",
            baseContents: "",
            baseHash: hash,
          });
        else if (current && current.revision > saved.revision)
          store.put({ ...current, baseHash: hash, baseContents: saved.text });
        complete(undefined);
      };
    }).then(() => {
      const current = memoryDrafts.get(saved.key);
      if (current?.revision === saved.revision)
        memoryDrafts.set(saved.key, {
          ...current,
          saveStatus: "saved",
          text: "",
          baseContents: "",
          baseHash: hash,
        });
      else if (current && current.revision > saved.revision)
        memoryDrafts.set(saved.key, { ...current, baseHash: hash, baseContents: saved.text });
    });
  },
  discard(key: string, revision: number): Promise<void> {
    return transaction<void>("readwrite", (store, complete) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result as EditorDraft | undefined;
        if (current?.revision === revision)
          store.put({ ...current, saveStatus: "saved", text: "", baseContents: "" });
        complete(undefined);
      };
    }).then(() => {
      const current = memoryDrafts.get(key);
      if (current?.revision === revision)
        memoryDrafts.set(key, { ...current, saveStatus: "saved", text: "", baseContents: "" });
    });
  },
};

const branchPromises = new Map<string, Promise<string>>();
const channels = new Map<string, BroadcastChannel>();
export function editorBranch(profile: string): Promise<string> {
  const existing = branchPromises.get(profile);
  if (existing) return existing;
  const promise = new Promise<string>((resolve, reject) => {
    try {
      const storageKey = `f5-editor-branch:${profile}`;
      const preferred = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      const activate = (branch: string) => {
        sessionStorage.setItem(storageKey, branch);
        if (typeof BroadcastChannel !== "undefined") {
          const channel = new BroadcastChannel(`f5-editor:${profile}`);
          channels.set(profile, channel);
          channel.onmessage = (event) => {
            if (event.data?.type === "draft")
              window.dispatchEvent(new CustomEvent("f5-editor-draft", { detail: event.data }));
          };
          window.addEventListener("pagehide", () => channel.close(), { once: true });
        }
        resolve(branch);
      };
      if (navigator.locks) {
        // A live document owns its branch even when its event loop is suspended.
        // A duplicated window inherits sessionStorage but cannot adopt that lock.
        const claim = (branch: string) => {
          void navigator.locks
            .request(`f5-editor:${profile}:${branch}`, { ifAvailable: true }, async (lock) => {
              if (!lock) {
                claim(crypto.randomUUID());
                return;
              }
              activate(branch);
              await new Promise<void>((release) =>
                window.addEventListener("pagehide", () => release(), { once: true }),
              );
            })
            .catch(reject);
        };
        claim(preferred);
      } else {
        // Without document-owned exclusion, preserve old branches for explicit
        // recovery and always fork rather than risk concurrent revision writers.
        activate(crypto.randomUUID());
      }
    } catch (error) {
      reject(error);
    }
  });
  branchPromises.set(profile, promise);
  return promise;
}

export function editorFileKey(profile: string, workspace: string, file: string): string {
  return JSON.stringify([profile, workspace, file]);
}
