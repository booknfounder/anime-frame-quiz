import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { CHARACTERS } from './seed.js';
// المسار: DB_PATH إن وُجد وكان قابلًا للكتابة، وإلا ./data/game.db، وإلا مجلد temp. لا يُفترض وجود قرص دائم.
function resolveDbFile() {
  for (const f of [process.env.DB_PATH, path.resolve('data/game.db'), path.join(os.tmpdir(), 'anime-frame-quiz.db')].filter(Boolean)) {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.accessSync(path.dirname(f), fs.constants.W_OK); return f; }
    catch (e) { console.warn(`[db] المسار غير قابل للكتابة: ${f} (${e.code})`); }
  }
  throw new Error('لا يوجد مسار قابل للكتابة لقاعدة SQLite');
}
const file = resolveDbFile();
console.log(`[db] SQLite: ${file}` + (process.env.DB_PATH ? '' : ' (تخزين محلي؛ قد يُمسح عند إعادة النشر ما لم يُرفق قرص دائم)'));
export const db = new DatabaseSync(file);
db.exec(`
CREATE TABLE IF NOT EXISTS characters(id INTEGER PRIMARY KEY, anime TEXT NOT NULL, name_en TEXT NOT NULL UNIQUE, name_ar TEXT NOT NULL, difficulty TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aliases(id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL REFERENCES characters(id), alias TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL REFERENCES characters(id), url TEXT NOT NULL UNIQUE, note TEXT);
CREATE TABLE IF NOT EXISTS profiles(name TEXT PRIMARY KEY, avatar TEXT, games INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, total_points INTEGER DEFAULT 0, best INTEGER DEFAULT 0);
`);
export const norm = s => String(s||'').toLowerCase().normalize('NFKD')
  .replace(/[\u064B-\u065F\u0670\u0640\u0300-\u036f]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
  .replace(/[^a-z0-9\u0600-\u06ff]+/g,' ').trim();
if (db.prepare('SELECT COUNT(*) c FROM characters').get().c === 0) {
  const ic = db.prepare('INSERT INTO characters(anime,name_en,name_ar,difficulty) VALUES(?,?,?,?)');
  const ia = db.prepare('INSERT INTO aliases(character_id,alias) VALUES(?,?)');
  for (const [anime,en,ar,al,diff] of CHARACTERS) {
    const id = Number(ic.run(anime,en,ar,diff).lastInsertRowid);
    for (const a of new Set([en,ar,...al].map(norm))) if (a) ia.run(id,a);
  }
}
export function pool(animes, difficulty) {
  const d = difficulty && difficulty !== 'all';
  const rows = db.prepare(`SELECT i.id image_id,i.url,c.id cid,c.anime,c.name_en,c.name_ar,c.difficulty FROM images i JOIN characters c ON c.id=i.character_id
    WHERE c.anime IN (${animes.map(()=>'?').join(',')}) ${d?'AND c.difficulty=?':''}`).all(...animes, ...(d?[difficulty]:[]));
  const al = db.prepare('SELECT alias FROM aliases WHERE character_id=?');
  return rows.map(r => ({...r, accepted: al.all(r.cid).map(x=>x.alias)}));
}
