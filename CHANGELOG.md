# Changelog

## 1.3.0

- **"Use macOS Text Replacements" now defaults off**, and is turned off once for
  existing installs. macOS already applies your Text Replacements natively inside
  Obsidian, so the plugin doing it too double-expanded them (e.g. "dont" →
  "don'tt"). If you deliberately want the plugin to own replacements — its version
  skips code, math, and links — disable Obsidian's native handling (Settings →
  Editor) and turn this back on; it won't be flipped off again.
- **Smart quotes**: corrected contractions now use a curly apostrophe (don’t),
  matching native macOS autocorrect. Toggle in settings.

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
