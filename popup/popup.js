'use strict'

localizePage()

const DEFAULTS = { format: 'html', lazy: true, stamp: false }
const $ = (id) => document.getElementById(id)
const { el, wayback, formatDate, formatBytes, parseTags } = BurgUtil

let tab = null
let versions = []

function openTab(url) {
  chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined })
}

function setStatus(text, percent, error = false) {
  $('status').hidden = false
  $('status').classList.toggle('error', error)
  $('status-text').textContent = text
  $('bar-fill').style.width = `${percent ?? 0}%`
}

function updateSaveLabel() {
  const format = document.querySelector('input[name="format"]:checked').value
  $('save-sub').textContent = `${format === 'mhtml' ? 'MHTML' : t('fmtHtml')} · Alt+Shift+A`
  $('stamp').disabled = format === 'mhtml'
  $('stamp').closest('label').classList.toggle('muted', format === 'mhtml')
}

async function init() {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const supported = tab && /^https?:/.test(tab.url || '') && !/^https:\/\/chromewebstore\.google\.com/.test(tab.url)

  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }
  document.querySelector(`input[name="format"][value="${settings.format}"]`).checked = true
  $('lazy').checked = settings.lazy
  $('stamp').checked = settings.stamp
  updateSaveLabel()

  if (!supported) {
    $('unsupported').hidden = false
    $('host').textContent = t('notAvailable')
    for (const part of document.querySelectorAll('.actions, .fields, .block')) part.hidden = true
    return
  }
  $('host').textContent = new URL(tab.url).hostname.replace(/^www\./, '')

  versions = await ArchiveDB.versions(tab.url)
  if (versions.length) {
    $('history').hidden = false
    $('history-text').textContent = t('historyText', versions.length, formatDate(versions[0].createdAt))
  }
}

for (const radio of document.querySelectorAll('input[name="format"]')) {
  radio.addEventListener('change', () => {
    chrome.storage.local.set({ format: radio.value })
    updateSaveLabel()
  })
}
$('lazy').addEventListener('change', () => chrome.storage.local.set({ lazy: $('lazy').checked }))
$('stamp').addEventListener('change', () => chrome.storage.local.set({ stamp: $('stamp').checked }))

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'progress' && tab && message.tabId === tab.id) setStatus(message.text, message.percent)
})

async function save(compare) {
  const previous = versions[0]
  for (const button of document.querySelectorAll('.action, #save-compare')) button.disabled = true
  $('result').hidden = true
  setStatus(t('starting'), 0)

  const response = await chrome.runtime.sendMessage({
    type: 'save',
    tabId: tab.id,
    options: { tags: parseTags($('tags').value), note: $('note').value.trim() },
  })

  for (const button of document.querySelectorAll('.action, #save-compare')) button.disabled = false
  if (!response || !response.ok) {
    setStatus(response ? response.error : t('unknownError'), 100, true)
    return
  }

  $('status').hidden = true
  $('tags').value = ''
  $('note').value = ''
  if (compare && previous) {
    openTab(chrome.runtime.getURL(`compare/compare.html?a=${previous.id}&b=${response.id}`))
    return window.close()
  }

  $('result').hidden = false
  $('result').replaceChildren(
    el('span', {}, el('strong', {}, t('savedLabel')), ` · ${response.kind.toUpperCase()} · ${formatBytes(response.size)}`),
    el('button', { class: 'small primary', onclick: () => openTab(chrome.runtime.getURL(`view/view.html?id=${response.id}`)) }, t('view'))
  )
  versions = await ArchiveDB.versions(tab.url)
  $('history').hidden = false
  $('history-text').textContent = t('historyText', versions.length, formatDate(versions[0].createdAt))
}

$('save').addEventListener('click', () => save(false))
$('save-compare').addEventListener('click', () => save(true))
$('open-latest').addEventListener('click', () => openTab(chrome.runtime.getURL(`view/view.html?id=${versions[0].id}`)))

for (const button of document.querySelectorAll('[data-wb]')) {
  button.addEventListener('click', () => {
    const kind = button.dataset.wb
    if (kind === 'around') {
      if (!$('wb-date').value) return $('wb-date').focus()
      return openTab(wayback.around(tab.url, $('wb-date').value))
    }
    openTab(wayback[kind](tab.url))
  })
}

$('site').addEventListener('click', (event) => {
  event.preventDefault()
  const query = tab && /^https?:/.test(tab.url || '') ? `?url=${encodeURIComponent(tab.url)}` : ''
  openTab(chrome.runtime.getURL(`site/site.html${query}`))
})

// chrome:// links don't open from a regular <a>
$('shortcuts').addEventListener('click', (event) => {
  event.preventDefault()
  openTab('chrome://extensions/shortcuts')
})

init()
