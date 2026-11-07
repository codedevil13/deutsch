/* Deutsch, offline engine. A JavaScript port of the Python trainer (trainer.py, check.py, store.py, reading.py, ai.py).
   Everything lives on this device (localStorage). The only network call is the optional Claude help, with YOUR own key. */
(function () {
"use strict";
const B = window.BANK;
const INTERVALS = [1, 2, 4, 8, 16, 32];
const KEY = "deutsch.progress.v1", TKEY = "deutsch.texts.v1", SKEY = "deutsch.settings.v1";

class ApiError extends Error { constructor(m, code) { super(m); this.code = code || 400; } }

/* ---------- small helpers ---------- */
const todayISO = () => new Date().toLocaleDateString("sv");
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv"); };
function hash(str, len) {                      // stable, not cryptographic (FNV-1a, two rounds)
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193) >>> 0; h2 = Math.imul(h2 + str.charCodeAt(i), 0x85ebca6b) >>> 0; }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, len || 8);
}
function rngFor(salt) {                        // seeded, like the Python version: the same day gives the same shuffle
  let s = parseInt(hash(todayISO() + "-" + salt, 8), 16) >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rnd) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
function sample(arr, n, rnd) { return shuffle(arr.slice(), rnd).slice(0, n); }
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function cmpTuple(a, b) { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; }

/* ---------- settings ---------- */
const Settings = {
  get() { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch (e) { return {}; } },
  set(o) { try { localStorage.setItem(SKEY, JSON.stringify({ ...Settings.get(), ...o })); } catch (e) {} },
};

/* ---------- progress (same format as the laptop's progress.json) ---------- */
const Progress = {
  data: null,
  load() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    this.setData(d);
  },
  setData(d) {
    for (const [k, v] of Object.entries({ items: {}, log: {}, parts: [], ai_items: {}, words: [], reading: {}, reading_cache: {}, last_station: 15 })) if (!(k in d)) d[k] = v;
    this.data = d;
  },
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { throw new ApiError("Speichern nicht möglich (Speicher voll?)"); } },
  item(id) { return this.data.items[id] || {}; },
  record(id, ok, given, today) {
    const it = (this.data.items[id] = this.data.items[id] || { box: 0, seen: 0, wrong: 0 });
    it.seen += 1;
    if (ok) {
      if (it.last !== today || it.box === 0) it.box = Math.min(it.box + 1, INTERVALS.length);
      it.due = addDays(today, INTERVALS[it.box - 1]);
    } else { it.box = 0; it.wrong += 1; it.due = addDays(today, 1); }
    it.last = today;
    (this.data.log[today] = this.data.log[today] || []).push({ id, ok, given });
    this.save();
  },
  dueIds(today) {
    return Object.entries(this.data.items).filter(([, v]) => (v.due || "9") <= today).map(([k, v]) => [v.due || "", k])
      .sort((a, b) => cmpTuple(a, b)).map(x => x[1]);
  },
  practicedDays() { return Object.entries(this.data.log).filter(([, e]) => e.length).map(x => x[0]).sort(); },
  todayLog(today) { return (this.data.log[today] || []).slice(); },
  addPart(today, task, text, feedback) { this.data.parts.push({ date: today, task, text, feedback: feedback || "" }); this.save(); },
};

