'use strict'

// Text differences without a library.
// Strip the common start and end, diff small chunks with classic LCS, and
// first split large chunks on lines that occur exactly once on both sides
// (patience diff). Fast enough for pages with thousands of lines.

const BurgDiff = (() => {
  const DP_LIMIT = 4e6 // cells in the LCS table (16 MB)

  function core(a, aLo, aHi, b, bLo, bHi, out) {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push(['=', aLo++, bLo++])
    const tail = []
    while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) tail.push(['=', --aHi, --bHi])

    const n = aHi - aLo
    const m = bHi - bLo
    if (n === 0) for (let j = bLo; j < bHi; j++) out.push(['+', -1, j])
    else if (m === 0) for (let i = aLo; i < aHi; i++) out.push(['-', i, -1])
    else if (n * m <= DP_LIMIT) lcs(a, aLo, aHi, b, bLo, bHi, out)
    else {
      const anchors = patience(a, aLo, aHi, b, bLo, bHi)
      if (!anchors.length) {
        for (let i = aLo; i < aHi; i++) out.push(['-', i, -1])
        for (let j = bLo; j < bHi; j++) out.push(['+', -1, j])
      } else {
        let i0 = aLo
        let j0 = bLo
        for (const [i, j] of anchors) {
          core(a, i0, i, b, j0, j, out)
          out.push(['=', i, j])
          i0 = i + 1
          j0 = j + 1
        }
        core(a, i0, aHi, b, j0, bHi, out)
      }
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k])
  }

  function lcs(a, aLo, aHi, b, bLo, bHi, out) {
    const n = aHi - aLo
    const m = bHi - bLo
    const w = m + 1
    const table = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] =
          a[aLo + i] === b[bLo + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[aLo + i] === b[bLo + j]) out.push(['=', aLo + i++, bLo + j++])
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) out.push(['-', aLo + i++, -1])
      else out.push(['+', -1, bLo + j++])
    }
    while (i < n) out.push(['-', aLo + i++, -1])
    while (j < m) out.push(['+', -1, bLo + j++])
  }

  /** Longest increasing sequence of lines that are unique on both sides. */
  function patience(a, aLo, aHi, b, bLo, bHi) {
    const counts = new Map()
    for (let i = aLo; i < aHi; i++) {
      const c = counts.get(a[i]) || { a: 0, b: 0, i: -1, j: -1 }
      c.a++
      c.i = i
      counts.set(a[i], c)
    }
    for (let j = bLo; j < bHi; j++) {
      const c = counts.get(b[j])
      if (c) {
        c.b++
        c.j = j
      }
    }
    const pairs = []
    for (const c of counts.values()) if (c.a === 1 && c.b === 1) pairs.push([c.i, c.j])
    pairs.sort((x, y) => x[0] - y[0])

    // Patience sorting on j, with back pointers
    const tops = []
    const prev = new Array(pairs.length)
    for (let k = 0; k < pairs.length; k++) {
      let lo = 0
      let hi = tops.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (pairs[tops[mid]][1] < pairs[k][1]) lo = mid + 1
        else hi = mid
      }
      prev[k] = lo > 0 ? tops[lo - 1] : -1
      tops[lo] = k
    }
    const result = []
    for (let k = tops.length ? tops[tops.length - 1] : -1; k >= 0; k = prev[k]) result.push(pairs[k])
    return result.reverse()
  }

  function diff(a, b) {
    const out = []
    core(a, 0, a.length, b, 0, b.length, out)
    return out
  }

  /**
   * Line diff.
   * @returns [{ type: 'same'|'del'|'add', a, b }] (a/b = line number or -1)
   */
  function lines(a, b) {
    return diff(a, b).map(([op, i, j]) => ({ type: op === '=' ? 'same' : op === '-' ? 'del' : 'add', a: i, b: j }))
  }

  /** Word diff within one changed line. @returns { a: [{text, changed}], b: [...] } */
  function words(left, right) {
    const tokenize = (text) => text.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || []
    const ta = tokenize(left).slice(0, 2000)
    const tb = tokenize(right).slice(0, 2000)
    const sideA = []
    const sideB = []
    const push = (side, text, changed) => {
      const last = side[side.length - 1]
      if (last && last.changed === changed) last.text += text
      else side.push({ text, changed })
    }
    for (const [op, i, j] of diff(ta, tb)) {
      if (op === '=') {
        push(sideA, ta[i], false)
        push(sideB, tb[j], false)
      } else if (op === '-') push(sideA, ta[i], true)
      else push(sideB, tb[j], true)
    }
    return { a: sideA, b: sideB }
  }

  return { lines, words }
})()
