'use strict'

// Burg Archive: service worker
// Saves the current page (popup, keyboard shortcut or context menu) and shows
// the progress on the toolbar icon. The actual work is in lib/capture.js.

importScripts('lib/i18n.js', 'lib/db.js', 'lib/capture.js')

const DEFAULTS = { format: 'html', lazy: true, stamp: false }
const BADGE_BG = '#F3EFE6'
const running = new Set()

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }
}

function badge(tabId, text, title) {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG, tabId }).catch(() => {})
  chrome.action.setBadgeTextColor({ color: '#0E0E10', tabId }).catch(() => {})
  chrome.action.setBadgeText({ text, tabId }).catch(() => {})
  if (title) chrome.action.setTitle({ title, tabId }).catch(() => {})
}

function clearBadgeLater(tabId) {
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {})
    chrome.action.setTitle({ title: t('extName'), tabId }).catch(() => {})
  }, 5000)
}

async function savePage(tab, overrides = {}) {
  if (running.has(tab.id)) return { ok: false, error: t('errAlreadySaving') }
  running.add(tab.id)
  const report = (text, percent) => {
    badge(tab.id, percent !== undefined ? `${percent}%` : '…')
    chrome.runtime.sendMessage({ type: 'progress', tabId: tab.id, text, percent }).catch(() => {})
  }
  try {
    const options = { ...(await getSettings()), ...overrides }
    const meta = await BurgCapture.archiveTab(tab, options, report)
    badge(tab.id, '✓', t('badgeSaved', meta.title))
    clearBadgeLater(tab.id)
    const result = { ok: true, id: meta.id, title: meta.title, size: meta.size, kind: meta.kind }
    chrome.runtime.sendMessage({ type: 'saved', tabId: tab.id, ...result }).catch(() => {})
    return result
  } catch (error) {
    console.error('[Burg Archive]', error)
    badge(tab.id, '!', t('badgeError', error.message))
    clearBadgeLater(tab.id)
    return { ok: false, error: error.message }
  } finally {
    running.delete(tab.id)
  }
}

// ---------------------------------------------------------------------------
// Messages, keyboard shortcut and menus
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'save') return
  chrome.tabs
    .get(message.tabId)
    .then((tab) => savePage(tab, message.options || {}))
    .then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }))
  return true
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'save-page') return
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab) savePage(tab)
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-page',
      title: t('menuSavePage'),
      contexts: ['page', 'frame', 'selection', 'image', 'link'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    })
    chrome.contextMenus.create({ id: 'open-library', title: t('menuOpenLibrary'), contexts: ['action'] })
    chrome.contextMenus.create({ id: 'open-site', title: t('menuSaveSite'), contexts: ['action'] })
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-page' && tab) savePage(tab)
  if (info.menuItemId === 'open-library') chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') })
  if (info.menuItemId === 'open-site') {
    const url = tab && /^https?:/.test(tab.url || '') ? `?url=${encodeURIComponent(tab.url)}` : ''
    chrome.tabs.create({ url: chrome.runtime.getURL(`site/site.html${url}`) })
  }
})

// Burg Media: welcome page after installing, short page after removing.
// Only UTM tags in the URL, nothing else is sent.
const SITE = 'https://burgmedia.eu/extensies/burg-archief/'
const utm = (campaign) => '?utm_source=burg-archief&utm_medium=extension&utm_campaign=' + campaign
chrome.runtime.setUninstallURL(SITE + 'verwijderd/' + utm('uninstall'))
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: SITE + 'welkom/' + utm('install') })
})
