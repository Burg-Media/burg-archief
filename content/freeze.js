'use strict'

// Burg Archive: freezes the page as it is rendered right now.
//
// Runs in every frame (allFrames) and returns the serialized DOM:
// scripts removed, form values, canvas and shadow DOM included, all URLs
// absolute. Resources (images, CSS, fonts) are fetched by the background;
// here only tokens stand in their place (__BURG_<nonce>_R12__ etc.).
//
// Tokens:  R<n>  URL of resource n (in an attribute)
//          S<n>  contents of stylesheet n (in a <style>)
//          A<n>  style attribute n (CSS with url())
//          F<p>  srcdoc of the child frame with path p (e.g. 0.2)

window.__burgFreeze = function freeze(options) {
  if (options.infoOnly) return { path: '', url: location.href, ...pageInfo() }

  const nonce = options.nonce
  const token = (kind, id) => `__BURG_${nonce}_${kind}${id}__`
  const resources = [] // absolute URLs
  const resourceIndex = new Map()
  const styles = [] // { css, base, media } or { href, media }
  const attrStyles = [] // { css, base }

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  const DROP = new Set(['script', 'noscript', 'base'])
  const SKIP_LINK = /^(preload|prefetch|modulepreload|dns-prefetch|preconnect|prerender|manifest|serviceworker|import)$/i
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url']
  const BLANKISH = /^(|about:blank|data:image\/(gif|svg\+xml)[^,]*,.{0,400})$/i

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  function absolute(value, base = document.baseURI) {
    if (!value) return ''
    try {
      return new URL(value.trim(), base).href
    } catch (e) {
      return value
    }
  }

  function resource(url) {
    if (!url) return ''
    if (/^data:/i.test(url)) return url
    if (!/^https?:/i.test(url)) return /^(blob|javascript|about):/i.test(url) ? '' : url
    let index = resourceIndex.get(url)
    if (index === undefined) {
      index = resources.length
      resources.push(url)
      resourceIndex.set(url, index)
    }
    return token('R', index)
  }

  const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;')
  const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;')

  function rulesText(sheet) {
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join('\n')
    } catch (e) {
      return null // cross-origin without CORS: the background fetches the file
    }
  }

  /** Largest candidate from a srcset. */
  function bestFromSrcset(srcset) {
    let best = null
    let bestSize = -1
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [url, descriptor = '1x'] = part.trim().split(/\s+/)
      const size = parseFloat(descriptor) * (descriptor.endsWith('w') ? 1 : 1000)
      if (url && size > bestSize) {
        best = url
        bestSize = size
      }
    }
    return best
  }

  /** Index of a window in its parent's frames (also works cross-origin). */
  function frameIndex(win) {
    const parent = win.parent
    for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] === win) return i
    return -1
  }

  function framePath() {
    const path = []
    let win = window
    try {
      while (win !== win.top) {
        path.unshift(frameIndex(win))
        win = win.parent
      }
    } catch (e) {
      return null
    }
    return path.join('.')
  }
  const myPath = framePath()

  // ------------------------------------------------------------------------
  // Serializing
  // ------------------------------------------------------------------------

  function styleBlock(css, media, base) {
    const id = styles.length
    styles.push({ css, base, media: media || '' })
    return `<style>${token('S', id)}</style>`
  }

  function sheetToStyle(sheet, ownerText, base) {
    const css = (sheet && rulesText(sheet)) ?? ownerText ?? ''
    return styleBlock(css, '', base)
  }

  function adoptedStyles(root) {
    let out = ''
    for (const sheet of root.adoptedStyleSheets || []) out += sheetToStyle(sheet, null, document.baseURI)
    return out
  }

  function attributes(el, overrides) {
    const tag = el.localName
    let out = ''
    const seen = new Set()
    // overrides: null = leave the attribute out
    const add = (name, value) => {
      if (value === null || value === undefined) return
      seen.add(name)
      out += value === '' ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`
    }

    for (const [name, value] of Object.entries(overrides)) add(name, value)

    for (const attr of el.attributes) {
      const name = attr.name
      const lower = name.toLowerCase()
      if (seen.has(name) || name in overrides) continue
      let value = attr.value
      if (lower.startsWith('on')) continue
      if (lower === 'nonce' || lower === 'integrity' || lower === 'crossorigin') continue
      if (/^(href|src|action|formaction|xlink:href|poster|cite|data|background)$/.test(lower) && /^\s*javascript:/i.test(value)) {
        value = '#'
      }
      if (lower === 'style') {
        if (/url\(/i.test(value)) {
          const id = attrStyles.length
          attrStyles.push({ css: value, base: document.baseURI })
          value = token('A', id)
        }
      } else if (lower === 'href' || lower === 'xlink:href') {
        if (tag === 'image') value = resource(absolute(value))
        else if (!value.startsWith('#')) value = absolute(value)
      } else if (lower === 'src') {
        value = absolute(value)
      } else if (lower === 'action' || lower === 'formaction' || lower === 'cite' || lower === 'data') {
        value = absolute(value)
      } else if (lower === 'poster' || lower === 'background') {
        value = resource(absolute(value))
      } else if (lower === 'loading' && tag === 'img') {
        continue
      }
      add(name, value)
    }
    return out
  }

  function serializeChildren(node, ctx) {
    let out = ''
    for (let child = node.firstChild; child; child = child.nextSibling) out += serialize(child, ctx)
    return out
  }

  function shadowRootOf(el) {
    try {
      if (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el)
    } catch (e) {
      // not an element with a shadow root
    }
    return el.shadowRoot
  }

  function serialize(node, ctx) {
    switch (node.nodeType) {
      case Node.TEXT_NODE: {
        const parent = node.parentNode
        if (parent && parent.namespaceURI === 'http://www.w3.org/1999/xhtml' && /^(style|script)$/.test(parent.localName)) return ''
        return escapeText(node.data)
      }
      case Node.COMMENT_NODE:
        return ''
      case Node.ELEMENT_NODE:
        return serializeElement(node, ctx)
      case Node.DOCUMENT_FRAGMENT_NODE:
        return serializeChildren(node, ctx)
      default:
        return ''
    }
  }

  function serializeElement(el, ctx) {
    const tag = el.localName
    const isHtml = el.namespaceURI === 'http://www.w3.org/1999/xhtml'
    if (isHtml && DROP.has(tag)) return ''
    if (el.id === 'burg-archief-stamp') return ''

    const overrides = {}
    let inner = null

    if (isHtml) {
      switch (tag) {
        case 'meta': {
          const equiv = (el.httpEquiv || '').toLowerCase()
          if (equiv === 'refresh' || equiv === 'content-security-policy' || el.getAttribute('charset') || equiv === 'content-type') return ''
          break
        }
        case 'link': {
          const rel = (el.rel || '').toLowerCase()
          if (rel.split(/\s+/).some((r) => SKIP_LINK.test(r))) return ''
          if (rel.includes('stylesheet')) {
            if (el.disabled || rel.includes('alternate')) return ''
            const media = el.media && el.media !== 'all' ? el.media : ''
            const text = el.sheet ? rulesText(el.sheet) : null
            const id = styles.length
            if (text !== null) styles.push({ css: text, base: el.href, media })
            else styles.push({ href: el.href, media })
            return `<style>${token('S', id)}</style>`
          }
          if (/\bicon\b/.test(rel) || rel === 'apple-touch-icon') overrides.href = resource(absolute(el.getAttribute('href')))
          break
        }
        case 'style': {
          if (el.sheet && el.sheet.disabled) return ''
          const media = el.media && el.media !== 'all' ? el.media : ''
          const text = el.sheet ? rulesText(el.sheet) : null
          return styleBlock(text ?? el.textContent, media, document.baseURI)
        }
        case 'img': {
          let src = el.currentSrc || el.getAttribute('src') || ''
          if (BLANKISH.test(src) || !el.complete || el.naturalWidth === 0) {
            for (const name of LAZY_ATTRS) if (el.getAttribute(name)) src = el.getAttribute(name)
            const lazySet = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset')
            if (lazySet) src = bestFromSrcset(lazySet) || src
            if (!src && el.getAttribute('srcset')) src = bestFromSrcset(el.getAttribute('srcset'))
          }
          overrides.src = resource(absolute(src))
          for (const name of ['srcset', 'sizes', 'data-srcset', 'data-lazy-srcset', ...LAZY_ATTRS]) overrides[name] = null
          break
        }
        case 'source': {
          // Inside <picture> the <img> already picks the right source (currentSrc)
          if (el.parentNode && el.parentNode.localName === 'picture') return ''
          overrides.src = absolute(el.getAttribute('src'))
          break
        }
        case 'input': {
          const type = (el.type || '').toLowerCase()
          if (type === 'password' || type === 'hidden' || type === 'file') {
            overrides.value = type === 'hidden' ? el.value : null
          } else if (type === 'checkbox' || type === 'radio') {
            overrides.checked = el.checked ? '' : null
          } else {
            overrides.value = el.value
          }
          if (type === 'image') overrides.src = resource(absolute(el.getAttribute('src')))
          break
        }
        case 'textarea':
          inner = escapeText(el.value)
          break
        case 'option':
          overrides.selected = el.selected ? '' : null
          break
        case 'canvas': {
          try {
            const data = el.toDataURL('image/png')
            if (data.length > 30) {
              const rect = el.getBoundingClientRect()
              const style = el.getAttribute('style') || ''
              return `<img src="${data}"${el.id ? ` id="${escapeAttr(el.id)}"` : ''}${
                el.className && typeof el.className === 'string' ? ` class="${escapeAttr(el.className)}"` : ''
              } width="${el.width}" height="${el.height}" style="${escapeAttr(
                `${style};width:${rect.width}px;height:${rect.height}px`
              )}">`
            }
          } catch (e) {
            // tainted canvas (cross-origin): leave it empty
          }
          break
        }
        case 'iframe':
        case 'frame': {
          let index = -1
          try {
            for (let i = 0; i < window.frames.length; i++) if (window.frames[i] === el.contentWindow) index = i
          } catch (e) {
            index = -1
          }
          overrides.src = absolute(el.getAttribute('src'))
          overrides.loading = null
          if (index >= 0 && myPath !== null) {
            const path = myPath === '' ? String(index) : `${myPath}.${index}`
            overrides.srcdoc = token('F', path)
          } else {
            overrides.srcdoc = null
          }
          break
        }
        case 'video':
        case 'audio':
          overrides.autoplay = null
          overrides.src = absolute(el.currentSrc || el.getAttribute('src'))
          break
        case 'object':
        case 'embed':
        case 'applet':
          return ''
        case 'details':
          overrides.open = el.open ? '' : null
          break
        case 'template':
          inner = serializeChildren(el.content, ctx)
          break
      }
    }

    let open = `<${tag}${attributes(el, overrides)}`
    if (isHtml && VOID.has(tag)) return `${open}>`
    open += '>'

    if (inner === null) {
      inner = ''
      const shadow = isHtml ? shadowRootOf(el) : null
      if (shadow) {
        inner += `<template shadowrootmode="open">${adoptedStyles(shadow)}${serializeChildren(shadow, ctx)}</template>`
      }
      inner += serializeChildren(el, ctx)
    }
    return `${open}${inner}</${tag}>`
  }

  // ------------------------------------------------------------------------
  // Document
  // ------------------------------------------------------------------------

  const doc = document.documentElement
  let head = ''
  let body = ''
  const headEl = document.head
  const bodyEl = document.body

  if (headEl) head = serializeChildren(headEl, {}) + adoptedStyles(document)
  if (bodyEl) body = serializeChildren(bodyEl, {})

  // Add elements outside <head>/<body> (rare) to the body
  for (let child = doc.firstChild; child; child = child.nextSibling) {
    if (child !== headEl && child !== bodyEl) body += serialize(child, {})
  }

  const meta = []
  meta.push('<meta charset="utf-8">')
  if (myPath === '') {
    const savedAt = new Date(options.savedAt)
    meta.push(`<!-- ${t('savedWith')} | ${location.href.replace(/--/g, '%2D%2D').replace(/>/g, '%3E')} | ${savedAt.toISOString()} -->`)
    meta.push(`<meta name="burg-archief:url" content="${escapeAttr(location.href)}">`)
    meta.push(`<meta name="burg-archief:saved" content="${savedAt.toISOString()}">`)
  }
  meta.push(`<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`)

  let stamp = ''
  if (myPath === '' && options.stamp) {
    const when = new Date(options.savedAt).toLocaleString(t('locale'), { dateStyle: 'long', timeStyle: 'medium' })
    stamp =
      `<div id="burg-archief-stamp" style="all:initial;display:block;box-sizing:border-box;width:100%;padding:8px 14px;` +
      `background:#0E0E10;color:#F4F3F0;font:12px/1.4 ui-monospace,Menlo,monospace;border-bottom:3px solid #F3EFE6;` +
      `position:relative;z-index:2147483647;word-break:break-all">${escapeText(t('stampText', when))} · ` +
      `${escapeText(location.href)}</div>`
  }

  const doctype = document.doctype
    ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${
        document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''
      }>`
    : ''

  const htmlAttrs = attributes(doc, {})
  const bodyAttrs = bodyEl ? attributes(bodyEl, {}) : ''
  const headAttrs = headEl ? attributes(headEl, {}) : ''
  const bodyTag = bodyEl ? bodyEl.localName : 'body'

  const html =
    `${doctype}<html${htmlAttrs}><head${headAttrs}>${meta.join('')}${head}</head>` +
    `<${bodyTag}${bodyAttrs}>${stamp}${body}</${bodyTag}></html>`

  const result = { path: myPath, url: location.href, html, resources, styles, attrStyles }
  return myPath === '' ? Object.assign(result, pageInfo()) : result
}

/** Title, visible text and SEO properties of the main frame. */
function pageInfo() {
  const text = (document.body ? document.body.innerText : '').slice(0, 600000)
  const metaContent = (selector) => {
    const el = document.querySelector(selector)
    return el ? (el.getAttribute('content') || el.getAttribute('href') || '').trim() : ''
  }
  const headings = (level) =>
    [...document.querySelectorAll(level)].map((h) => h.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 30)
  const links = [...document.querySelectorAll('a[href]')]
  return {
    title: document.title,
    text,
    lang: document.documentElement.lang || '',
    seo: {
      title: document.title,
      description: metaContent('meta[name="description" i]'),
      canonical: metaContent('link[rel="canonical" i]'),
      robots: metaContent('meta[name="robots" i]'),
      h1: headings('h1'),
      h2: headings('h2'),
      words: (text.match(/[\p{L}\p{N}]+/gu) || []).length,
      links: links.length,
      internal: links.filter((a) => a.host === location.host).length,
      images: document.images.length,
    },
  }
}

true
