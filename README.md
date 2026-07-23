# macOS Autocorrect

Autocorrect as you type — something Electron apps famously can't do — powered by the
**real macOS autocorrect engine** (`NSSpellChecker`, the same API native Mac apps use).

## How it works

When you finish a word (space, punctuation, or Enter), the plugin asks macOS what it
would have autocorrected that word to, via a tiny background `osascript` helper.
macOS answers only when it's confident — the same logic as TextEdit/Notes — and the
plugin swaps the word in, with a brief highlight so you notice. It respects words
you've taught your Mac via "Learn Spelling".

- One `Cmd+Z` undoes a correction like any edit.
- The command **"Revert last correction"** (assign it a hotkey!) puts your original
  word back and stops correcting it for the rest of the session.
- A permanent ignore list lives in the plugin settings.
- It skips code blocks, inline code, math, links, tags, URLs, frontmatter,
  ALLCAPS/camelCase words, and anything typed during IME composition.
- Works in every pane and pop-out window.

## Install

Install from Community plugins in Obsidian, or manually: unzip into
`YourVault/.obsidian/plugins/mac-autocorrect/` (folder must contain
`main.js`, `manifest.json`, `styles.css`), then enable it in
Settings → Community plugins (hit the refresh icon first).

## Full macOS typing behavior

Mirroring the macOS keyboard settings panel, each with its own toggle:

- **Correct spelling automatically** — native autocorrect as described above.
- **Capitalize words automatically** — capitalizes the first word of sentences,
  new paragraphs, list items, headings, and blockquotes. It will NOT capitalize:
  soft-wrapped continuation lines (a new line whose previous line doesn't end a
  sentence), words after abbreviations ("etc.", "e.g.", "Mr.", initials like
  "J."), after ellipses ("..."), or words with internal capitals ("iPhone").
- **Add period with double-space** — two spaces after a word become ". ",
  and the next word then gets capitalized naturally.
- **Smart quotes** — corrected contractions use a curly apostrophe (don’t),
  matching native macOS autocorrect. On by default; toggle in settings.

## A note on macOS Text Replacements

Unlike autocorrect, your macOS **Text Replacements** (System Settings → Keyboard)
already work natively inside Obsidian — Obsidian applies them for you. So this
plugin leaves them alone by default, and its "Use macOS Text Replacements"
setting is **off**. (Earlier versions had it on, which double-expanded shortcuts
like "dont" → "don'tt"; 1.3.0 turns it off, once, for everyone.)

The setting is still there for one specific case: the native handling applies
replacements *everywhere*, including inside code and math. If that bothers you,
disable Obsidian's own handling (Settings → Editor) and turn this on instead —
the plugin's version is context-aware and skips code blocks, inline code, math,
and links. Owning replacements in exactly one layer is the rule; using both
double-expands them.

When enabled, the plugin reads your replacement list from
`~/Library/KeyboardServices/TextReplacements.db` (the store behind that Settings
panel), reloads it automatically when it changes, and supports shortcuts with
digits or symbols. Shortcuts containing spaces are not supported.

## Security & privacy disclosures

Per Obsidian's developer policies, this plugin accesses things outside your vault —
here is exactly what and why:

- **Helper process**: on macOS it spawns one small `/usr/bin/osascript` process
  (Apple's own scripting runtime, script embedded in this plugin's source — nothing
  downloaded) to query `NSSpellChecker`, the system autocorrect engine. It runs
  only while the plugin is enabled and is terminated on unload.
- **File access outside the vault**: *only if you turn on "Use macOS Text
  Replacements"* (off by default), it reads (never writes)
  `~/Library/KeyboardServices/TextReplacements.db` — the database behind
  System Settings → Keyboard → Text Replacements — using the system `sqlite3`
  tool. Left off, the plugin never touches it.
- **No network use.** Nothing leaves your machine; no telemetry of any kind.
  Words you type are sent only to your Mac's own local spellchecker.

## Maintenance

Provided as-is and maintained on a best-effort basis. It's MIT-licensed —
forks, fixes, and adoptions are welcome and encouraged.

## Notes & limitations

- macOS only for the native engine. On other platforms (or if the helper fails),
  it falls back to the Electron spellchecker's first suggestion — set the engine
  to "Electron spellchecker" explicitly if you prefer that behavior.
- Inline predictive text is not possible — Apple's on-device language model has
  no public API.
- Vim mode: corrections apply to text typed in insert mode; if you find any
  interaction odd, toggles let you disable individual features. Feedback welcome.
- The abbreviation list for auto-capitalization is English-centric; add your
  own in settings ("Additional abbreviations").
- If the Text Replacements database can't be read (very old macOS, or none
  defined yet), the feature quietly does nothing — everything else still works.
- System-wide double-space timing, sentence detection, and capitalization are
  reimplemented to match macOS behavior as closely as markdown allows; version
  history lives in CHANGELOG.md.
