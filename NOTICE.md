# Notice

Burg Archive is Copyright (c) 2026 Burg Media and released under the MIT License (see [LICENSE](LICENSE)).

All JavaScript, HTML and CSS in this repository was written by Burg Media. There are no third-party libraries, no bundler and no minified code. The MIT License does not apply to the third-party components below; they keep their own licenses.

## Fonts: `fonts/`

- **Geist** (`geist-latin.woff2`) and **Geist Mono** (`geist-mono-latin.woff2`), Copyright 2024 The Geist Project Authors, https://github.com/vercel/geist-font
- License: SIL Open Font License 1.1, full text in [`fonts/LICENSE-Geist-OFL.txt`](fonts/LICENSE-Geist-OFL.txt).

## Algorithms and formats

These are implemented in Burg Media's own code; no third-party code is included.

- **Text comparison** in `lib/diff.js` uses the classic longest common subsequence (LCS) method and, for large inputs, the patience diff idea of anchoring on lines that occur once on both sides.
- **ZIP files** in `lib/zip.js` follow the PKWARE ZIP file format (stored entries, UTF-8 file names) with the standard CRC-32 checksum.
- **MHTML** files are created by Chrome itself through the `chrome.pageCapture` API.

## Wayback Machine

The Wayback Machine buttons only build links to `web.archive.org`, a service of the Internet Archive (https://archive.org). Burg Archive is not affiliated with the Internet Archive.
