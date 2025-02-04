import type { ByteKV, ByteKVBehavior, DocStorage } from '@toeverything/infra';
import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  openDB,
} from 'idb';
import { mergeUpdates } from 'yjs';

import { BroadcastChannelDocEventBus } from './doc-broadcast-channel';

function isEmptyUpdate(binary: Uint8Array) {
  return (
    binary.byteLength === 0 ||
    (binary.byteLength === 2 && binary[0] === 0 && binary[1] === 0)
  );
}

export class IndexedDBDocStorage implements DocStorage {
  constructor(private readonly workspaceId: string) {}
  eventBus = new BroadcastChannelDocEventBus(this.workspaceId);
  readonly doc = new Doc();
  readonly syncMetadata = new KV(`${this.workspaceId}:sync-metadata`);
  readonly serverClock = new KV(`${this.workspaceId}:server-clock`);
}

interface DocDBSchema extends DBSchema {
  workspace: {
    key: string;
    value: {
      id: string;
      updates: {
        timestamp: number;
        update: Uint8Array;
      }[];
    };
  };
}

type DocType = DocStorage['doc'];
class Doc implements DocType {
  dbName = 'affine-local';
  dbPromise: Promise<IDBPDatabase<DocDBSchema>> | null = null;
  dbVersion = 1;

  constructor() {}

  upgradeDB(db: IDBPDatabase<DocDBSchema>) {
    db.createObjectStore('workspace', { keyPath: 'id' });
  }

  getDb() {
    if (this.dbPromise === null) {
      this.dbPromise = openDB<DocDBSchema>(this.dbName, this.dbVersion, {
        upgrade: db => this.upgradeDB(db),
      });
    }
    return this.dbPromise;
  }

  async get(docId: string): Promise<Uint8Array | null> {
    const db = await this.getDb();
    const store = db
      .transaction('workspace', 'readonly')
      .objectStore('workspace');
    const data = await store.get(docId);

    if (!data) {
      return null;
    }

    const updates = data.updates
      .map(({ update }) => update)
      .filter(update => !isEmptyUpdate(update));
    const update = updates.length > 0 ? mergeUpdates(updates) : null;

    return update;
  }

  async set(docId: string, data: Uint8Array) {
    const db = await this.getDb();
    const store = db
      .transaction('workspace', 'readwrite')
      .objectStore('workspace');

    const rows = [{ timestamp: Date.now(), update: data }];
    await store.put({
      id: docId,
      updates: rows,
    });
  }

  async keys() {
    const db = await this.getDb();
    const store = db
      .transaction('workspace', 'readonly')
      .objectStore('workspace');

    return store.getAllKeys();
  }

  clear(): void | Promise<void> {
    return;
  }

  del(_key: string): void | Promise<void> {
    return;
  }

  async transaction<T>(
    cb: (transaction: ByteKVBehavior) => Promise<T>
  ): Promise<T> {
    const db = await this.getDb();
    const store = db
      .transaction('workspace', 'readwrite')
      .objectStore('workspace');
    return await cb({
      async get(docId) {
        const data = await store.get(docId);

        if (!data) {
          return null;
        }

        const { updates } = data;
        const update = mergeUpdates(updates.map(({ update }) => update));

        return update;
      },
      keys() {
        return store.getAllKeys();
      },
      async set(docId, data) {
        const rows = [{ timestamp: Date.now(), update: data }];
        await store.put({
          id: docId,
          updates: rows,
        });
      },
      async clear() {
        return await store.clear();
      },
      async del(key) {
        return store.delete(key);
      },
    });
  }
}

interface KvDBSchema extends DBSchema {
  kv: {
    key: string;
    value: { key: string; val: Uint8Array };
  };
}

class KV implements ByteKV {
  constructor(private readonly dbName: string) {}

  dbPromise: Promise<IDBPDatabase<KvDBSchema>> | null = null;
  dbVersion = 1;

  upgradeDB(db: IDBPDatabase<KvDBSchema>) {
    db.createObjectStore('kv', { keyPath: 'key' });
  }

  getDb() {
    if (this.dbPromise === null) {
      this.dbPromise = openDB<KvDBSchema>(this.dbName, this.dbVersion, {
        upgrade: db => this.upgradeDB(db),
      });
    }
    return this.dbPromise;
  }

  async transaction<T>(
    cb: (transaction: ByteKVBehavior) => Promise<T>
  ): Promise<T> {
    const db = await this.getDb();
    const store = db.transaction('kv', 'readwrite').objectStore('kv');

    const behavior = new KVBehavior(store);
    return await cb(behavior);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.getDb();
    const store = db.transaction('kv', 'readonly').objectStore('kv');
    return new KVBehavior(store).get(key);
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    return new KVBehavior(store).set(key, value);
  }
  async keys(): Promise<string[]> {
    const db = await this.getDb();
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    return new KVBehavior(store).keys();
  }
  async clear() {
    const db = await this.getDb();
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    return new KVBehavior(store).clear();
  }
  async del(key: string) {
    const db = await this.getDb();
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    return new KVBehavior(store).del(key);
  }
}

class KVBehavior implements ByteKVBehavior {
  constructor(
    private readonly store: IDBPObjectStore<KvDBSchema, ['kv'], 'kv', any>
  ) {}
  async get(key: string): Promise<Uint8Array | null> {
    const value = await this.store.get(key);
    return value?.val ?? null;
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    if (this.store.put === undefined) {
      throw new Error('Cannot set in a readonly transaction');
    }
    await this.store.put({
      key: key,
      val: value,
    });
  }
  async keys(): Promise<string[]> {
    return await this.store.getAllKeys();
  }
  async del(key: string) {
    if (this.store.delete === undefined) {
      throw new Error('Cannot set in a readonly transaction');
    }
    return await this.store.delete(key);
  }

  async clear() {
    if (this.store.clear === undefined) {
      throw new Error('Cannot set in a readonly transaction');
    }
    return await this.store.clear();
  }
}