/* ---------- answer checking (check.py) ---------- */
const PUNCT = /[.,!?;:„“”"'’‚‘()»«]/g;
const tidy = s => (s || "").normalize("NFC").replace(PUNCT, " ").replace(/\s+/g, " ").trim();
const fold = s => s.toLowerCase().replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
function judge(given, answer) {
  const g = tidy(given);
  if (!g) return ["wrong", ""];
  const options = answer.split("|").filter(a => a.trim()).map(tidy);
  for (const o of options) if (g === o) return ["ok", ""];
  for (const o of options) if (g.toLowerCase() === o.toLowerCase()) return ["ok", ""];
  for (const o of options) if (fold(g) === fold(o)) return ["ok", "Richtig. Mit den Sonderzeichen: " + o];
  return ["wrong", ""];
}
function filledSentences(prompt, answer) {
  const base = prompt.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const out = [];
  for (const opt of answer.split("|").map(a => a.trim()).filter(Boolean)) {
    const words = opt.split(/\s+/), blanks = (base.match(/___/g) || []).length;
    if (blanks > 1 && words.length === blanks) { let i = 0; out.push(base.replace(/___/g, () => words[i++])); }
    else out.push(blanks ? base.replace("___", opt) : base);
  }
  return out;
}
function judgeItem(given, prompt, answer) {
  let [st, note] = judge(given, answer);
  if (st === "ok") return [st, note];
  for (const s of filledSentences(prompt, answer)) { [st, note] = judge(given, s); if (st === "ok") return [st, note]; }
  return ["wrong", ""];
}

/* ---------- trainer (trainer.py) ---------- */
const TAG_NAMES = {
  dativ: "die Dativ-Verben", akk: "der Akkusativ", praep: "die Präpositionen", genus: "Artikel und Genus",
  partizip: "die Partizipien", trennbar: "die trennbaren Verben", reflexiv: "die reflexiven Verben",
  wortstellung: "die Wortstellung im Nebensatz", endung: "die Adjektivendungen", konjunktiv: "der Konjunktiv II",
  passiv: "das Passiv", genitiv: "der Genitiv", relativ: "die Relativsätze", konj1: "der Konjunktiv I",
  ndekl: "die n-Deklination", partadj: "Partizipien als Adjektive", starke: "die starken Verben",
  imperativ: "der Imperativ", konnektor: "wenn, als, ob und Co.", praet: "das Präteritum",
  vergleich: "die Vergleiche", stolper: "die typischen Stolpersteine", schreibweise: "die Schreibweise",
  nomen: "die Artikel der neuen Nomen", eigene: "deine eigenen Fehler von früher",
};
const WEAK_TAGS = new Set(["dativ", "partizip", "genus", "trennbar", "wortstellung", "praep", "starke", "nomen"]);
const HINTS = {
  dativ: "Wem? → Dativ. Steht das Verb auf der Dativ-Liste (helfen, danken, gehören, gefallen …)? Dann die Person im Dativ.",
  akk: "Wen oder was? → Akkusativ. Nur maskulin ändert sich: der → den, ein → einen.",
  praep: "Welcher Fall gehört zur Präposition? Wechselpräposition: Wo? → Dativ, Wohin? → Akkusativ.",
  genus: "Schau auf das Genus des Nomens: Das Pronomen und der Artikel richten sich danach.",
  partizip: "Starkes Verb? Dann endet das Partizip auf -en, nicht -t. Und: sein (Ort/Zustand ändert sich) oder haben?",
  trennbar: "Trennbar? Dann geht die Vorsilbe ans Satzende (ge steckt dazwischen im Partizip).",
  reflexiv: "Das Reflexivpronomen richtet sich nach dem Subjekt: ich → mich, er/sie → sich, wir → uns.",
  wortstellung: "Nebensatz (weil, dass, wenn)? Dann steht das konjugierte Verb ganz am Ende.",
  endung: "Zeigt der Artikel schon den Fall? Sonst zeigt ihn das Adjektiv (-er, -es). Dativ mit Artikel: immer -en.",
  vergleich: "Komparativ: -er (oft mit Umlaut). Superlativ: am … -sten. gut, viel, gern sind unregelmäßig.",
  konjunktiv: "Mit Umlaut = höflich oder hypothetisch (hätte, wäre, könnte). Ohne Umlaut = Vergangenheit.",
  passiv: "Passiv = werden + Partizip II. werden richtet sich nach dem Subjekt. Zustand: sein + Partizip II.",
  genitiv: "Genitiv: des / der + Nomen auf -s (maskulin, neutral). Feminin und Plural: der.",
  relativ: "Genus und Zahl kommen vom Nomen davor, der Fall von der Rolle im Relativsatz (Wer? Wen? Wem?).",
  konj1: "Konjunktiv I (indirekte Rede): Stamm + -e. Von sein: sei.",
  ndekl: "n-Deklination: männliche Person auf -e / -ent / -ist: in jedem Fall außer Nominativ endet es auf -n/-en.",
  partadj: "Partizip II (eingereicht) oder Partizip I (Infinitiv + d), dann die normale Adjektivendung.",
  starke: "Starkes Verb: Vokalwechsel bei du und er/sie/es, nie bei ihr. Präteritum und Partizip lernen.",
  praet: "sein, haben und die Modalverben stehen im Gespräch im Präteritum. Ohne Umlaut.",
  konnektor: "wenn = immer / Gegenwart, als = einmal in der Vergangenheit, ob = Ja/Nein-Frage. Adverbien wie trotzdem: Verb direkt danach.",
  imperativ: "Imperativ: du-Form ohne du (e → i bleibt: hilf, lies). Sie: Verb + Sie.",
  schreibweise: "Denk an ß und die Schreibweise der Grußformel.",
  stolper: "Das ist einer deiner typischen Stolpersteine. Frag dich: nein/nie, kennen/wissen, viel/viele?",
};
const NOUN_HINT = {
  a: "Schau auf die Endung: -ung, -heit, -keit, -ft, -thek → die · -chen, -nis, -ment, -um, Ge- → das · -er, einsilbig → meist der.",
  p: "Welches Muster: -e (± Umlaut), -er (+ Umlaut), -(e)n oder keine Endung?",
};

const T = {
  items: {},
  build() {
    this.items = {};
    for (const [n, , ] of B.STATIONS) (B.GAPS[n] || []).forEach(([prompt, answer, why, tag], i) =>
      this.add({ id: `s-${n}-${i}`, kind: "gap", station: n, prompt, answer, why, tag }));
    B.NOUN_SETS.forEach(([, nouns], si) => nouns.forEach(([art, sg, pl, en, why], ni) => {
      this.add({ id: `n-${si}-${ni}-a`, kind: "noun", station: 0, set: si, prompt: `___ ${sg}  (${en})`, answer: art, why: `${art} ${sg}: ${why}`, tag: "nomen" });
      if (pl) this.add({ id: `n-${si}-${ni}-p`, kind: "noun", station: 0, set: si, prompt: `Plural: ${art} ${sg} → die ___`, answer: pl, why: `${art} ${sg}, die ${pl}`, tag: "nomen" });
    }));
    for (const [id, it] of Object.entries(Progress.data.ai_items)) this.items[id] = it;
  },
  add(it) { this.items[it.id] = it; },
  priority(id) { const it = Progress.item(id); return [(it.seen || 0) > 0, it.box || 0, it.last || ""]; },
  sortByPriority(ids) { return ids.sort((a, b) => cmpTuple(this.priority(a), this.priority(b))); },
  pub(id) { const it = this.items[id]; return { id, prompt: it.prompt, kind: it.kind, tag: it.tag || "" }; },
  nextNounSet() {
    const info = si => {
      const ids = Object.entries(this.items).filter(([, it]) => it.kind === "noun" && it.set === si).map(x => x[0]);
      const seen = ids.map(i => Progress.item(i).last || "");
      return [seen.every(s => s === ""), seen.length ? seen.reduce((a, b) => (a < b ? a : b)) : ""];
    };
    // sets never practised first, otherwise the one practised longest ago
    const key = i => { const [never, min] = info(i); return [!never, min, i]; };
    const idx = B.NOUN_SETS.map((_, i) => i);
    idx.sort((a, b) => cmpTuple(key(a), key(b)));
    return idx[0];
  },
  plan(station, today) {
    const rnd = rngFor("station" + station);
    const st = B.STATIONS.find(s => s[0] === station);
    const [, title, anchors] = st;
    let gapIds = Object.entries(this.items).filter(([, it]) => (it.kind === "gap" || it.kind === "ai") && it.station === station).map(x => x[0]);
    shuffle(gapIds, rnd); this.sortByPriority(gapIds);
    const gaps = gapIds.slice(0, 4);
    const due = Progress.dueIds(today).filter(i => this.items[i] && this.items[i].kind !== "noun" && !gaps.includes(i));
    let warm = due.slice(0, 4);
    if (warm.length < 3) {
      const pool = Object.entries(this.items).filter(([i, it]) => it.kind === "gap" && it.station !== station && WEAK_TAGS.has(it.tag) && !warm.includes(i)).map(x => x[0]);
      shuffle(pool, rnd); this.sortByPriority(pool);
      warm = warm.concat(pool.slice(0, 3 - warm.length));
    }
    const ns = this.nextNounSet(), nouns = B.NOUN_SETS[ns];
    const teach = nouns[1].map(([art, sg, pl, en, why]) => ({ art, sg, pl, en, why }));
    const nIds = Object.entries(this.items).filter(([, it]) => it.kind === "noun" && it.set === ns).map(x => x[0]);
    const artIds = nIds.filter(i => i.endsWith("-a")), plIds = shuffle(nIds.filter(i => i.endsWith("-p")), rnd);
    const nounTest = artIds.concat(plIds.slice(0, 4));
    const partsDone = Progress.data.parts.length;
    const [kind, ptitle, instruction] = B.PART_B[partsDone % B.PART_B.length];
    const part = { kind, title: ptitle, instruction };
    if (kind === "spontan") { part.questions = sample(B.SPONTAN, 5, rnd); part.timebuyers = B.TIME_BUYERS; }
    const words = Progress.data.words.filter(w => !w.taught).slice(0, 5).map(w => ({ id: w.id, text: w.text, note: w.note || "", gloss: w.gloss || null }));
    Progress.data.last_station = station; Progress.save();
    return { station, title, read: anchors, warm: warm.map(i => this.pub(i)), gaps: gaps.map(i => this.pub(i)),
      nouns: { set: ns >= 0 ? B.NOUN_SETS[ns][0] : "", teach, test: nounTest.map(i => this.pub(i)) }, words, partb: part };
  },
  check(id, given, today) {
    const it = this.items[id];
    if (!it) throw new ApiError("unknown exercise", 404);
    const [status, note] = judgeItem(given, it.prompt, it.answer), ok = status === "ok";
    Progress.record(id, ok, given, today);
    return { ok, note, answer: it.answer.split("|")[0], why: it.why };
  },
  hint(id, level) {
    const it = this.items[id];
    if (!it) throw new ApiError("unknown exercise", 404);
    const answer = it.answer.split("|")[0];
    const shape = answer.split(/\s+/).map(w => w[0] + "_".repeat(w.length - 1)).join(" ");
    const t1 = it.kind === "noun" ? NOUN_HINT[id.endsWith("-p") ? "p" : "a"] : (HINTS[it.tag || ""] || "");
    if (level <= 1 && t1) return { text: t1, more: true };
    if (level <= 2 || !t1) return { text: "Fängt so an: " + shape, more: false };
    return { text: "Mehr geht nicht ohne die Lösung. „Weiß ich nicht“ zeigt sie dir.", more: false };
  },
  addAiItems(station, raw, tag, due) {
    const out = [];
    for (const d of raw) {
      const id = "ai-" + hash(d.prompt, 8);
      const item = { id, kind: "ai", station, prompt: d.prompt, answer: d.answer, why: d.why || (tag === "eigene" ? "Aus deinem eigenen Text." : "Von Claude vorgeschlagen."), tag: tag || "ai" };
      this.items[id] = item; Progress.data.ai_items[id] = item;
      if (due) Progress.data.items[id] = Progress.data.items[id] || { box: 0, seen: 0, wrong: 0, due };
      out.push(this.pub(id));
    }
    Progress.save();
    return out;
  },
  addWord(text, note, today) {
    const w = { id: "w-" + hash(text + Progress.data.words.length, 8), text: text.trim().slice(0, 80), note: (note || "").trim().slice(0, 200), date: today, gloss: null, taught: false };
    Progress.data.words.push(w); Progress.save(); return w;
  },
  readingState(tid) { return (Progress.data.reading[tid] = Progress.data.reading[tid] || { done: [], last: 0 }); },
  closing(today) {
    const last = {};
    for (const e of Progress.todayLog(today)) last[e.id] = e;
    const right = [], wrong = [];
    for (const [id, e] of Object.entries(last)) { const it = this.items[id]; if (it) (e.ok ? right : wrong).push(it); }
    const tagsOk = [];
    for (const it of right) if (TAG_NAMES[it.tag] && !tagsOk.includes(it.tag)) tagsOk.push(it.tag);
    const praise = tagsOk.length ? ["Gut gelaufen heute: " + tagsOk.slice(0, 3).map(t => TAG_NAMES[t]).join(", ") + "."]
      : ["Du hast heute angefangen, und das ist der schwerste Teil."];
    const mistakes = wrong.map(it => ({ prompt: it.prompt, answer: it.answer.split("|")[0], why: it.why }));
    return { praise, mistakes, next: mistakes.length ? "Diese Aufgaben kommen morgen noch einmal." : "Morgen gibt es eine kurze Wiederholung und etwas Neues." };
  },
  stationStatus() {
    const out = {};
    for (const [n] of B.STATIONS) {
      const ids = Object.entries(this.items).filter(([, it]) => (it.kind === "gap" || it.kind === "ai") && it.station === n).map(x => x[0]);
      const seen = ids.filter(i => Progress.item(i).seen), strong = ids.filter(i => (Progress.item(i).box || 0) >= 3);
      out[n] = !seen.length ? "neu" : (ids.length && strong.length >= 0.7 * ids.length ? "sitzt" : "ueben");
    }
    return out;
  },
  weakSpots(today) {
    const since = addDays(today, -14), counts = {}, stationOf = {};
    for (const day of Object.keys(Progress.data.log).sort()) {
      if (day < since) continue;
      for (const e of Progress.data.log[day]) {
        const it = this.items[e.id];
        if (it && !e.ok && TAG_NAMES[it.tag] && it.station) { counts[it.tag] = (counts[it.tag] || 0) + 1; stationOf[it.tag] = it.station; }
      }
    }
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3).map(t => ({ name: TAG_NAMES[t], station: stationOf[t] }));
  },
  state(today) {
    const days = Progress.practicedDays(), parts = Progress.data.parts, key = Settings.get().apiKey;
    const status = {}; for (const [k, v] of Object.entries(this.stationStatus())) status[String(k)] = v;
    return {
      stations: B.STATIONS.map(([n, t, a]) => ({ n, title: t, read: a[0] })), status, weak: this.weakSpots(today),
      words: Progress.data.words.slice(-30).reverse().map(w => ({ text: w.text, gloss: w.gloss || null, taught: !!w.taught })),
      parts: parts.slice(-50).reverse().map(p => ({ date: p.date, task: p.task, text: p.text, feedback: p.feedback || "" })),
      spontan: B.SPONTAN, timebuyers: B.TIME_BUYERS, recommended: Progress.data.last_station || 15,
      days: days.slice(-14), practiced_today: days.includes(today),
      waiting: Progress.dueIds(today).some(i => this.items[i] && this.items[i].kind !== "noun"),
      ai: true, ai_ready: !!key,
    };
  },
};

