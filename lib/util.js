'use strict'

// Shared helpers for the pages of Burg Archive.

const BurgUtil = (() => {
  const pad = (n) => String(n).padStart(2, '0')

  function formatDate(time, withSeconds = false) {
    return new Date(time).toLocaleString(t('locale'), { dateStyle: 'medium', timeStyle: withSeconds ? 'medium' : 'short' })
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toLocaleString(t('locale'), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
  }

  function stamp(time) {
    const d = new Date(time)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`
  }

  function baseName(meta) {
    return `${meta.host || t('pageFallback')}_${stamp(meta.createdAt)}`.replace(/[^\w.-]+/g, '-')
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else if (key in node && key !== 'list') node[key] = value
      else node.setAttribute(key, value === true ? '' : value)
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
    return node
  }

  function parseTags(text) {
    return [...new Set(String(text || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))]
  }

  // ------------------------------------------------------------------------
  // Wayback Machine (links only; the user clicks them)
  // ------------------------------------------------------------------------

  function waybackStamp(date) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  }

  const wayback = {
    calendar: (url) => `https://web.archive.org/web/*/${url}`,
    oldest: (url) => `https://web.archive.org/web/19960101000000/${url}`,
    newest: (url) => `https://web.archive.org/web/${waybackStamp(new Date())}/${url}`,
    /** @param day 'YYYY-MM-DD' */
    around: (url, day) => `https://web.archive.org/web/${day.replace(/-/g, '')}120000/${url}`,
    save: (url) => `https://web.archive.org/save/${url}`,
  }

  // ------------------------------------------------------------------------
  // ZIP export: folder structure per site, links between pages made relative
  // ------------------------------------------------------------------------

  function shortHash(text) {
    let h = 2166136261
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
    return (h >>> 0).toString(36)
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url)
      u.hash = ''
      return u.href
    } catch (e) {
      return url
    }
  }

  function pathForUrl(url, kind) {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    let path = decodeURIComponent(u.pathname).replace(/[<>:"\\|?*\u0000-\u001f]/g, '_')
    let segments = path.split('/').filter((s) => s && s !== '.' && s !== '..')
    let file = 'index'
    if (!path.endsWith('/') && segments.length) {
      const last = segments.pop()
      file = last.replace(/\.(html?|php\d?|aspx?|jsp|cfm)$/i, '')
    }
    if (u.search) file += `_${shortHash(u.search)}`
    const ext = kind === 'mhtml' ? 'mhtml' : 'html'
    return [host, ...segments, `${file}.${ext}`].join('/')
  }

  function relativePath(from, to) {
    const a = from.split('/').slice(0, -1)
    const b = to.split('/')
    let common = 0
    while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++
    return '../'.repeat(a.length - common) + b.slice(common).join('/')
  }

  /**
   * @param items metas (newest first or in any order)
   * @param getFile id → Blob
   * @returns Blob (ZIP)
   */
  async function buildZip(items, getFile, title) {
    const root = title.replace(/[^\w.-]+/g, '-')
    const used = new Set()
    const entries = items.map((meta) => {
      let path = pathForUrl(meta.url, meta.kind)
      if (used.has(path)) path = path.replace(/(\.\w+)$/, `_${stamp(meta.createdAt)}$1`)
      while (used.has(path)) path = path.replace(/(\.\w+)$/, '_$1')
      used.add(path)
      return { meta, path }
    })

    // Per URL, the newest version is the link target
    const byUrl = new Map()
    for (const entry of [...entries].sort((x, y) => x.meta.createdAt - y.meta.createdAt)) {
      if (entry.meta.kind === 'html') byUrl.set(normalizeUrl(entry.meta.url), entry.path)
    }

    const files = []
    for (const { meta, path } of entries) {
      let data = await getFile(meta.id)
      if (!data) continue
      if (meta.kind === 'html' && byUrl.size > 1) {
        const html = await data.text()
        data = html.replace(/(<a\b[^>]*?\shref=")([^"]*)(")/gi, (whole, start, href, end) => {
          const raw = href.replace(/&amp;/g, '&')
          const [base, hash] = raw.split('#')
          const target = byUrl.get(normalizeUrl(base))
          if (!target) return whole
          return `${start}${relativePath(path, target)}${hash !== undefined ? `#${hash}` : ''}${end}`
        })
      }
      files.push({ name: `${root}/${path}`, data, date: new Date(meta.createdAt) })
    }

    const listing = entries
      .map(({ meta, path }) => ({
        url: meta.url,
        title: meta.title,
        bewaard: new Date(meta.createdAt).toISOString(),
        bestand: path,
        type: meta.kind,
        sha256_origineel: meta.sha256,
        tags: meta.tags,
        notitie: meta.note || undefined,
      }))
    files.push({ name: `${root}/archief.json`, data: JSON.stringify(listing, null, 2) })
    files.push({ name: `${root}/${t('overviewFile')}`, data: overviewHtml(title, entries) })
    return BurgZip.create(files)
  }

  function overviewHtml(title, entries) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
    const rows = [...entries]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(
        ({ meta, path }) =>
          `<tr><td><a href="${esc(path)}">${esc(meta.title || meta.url)}</a><br><small>${esc(meta.url)}</small></td>` +
          `<td>${esc(formatDate(meta.createdAt))}</td><td>${meta.kind.toUpperCase()}</td></tr>`
      )
      .join('\n')
    return `<!doctype html><html lang="${t('lang')}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#0E0E10;background:#FBF9F4}h1{font-weight:600;letter-spacing:-.02em}
table{border-collapse:collapse;width:100%}td{padding:8px 10px;border-bottom:1px solid #E4DFD3;vertical-align:top}
small{color:#6B675E;font-family:ui-monospace,Menlo,monospace}a{color:#0E0E10}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(t('overviewIntro', entries.length))}</p>
<table>${rows}</table></body></html>`
  }

  return { formatDate, formatBytes, stamp, baseName, download, el, parseTags, wayback, buildZip, pathForUrl, relativePath }
})()
