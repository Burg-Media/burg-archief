'use strict'

localizePage()

const $ = (id) => document.getElementById(id)
const { el, formatDate, formatBytes } = BurgUtil
const params = new URLSearchParams(location.search)
const CONTEXT = 2 // unchanged lines around a change

const state = { a: null, b: null, rows: [], visualLoaded: false }
const frameUrls = []

const normalize = (text) =>
  (text || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

async function init() {
  const [a, b] = await Promise.all([ArchiveDB.getMeta(params.get('a')), ArchiveDB.getMeta(params.get('b'))])
  if (!a || !b) {
    $('missing').hidden = false
    return
  }
  $('content').hidden = false
  await fillPickers(a, b)
  await select(a, b)
}

async function fillPickers(a, b) {
  const optionsFor = async (item) => (await ArchiveDB.versions(item.url)).map((v) => el('option', { value: v.id }, `${formatDate(v.createdAt, true)} · ${v.kind.toUpperCase()} · ${formatBytes(v.size)}`))
  $('pick-a').replaceChildren(...(await optionsFor(a)))
  $('pick-b').replaceChildren(...(await optionsFor(b)))
  $('pick-a').value = a.id
  $('pick-b').value = b.id
}

async function select(a, b) {
  state.a = a
  state.b = b
  state.visualLoaded = false
  history.replaceState(null, '', `?a=${encodeURIComponent(a.id)}&b=${encodeURIComponent(b.id)}`)
  $('url').textContent = a.url === b.url ? a.url : `${a.url}  →  ${b.url}`
  $('title-a').textContent = a.title
  $('title-b').textContent = b.title

  const [textA, textB] = await Promise.all([ArchiveDB.getText(a.id), ArchiveDB.getText(b.id)])
  const linesA = normalize(textA)
  const linesB = normalize(textB)
  state.rows = buildRows(linesA, linesB, BurgDiff.lines(linesA, linesB))

  const count = (type) => state.rows.filter((row) => row.type === type).length
  $('s-del').textContent = count('del')
  $('s-add').textContent = count('add')
  $('s-mod').textContent = count('mod')
  $('s-same').textContent = count('same')

  renderDiff()
  renderSeo()
  if (!$('tab-visual').hidden) renderVisual()
}

for (const id of ['pick-a', 'pick-b']) {
  $(id).addEventListener('change', async () => {
    const [a, b] = await Promise.all([ArchiveDB.getMeta($('pick-a').value), ArchiveDB.getMeta($('pick-b').value)])
    select(a, b)
  })
}

$('swap').addEventListener('click', async () => {
  const { a, b } = state
  await fillPickers(b, a)
  select(b, a)
})

// ---------------------------------------------------------------------------
// Text diff
// ---------------------------------------------------------------------------

/** Merge consecutive removed/added lines pairwise into 'mod'. */
function buildRows(linesA, linesB, ops) {
  const rows = []
  let dels = []
  let adds = []
  const flush = () => {
    const pairs = Math.min(dels.length, adds.length)
    for (let k = 0; k < pairs; k++) rows.push({ type: 'mod', a: linesA[dels[k]], b: linesB[adds[k]] })
    for (let k = pairs; k < dels.length; k++) rows.push({ type: 'del', a: linesA[dels[k]] })
    for (let k = pairs; k < adds.length; k++) rows.push({ type: 'add', b: linesB[adds[k]] })
    dels = []
    adds = []
  }
  for (const op of ops) {
    if (op.type === 'same') {
      flush()
      rows.push({ type: 'same', a: linesA[op.a], b: linesB[op.b] })
    } else if (op.type === 'del') dels.push(op.a)
    else adds.push(op.b)
  }
  flush()
  return rows
}

function marked(parts) {
  return parts.map((part) => (part.changed ? el('mark', {}, part.text) : part.text))
}

function rowElement(row) {
  if (row.type === 'same') return el('div', { class: 'row' }, el('div', { class: 'cell' }, row.a), el('div', { class: 'cell' }, row.b))
  if (row.type === 'del') return el('div', { class: 'row' }, el('div', { class: 'cell del' }, row.a), el('div', { class: 'cell' }))
  if (row.type === 'add') return el('div', { class: 'row' }, el('div', { class: 'cell' }), el('div', { class: 'cell add' }, row.b))
  const words = BurgDiff.words(row.a, row.b)
  return el('div', { class: 'row' }, el('div', { class: 'cell del' }, marked(words.a)), el('div', { class: 'cell add' }, marked(words.b)))
}

function renderDiff() {
  const diff = $('diff')
  const rows = state.rows
  const onlyChanges = $('only-changes').checked

  if (!rows.some((row) => row.type !== 'same')) {
    diff.replaceChildren(el('div', { class: 'none' }, rows.length ? t('textIdentical') : t('noText')))
    return
  }
  if (!onlyChanges) {
    diff.replaceChildren(...rows.map(rowElement))
    return
  }

  // Which unchanged lines do we show as context?
  const visible = new Uint8Array(rows.length)
  rows.forEach((row, i) => {
    if (row.type === 'same') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) visible[k] = 1
  })

  const out = []
  for (let i = 0; i < rows.length; ) {
    if (visible[i]) {
      out.push(rowElement(rows[i]))
      i++
      continue
    }
    const start = i
    while (i < rows.length && !visible[i]) i++
    const hidden = rows.slice(start, i)
    const gap = el('button', { class: 'gap' }, t(hidden.length === 1 ? 'gapOne' : 'gapMany', hidden.length))
    gap.addEventListener('click', () => gap.replaceWith(...hidden.map(rowElement)))
    out.push(gap)
  }
  diff.replaceChildren(...out)
}