/* ---------- reading (reading.py: pasted or imported .txt/.md only on the phone) ---------- */
const HARD_HINTS = ["shakespeare", "hamlet", "macbeth", "romeo", "sommernacht", "othello", "lear", "sturm", "kaufmann", "faust", "goethe", "schiller"];
const TARGET = 190, MAXW = 300;
const words = s => s.split(/\s+/).filter(Boolean).length;
const isLower = ch => !!ch && ch === ch.toLowerCase() && ch !== ch.toUpperCase();
function unwrap(par) {
  const lines = par.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return lines.join(" ");
  const lowerStarts = lines.slice(1).filter(l => isLower(l[0])).length, avg = lines.reduce((a, l) => a + l.length, 0) / lines.length;
  if (lowerStarts >= 0.4 * (lines.length - 1) || avg >= 62) return lines.join(" ").replace(/(\p{L})-\s+(?=[a-zäöüß])/gu, "$1");
  return lines.join("\n");
}
function splitPassages(text) {
  text = text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n");
  const paras = text.split(/\n\s*\n/).filter(p => p.trim()).map(unwrap), pieces = [];
  for (const p of paras) {
    if (words(p) <= MAXW) { pieces.push(p); continue; }
    let cur = "";
    for (const sent of p.split(/(?<=[.!?])\s+/)) {
      if (cur && words(cur) + words(sent) > TARGET) { pieces.push(cur); cur = sent; } else cur = (cur + " " + sent).trim();
    }
    if (cur) pieces.push(cur);
  }
  const out = []; let cur = "";
  for (const piece of pieces) {
    if (cur && words(cur) >= TARGET) { out.push(cur); cur = piece; }
    else if (cur && words(cur) + words(piece) > MAXW) { out.push(cur); cur = piece; }
    else cur = cur ? cur + "\n\n" + piece : piece;
  }
  if (cur.trim()) out.push(cur);
  return out.filter(p => words(p) >= 8);
}
const Texts = {
  all() { try { return JSON.parse(localStorage.getItem(TKEY)) || []; } catch (e) { return []; } },
  save(list) { try { localStorage.setItem(TKEY, JSON.stringify(list)); } catch (e) { throw new ApiError("Speichern nicht möglich (Speicher voll?)"); } },
  find(id) { return this.all().find(t => t.id === id); },
  level(t) { return HARD_HINTS.some(h => t.title.toLowerCase().includes(h)) ? "schwer" : "mittel"; },
};

