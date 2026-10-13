'use strict'

localizePage()

const $ = (id) => document.getElementById(id)
const { el, formatDate, formatBytes, parseTags, buildZip, stamp } = BurgUtil
const PAGE_SIZE = 120
const pageCount = (n) => t(n === 1 ? 'pageOne' : 'pageMany', n)

const state = {
  items: [],
  texts: null, // Map id → lowercase text, only loaded on the first search
  kind: '',
  tag: '',
  run: new URLSearchParams(location.search).get('run') || '',
  selected: new Set(),
  shown: PAGE_SIZE,
}
const thumbUrls = new Map()

function notice(text, type = '') {
  $('notice').hidden = !text
  $('notice').className = `notice ${type}`
  $('notice').textContent = text || ''
}

function thumbUrl(item) {
  if (!item.thumb) return null
  if (!thumbUrls.has(item.id)) thumbUrls.set(item.id, URL.createObjectURL(item.thumb))
  return thumbUrls.get(item.id)
}

async function load() {
  state.items = await ArchiveDB.list()
  const total = state.items.reduce((sum, item) => sum + item.size, 0)
  $('summary').textContent = `${pageCount(state.items.length)} · ${formatBytes(total)}`
  renderFilters()
  render()
}

async function ensureTexts() {
  if (state.texts) return
  const texts = await ArchiveDB.allTexts()
  state.texts = new Map([...texts].map(([id, text]) => [id, { raw: text, lower: text.toLowerCase() }]))
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function renderFilters() {
  const tagCounts = new Map()
  const runs = new Map()
  for (const item of state.items) {
    for (const tag of item.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
    if (item.run) {
      const run = runs.get(item.run) || { host: item.host, count: 0, time: Number(item.run.split('-')[1]) || item.createdAt }
      run.count++
      runs.set(item.run, run)
    }
  }

  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  $('tag-filters').replaceChildren(
    ...(tags.length ? [el('span', { class: 'lbl' }, 'Tags')] : []),
    ...tags.map(([tag, count]) =>
      el(
        'button',
        { class: `chip${state.tag === tag ? ' on' : ''}`, onclick: () => setFilter('tag', state.tag === tag ? '' : tag) },
        `${tag} `,
        el('span', { class: 'muted' }, String(count))
      )
    )
  )

  const runList = [...runs].sort((a, b) => b[1].time - a[1].time)
  $('run-filters').replaceChildren(
    ...(runList.length ? [el('span', { class: 'lbl' }, 'Sites')] : []),
    ...runList.map(([id, run]) =>
      el(
        'button',
        { class: `chip${state.run === id ? ' on' : ''}`, onclick: () => setFilter('run', state.run === id ? '' : id) },
        `${run.host} · ${new Date(run.time).toLocaleDateString(t('locale'))} `,
        el('span', { class: 'muted' }, String(run.count))
      )
    )
  )
}

function setFilter(key, value) {
  state[key] = value
  state.shown = PAGE_SIZE
  renderFilters()
  render()
}

for (const chip of document.querySelectorAll('[data-kind]')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-kind]')) other.classList.toggle('on', other === chip)
    setFilter('kind', chip.dataset.kind)
  })
}

// ---------------------------------------------------------------------------
// Searching and showing
// ---------------------------------------------------------------------------

function terms() {
  return $('search').value.toLowerCase().split(/\s+/).filter(Boolean)
}

function matches(item, words) {
  if (!words.length) return true
  const text = state.texts && state.texts.get(item.id)
  const hay = `${item.title} ${item.url} ${(item.tags || []).join(' ')} ${item.note || ''}`.toLowerCase()
  return words.every((word) => hay.includes(word) || (text && text.lower.includes(word)))
}

function filtered() {
  const words = terms()
  let items = state.items.filter(
    (item) =>
      (!state.kind || item.kind === state.kind) &&
      (!state.tag || (item.tags || []).includes(state.tag)) &&
      (!state.run || item.run === state.run) &&
      matches(item, words)
  )
  if ($('latest-only').checked) {
    const seen = new Set()
    items = items.filter((item) => !seen.has(item.url) && seen.add(item.url))
  }
  const sorters = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    title: (a, b) => (a.title || '').localeCompare(b.title || '', t('lang')),
    host: (a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url) || b.createdAt - a.createdAt,
    size: (a, b) => b.size - a.size,
  }
  return items.sort(sorters[$('sort').value])
}

/** Text snippet around the first match, with <mark> (via the DOM, not via innerHTML). */
function snippet(item, words) {
  const text = state.texts && state.texts.get(item.id)
  if (!text || !words.length) return null
  let at = -1
  let word = ''
  for (const w of words) {
    at = text.lower.indexOf(w)
    if (at >= 0) {
      word = w
      break
    }
  }
  if (at < 0) return null
  const start = Math.max(0, at - 60)
  const end = Math.min(text.raw.length, at + word.length + 90)
  const clean = (s) => s.replace(/\s+/g, ' ')
  return el(
    'div',
    { class: 'snippet' },
    start > 0 ? '…' : '',
    clean(text.raw.slice(start, at)),
    el('mark', {}, clean(text.raw.slice(at, at + word.length))),
    clean(text.raw.slice(at + word.length, end)),
    end < text.raw.length ? '…' : ''
  )
}

function versionCounts() {
  const counts = new Map()
  for (const item of state.items) counts.set(item.url, (counts.get(item.url) || 0) + 1)
  return counts
}

