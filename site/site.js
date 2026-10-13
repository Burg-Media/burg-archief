'use strict'

// Save whole site: find pages (sitemap or following links), then open them
// one by one in a separate window and capture them with BurgCapture.
// This page drives everything, so it has to stay open.

localizePage()

const $ = (id) => document.getElementById(id)
const { el, formatBytes, parseTags, buildZip, stamp } = BurgUtil
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|gz|7z|tar|exe|dmg|msi|docx?|xlsx?|pptx?|odt|csv|mp4|mp3|m4a|wav|webm|mov|avi|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|otf|eot)$/i
const FETCH_TIMEOUT = 15000
const LOAD_TIMEOUT = 45000
const pageCount = (n) => t(n === 1 ? 'pageOne' : 'pageMany', n)

const state = { urls: [], checked: new Set(), statuses: new Map(), running: false, stop: false, runId: null }

// ---------------------------------------------------------------------------
// Finding pages
// ---------------------------------------------------------------------------

const siteKey = (host) => host.replace(/^www\./, '').toLowerCase()

function cleanUrl(value, base) {
  try {
    const u = new URL(value, base)
    if (!/^https?:$/.test(u.protocol)) return null
    u.hash = ''
    return u.href
  } catch (e) {
    return null
  }
}

async function fetchText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal })
    if (!response.ok) return null
    return { text: await response.text(), type: response.headers.get('content-type') || '', url: response.url }
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function makeFilter(start) {
  const startUrl = new URL(start)
  const key = siteKey(startUrl.hostname)
  const dir = startUrl.pathname.replace(/[^/]*$/, '')
  const samePath = $('same-path').checked
  return (url) => {
    if (!url) return false
    const u = new URL(url)
    if (siteKey(u.hostname) !== key) return false
    if (SKIP_EXT.test(u.pathname)) return false
    if (samePath && !u.pathname.startsWith(dir)) return false
    return true
  }
}