/* ---------- Claude (optional, your own key; ai.py prompts) ---------- */
const SYSTEM_BASE = `You are a warm, concise German tutor for one learner.
Rules you always follow:
- Never give scores, grades, percentages or counts of mistakes. Praise concretely in words.
- Teach first, then (only if asked) quiz. One concept at a time. Never dump long tests.
- Keep replies short (under about 150 words unless asked for more). Explain in English, give examples in German.
- Correct only the 2 or 3 most important mistakes, each with the corrected sentence and a one-line reason.
- Plain text only. No markdown tables, no headings.`;
const systemPrompt = () => { const p = (Settings.get().profile || "").trim(); return SYSTEM_BASE + (p ? "\nAbout the learner (private, written by them): " + p.slice(0, 800) : ""); };
const CHAT_RULES = `Conversation-partner mode: reply in simple German (about B1), one to three sentences, then ask one
follow-up question. If the learner's last message had an important mistake, add one final line starting with
'Kleine Korrektur:' that fixes at most two things. Never switch to a lesson unless asked.`;

async function ask(prompt, system, maxTokens) {
  const s = Settings.get();
  if (!s.apiKey) throw new ApiError("Für Claude-Hilfe: Schlüssel unter Einstellungen eintragen.", 502);
  if (!navigator.onLine) throw new ApiError("Du bist offline. Claude braucht Internet, alles andere geht auch so.", 502);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": s.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: s.model || "claude-haiku-5-5", max_tokens: maxTokens || 1024, system: system || systemPrompt(), messages: [{ role: "user", content: prompt }] }),
    });
  } catch (e) { throw new ApiError("Claude ist gerade nicht erreichbar.", 502); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError("Claude hat nicht geantwortet (" + ((j.error && j.error.message) || r.status).toString().slice(0, 140) + ").", 502);
  const out = (j.content || []).map(c => c.text || "").join("").trim();
  if (!out) throw new ApiError("Claude hat nicht geantwortet.", 502);
  return out;
}
function parseItems(raw) {
  const a = raw.indexOf("["), b = raw.lastIndexOf("]");
  if (a < 0 || b <= a) throw new ApiError("Claudes Antwort hatte keine Aufgaben. Nochmal versuchen.", 502);
  let data; try { data = JSON.parse(raw.slice(a, b + 1)); } catch (e) { throw new ApiError("Claudes Antwort konnte nicht gelesen werden.", 502); }
  const items = [];
  for (const d of Array.isArray(data) ? data : []) {
    if (!d || typeof d !== "object") continue;
    const prompt = String(d.prompt || "").trim(), answer = String(d.answer || "").trim(), why = String(d.why || "").trim();
    if (prompt.includes("___") && answer && prompt.length < 200) items.push({ prompt, answer, why });
  }
  if (!items.length) throw new ApiError("Claudes Aufgaben waren nicht brauchbar. Nochmal versuchen.", 502);
  return items.slice(0, 6);
}
function jsonObject(raw) {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) throw new ApiError("Claudes Antwort konnte nicht gelesen werden.", 502);
  try { const d = JSON.parse(raw.slice(a, b + 1)); if (d && typeof d === "object" && !Array.isArray(d)) return d; } catch (e) {}
  throw new ApiError("Claudes Antwort konnte nicht gelesen werden.", 502);
}
const GAP_FORMAT = 'Each prompt contains ___ for the blank and an English hint in brackets; the answer is the missing German word(s) only (alternatives separated by |); \'why\' is one short sentence with the rule.';
const AI = {
  review: (task, instruction, text) => ask(`Task the learner was given: ${task}\n${instruction}\n\nThe learner's text:\n${text}\n\nGive feedback: first one concrete thing they did well, then the 2 or 3 most important corrections (each: corrected sentence + one-line reason). If the text is short, finish with one clean corrected version. No scores.`),
  explain: (prompt, given, answer, why) => ask(`Exercise: ${prompt}\nLearner answered: ${given || "(nothing)"}\nCorrect answer: ${answer}\nShort rule from the cheat sheet: ${why}\n\nExplain in 3 or 4 lines why the right answer is right and give the decision path I should use next time, plus one extra example sentence. Do not quiz me. The app judged this answer wrong, so explain the actual mistake. If I typed a whole sentence, focus on the missing word only. Never comment on commas, capitalisation or other punctuation.`),
  chat: history => ask(history.slice(-12).map(t => `${t.role === "user" ? "Learner" : "You"}: ${t.text}`).join("\n") + "\nYou:", systemPrompt() + "\n" + CHAT_RULES),
  more: async (title, avoid) => parseItems(await ask(`Write 4 NEW gap-fill exercises for the German topic: ${title} (level A2 to B2).\nStyle of the existing ones:\n${avoid.slice(0, 5).map(p => "- " + p).join("\n")}\n\nRules: ${GAP_FORMAT} Do not repeat the examples above.\nReply with ONLY a JSON array like [{"prompt": "...", "answer": "...", "why": "..."}].`)),
  mine: async text => {
    const raw = await ask(`Here is a German text I wrote:\n\n${text}\n\nFind the real mistakes (grammar, wrong words, word order; ignore capitalisation, commas and ß/ae spelling). For the 2 to 4 most useful ones write a gap-fill exercise that trains the same rule with a NEW sentence (not my sentence). ${GAP_FORMAT} If there are no real mistakes reply with [].\nReply with ONLY a JSON array like [{"prompt": "...", "answer": "...", "why": "..."}].`);
    return ["[]", ""].includes(raw.trim()) ? [] : parseItems(raw);
  },
  gloss: async (word, note) => {
    const d = jsonObject(await ask(`German word or phrase I just met: ${word}\n${note ? "Context: " + note + "\n" : ""}Reply with ONLY JSON: {"de": "article + word (or the phrase) as it should be learned", "plural": "plural for nouns, else empty", "en": "short English meaning", "example": "one simple German example sentence"}`));
    const o = {}; for (const k of ["de", "plural", "en", "example"]) o[k] = String(d[k] || "").trim().slice(0, 200); return o;
  },
  exercises: async (title, passage, level) => {
    const simple = level === "schwer" ? '"simple": a B1 rewrite of the passage, same events, about the same length' : '"simple": ""';
    const d = jsonObject(await ask(`Passage from '${title}' (text difficulty: ${level}; learner is around B1):\n\n${passage}\n\nCreate CBSE-style comprehension material. Reply with ONLY one JSON object with these keys:\n${simple},\n"glossary": 6 to 8 hard or old-fashioned words from the passage, each {"word": "as in the text", "meaning": "short English meaning", "wortart": "Nomen/Verb/Adjektiv/Adverb/...", "synonym": "German synonym or empty", "antonym": "German antonym or empty"},\n"questions": exactly 5, each {"type": "verstehen|wort|grammatik|schluss", "q": "German question (add an English hint in brackets if tricky)", "model": "model answer in German, one or two sentences"}: two verstehen (facts from the text), one wort (synonym, antonym or Wortart of a word in the text), one grammatik (e.g. put a sentence in the Perfekt, or find the Relativsatz), one schluss (why / what will probably happen).\nNo scores, no numbering inside the text.`, systemPrompt(), 3000));
    const gl = (d.glossary || []).filter(g => g && g.word).map(g => { const o = {}; for (const k of ["word", "meaning", "wortart", "synonym", "antonym"]) o[k] = String(g[k] || "").trim(); return o; });
    const qs = (d.questions || []).filter(q => q && q.q && q.model).map(q => { const o = {}; for (const k of ["type", "q", "model"]) o[k] = String(q[k] || "").trim(); return o; });
    if (!qs.length) throw new ApiError("Claudes Fragen waren nicht brauchbar. Nochmal versuchen.", 502);
    return { simple: String(d.simple || "").trim(), glossary: gl.slice(0, 8), questions: qs.slice(0, 6) };
  },
  judgeAnswer: (q, model, answer) => ask(`Question: ${q}\nModel answer: ${model}\nMy answer: ${answer || "(nothing)"}\n\nCompare my answer to the model: say in one or two lines what is good, then fix at most two real mistakes (grammar or content). Ignore capitalisation, commas and ß/ae spelling. No scores.`),
};

