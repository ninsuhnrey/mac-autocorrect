# macOS Autocorrect

Autocorrect as you type — the thing Electron apps famously can't do — powered by the
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

Unzip into `YourVault/.obsidian/plugins/mac-autocorrect/` (folder must contain
`main.js`, `manifest.json`, `styles.css`), then enable it in
Settings → Community plugins (hit the refresh icon first).

## v1.1 — full macOS typing behavior

Mirroring the macOS keyboard settings panel, each with its own toggle:

- **Correct spelling automatically** — native autocorrect as described above.
- **Capitalize words automatically** — capitalizes the first word of sentences,
  new paragraphs, list items, headings, and blockquotes. It will NOT capitalize:
  soft-wrapped continuation lines (a new line whose previous line doesn't end a
  sentence), words after abbreviations ("etc.", "e.g.", "Mr.", initials like
  "J."), after ellipses ("..."), or words with internal capitals ("iPhone").
- **Add period with double-space** — two spaces after a word become ". ",
  and the next word then gets capitalized naturally.

## v1.2 — macOS Text Replacements

The plugin reads your actual replacement list from macOS
(`~/Library/KeyboardServices/TextReplacements.db`, the iCloud-synced store
behind System Settings → Keyboard → Text Replacements) and expands shortcuts
when you type a space, punctuation, or Enter after them.

- Shortcuts with digits or symbols work ("addr1", ";sig").
- Typing a shortcut with a leading capital expands with a leading capital.
- Expansions get capitalized at sentence starts (if that toggle is on).
- The list auto-reloads when you edit it in System Settings (checked at most
  every 30s), or immediately via the "Reload macOS Text Replacements" command.
- Shortcuts containing spaces are not supported.

## Security & privacy disclosures

Per Obsidian's developer policies, this plugin accesses things outside your vault —
here is exactly what and why:

- **Helper process**: on macOS it spawns one small `/usr/bin/osascript` process
  (Apple's own scripting runtime, script embedded in this plugin's source — nothing
  downloaded) to query `NSSpellChecker`, the system autocorrect engine. It runs
  only while the plugin is enabled and is terminated on unload.
- **File access outside the vault**: it reads (never writes)
  `~/Library/KeyboardServices/TextReplacements.db` — the database behind
  System Settings → Keyboard → Text Replacements — using the system `sqlite3`
  tool, so your replacements work in Obsidian. Disable "Use macOS Text
  Replacements" in settings to prevent this read entirely.
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
