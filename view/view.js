'use strict'

localizePage()

const $ = (id) => document.getElementById(id)
const { el, formatDate, formatBytes, parseTags, baseName, wayback } = BurgUtil
const id = new URLSearchParams(location.search).get('id')

let meta = null
let file = null
let frameUrl = null
$('thumb-large').alt = t('thumbnail')

async function init() {
  meta = id && (await ArchiveDB.getMeta(id))
  file = meta && (await ArchiveDB.getFile(id))
  if (!meta || !file) {
    $('missing').hidden = false
    for (const button of document.querySelectorAll('.actions button')) button.disabled = true
    return
  }
  $('layout').hidden = false
  document.title = `${meta.title || meta.url} · ${t('extName')}`

  $('page-url').textContent = meta.url
  $('page-url').href = meta.url
  $('page-url').title = t('openCurrent')
  $('page-meta').textContent = t('viewMeta', meta.kind.toUpperCase(), formatBytes(meta.size), formatDate(meta.createdAt))
  $('title').textContent = meta.title || meta.url

  $('f-date').textContent = `${formatDate(meta.createdAt, true)} (${new Date(meta.createdAt).toISOString()})`
  $('f-url').textContent = meta.url
  $('f-kind').textContent = meta.kind === 'mhtml' ? 'MHTML (Chrome)' : `${t('fmtHtml')}${meta.stamp ? t('withStamp') : ''}`
  $('f-size').textContent = formatBytes(meta.size)
  $('f-hash').textContent = meta.sha256

  $('tags').value = (meta.tags || []).join(', ')
  $('note').value = meta.note || ''

  renderSeo()
  await renderVersions()

  if (meta.kind === 'html') {
    // <base target="_blank">: links open the real site in a new tab.
    // The frame is sandboxed (no scripts, its own origin).
    const html = await file.text()
    const withBase = html.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">')
    frameUrl = URL.createObjectURL(new Blob([withBase], { type: 'text/html;charset=utf-8' }))
    $('frame').src = frameUrl
  } else {
    $('frame').hidden = true
    $('fullscreen').hidden = true
    $('mhtml-note').hidden = false
    if (meta.thumb) {
      $('thumb-large').src = URL.createObjectURL(meta.thumb)
      $('thumb-large').hidden = false
    }
  }
}

function renderSeo() {
  const seo = meta.seo
  if (!seo) return
  $('seo-section').hidden = false
  const rows = [
    [t('seoTitle'), seo.title],
    [t('seoDescription'), seo.description],
    ['Canonical', seo.canonical],
    ['Robots', seo.robots],
    ['H1', (seo.h1 || []).join(' · ')],
    [t('seoWords'), String(seo.words)],
    ['Links', t('linksInternal', seo.links, seo.internal)],
    [t('seoImages'), String(seo.images)],
  ]
  $('seo').replaceChildren(
    ...rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', { class: value ? '' : 'muted' }, value || '—')])
  )
}

async function renderVersions() {
  const versions = await ArchiveDB.versions(meta.url)
  if (versions.length < 2) {
    $('versions').replaceChildren(el('li', { class: 'muted' }, t('onlyThisVersion')))
    return
  }
  $('versions').replaceChildren(
    ...versions.map((version) => {
      const current = version.id === meta.id
      const [older, newer] = version.createdAt < meta.createdAt ? [version, meta] : [meta, version]
      return el(
        'li',
        { class: current ? 'current' : '' },
        el('span', {}, `${formatDate(version.createdAt, true)}${version.kind === 'mhtml' ? ' · MHTML' : ''}`),
        current
          ? el('em', { class: 'muted' }, t('thisOne'))
          : el('a', { href: `view.html?id=${encodeURIComponent(version.id)}` }, t('viewLower')),
        current
          ? null
          : el('a', { href: `../compare/compare.html?a=${encodeURIComponent(older.id)}&b=${encodeURIComponent(newer.id)}` }, t('compareLower'))
      )
    })
  )
}

// ---------------------------------------------------------------------------
// Tabs and actions
// ---------------------------------------------------------------------------

let textLoaded = false
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', async () => {
    for (const other of document.querySelectorAll('[data-tab]')) other.classList.toggle('on', other === tab)
    const showText = tab.dataset.tab === 'text'
    if (showText && !textLoaded) {
      $('text').textContent = (await ArchiveDB.getText(meta.id)) || t('noTextSaved')
      textLoaded = true
    }
    $('text').hidden = !showText
    if (meta.kind === 'html') $('frame').hidden = showText
    else $('thumb-large').hidden = showText || !meta.thumb
  })
}

$('download').addEventListener('click', () => {
  BurgUtil.download(file, `${baseName(meta)}.${meta.kind === 'mhtml' ? 'mhtml' : 'html'}`)
})

$('fullscreen').addEventListener('click', () => {
  const full = document.body.classList.toggle('full')
  $('fullscreen').textContent = full ? t('showDetails') : t('fullscreen')
})

$('copy-hash').addEventListener('click', async () => {
  await navigator.clipboard.writeText(meta.sha256)
  $('copy-hash').textContent = t('copied')
  setTimeout(() => ($('copy-hash').textContent = t('copy')), 1500)
})

async function saveDetails() {
  const tags = parseTags($('tags').value)
  const note = $('note').value.trim()
  if (tags.join(',') === (meta.tags || []).join(',') && note === (meta.note || '')) return
  meta = await ArchiveDB.update(meta.id, { tags, note })
  $('tags').value = tags.join(', ')
  $('saved-hint').textContent = t('savedHint')
  setTimeout(() => ($('saved-hint').textContent = ''), 1500)
}
$('tags').addEventListener('change', saveDetails)
$('tags').addEventListener('keydown', (event) => event.key === 'Enter' && saveDetails())
$('note').addEventListener('change', saveDetails)

for (const button of document.querySelectorAll('[data-wb]')) {
  button.addEventListener('click', () => {
    const kind = button.dataset.wb
    const day = new Date(meta.createdAt).toISOString().slice(0, 10)
    chrome.tabs.create({ url: kind === 'saved' ? wayback.around(meta.url, day) : wayback[kind](meta.url) })
  })
}

// Delete in two clicks, without a browser dialog
let deleteTimer = null
$('delete').addEventListener('click', async () => {
  const button = $('delete')
  if (!button.dataset.armed) {
    button.dataset.armed = '1'
    button.textContent = t('confirmDelete')
    deleteTimer = setTimeout(() => {
      button.dataset.armed = ''
      button.textContent = t('delete')
    }, 4000)
    return
  }
  clearTimeout(deleteTimer)
  await ArchiveDB.remove(meta.id)
  if (frameUrl) URL.revokeObjectURL(frameUrl)
  location.href = '../library/library.html'
})

init()