/* ---------- the API the page talks to (same routes as the laptop server) ---------- */
function passageOf(body) {
  const t = Texts.find(String(body.id || ""));
  if (!t) throw new ApiError("Text nicht gefunden", 404);
  const passages = splitPassages(t.text), idx = parseInt(body.idx || 0, 10);
  if (!(idx >= 0 && idx < passages.length)) throw new ApiError("Abschnitt nicht gefunden", 404);
  return { t, passages, idx };
}
const routes = {
  "/api/state": () => T.state(todayISO()),
  "/api/texts": () => ({
    texts: Texts.all().map(t => { const n = splitPassages(t.text).length, st = T.readingState(t.id);
      return { id: t.id, title: t.title, level: Texts.level(t), file: t.title + ".txt", passages: n, done: st.done.length, next: Math.min(st.last, Math.max(n - 1, 0)) }; }),
    folder: "",
  }),
  "/api/session": b => { const n = parseInt(b.station || 0, 10); if (!(n >= 1 && n <= 16)) throw new ApiError("Unknown station"); return T.plan(n, todayISO()); },
  "/api/check": b => T.check(String(b.id || ""), String(b.answer || ""), todayISO()),
  "/api/hint": b => T.hint(String(b.id || ""), parseInt(b.level || 1, 10)),
  "/api/part": b => { const text = String(b.text || "").trim(); if (!text) throw new ApiError("Schreib erst etwas."); Progress.addPart(todayISO(), String(b.task || ""), text, String(b.feedback || "")); return { saved: true }; },
  "/api/close": () => T.closing(todayISO()),
  "/api/text/add": b => {
    const text = String(b.text || "").trim();
    if (text.split(/\s+/).length < 15) throw new ApiError("Der Text ist zu kurz. Füge mindestens ein paar Sätze ein.");
    const title = String(b.title || "").replace(/[^\p{L}\p{N}_\- ]/gu, "").trim() || "Text";
    const list = Texts.all(); let name = title, n = 2;
    while (list.some(t => t.title === name)) name = `${title} ${n++}`;
    const id = hash(name, 10); list.push({ id, title: name, text }); Texts.save(list); return { id };
  },
  "/api/passage": b => {
    const { t, passages, idx } = passageOf(b);
    return { id: t.id, title: t.title, level: Texts.level(t), idx, total: passages.length, text: passages[idx], exercises: Progress.data.reading_cache[`${t.id}:${idx}`] || null };
  },
  "/api/passage/done": b => { const { t, idx } = passageOf(b), st = T.readingState(t.id); if (!st.done.includes(idx)) st.done.push(idx); st.last = idx + 1; Progress.save(); return { ok: true }; },
  "/api/word": b => {
    const text = String(b.text || "").trim();
    if (!text) throw new ApiError("Welches Wort?");
    const w = T.addWord(text, String(b.note || ""), todayISO());
    if (Settings.get().apiKey) AI.gloss(w.text, w.note).then(g => { const x = Progress.data.words.find(v => v.id === w.id); if (x) { x.gloss = g; Progress.save(); } }).catch(() => {});
    return { saved: true };
  },
  "/api/words/taught": b => { const ids = Array.isArray(b.ids) ? b.ids.map(String) : []; for (const w of Progress.data.words) if (ids.includes(w.id)) w.taught = true; Progress.save(); return { ok: true }; },
};
const aroutes = {
  "/api/passage/exercises": async b => {
    const { t, passages, idx } = passageOf(b), k = `${t.id}:${idx}`, cached = Progress.data.reading_cache[k];
    if (cached && !b.fresh) return cached;
    const data = await AI.exercises(t.title, passages[idx], Texts.level(t));
    Progress.data.reading_cache[k] = data; Progress.save(); return data;
  },
  "/api/ai/review": async b => { const text = String(b.text || "").trim(); if (!text) throw new ApiError("Schreib erst etwas."); return { text: await AI.review(String(b.task || ""), String(b.instruction || ""), text) }; },
  "/api/ai/explain": async b => { const it = T.items[String(b.id || "")]; if (!it) throw new ApiError("Unknown exercise", 404); return { text: await AI.explain(it.prompt, String(b.given || ""), it.answer.split("|")[0], it.why) }; },
  "/api/ai/chat": async b => {
    if (!Array.isArray(b.history) || !b.history.length) throw new ApiError("Nothing to answer");
    return { text: await AI.chat(b.history.filter(h => h && typeof h === "object").map(h => ({ role: h.role === "user" ? "user" : "assistant", text: String(h.text || "").slice(0, 2000) }))) };
  },
  "/api/ai/answer": async b => ({ text: await AI.judgeAnswer(String(b.q || ""), String(b.model || ""), String(b.answer || "").slice(0, 2000)) }),
  "/api/ai/mine": async b => {
    const text = String(b.text || "").trim(); if (!text) throw new ApiError("Schreib erst etwas.");
    const items = await AI.mine(text);
    return { count: T.addAiItems(0, items, "eigene", addDays(todayISO(), 1)).length };
  },
  "/api/ai/more": async b => {
    const n = parseInt(b.station || 0, 10), st = B.STATIONS.find(s => s[0] === n);
    if (!st) throw new ApiError("Unknown station");
    const existing = Object.values(T.items).filter(it => it.station === n && it.kind === "gap").map(it => it.prompt);
    return { items: T.addAiItems(n, await AI.more(st[1], existing)) };
  },
};
async function handle(path, body) {
  const p = path.split("?")[0];
  try {
    if (routes[p]) return routes[p](body || {});
    if (aroutes[p]) return await aroutes[p](body || {});
  } catch (e) { if (e instanceof ApiError) throw new Error(e.message); throw e; }
  throw new Error("not found");
}

