'use strict';

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { EditorView, Decoration } = require('@codemirror/view');
const { StateField, StateEffect } = require('@codemirror/state');
const { syntaxTree } = require('@codemirror/language');

/* ------------------------------------------------------------------ *
 * Native macOS spellchecker bridge.
 *
 * A tiny persistent JXA (JavaScript for Automation) helper process
 * exposes NSSpellChecker.correctionForWordRange — the exact API that
 * powers autocorrect in native Mac apps. It returns a correction only
 * when the system is confident, and it respects words you've taught
 * your Mac ("Learn Spelling").
 *
 * Protocol: one request per line on stdin:  "<id>\t<lang>\t<word>"
 *           one response per line on stdout: "<id>\t<correction>"
 *           (empty correction = leave the word alone)
 * ------------------------------------------------------------------ */

const JXA_SOURCE = [
  "ObjC.import('AppKit');",
  "ObjC.import('Foundation');",
  "var checker = $.NSSpellChecker.sharedSpellChecker;",
  "var TAG = 1;",
  "try { TAG = $.NSSpellChecker.uniqueSpellDocumentTag; } catch (e) {}",
  "var stdinH = $.NSFileHandle.fileHandleWithStandardInput;",
  "var stdoutH = $.NSFileHandle.fileHandleWithStandardOutput;",
  "function respond(line) {",
  "  var s = $.NSString.alloc.initWithUTF8String(line + '\\n');",
  "  stdoutH.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));",
  "}",
  "var buf = '';",
  "while (true) {",
  "  var data = stdinH.availableData;",
  "  if (data.length == 0) break;",
  "  var chunk = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);",
  "  buf += (chunk && chunk.js) ? chunk.js : '';",
  "  var idx;",
  "  while ((idx = buf.indexOf('\\n')) >= 0) {",
  "    var line = buf.slice(0, idx);",
  "    buf = buf.slice(idx + 1);",
  "    var parts = line.split('\\t');",
  "    var id = parts[0];",
  "    var lang = parts[1] || '';",
  "    var word = parts[2] || '';",
  "    var out = '';",
  "    try {",
  "      var language = lang.length ? lang : ObjC.unwrap(checker.language);",
  "      var corr = checker.correctionForWordRangeInStringLanguageInSpellDocumentWithTag(",
  "        $.NSMakeRange(0, word.length), word, language, TAG);",
  "      var u = ObjC.unwrap(corr);",
  "      if (typeof u === 'string') out = u;",
  "    } catch (e) { out = ''; }",
  "    respond(id + '\\t' + out);",
  "  }",
  "}",
].join('\n');

class NativeChecker {
  constructor() {
    this.proc = null;
    this.pending = new Map(); // id -> {resolve, timer}
    this.seq = 0;
    this.buf = '';
    this.failed = false;
  }

  start() {
    if (this.proc || this.failed) return;
    try {
      const { spawn } = require('child_process');
      this.proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SOURCE], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onData(chunk));
      this.proc.on('error', () => this._die());
      this.proc.on('exit', () => this._die());
    } catch (e) {
      this._die();
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      const correction = line.slice(tab + 1);
      const req = this.pending.get(id);
      if (req) {
        this.pending.delete(id);
        clearTimeout(req.timer);
        req.resolve(correction.length ? correction : null);
      }
    }
  }

  _die() {
    this.failed = true;
    this.proc = null;
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.resolve(null);
    }
    this.pending.clear();
  }

  correction(word, lang) {
    this.start();
    if (!this.proc || this.failed) return Promise.resolve(undefined); // undefined = engine unavailable
    return new Promise((resolve) => {
      const id = String(this.seq++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 1500);
      this.pending.set(id, { resolve, timer });
      try {
        this.proc.stdin.write(id + '\t' + (lang || '') + '\t' + word + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        this._die();
        resolve(undefined);
      }
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.stdin.end(); this.proc.kill(); } catch (e) {}
      this.proc = null;
    }
  }
}

/* ---------------------- macOS Text Replacements ---------------------- *
 * macOS stores Settings → Keyboard → Text Replacements in a local
 * SQLite database (iCloud-synced). We read it with the system sqlite3
 * CLI, hex-encoding values so phrases with newlines/tabs survive.
 * ---------------------------------------------------------------------- */

