'use strict'

// Burg Archive: capture a tab and add it to the archive.
// Runs in the service worker (importScripts) and in extension pages
// (the site page uses it for every page of a site).
//
// Single HTML file: content/freeze.js freezes every frame, then this script
// fetches all resources (host permissions, so no CORS trouble) and embeds them
// as data URIs in the HTML. MHTML: a single call to chrome.pageCapture.

const BurgCapture = (() => {
  const FETCH_TIMEOUT = 20000
  const MAX_RESOURCE = 25 * 1024 * 1024
  const CONCURRENCY = 6
  const MAX_IMPORT_DEPTH = 5
  const THUMB_WIDTH = 480
  const THUMB_HEIGHT = 360

  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    css: 'text/css', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function assertCapturable(tab) {
    if (!tab || !tab.url || !/^https?:/.test(tab.url) || /^https:\/\/chromewebstore\.google\.com/.test(tab.url)) {
      throw new Error(t('errNotCapturable'))
    }
  }

  function newId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ------------------------------------------------------------------------
  // In the page
  // ------------------------------------------------------------------------

  /** Scrolls through the page so lazy-loaded images load. */
  async function pagePrescroll() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const scrollTo = (top) => window.scrollTo({ top, left: 0, behavior: 'instant' })
    const original = scrollY
    for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager'
    const el = document.scrollingElement || document.documentElement
    const step = Math.max(200, innerHeight * 0.8)
    const start = performance.now()
    for (let y = 0; y < el.scrollHeight && performance.now() - start < 8000; y += step) {
      scrollTo(y)
      await sleep(120)
    }
    scrollTo(el.scrollHeight)
    await sleep(300)
    const pending = [...document.images].filter((img) => !img.complete)
    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((r) => {
              img.addEventListener('load', r, { once: true })
              img.addEventListener('error', r, { once: true })
            })
        )
      ),
      sleep(3000),
    ])
    scrollTo(0)
    await sleep(250)
    return original
  }

  function pageScroll(top) {
    window.scrollTo({ top, left: 0, behavior: 'instant' })
  }

  async function freezeFrames(tabId, options) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: !options.infoOnly }, files: ['lib/i18n.js', 'content/freeze.js'] })
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: !options.infoOnly },
      func: (opts) => (window.__burgFreeze ? window.__burgFreeze(opts) : null),
      args: [options],
    })
    const frames = new Map()
    for (const { result } of results) if (result && result.path !== null && !frames.has(result.path)) frames.set(result.path, result)
    if (!frames.has('')) throw new Error(t('errNoContent'))
    return frames
  }

  // ------------------------------------------------------------------------
  // Fetching resources
  // ------------------------------------------------------------------------

  function createFetcher(onProgress) {
    const cache = new Map()
    let active = 0
    const queue = []
    let started = 0
    let finished = 0

    const report = () => onProgress && onProgress(finished, started)

    async function limited(task) {
      if (active >= CONCURRENCY) await new Promise((resolve) => queue.push(resolve))
      active++
      try {
        return await task()
      } finally {
        active--
        if (queue.length) queue.shift()()
      }
    }

    async function get(url) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: controller.signal })
        if (!response.ok) return null
        const length = Number(response.headers.get('content-length') || 0)
        if (length > MAX_RESOURCE) return null
        const blob = await response.blob()
        if (blob.size > MAX_RESOURCE) return null
        return blob
      } catch (error) {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    function load(url) {
      if (!cache.has(url)) {
        started++
        report()
        cache.set(
          url,
          limited(() => get(url)).finally(() => {
            finished++
            report()
          })
        )
      }
      return cache.get(url)
    }

    function mimeFor(url, blob) {
      const type = (blob.type || '').split(';')[0].trim().toLowerCase()
      if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream' && type !== 'text/plain') return type
      const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1]
      return MIME_BY_EXT[(ext || '').toLowerCase()] || type || 'application/octet-stream'
    }

    return {
      async dataUri(url) {
        const blob = await load(url)
        if (!blob) return null
        return `data:${mimeFor(url, blob)};base64,${await toBase64(blob)}`
      },
      async text(url) {
        const blob = await load(url)
        return blob ? blob.text() : null
      },
    }
  }

  async function toBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(binary)
  }

  function resolveUrl(value, base) {
    try {
      return new URL(value, base).href
    } catch (e) {
      return null
    }
  }

  // ------------------------------------------------------------------------
  // CSS: inline @import and url()
  // ------------------------------------------------------------------------

  const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);/gi
  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi

  async function replaceAsync(text, regex, replacer) {
    const matches = [...text.matchAll(regex)]
    if (!matches.length) return text
    const replacements = await Promise.all(matches.map((match) => replacer(...match)))
    let out = ''
    let last = 0
    matches.forEach((match, k) => {
      out += text.slice(last, match.index) + replacements[k]
      last = match.index + match[0].length
    })
    return out + text.slice(last)
  }

  async function processCss(css, base, fetcher, depth = 0) {
    if (!css) return ''
    css = css.replace(/\/\*[#@]\s*sourceMappingURL=[^*]*\*\//g, '')

    css = await replaceAsync(css, IMPORT_RE, async (whole, _q1, url1, _q2, url2, condition) => {
      const url = resolveUrl(url1 || url2, base)
      if (!url || depth >= MAX_IMPORT_DEPTH) return ''
      const text = await fetcher.text(url)
      if (text === null) return ''
      const inner = await processCss(text, url, fetcher, depth + 1)
      condition = condition.trim()
      // layer(...) and supports(...) are dropped; media queries are kept
      const media = condition.replace(/^(layer(\([^)]*\))?|supports\([^)]*\))\s*/gi, '').trim()
      return media ? `@media ${media}{${inner}}` : inner
    })

    return replaceAsync(css, URL_RE, async (whole, dq, sq, bare) => {
      const raw = (dq ?? sq ?? bare ?? '').replace(/\\(.)/g, '$1').trim()
      if (!raw || raw.startsWith('#') || /^(data|about):/i.test(raw)) return whole
      const url = resolveUrl(raw, base)
      if (!url || !/^https?:/i.test(url)) return whole
      const data = await fetcher.dataUri(url)
      return `url("${data || url}")`
    })
  }

  // ------------------------------------------------------------------------
  // Assembling the HTML
  // ------------------------------------------------------------------------

  const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

  async function buildHtml(frames, nonce, fetcher) {
    // First fetch and process everything (in parallel), then replace the tokens
    const resolved = new Map()
    await Promise.all(
      [...frames.values()].map(async (frame) => {
        const [resources, styles, attrStyles] = await Promise.all([
          Promise.all(frame.resources.map(async (url) => (await fetcher.dataUri(url)) || escapeAttr(url))),
          Promise.all(
            frame.styles.map(async (style) => {
              let css = style.css
              let base = style.base
              if (css === undefined) {
                css = (await fetcher.text(style.href)) || ''
                base = style.href
              }
              const out = await processCss(css, base, fetcher)
              return style.media ? `@media ${style.media}{${out}}` : out
            })
          ),
          Promise.all(frame.attrStyles.map((style) => processCss(style.css, style.base, fetcher))),
        ])
        resolved.set(frame.path, { resources, styles, attrStyles })
      })
    )

    const tokenRe = new RegExp(`__BURG_${nonce}_([RSA])(\\d+)__`, 'g')
    const frameRe = new RegExp(`\\ssrcdoc="__BURG_${nonce}_F([\\d.]+)__"`, 'g')
    const done = new Map()

    function assemble(path, depth = 0) {
      if (done.has(path)) return done.get(path)
      const frame = frames.get(path)
      const parts = resolved.get(path)
      let html = frame.html.replace(tokenRe, (whole, kind, index) => {
        const i = Number(index)
        if (kind === 'R') return parts.resources[i] ?? ''
        if (kind === 'S') return (parts.styles[i] ?? '').replace(/<\/(style)/gi, '<\\/$1')
        return escapeAttr(parts.attrStyles[i] ?? '')
      })
      html = html.replace(frameRe, (whole, child) =>
        frames.has(child) && depth < 10 ? ` srcdoc="${escapeAttr(assemble(child, depth + 1))}"` : ''
      )
      done.set(path, html)
      return html
    }

    return assemble('')
  }

  // ------------------------------------------------------------------------
  // Thumbnail and hash
  // ------------------------------------------------------------------------

  async function thumbnail(tab) {
    try {
      const current = await chrome.tabs.get(tab.id)
      if (!current.active) return null
      const win = await chrome.windows.get(current.windowId)
      if (win.state === 'minimized') return null
      const dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'jpeg', quality: 80 })
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
      const scale = THUMB_WIDTH / bitmap.width
      const height = Math.min(THUMB_HEIGHT, Math.round(bitmap.height * scale))
      const canvas = new OffscreenCanvas(THUMB_WIDTH, height)
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, bitmap.width, height / scale, 0, 0, THUMB_WIDTH, height)
      bitmap.close()
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 })
    } catch (error) {
      return null
    }
  }

  async function sha256(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  // ------------------------------------------------------------------------
  // Putting it all together
  // ------------------------------------------------------------------------

  /**
   * @param tab chrome.tabs.Tab
   * @param options { format: 'html'|'mhtml', lazy, stamp, tags, note, run }
   * @param progress (text, percent?) => void
   * @returns meta of the saved item
   */
  async function archiveTab(tab, options = {}, progress = () => {}) {
    assertCapturable(tab)
    const format = options.format === 'mhtml' ? 'mhtml' : 'html'
    const createdAt = Date.now()
    const nonce = Math.random().toString(36).slice(2, 10)
    const target = { tabId: tab.id }

    let originalScroll = null
    if (options.lazy) {
      progress(t('progScroll'))
      const [{ result }] = await chrome.scripting.executeScript({ target, func: pagePrescroll })
      originalScroll = result
    }

    progress(t('progThumb'))
    const thumb = await thumbnail(tab)
    if (originalScroll) chrome.scripting.executeScript({ target, func: pageScroll, args: [originalScroll] }).catch(() => {})

    let file
    let info
    if (format === 'mhtml') {
      progress(t('progMhtml'))
      info = (await freezeFrames(tab.id, { nonce, savedAt: createdAt, infoOnly: true })).get('')
      file = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id })
      file = new Blob([file], { type: 'multipart/related' })
    } else {
      progress(t('progFreeze'))
      const frames = await freezeFrames(tab.id, { nonce, savedAt: createdAt, stamp: !!options.stamp })
      info = frames.get('')
      const fetcher = createFetcher((finished, started) =>
        progress(t('progResources', finished, started), started ? Math.round((finished / started) * 100) : 0)
      )
      const html = await buildHtml(frames, nonce, fetcher)
      progress(t('progSaving'))
      file = new Blob([html], { type: 'text/html' })
    }

    let host = ''
    try {
      host = new URL(info.url).hostname.replace(/^www\./, '')
    } catch (e) {
      // not a valid URL
    }

    const meta = {
      id: newId(),
      url: info.url || tab.url,
      host,
      title: info.title || tab.title || info.url,
      createdAt,
      kind: format,
      size: file.size,
      sha256: await sha256(file),
      tags: options.tags || [],
      note: options.note || '',
      stamp: format === 'html' && !!options.stamp,
      thumb,
      seo: info.seo || null,
      lang: info.lang || '',
      run: options.run || null,
    }
    await ArchiveDB.save(meta, file, info.text || '')
    return meta
  }

  return { archiveTab, assertCapturable, sleep }
})()
