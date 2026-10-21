export type LocalSegment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};

export type LocalNote = {
  id: string;
  serverId: string | null;
  title: string;
  createdAt: string;
  status: string;
  error?: string;
  transcript: LocalSegment[];
  summary: string | null;
  mindmap: any;
  hasAudio: boolean;
};

const DB_NAME = 'lecmap-local';
const DB_VERSION = 1;
const NOTES = 'notes';
const AUDIO = 'audio';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('No se pudo abrir IndexedDB'));
  });
  return dbPromise;
}

function request<T>(store: IDBObjectStore, method: 'get' | 'getAll' | 'put' | 'delete', value?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = method === 'getAll'
      ? store.getAll()
      : method === 'get'
        ? store.get(value)
        : method === 'put'
          ? ('key' in value ? store.put(value.value, value.key) : store.put(value.value))
          : store.delete(value);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error || new Error('Error de IndexedDB'));
  });
}

export async function listLocalNotes(): Promise<LocalNote[]> {
  const db = await openDb();
  const tx = db.transaction(NOTES, 'readonly');
  const notes = await request<LocalNote[]>(tx.objectStore(NOTES), 'getAll');
  return notes.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getLocalNote(id: string): Promise<LocalNote | undefined> {
  const db = await openDb();
  const tx = db.transaction(NOTES, 'readonly');
  return request<LocalNote | undefined>(tx.objectStore(NOTES), 'get', id);
}

export async function saveLocalNote(note: LocalNote): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(NOTES, 'readwrite');
  await request(tx.objectStore(NOTES), 'put', { value: note });
}

export async function deleteLocalNote(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([NOTES, AUDIO], 'readwrite');
  tx.objectStore(NOTES).delete(id);
  tx.objectStore(AUDIO).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('No se pudo borrar la nota local'));
  });
}

export async function saveAudio(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readwrite');
  await request(tx.objectStore(AUDIO), 'put', { key: id, value: blob });
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readonly');
  return request<Blob | undefined>(tx.objectStore(AUDIO), 'get', id);
}

export async function deleteAudio(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readwrite');
  await request(tx.objectStore(AUDIO), 'delete', id);
}

export async function setLocalAudioFlag(note: LocalNote, hasAudio: boolean): Promise<LocalNote> {
  const updated = { ...note, hasAudio };
  await saveLocalNote(updated);
  return updated;
}

export async function findLocalByServerId(serverId: string): Promise<LocalNote | undefined> {
  const notes = await listLocalNotes();
  return notes.find((n) => n.serverId === serverId);
}