class Replacements {
  constructor() {
    this.map = new Map(); // shortcut -> phrase
    this.lastCheck = 0;
    this.mtime = 0;
    this.loading = false;
  }

  dbPath() {
    const path = require('path');
    const os = require('os');
    return path.join(os.homedir(), 'Library', 'KeyboardServices', 'TextReplacements.db');
  }

  // throttled freshness check; reloads if the db changed
  maybeReload(force) {
    const now = Date.now();
    if (!force && now - this.lastCheck < 30000) return;
    this.lastCheck = now;
    try {
      const fs = require('fs');
      const stat = fs.statSync(this.dbPath());
      if (!force && stat.mtimeMs === this.mtime) return;
      this.mtime = stat.mtimeMs;
      this.load();
    } catch (e) {
      /* db missing (not macOS, or no replacements yet) */
    }
  }

  load(onDone) {
    if (this.loading) return;
    this.loading = true;
    const finish = (map) => {
      this.loading = false;
      if (map) this.map = map;
      if (onDone) onDone(this.map.size, !!map);
    };
    const run = (sql, cb) => {
      try {
        const { execFile } = require('child_process');
        execFile(
          '/usr/bin/sqlite3',
          ['-readonly', this.dbPath(), sql],
          { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => cb(err, stdout || '', stderr || '')
        );
      } catch (e) {
        cb(e, '', '');
      }
    };
    const parse = (stdout) => {
      const map = new Map();
      for (const line of stdout.split('\n')) {
        if (!line.length) continue;
        const parts = line.split('|');
        if (parts.length !== 2) continue;
        try {
          const shortcut = Buffer.from(parts[0], 'hex').toString('utf8');
          const phrase = Buffer.from(parts[1], 'hex').toString('utf8');
          if (shortcut.length && phrase.length) map.set(shortcut, phrase);
        } catch (e) {}
      }
      return map;
    };
    const q1 =
      'SELECT hex(ZSHORTCUT), hex(ZPHRASE) FROM ZTEXTREPLACEMENTENTRY WHERE ZWASDELETED IS NOT 1;';
    const q2 = 'SELECT hex(ZSHORTCUT), hex(ZPHRASE) FROM ZTEXTREPLACEMENTENTRY;';
    run(q1, (err, stdout) => {
      if (!err) return finish(parse(stdout));
      run(q2, (err2, stdout2) => {
        if (!err2) return finish(parse(stdout2));
        finish(null);
      });
    });
  }
}

/* ---------------------- correction flash highlight ---------------------- */

const addFlash = StateEffect.define({
  map: (v, m) => ({ from: m.mapPos(v.from), to: m.mapPos(v.to) }),
});
const clearFlash = StateEffect.define();
const flashMark = Decoration.mark({ class: 'mac-autocorrect-flash' });

const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFlash) && e.value.from < e.value.to) {
        deco = deco.update({ add: [flashMark.range(e.value.from, e.value.to)] });
      }
      if (e.is(clearFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* --------------------------- sentence logic --------------------------- */

// abbreviations that end in "." without ending the sentence
const BASE_ABBREV = [
  'etc', 'vs', 'cf', 'ca', 'al', 'approx', 'appt', 'apt', 'dept', 'est',
  'fig', 'ft', 'hr', 'hrs', 'incl', 'jr', 'sr', 'max', 'min', 'misc',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'mt', 'no', 'nos', 'vol', 'vols',
  'sec', 'ed', 'eds', 'trans', 'univ', 'assn', 'gov', 'inc', 'ltd',
];
const ABBREV = new Set(BASE_ABBREV);

function setExtraAbbreviations(raw) {
  ABBREV.clear();
  for (const a of BASE_ABBREV) ABBREV.add(a);
  for (const w of String(raw || '').split(/[,\n]/)) {
    const t = w.trim().toLowerCase().replace(/\.+$/, '');
    if (t.length) ABBREV.add(t);
  }
}

// Does this text (already trimmed at the end) end a sentence?
function endsSentence(text) {
  const m = text.match(/(.)?([.!?])["'")\]»]*$/su);
  if (!m) return false;
  if (m[2] !== '.') return true; // ! or ?
  const c = m[1];
  if (!c) return false; // line is just "."
  if (c === '.') return false; // "..." ellipsis — treat as continuing
  if (/\p{N}/u.test(c)) return true; // "in 1999."
  if (/\p{L}/u.test(c)) {
    const t = text.match(/(\p{L}+)\.["'")\]»]*$/u);
    const tok = t ? t[1] : '';
    if (tok.length === 1) return false; // initials: "J. Smith", and "e.g." (ends in "g.")
    if (ABBREV.has(tok.toLowerCase())) return false;
    return true;
  }
  return true;
}

