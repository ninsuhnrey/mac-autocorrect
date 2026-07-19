# Changelog

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
