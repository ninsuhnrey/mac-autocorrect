# Changelog

## 1.2.2

- Fix: typing a contraction or possessive apostrophe ("didn't", "James'") no
  longer corrects the pre-apostrophe stub and duplicate the suffix (e.g.
  "didn't" becoming "didn't't"). The apostrophe is no longer treated as a
  word-ending boundary. (#1)
- Fix: added a guard so a correction never applies if you've kept typing the
  word while the spellchecker was still thinking (race condition).

## 1.2.1

- Documentation refresh (no functional changes).

## 1.2.0

- Apply macOS Text Replacements (System Settings → Keyboard) on word boundaries:
  digits/symbol shortcuts, capitalized-shortcut handling, multi-line phrases,
  auto-reload when the list changes.
- User-extensible abbreviation list for the capitalizer.

## 1.1.0

- Capitalize words automatically (sentence starts, paragraphs, list items,
  headings, blockquotes; abbreviation- and markdown-aware).
- Add period with double-space.
- Settings mirror the macOS keyboard panel.

## 1.0.0

- Autocorrect as you type via the native macOS spellchecker
  (`NSSpellChecker.correctionForWordRange`), with Electron-spellchecker fallback.
- Correction flash, revert command, session + permanent ignore lists.
- Skips code, math, links, tags, URLs, frontmatter, ALLCAPS/camelCase, IME input.