async function fromSitemaps(start, accept, max, status) {
  const origin = new URL(start).origin
  const queue = []
  const robots = await fetchText(`${origin}/robots.txt`)
  if (robots) {
    for (const match of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(match[1])
  }
  if (!queue.length) queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`)

  const seen = new Set()
  const found = new Set()
  while (queue.length && seen.size < 50 && found.size < max) {
    const sitemap = queue.shift()
    if (seen.has(sitemap)) continue
    seen.add(sitemap)
    status(t('readingSitemap', sitemap))
    const response = await fetchText(sitemap)
    if (!response || !/<(urlset|sitemapindex)\b/i.test(response.text)) continue
    const doc = new DOMParser().parseFromString(response.text, 'application/xml')
    const isIndex = doc.documentElement.localName === 'sitemapindex'
    for (const loc of doc.getElementsByTagNameNS('*', 'loc')) {
      const url = cleanUrl(loc.textContent.trim(), sitemap)
      if (!url) continue
      if (isIndex) queue.push(url)
      else if (accept(url) && found.size < max) found.add(url)
    }
  }
  return [...found]
}

async function fromLinks(start, accept, max, depth, status) {
  const found = new Set([start])
  let level = [start]
  for (let d = 0; d < depth && level.length && found.size < max; d++) {
    const next = []
    for (let i = 0; i < level.length && found.size < max; i += 4) {
      const batch = level.slice(i, i + 4)
      status(t('followingLinks', d + 1, found.size))
      const pages = await Promise.all(batch.map(fetchText))
      for (const page of pages) {
        if (!page || !/html/i.test(page.type)) continue
        const doc = new DOMParser().parseFromString(page.text, 'text/html')
        const base = cleanUrl(doc.querySelector('base[href]')?.getAttribute('href') || page.url, page.url) || page.url
        for (const a of doc.querySelectorAll('a[href]')) {
          const url = cleanUrl(a.getAttribute('href'), base)
          if (url && !found.has(url) && accept(url) && found.size < max) {
            found.add(url)
            next.push(url)
          }
        }
      }
    }
    level = next
  }
  return [...found]
}

$('discover').addEventListener('click', async () => {
  const start = cleanUrl($('start').value.trim())
  if (!start) {
    $('discover-status').textContent = t('enterValidUrl')
    return $('start').focus()
  }
  $('start').value = start
  const max = Math.max(1, Math.min(1000, Number($('max').value) || 100))
  const method = $('method').value
  const accept = makeFilter(start)
  const status = (text) => ($('discover-status').textContent = text)
  $('discover').disabled = true

  try {
    let urls = []
    let source = ''
    if (method !== 'links') {
      urls = await fromSitemaps(start, accept, max, status)
      source = 'sitemap'
    }
    if (method === 'links' || (method === 'both' && !urls.length)) {
      urls = await fromLinks(start, accept, max, Number($('depth').value), status)
      source = 'links'
    }
    if (!urls.includes(start) && accept(start)) urls.unshift(start)
    urls = urls.slice(0, max).sort((a, b) => (a === start ? -1 : b === start ? 1 : a.localeCompare(b)))
    state.urls = urls
    state.checked = new Set(urls)
    state.statuses.clear()
    status(
      urls.length
        ? t(source === 'sitemap' ? 'foundSitemap' : 'foundLinks', pageCount(urls.length))
        : t('noPagesFound')
    )
    $('step-pick').hidden = !urls.length
    $('step-run').hidden = !urls.length
    $('done').hidden = true
    renderUrls()
  } catch (error) {
    status(t('findFailed', error.message))
  } finally {
    $('discover').disabled = false
  }
})

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const STATUS_LABEL = { busy: t('statusBusy'), ok: t('statusOk'), err: t('statusErr'), skip: t('statusSkip') }

function renderUrls() {
  const query = $('filter').value.trim().toLowerCase()
  const shown = state.urls.filter((url) => !query || url.toLowerCase().includes(query))
  $('urls').replaceChildren(
    ...shown.map((url) => {
      const status = state.statuses.get(url)
      return el(
        'li',
        { dataset: { url } },
        el(
          'label',
          {},
          el('input', {
            type: 'checkbox',
            checked: state.checked.has(url),
            disabled: state.running,
            onchange: (event) => {
              if (event.target.checked) state.checked.add(url)
              else state.checked.delete(url)
              updateCount()
            },
          }),
          el('span', {}, url)
        ),
        el('span', { class: `state ${status ? status.state : ''}`, title: status && status.error ? status.error : '' }, status ? STATUS_LABEL[status.state] : '')
      )
    })
  )
  updateCount()
}

function updateCount() {
  $('pick-count').textContent = t('pickedCount', state.checked.size, state.urls.length)
  $('run').disabled = state.running || !state.checked.size
}

function setStatus(url, value) {
  state.statuses.set(url, value)
  const item = [...$('urls').children].find((li) => li.dataset.url === url)
  if (item) {
    const badge = item.querySelector('.state')
    badge.className = `state ${value.state}`
    badge.textContent = STATUS_LABEL[value.state]
    badge.title = value.error || ''
    if (value.state === 'busy') item.scrollIntoView({ block: 'nearest' })
  }
}

$('filter').addEventListener('input', renderUrls)
$('all').addEventListener('click', () => {
  const query = $('filter').value.trim().toLowerCase()
  for (const url of state.urls) if (!query || url.toLowerCase().includes(query)) state.checked.add(url)
  renderUrls()
})
$('none').addEventListener('click', () => {
  const query = $('filter').value.trim().toLowerCase()
  for (const url of state.urls) if (!query || url.toLowerCase().includes(query)) state.checked.delete(url)
  renderUrls()
})

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      chrome.tabs.onRemoved.removeListener(removed)
      resolve()
    }
    const listener = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && tab.url !== 'about:blank') finish()
    }
    const removed = (id) => id === tabId && finish()
    const timer = setTimeout(finish, LOAD_TIMEOUT)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.onRemoved.addListener(removed)
  })
}

function progress(done, total, text) {
  $('progress').hidden = false
  $('bar-fill').style.width = `${total ? Math.round((done / total) * 100) : 0}%`
  $('progress-text').textContent = `${done}/${total} · ${text}`
}

$('run').addEventListener('click', async () => {
  const urls = state.urls.filter((url) => state.checked.has(url))
  if (!urls.length) return
  state.running = true
  state.stop = false
  state.runId = `run-${Date.now()}`
  $('run').disabled = true
  $('stop').hidden = false
  $('stop').disabled = false
  $('stop').textContent = t('stop')
  $('done').hidden = true
  $('discover').disabled = true
  renderUrls()

  const options = { format: $('format').value, lazy: $('lazy').checked, tags: parseTags($('tags').value), run: state.runId }
  const wait = Number($('wait').value)
  let win = null
  let ok = 0
  let failed = 0

  try {
    win = await chrome.windows.create({ url: 'about:blank', focused: true, width: 1280, height: 900, type: 'normal' })
    const tabId = win.tabs[0].id

    for (const [index, url] of urls.entries()) {
      if (state.stop) {
        setStatus(url, { state: 'skip' })
        continue
      }
      setStatus(url, { state: 'busy' })
      progress(index, urls.length, t('opening', url))
      try {
        const loaded = waitForLoad(tabId)
        await chrome.tabs.update(tabId, { url })
        await loaded
        await BurgCapture.sleep(wait)
        const tab = await chrome.tabs.get(tabId)
        await BurgCapture.archiveTab(tab, options, (text) => progress(index, urls.length, `${text} ${url}`))
        setStatus(url, { state: 'ok' })
        ok++
      } catch (error) {
        setStatus(url, { state: 'err', error: error.message })
        failed++
        if (/no tab with id/i.test(error.message)) {
          state.stop = true // window closed
        }
      }
    }
  } catch (error) {
    progress(0, urls.length, t('failedMsg', error.message))
  } finally {
    if (win) chrome.windows.remove(win.id).catch(() => {})
    chrome.tabs.getCurrent().then((tab) => tab && chrome.tabs.update(tab.id, { active: true })).catch(() => {})
    state.running = false
    $('stop').hidden = true
    $('discover').disabled = false
    updateCount()
    for (const box of $('urls').querySelectorAll('input')) box.disabled = false
    progress(urls.length, urls.length, t('doneSummary', ok, failed ? t('doneFailedPart', failed) : '', state.stop ? ` ${t('doneStopped')}` : ''))
    $('done').hidden = !ok
    $('open-run').href = `../library/library.html?run=${encodeURIComponent(state.runId)}`
  }
})

$('stop').addEventListener('click', () => {
  state.stop = true
  $('stop').disabled = true
  $('stop').textContent = t('stopAfterPage')
})

$('zip').addEventListener('click', async () => {
  $('zip').disabled = true
  $('zip-status').textContent = t('makingZip')
  try {
    const items = (await ArchiveDB.list()).filter((item) => item.run === state.runId)
    const host = items[0] ? items[0].host : 'site'
    const title = `${host}_${stamp(Date.now())}`
    const zip = await buildZip(items, (id) => ArchiveDB.getFile(id), title)
    BurgUtil.download(zip, `${title}.zip`)
    $('zip-status').textContent = t('zipSiteDone', pageCount(items.length), formatBytes(zip.size), t('overviewFile'))
  } catch (error) {
    $('zip-status').textContent = t('failedMsg', error.message)
  } finally {
    $('zip').disabled = false
  }
})

// Start URL from the popup
const fromPopup = new URLSearchParams(location.search).get('url')
if (fromPopup) {
  try {
    $('start').value = new URL(fromPopup).origin + '/'
  } catch (e) {
    // not a valid URL
  }
}