// markdown block prefixes: blockquote '>', headings, list bullets, numbered lists
const BLOCK_PREFIX = /^(\s|>|#{1,6}\s|[-*+]\s|\d+[.)]\s)*$/;
const HAS_MARKER = /[>#]|(^|\s)([-*+]|\d+[.)])\s/;

/* ------------------------------ plugin ------------------------------ */

const DEFAULT_SETTINGS = {
  enabled: true, // correct spelling automatically
  capitalize: true, // capitalize words automatically
  doubleSpacePeriod: true, // add period with double-space
  useTextReplacements: true, // apply macOS Text Replacements
  engine: 'auto', // 'auto' | 'native' | 'electron'
  language: '', // '' = system language
  flash: true,
  ignoreWords: '',
  extraAbbreviations: '',
};

// characters that end a word and trigger a check
const BOUNDARY = /^[\s.,;:!?)\]}"'»›…—–]/;
// characters before a word that mean "leave this alone" (tags, paths, wiki syntax, etc.)
const BAD_PREFIX = /[#@/\\.`_~$%&+=<>{[-]/;

module.exports = class MacAutocorrectPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    setExtraAbbreviations(this.settings.extraAbbreviations);
    this.native = new NativeChecker();
    this.repl = new Replacements();
    this.sessionIgnore = new Set();
    this.lastCorrection = null;

    if (this.settings.useTextReplacements && process.platform === 'darwin') {
      this.repl.maybeReload(true);
    }

    this.addSettingTab(new AutocorrectSettingTab(this.app, this));

    this.registerEditorExtension([
      flashField,
      EditorView.updateListener.of((update) => this.onEditorUpdate(update)),
    ]);

    this.addCommand({
      id: 'reload-text-replacements',
      name: 'Reload macOS Text Replacements',
      callback: () => {
        this.repl.load((count, ok) => {
          new Notice(ok ? `Loaded ${count} text replacement${count === 1 ? '' : 's'}.` : 'Could not read the Text Replacements database.');
        });
      },
    });

    this.addCommand({
      id: 'revert-last-correction',
      name: 'Revert last correction (and stop correcting that word this session)',
      callback: () => this.revertLast(),
    });

    this.register(() => this.native.stop());
  }

  onunload() {
    this.native.stop();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* -------------------- typing detection -------------------- */

  onEditorUpdate(update) {
    const s = this.settings;
    if (!s.enabled && !s.capitalize && !s.doubleSpacePeriod) return;
    if (!update.docChanged) return;
    if (update.view.composing) return; // don't interfere with IME input

    for (const tr of update.transactions) {
      if (!tr.isUserEvent('input')) continue;
      if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.autocorrect')) continue;

      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const text = inserted.toString();
        if (text.length === 0 || text.length > 2 || !BOUNDARY.test(text)) return;
        if (s.doubleSpacePeriod && text === ' ') {
          this.handleDoubleSpace(update.view, fromB);
        }
        if (s.enabled || s.capitalize) {
          this.checkWordBefore(update.view, fromB);
        }
      });
    }
  }

  // in a context (code, math, link, tag, frontmatter…) we should not touch?
  isProtected(state, pos) {
    try {
      const node = syntaxTree(state).resolveInner(Math.min(pos, state.doc.length), -1);
      const names = (node.name || '') + '/' + (node.parent ? node.parent.name : '');
      return /code|math|frontmatter|hashtag|url|link|escape|html|comment|tag/i.test(names);
    } catch (e) {
      return false;
    }
  }

  /* ---------------- double-space -> period ---------------- */

  handleDoubleSpace(view, fromB) {
    // the just-typed space sits at [fromB, fromB+1)
    if (fromB < 2) return;
    const state = view.state;
    if (state.sliceDoc(fromB - 1, fromB) !== ' ') return; // previous char must be a space
    const prev2 = state.sliceDoc(fromB - 2, fromB - 1);
    if (!/[\p{L}\p{N}"'")\]»]/u.test(prev2)) return; // must follow the end of a word
    if (this.isProtected(state, fromB - 2)) return;

    // dispatching inside an update listener is not allowed — defer a tick
    Promise.resolve().then(() => {
      try {
        if (view.state.sliceDoc(fromB - 1, fromB + 1) !== '  ') return;
        view.dispatch({
          changes: { from: fromB - 1, to: fromB + 1, insert: '. ' },
          userEvent: 'input.autocorrect',
        });
      } catch (e) {}
    });
  }

  /* ---------------- word completion: capitalize + spelling ---------------- */

  checkWordBefore(view, pos) {
    const state = view.state;
    const line = state.doc.lineAt(pos);
    const before = state.doc.sliceString(line.from, pos);

    // macOS Text Replacements first: shortcuts may contain non-letters ("addr1", ";sig")
    if (this.settings.useTextReplacements && this.tryReplacement(view, state, line, before, pos)) {
      return;
    }

    const m = before.match(/[\p{L}][\p{L}'’]*$/u);
    if (!m) return;

    const word = m[0];
    const from = pos - word.length;

    // shared filters
    if (/\p{Lu}/u.test(word.slice(1))) return; // acronyms / camelCase / iPhone — hands off
    if (from > line.from) {
      const prev = state.doc.sliceString(from - 1, from);
      if (BAD_PREFIX.test(prev)) return; // #tag, [[link, path/word, mid.domain, snake_case…
    }
    if (this.isProtected(state, from + 1)) return;

    const wantCap =
      this.settings.capitalize &&
      /\p{Ll}/u.test(word[0]) &&
      this.isSentenceStart(state, line, from);

    const lower = word.toLowerCase();
    const wantSpell =
      this.settings.enabled &&
      (word.length >= 2 || lower === 'i') &&
      !this.sessionIgnore.has(lower) &&
      !this.ignoreSet().has(lower);

    if (!wantCap && !wantSpell) return;

    // dispatching inside an update listener is not allowed — defer a tick
    Promise.resolve().then(() => {
      let w = word;
      let to = from + w.length;

      if (wantCap) {
        try {
          if (view.state.sliceDoc(from, to) !== w) return;
          const cap = w[0].toLocaleUpperCase();
          view.dispatch({
            changes: { from, to: from + 1, insert: cap },
            userEvent: 'input.autocorrect',
          });
          w = cap + w.slice(1);
        } catch (e) {
          return;
        }
      }

      if (!wantSpell) return;
      this.getCorrection(w).then((corr) => {
        if (!corr || corr === w) return;
        this.applyCorrection(view, from, from + w.length, w, corr);
      });
    });
  }

  // Try to expand a macOS Text Replacement ending at `pos`. Returns true if handled.
  tryReplacement(view, state, line, before, pos) {
    if (!this.repl.map.size) {
      this.repl.maybeReload();
      return false;
    }
    this.repl.maybeReload(); // throttled freshness check for next time

    const tm = before.match(/\S+$/u);
    if (!tm) return false;

    let token = tm[0];
    let from = pos - token.length;
    // allow shortcuts right after opening punctuation: ("omw
    const stripped = token.replace(/^[("'\[{«‹¿¡]+/u, '');
    from += token.length - stripped.length;
    token = stripped;
    if (!token.length) return false;
    if (this.sessionIgnore.has(token.toLowerCase())) return false;
    if (this.isProtected(state, from + 1)) return false;

    let phrase = this.repl.map.get(token);
    if (phrase === undefined && /\p{Lu}/u.test(token[0])) {
      // typed with a leading capital (e.g. sentence start): match the lowercase
      // shortcut and capitalize the phrase, like macOS does
      const alt = token[0].toLocaleLowerCase() + token.slice(1);
      const altPhrase = this.repl.map.get(alt);
      if (altPhrase !== undefined && /\p{Ll}/u.test(altPhrase[0])) {
        phrase = altPhrase[0].toLocaleUpperCase() + altPhrase.slice(1);
      } else if (altPhrase !== undefined) {
        phrase = altPhrase;
      }
    }
    if (phrase === undefined || phrase === token) return false;

    // capitalize a lowercase phrase at a sentence start
    if (
      this.settings.capitalize &&
      /\p{Ll}/u.test(phrase[0]) &&
      this.isSentenceStart(state, line, from)
    ) {
      phrase = phrase[0].toLocaleUpperCase() + phrase.slice(1);
    }

    const to = pos;
    const original = token;
    const insert = phrase;
    // dispatching inside an update listener is not allowed — defer a tick
    Promise.resolve().then(() => {
      try {
        if (view.state.sliceDoc(from, to) !== original) return;
        const spec = {
          changes: { from, to, insert },
          userEvent: 'input.autocorrect',
        };
        if (this.settings.flash) {
          spec.effects = addFlash.of({ from, to: from + insert.length });
        }
        view.dispatch(spec);
        this.lastCorrection = { view, from, to: from + insert.length, original, corrected: insert };
        if (this.settings.flash) {
          window.setTimeout(() => {
            try {
              view.dispatch({ effects: clearFlash.of(null) });
            } catch (e) {}
          }, 1200);
        }
      } catch (e) {}
    });
    return true;
  }

  // Is the word starting at `from` the first word of a sentence?
  isSentenceStart(state, line, from) {
    const pre = state.doc.sliceString(line.from, from);

    // at the start of the line (possibly after markdown block markers)?
    if (BLOCK_PREFIX.test(pre)) {
      if (line.number === 1) return true; // start of note
      if (HAS_MARKER.test(pre)) return true; // heading / list item / quote → fresh block
      const prevLine = state.doc.line(line.number - 1);
      const pt = prevLine.text.trim();
      if (!pt.length) return true; // blank line above → new paragraph
      return endsSentence(pt); // "…sentence.\nnext" → capitalize; soft-wrapped continuation → don't
    }

    // mid-line: require sentence-ending punctuation + whitespace before the word
    const trimmed = pre.replace(/\s+$/, '');
    if (trimmed === pre) return false; // no gap → not a fresh word position
    return endsSentence(trimmed);
  }

  /* -------------------- correction engines -------------------- */

  async getCorrection(word) {
    const engine = this.settings.engine;
    const wantNative =
      engine === 'native' || (engine === 'auto' && process.platform === 'darwin');

    if (wantNative && !this.native.failed) {
      const corr = await this.native.correction(word, this.settings.language);
      if (corr !== undefined) return corr; // engine worked (may be null = no correction)
      // undefined → helper unavailable, fall through to Electron
    }
    if (engine === 'native') return null; // user forced native; don't silently switch

    return this.electronCorrection(word);
  }

  electronCorrection(word) {
    try {
      const { webFrame } = require('electron');
      if (!webFrame.isWordMisspelled(word)) return null;
      const suggestions = webFrame.getWordSuggestions(word);
      return suggestions && suggestions.length ? suggestions[0] : null;
    } catch (e) {
      return null;
    }
  }

  /* -------------------- applying corrections -------------------- */

  applyCorrection(view, from, to, word, corr) {
    // preserve a leading capital (typed or from auto-capitalization), but allow "i" -> "I"
    if (/\p{Lu}/u.test(word[0]) && /\p{Ll}/u.test(corr[0])) {
      corr = corr[0].toLocaleUpperCase() + corr.slice(1);
    }
    if (corr === word) return;

    let state;
    try {
      state = view.state;
    } catch (e) {
      return;
    }
    if (state.sliceDoc(from, to) !== word) return; // document changed while we asked

    const spec = {
      changes: { from, to, insert: corr },
      userEvent: 'input.autocorrect',
    };
    if (this.settings.flash) {
      spec.effects = addFlash.of({ from, to: from + corr.length });
    }
    try {
      view.dispatch(spec);
    } catch (e) {
      return;
    }

    this.lastCorrection = { view, from, to: from + corr.length, original: word, corrected: corr };

    if (this.settings.flash) {
      window.setTimeout(() => {
        try {
          view.dispatch({ effects: clearFlash.of(null) });
        } catch (e) {}
      }, 1200);
    }
  }

  revertLast() {
    const lc = this.lastCorrection;
    if (!lc) {
      new Notice('No autocorrection to revert.');
      return;
    }
    try {
      if (lc.view.state.sliceDoc(lc.from, lc.to) !== lc.corrected) {
        new Notice('The corrected text has changed — revert it manually (or undo).');
        return;
      }
      lc.view.dispatch({
        changes: { from: lc.from, to: lc.to, insert: lc.original },
        userEvent: 'input.autocorrect.revert',
      });
      this.sessionIgnore.add(lc.original.toLowerCase());
      new Notice(`Reverted to "${lc.original}" — won't correct it again this session.`);
      this.lastCorrection = null;
    } catch (e) {
      new Notice('Could not revert automatically.');
    }
  }

  ignoreSet() {
    if (this._ignoreCache && this._ignoreCacheSrc === this.settings.ignoreWords) {
      return this._ignoreCache;
    }
    this._ignoreCacheSrc = this.settings.ignoreWords;
    this._ignoreCache = new Set(
      this.settings.ignoreWords
        .split(/[,\n]/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length)
    );
    return this._ignoreCache;
  }
};

/* ------------------------------ settings ------------------------------ */

class AutocorrectSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Correct spelling automatically')
      .setDesc('Correct the previous word when you type a space, punctuation, or Enter.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Capitalize words automatically')
      .setDesc('Capitalize the first word of sentences, list items, and headings. Skips soft-wrapped lines, abbreviations like "etc." and "e.g.", and words with internal capitals.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.capitalize).onChange(async (v) => {
          this.plugin.settings.capitalize = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Add period with double-space')
      .setDesc('Typing two spaces after a word inserts a period, like macOS and iOS.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.doubleSpacePeriod).onChange(async (v) => {
          this.plugin.settings.doubleSpacePeriod = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Use macOS Text Replacements')
      .setDesc('Apply the shortcuts from System Settings → Keyboard → Text Replacements. The list reloads automatically when it changes; there is also a "Reload macOS Text Replacements" command.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useTextReplacements).onChange(async (v) => {
          this.plugin.settings.useTextReplacements = v;
          if (v) this.plugin.repl.maybeReload(true);
          await this.plugin.saveSettings();
        })
      )
      .addExtraButton((b) =>
        b
          .setIcon('refresh-cw')
          .setTooltip('Reload now')
          .onClick(() => {
            this.plugin.repl.load((count, ok) => {
              new Notice(ok ? `Loaded ${count} text replacement${count === 1 ? '' : 's'}.` : 'Could not read the Text Replacements database.');
            });
          })
      );

    new Setting(containerEl)
      .setName('Correction engine')
      .setDesc(
        'Native = real macOS autocorrect (NSSpellChecker): corrects only when confident, respects words your Mac has learned. Electron = built-in spellchecker, first suggestion. Auto = native on macOS, Electron elsewhere.'
      )
      .addDropdown((d) =>
        d
          .addOptions({ auto: 'Auto', native: 'macOS native', electron: 'Electron spellchecker' })
          .setValue(this.plugin.settings.engine)
          .onChange(async (v) => {
            this.plugin.settings.engine = v;
            this.plugin.native.failed = false; // let it retry
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Language override')
      .setDesc('Leave blank to use your system language. Otherwise e.g. en_US, en_GB, de_DE.')
      .addText((t) =>
        t.setValue(this.plugin.settings.language).onChange(async (v) => {
          this.plugin.settings.language = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Flash corrections')
      .setDesc('Briefly highlight a word right after it gets corrected.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.flash).onChange(async (v) => {
          this.plugin.settings.flash = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Additional abbreviations')
      .setDesc('Words ending in "." that should NOT start a new sentence after them (the built-in list covers common English ones). Comma- or newline-separated, with or without the period.')
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.extraAbbreviations).onChange(async (v) => {
          this.plugin.settings.extraAbbreviations = v;
          setExtraAbbreviations(v);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Never correct these words')
      .setDesc('Comma- or newline-separated. (Tip: the "Revert last correction" command also ignores the word for the rest of the session.)')
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.ignoreWords).onChange(async (v) => {
          this.plugin.settings.ignoreWords = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