$('only-changes').addEventListener('change', renderDiff)

// ---------------------------------------------------------------------------
// Properties (SEO)
// ---------------------------------------------------------------------------

function renderSeo() {
  const a = state.a.seo || {}
  const b = state.b.seo || {}
  const list = (value) => (Array.isArray(value) ? value.join('\n') : value === undefined || value === null ? '' : String(value))
  const rows = [
    [t('savedAt'), formatDate(state.a.createdAt, true), formatDate(state.b.createdAt, true), false],
    [t('file'), `${state.a.kind.toUpperCase()} · ${formatBytes(state.a.size)}`, `${state.b.kind.toUpperCase()} · ${formatBytes(state.b.size)}`, false],
    [t('seoTitle'), a.title, b.title],
    [t('seoDescription'), a.description, b.description],
    ['Canonical', a.canonical, b.canonical],
    ['Robots', a.robots, b.robots],
    ['H1', list(a.h1), list(b.h1)],
    ['H2', list(a.h2), list(b.h2)],
    [t('seoWords'), a.words, b.words],
    ['Links', a.links, b.links],
    [t('seoInternal'), a.internal, b.internal],
    [t('seoImages'), a.images, b.images],
  ]
  $('seo-rows').replaceChildren(
    ...rows.map(([label, left, right, compare = true]) => {
      const l = list(left)
      const r = list(right)
      return el(
        'tr',
        { class: compare && l !== r ? 'changed' : '' },
        el('th', {}, label),
        el('td', { style: 'white-space: pre-wrap' }, l || '—'),
        el('td', { style: 'white-space: pre-wrap' }, r || '—')
      )
    })
  )
}

// ---------------------------------------------------------------------------
// Side by side
// ---------------------------------------------------------------------------

async function frameFor(item, frame) {
  if (item.kind !== 'html') {
    const img = el('img', { alt: t('thumbnail'), id: frame.id })
    if (item.thumb) img.src = URL.createObjectURL(item.thumb)
    return img
  }
  const html = (await (await ArchiveDB.getFile(item.id)).text()).replace(/<head([^>]*)>/i, '<head$1><base target="_blank">')
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  frameUrls.push(url)
  const iframe = el('iframe', { id: frame.id, title: frame.title })
  iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
  iframe.src = url
  return iframe
}

async function renderVisual() {
  if (state.visualLoaded) return
  state.visualLoaded = true
  while (frameUrls.length) URL.revokeObjectURL(frameUrls.pop())
  const frameA = $('frame-a')
  const frameB = $('frame-b')
  frameA.replaceWith(await frameFor(state.a, frameA))
  frameB.replaceWith(await frameFor(state.b, frameB))
}

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-tab]')) other.classList.toggle('on', other === tab)
    for (const name of ['text', 'seo', 'visual']) $(`tab-${name}`).hidden = name !== tab.dataset.tab
    $('only-changes').closest('label').hidden = tab.dataset.tab !== 'text'
    if (tab.dataset.tab === 'visual') renderVisual()
  })
}

init()