/* ---------- export / import (same file format as the laptop) ---------- */
function exportAll() { return JSON.stringify({ ...Progress.data, _texts: Texts.all() }, null, 1); }
function importAll(json) {
  const d = JSON.parse(json);
  if (!d || typeof d !== "object" || !("items" in d)) throw new Error("Das ist keine Deutsch-Fortschrittsdatei.");
  const texts = d._texts; delete d._texts;
  Progress.setData(d); Progress.save(); T.build();
  if (Array.isArray(texts)) Texts.save(texts);
}

Progress.load(); T.build();
window.DE = { handle, Settings, exportAll, importAll, Progress, T, Texts, splitPassages, judgeItem, hash };
})();

/* ---------- settings page ---------- */
window.settingsView = function () {
  const s = DE.Settings.get();
  view.innerHTML = `<h1>Einstellungen</h1>
  <div class="card"><h3>Claude-Hilfe (freiwillig)</h3>
    <p class="muted small" style="margin:4px 0 10px">Ohne Schlüssel geht alles außer Claude: Üben, Lesen, Spickzettel. Mit eigenem Anthropic-Schlüssel gibt es Erklärungen, Korrekturen, Plaudern und neue Aufgaben. Der Schlüssel bleibt nur auf diesem Handy, die Anfragen gehen direkt an Anthropic und kosten ein paar Cent.</p>
    <input type="text" id="akey" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false" style="-webkit-text-security:disc" value="${esc(s.apiKey || "")}">
    <input type="text" id="amodel" placeholder="Modell (Standard: claude-haiku-5-5)" autocomplete="off" spellcheck="false" style="margin-top:8px" value="${esc(s.model || "")}">
    <textarea id="aprof" placeholder="Über dich, nur für Claude (optional): Ziel, Niveau, was dir schwerfällt …" style="margin-top:8px;min-height:90px">${esc(s.profile || "")}</textarea>
    <p class="muted small" style="margin:6px 0 0">Das bleibt nur auf diesem Handy und geht nur an Claude, wenn du fragst.</p>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="asave">Speichern</button><button class="btn ghost" id="aclear">Schlüssel löschen</button></div><div id="amsg"></div></div>
  <div class="card"><h3>Fortschritt sichern und übertragen</h3>
    <p class="muted small" style="margin:4px 0 10px">Die Datei hat dasselbe Format wie am Laptop (<code>progress.json</code>). So kannst du zwischen Handy und Laptop wechseln.</p>
    <div class="row"><button class="btn" id="exp">Fortschritt speichern (Datei)</button></div>
    <div style="margin-top:12px"><label class="small muted">Fortschritt laden:</label><br><input type="file" id="imp" accept=".json,application/json"></div><div id="mmsg"></div></div>
  <div class="card"><h3>Als App installieren</h3><p class="muted small" style="margin:4px 0 0">In Chrome: Menü ⋮ → „Zum Startbildschirm hinzufügen“ oder „App installieren“. Danach läuft Deutsch auch ohne Internet.</p></div>`;
  $("#asave").onclick = () => { DE.Settings.set({ apiKey: $("#akey").value.trim(), model: $("#amodel").value.trim(), profile: $("#aprof").value.trim() }); $("#amsg").innerHTML = `<p class="muted small">Gespeichert.</p>`; };
  $("#aclear").onclick = () => { DE.Settings.set({ apiKey: "" }); $("#akey").value = ""; $("#amsg").innerHTML = `<p class="muted small">Gelöscht.</p>`; };
  $("#exp").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([DE.exportAll()], { type: "application/json" }));
    a.download = "deutsch-fortschritt-" + new Date().toLocaleDateString("sv") + ".json"; a.click();
  };
  $("#imp").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { DE.importAll(await f.text()); $("#mmsg").innerHTML = `<p class="muted small">Geladen ✓</p>`; } catch (x) { $("#mmsg").innerHTML = `<p class="err">${esc(x.message)}</p>`; }
  };
};