function card(item, words, counts) {
  const href = `../view/view.html?id=${encodeURIComponent(item.id)}`
  const url = thumbUrl(item)
  const thumb = el('a', { class: `thumb${url ? '' : ' placeholder'}`, href }, url ? '' : item.host || t('pageFallback'))
  if (url) thumb.style.backgroundImage = `url("${url}")`

  const pick = el('input', {
    type: 'checkbox',
    class: 'pick',
    checked: state.selected.has(item.id),
    'aria-label': t('select'),
    onchange: (event) => {
      if (event.target.checked) state.selected.add(item.id)
      else state.selected.delete(item.id)
      event.target.closest('.item').classList.toggle('selected', event.target.checked)
      renderSelection()
    },
  })

  const versions = counts.get(item.url) || 1
  return el(
    'article',
    { class: `item${state.selected.has(item.id) ? ' selected' : ''}` },
    pick,
    el('span', { class: 'kind' }, item.kind),
    thumb,
    el(
      'div',
      { class: 'body' },
      el('a', { class: 't', href, title: item.url }, item.title || item.url),
      el('div', { class: 'meta', title: item.url }, `${item.host} · ${formatDate(item.createdAt)} · ${formatBytes(item.size)}`),
      versions > 1 ? el('div', { class: 'meta' }, t('versionsOfUrl', versions)) : null,
      item.note ? el('div', { class: 'note' }, item.note) : null,
      (item.tags || []).length ? el('div', { class: 'tags' }, item.tags.map((tag) => el('span', { class: 'chip' }, tag))) : null,
      snippet(item, words)
    )
  )
}

function render() {
  const words = terms()
  const items = filtered()
  const counts = versionCounts()
  const grid = $('grid')

  if (!state.items.length) {
    grid.replaceChildren(
      el(
        'p',
        { class: 'empty' },
        t('libraryEmpty')
      )
    )
    return
  }
  if (!items.length) {
    grid.replaceChildren(el('p', { class: 'empty' }, t('nothingFound')))
    return
  }

  grid.replaceChildren(...items.slice(0, state.shown).map((item) => card(item, words, counts)))
  if (items.length > state.shown) {
    grid.append(
      el(
        'div',
        { class: 'more', style: 'grid-column: 1 / -1' },
        el('button', { onclick: () => ((state.shown += PAGE_SIZE), render()) }, t('showMore', items.length - state.shown))
      )
    )
  }
}

let searchTimer = null
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    if (terms().length) await ensureTexts()
    state.shown = PAGE_SIZE
    render()
  }, 150)
})
$('sort').addEventListener('change', render)
$('latest-only').addEventListener('change', render)

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectedItems() {
  return state.items.filter((item) => state.selected.has(item.id))
}

function renderSelection() {
  const count = state.selected.size
  $('selection').hidden = count === 0
  $('selection-count').textContent = t('selectedCount', count)
  $('sel-compare').disabled = count !== 2
  $('sel-compare').title = count === 2 ? '' : t('pickTwo')
  resetDelete()
}

function clearSelection() {
  state.selected.clear()
  renderSelection()
  render()
}

$('sel-clear').addEventListener('click', clearSelection)

$('sel-compare').addEventListener('click', () => {
  const [a, b] = selectedItems().sort((x, y) => x.createdAt - y.createdAt)
  location.href = `../compare/compare.html?a=${encodeURIComponent(a.id)}&b=${encodeURIComponent(b.id)}`
})

$('sel-zip').addEventListener('click', async () => {
  const button = $('sel-zip')
  const items = selectedItems()
  button.disabled = true
  button.textContent = t('makingZip')
  try {
    const hosts = [...new Set(items.map((item) => item.host))]
    const title = `${hosts.length === 1 ? hosts[0] : 'burg-archief'}_${stamp(Date.now())}`
    const zip = await buildZip(items, (id) => ArchiveDB.getFile(id), title)
    BurgUtil.download(zip, `${title}.zip`)
    notice(t('zipMade', items.length, formatBytes(zip.size)), 'ok')
  } catch (error) {
    notice(t('zipFailed', error.message), 'error')
  } finally {
    button.disabled = false
    button.textContent = t('downloadZip')
  }
})

async function addTags() {
  const tags = parseTags($('sel-tags').value)
  if (!tags.length) return $('sel-tags').focus()
  for (const item of selectedItems()) {
    const merged = [...new Set([...(item.tags || []), ...tags])]
    await ArchiveDB.update(item.id, { tags: merged })
  }
  $('sel-tags').value = ''
  notice(t('tagsAdded', state.selected.size), 'ok')
  await load()
}
$('sel-tag').addEventListener('click', addTags)
$('sel-tags').addEventListener('keydown', (event) => event.key === 'Enter' && addTags())

// Delete in two clicks, without a browser dialog
let deleteTimer = null
function resetDelete() {
  clearTimeout(deleteTimer)
  $('sel-delete').dataset.armed = ''
  $('sel-delete').textContent = t('delete')
}
$('sel-delete').addEventListener('click', async () => {
  const button = $('sel-delete')
  if (!button.dataset.armed) {
    button.dataset.armed = '1'
    button.textContent = t('confirmDeleteCount', state.selected.size)
    deleteTimer = setTimeout(resetDelete, 4000)
    return
  }
  const count = state.selected.size
  for (const id of state.selected) {
    await ArchiveDB.remove(id)
    if (thumbUrls.has(id)) URL.revokeObjectURL(thumbUrls.get(id))
    thumbUrls.delete(id)
    if (state.texts) state.texts.delete(id)
  }
  state.selected.clear()
  renderSelection()
  notice(t(count === 1 ? 'deletedOne' : 'deletedMany', count))
  await load()
})

// ---------------------------------------------------------------------------

load()
