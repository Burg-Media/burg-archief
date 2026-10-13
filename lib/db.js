'use strict'

// Local storage of the archive in IndexedDB (only in this browser).
// Shared by the service worker (importScripts) and the pages (<script>).
// 'meta'  title, url, date, tags, note, thumbnail, SEO data
// 'files' the saved file (HTML or MHTML) as a Blob
// 'texts' the visible text, for searching and comparing
// This way the library loads without reading all the large files.

const ArchiveDB = (() => {
  let dbPromise = null

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('burg-archief', 1)
        request.onupgradeneeded = () => {
          const meta = request.result.createObjectStore('meta', { keyPath: 'id' })
          meta.createIndex('url', 'url')
          request.result.createObjectStore('files')
          request.result.createObjectStore('texts')
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return dbPromise
  }

  async function tx(stores, mode, action) {
    const db = await open()
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode)
      const request = action(t)
      t.oncomplete = () => resolve(request ? request.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  const byDate = (a, b) => b.createdAt - a.createdAt

  return {
    /** @param meta { id, url, title, createdAt, kind, size, sha256, tags, note, thumb, seo, run } */
    save: (meta, file, text) =>
      tx(['meta', 'files', 'texts'], 'readwrite', (t) => {
        t.objectStore('files').put(file, meta.id)
        t.objectStore('texts').put(text || '', meta.id)
        t.objectStore('meta').put(meta)
      }),
    update: async (id, changes) => {
      const meta = await tx('meta', 'readonly', (t) => t.objectStore('meta').get(id))
      if (!meta) return null
      Object.assign(meta, changes)
      await tx('meta', 'readwrite', (t) => t.objectStore('meta').put(meta))
      return meta
    },
    getMeta: (id) => tx('meta', 'readonly', (t) => t.objectStore('meta').get(id)),
    getFile: (id) => tx('files', 'readonly', (t) => t.objectStore('files').get(id)),
    getText: (id) => tx('texts', 'readonly', (t) => t.objectStore('texts').get(id)),
    remove: (id) =>
      tx(['meta', 'files', 'texts'], 'readwrite', (t) => {
        for (const store of ['meta', 'files', 'texts']) t.objectStore(store).delete(id)
      }),
    /** All metadata, newest first. */
    async list() {
      return (await tx('meta', 'readonly', (t) => t.objectStore('meta').getAll())).sort(byDate)
    },
    /** All versions of one URL, newest first. */
    async versions(url) {
      return (await tx('meta', 'readonly', (t) => t.objectStore('meta').index('url').getAll(url))).sort(byDate)
    },
    /** Map id → text, for full-text search. */
    async allTexts() {
      const db = await open()
      return new Promise((resolve, reject) => {
        const texts = new Map()
        const request = db.transaction('texts').objectStore('texts').openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return resolve(texts)
          texts.set(cursor.key, cursor.value)
          cursor.continue()
        }
        request.onerror = () => reject(request.error)
      })
    },
  }
})()
