import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { db, norm, pool } from './db.js';

const ANIMES = ['naruto', 'dragonball', 'onepiece', 'bleach'];
const REVEAL_MS = 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
export const app = express();
app.use(express.json());

// ---------- REST ----------
app.get('/api/stats', (_q, r) => {
  const rows = db.prepare(`SELECT c.anime, c.difficulty, COUNT(i.id) images, COUNT(DISTINCT c.id) chars FROM characters c LEFT JOIN images i ON i.character_id=c.id GROUP BY c.anime,c.difficulty`).all();
  r.json(rows);
});
app.get('/api/characters', (_q, r) => r.json(db.prepare(`SELECT c.id,c.anime,c.name_en,c.name_ar,c.difficulty,(SELECT COUNT(*) FROM images WHERE character_id=c.id) images FROM characters c ORDER BY anime,name_en`).all()));
// حماية الإدارة: مقارنة ثابتة الزمن + حد للمحاولات الفاشلة. إن لم يُضبط ADMIN_KEY ترفض كل الطلبات.
const failed = new Map();
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const needAdmin = (q, r, n) => {
  const f = failed.get(q.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return r.status(429).json({ error: 'محاولات خاطئة كثيرة، حاول لاحقًا' });
  if (ADMIN_KEY && crypto.timingSafeEqual(sha(q.get('x-admin-key') || ''), sha(ADMIN_KEY))) return n();
  f.n++; failed.set(q.ip, f);
  r.status(401).json({ error: ADMIN_KEY ? 'مفتاح الإدارة غير صحيح' : 'الإدارة معطلة: ADMIN_KEY غير مضبوط على الخادم' });
};
app.get('/healthz', (_q, r) => r.send('ok'));
app.post('/api/images', needAdmin, (q, r) => {
  const { character_id, url, note } = q.body || {};
  if (!/^https?:\/\//i.test(url || '') || !db.prepare('SELECT 1 FROM characters WHERE id=?').get(character_id)) return r.status(400).json({ error: 'بيانات غير صالحة' });
  try { db.prepare('INSERT INTO images(character_id,url,note) VALUES(?,?,?)').run(character_id, url, note || null); r.json({ ok: true }); }
  catch { r.status(409).json({ error: 'الرابط مضاف مسبقًا' }); }
});

// استيراد آلي لصور الشخصيات من AniList. هذه صور ملفات الشخصيات وليست لقطات حلقات.
const ANILIST_TARGETS = [
  { key: 'naruto', search: 'Naruto' },
  { key: 'dragonball', search: 'Dragon Ball' },
  { key: 'onepiece', search: 'One Piece' },
  { key: 'bleach', search: 'Bleach' },
];
const ANILIST_QUERY = `query ($search: String, $page: Int) {
  Media(search: $search, type: ANIME) {
    id title { romaji english }
    characters(page: $page, perPage: 50, sort: FAVOURITES_DESC) {
      pageInfo { hasNextPage }
      edges { node { id name { full native } image { large } } }
    }
  }
}`;
let importingAniList = false;
app.post('/api/import/anilist', needAdmin, async (_q, r) => {
  if (importingAniList) return r.status(409).json({ error: 'هناك عملية استيراد تعمل الآن، انتظر حتى تنتهي' });
  importingAniList = true;
  const result = { addedImages: 0, existingImages: 0, addedCharacters: 0, matchedCharacters: 0, skipped: 0, sources: [], errors: [] };
  try {
    const findChars = db.prepare('SELECT id,name_en FROM characters WHERE anime=?');
    const insertChar = db.prepare('INSERT OR IGNORE INTO characters(anime,name_en,name_ar,difficulty) VALUES(?,?,?,?)');
    const findChar = db.prepare('SELECT id FROM characters WHERE anime=? AND name_en=?');
    const insertAlias = db.prepare('INSERT INTO aliases(character_id,alias) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM aliases WHERE character_id=? AND alias=?)');
    const insertImage = db.prepare('INSERT OR IGNORE INTO images(character_id,url,note) VALUES(?,?,?)');
    for (const target of ANILIST_TARGETS) {
      try {
        let page = 1, hasNext = true, found = 0;
        while (hasNext && page <= 3) {
          const response = await fetch('https://graphql.anilist.co', {
            method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
            body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: target.search, page } }),
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
          const payload = await response.json();
          if (payload.errors?.length) throw new Error(payload.errors.map(x => x.message).join('; '));
          const media = payload.data?.Media;
          if (!media) throw new Error('لم يعثر AniList على الأنمي');
          hasNext = !!media.characters?.pageInfo?.hasNextPage;
          const rows = media.characters?.edges || [];
          for (const edge of rows) {
            const node = edge?.node, full = String(node?.name?.full || '').trim(), url = String(node?.image?.large || '').trim();
            if (!full || !/^https:\/\//i.test(url)) { result.skipped++; continue; }
            let row = findChar.get(target.key, full);
            if (!row) {
              insertChar.run(target.key, full, full, 'medium');
              row = findChar.get(target.key, full);
              if (row) result.addedCharacters++;
            } else result.matchedCharacters++;
            if (!row) { result.skipped++; continue; }
            for (const alias of [full, node.name?.native].filter(Boolean)) {
              const normalized = norm(alias);
              if (normalized) insertAlias.run(row.id, normalized, row.id, normalized);
            }
            const ins = insertImage.run(row.id, url, 'AniList character portrait (ليست لقطة من حلقة)');
            if (Number(ins.changes) > 0) result.addedImages++; else result.existingImages++;
            found++;
          }
          page++;
        }
        result.sources.push({ anime: target.key, title: mediaTitle(target.search), characters: found });
      } catch (e) { result.errors.push({ anime: target.key, message: String(e?.message || e) }); }
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
    r.json({ ok: result.errors.length === 0, ...result, totalImages: total, note: 'AniList يوفر صور ملفات الشخصيات، وليس فريمات من حلقات الأنمي.' });
  } catch (e) {
    r.status(500).json({ error: `تعذر الاستيراد: ${String(e?.message || e)}` });
  } finally { importingAniList = false; }
});
function mediaTitle(search) { return ({ Naruto: 'Naruto', 'Dragon Ball': 'Dragon Ball', 'One Piece': 'One Piece', Bleach: 'Bleach' })[search] || search; }
app.get('/api/profile/:name', (q, r) => r.json(db.prepare('SELECT * FROM profiles WHERE name=?').get(q.params.name) || null));

const dist = path.resolve('dist');
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('*', (_q, r) => r.sendFile(path.join(dist, 'index.html'))); }

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Rooms ----------
const rooms = new Map();
const genCode = () => { let c; do { c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); } while (rooms.has(c)); return c; };
const clean = (s, n) => String(s || '').trim().slice(0, n);
const publicRoom = r => ({
  code: r.code, host: r.host, state: r.state, settings: r.settings,
  players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, ready: p.ready, score: p.score, connected: p.connected })),
});
const emitRoom = r => io.to(r.code).emit('room', publicRoom(r));
const board = r => [...r.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score })).sort((a, b) => b.score - a.score);
const defaults = () => ({ maxPlayers: 8, rounds: 10, time: 20, guessTime: 8, animes: [...ANIMES], difficulty: 'all', speedBonus: true });

function clamp(n, lo, hi, d) { n = Math.floor(Number(n)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function sanitize(s, cur) {
  const o = { ...cur };
  if (s.maxPlayers != null) o.maxPlayers = clamp(s.maxPlayers, 2, 30, cur.maxPlayers);
  if (s.rounds != null) o.rounds = clamp(s.rounds, 1, 100, cur.rounds);
  if (s.time != null) o.time = clamp(s.time, 5, 120, cur.time);
  if (s.guessTime != null) o.guessTime = clamp(s.guessTime, 3, 30, cur.guessTime);
  if (Array.isArray(s.animes)) { const a = s.animes.filter(x => ANIMES.includes(x)); if (a.length) o.animes = a; }
  if (['all', 'easy', 'medium', 'hard'].includes(s.difficulty)) o.difficulty = s.difficulty;
  if (s.speedBonus != null) o.speedBonus = !!s.speedBonus;
  return o;
}
const clearTimers = r => { const x = r.round; if (x) { clearTimeout(x.roundTimer); clearTimeout(x.guessTimer); } clearTimeout(r.nextTimer); };

function startGame(r) {
  const p = pool(r.settings.animes, r.settings.difficulty);
  if (!p.length) return 'لا توجد صور مضافة للأنميات/الصعوبة المختارة. أضف صورًا من صفحة الإدارة.';
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  // منع التكرار: كل صورة تظهر مرة واحدة فقط؛ إن قلّت الصور تُقلَّص الجولات
  r.queue = p; r.total = Math.min(r.settings.rounds, p.length); r.index = 0;
  r.state = 'playing'; r.players.forEach(x => { x.score = 0; });
  io.to(r.code).emit('game:started', { total: r.total, reduced: r.total < r.settings.rounds });
  emitRoom(r); nextRound(r); return null;
}

function nextRound(r) {
  if (r.index >= r.total) return finish(r);
  const q = r.queue[r.index++];
  const t = r.settings.time * 1000;
  r.round = { q, open: true, buzzer: null, tried: new Set(), startedAt: Date.now(), endsAt: Date.now() + t, guessEndsAt: 0 };
  r.round.roundTimer = setTimeout(() => reveal(r, null), t);
  io.to(r.code).emit('round:start', { index: r.index, total: r.total, image: q.url, difficulty: q.difficulty, anime: q.anime, remainingMs: t });
}

function reveal(r, winnerId) {
  const x = r.round; if (!x || !x.open) return;
  x.open = false; clearTimeout(x.roundTimer); clearTimeout(x.guessTimer);
  io.to(r.code).emit('round:reveal', { answer: { en: x.q.name_en, ar: x.q.name_ar }, winnerId, board: board(r), last: r.index >= r.total, revealMs: REVEAL_MS });
  r.nextTimer = setTimeout(() => nextRound(r), REVEAL_MS);
}

function finish(r) {
  r.state = 'finished'; r.round = null;
  const b = board(r), top = b[0]?.score ?? 0;
  const up = db.prepare(`INSERT INTO profiles(name,avatar,games,wins,total_points,best) VALUES(?,?,1,?,?,?) ON CONFLICT(name) DO UPDATE SET games=games+1,wins=wins+?,total_points=total_points+?,best=MAX(best,?),avatar=excluded.avatar`);
  for (const p of r.players.values()) { const w = (p.score === top && top > 0) ? 1 : 0; up.run(p.name, p.avatar, w, p.score, p.score, w, p.score, p.score); }
  io.to(r.code).emit('game:finished', { board: b, winners: b.filter(p => p.score === top && top > 0).map(p => p.id) });
  r.players.forEach(p => { p.ready = false; });
  emitRoom(r);
}

function wrong(r, pid) {
  const x = r.round; if (!x || !x.open) return;
  clearTimeout(x.guessTimer); x.tried.add(pid); x.buzzer = null; x.guessEndsAt = 0;
  const eligible = [...r.players.values()].filter(p => p.connected && !x.tried.has(p.id));
  io.to(r.code).emit('buzz:wrong', { playerId: pid });
  if (!eligible.length) return reveal(r, null);
  io.to(r.code).emit('buzz:open', { lockedOut: [...x.tried] });
}

io.on('connection', socket => {
  let room = null, me = null;
  const err = m => socket.emit('err', m);
  const join = (r, p) => { room = r; me = p; socket.join(r.code); };
  const isHost = () => room && me && room.host === me.id;
  const active = () => !!(room && me && room.players.has(me.id)); // اللاعب المطرود لا يملك أي صلاحية

  socket.on('room:create', (d, cb) => {
    const name = clean(d?.name, 16); if (!name) return cb?.({ error: 'أدخل اسمًا مستعارًا' });
    const r = { code: genCode(), host: null, state: 'lobby', settings: defaults(), players: new Map(), round: null };
    const p = { id: socket.id, name, avatar: clean(d?.avatar, 8), ready: true, score: 0, connected: true };
    r.host = p.id; r.players.set(p.id, p); rooms.set(r.code, r); join(r, p);
    cb?.({ ok: true, code: r.code, me: p.id }); emitRoom(r);
  });
  socket.on('room:join', (d, cb) => {
    const r = rooms.get(clean(d?.code, 8).toUpperCase()); const name = clean(d?.name, 16);
    if (!r) return cb?.({ error: 'الغرفة غير موجودة' });
    if (!name) return cb?.({ error: 'أدخل اسمًا مستعارًا' });
    if (r.state !== 'lobby') return cb?.({ error: 'المباراة بدأت بالفعل' });
    if (r.players.size >= r.settings.maxPlayers) return cb?.({ error: 'الغرفة ممتلئة' });
    if ([...r.players.values()].some(p => norm(p.name) === norm(name))) return cb?.({ error: 'الاسم مستخدم في الغرفة' });
    const p = { id: socket.id, name, avatar: clean(d?.avatar, 8), ready: false, score: 0, connected: true };
    r.players.set(p.id, p); join(r, p); cb?.({ ok: true, code: r.code, me: p.id }); emitRoom(r);
  });
  socket.on('room:settings', s => {
    if (!isHost() || room.state !== 'lobby') return;
    const n = sanitize(s || {}, room.settings);
    if (n.maxPlayers < room.players.size) n.maxPlayers = room.players.size;
    room.settings = n; emitRoom(room);
  });
  socket.on('player:ready', v => { if (active() && room.state === 'lobby' && !isHost()) { me.ready = !!v; emitRoom(room); } });
  socket.on('room:kick', id => {
    if (!isHost() || id === me.id || !room.players.has(id)) return;
    const kp = room.players.get(id);
    io.to(id).emit('kicked'); io.sockets.sockets.get(id)?.leave(room.code); room.players.delete(id);
    io.to(room.code).emit('player:left', { name: kp.name, reason: 'kicked' });
    if (room.state === 'playing') {
      if (room.players.size < 2) { clearTimers(room); finish(room); }
      else if (room.round?.buzzer === id) wrong(room, id);
      else if (room.round?.open && [...room.players.values()].every(p => room.round.tried.has(p.id))) reveal(room, null);
    }
    emitRoom(room);
  });
  socket.on('game:start', cb => {
    if (!isHost() || room.state !== 'lobby') return cb?.({ error: 'غير مسموح' });
    if (room.players.size < 2) return cb?.({ error: 'يلزم لاعبان على الأقل' });
    if ([...room.players.values()].some(p => !p.ready)) return cb?.({ error: 'ليس كل اللاعبين جاهزين' });
    const e = startGame(room); cb?.(e ? { error: e } : { ok: true });
  });
  // --- Buzzer: الخادم أحادي الخيط، فأول حدث 'buzz' يُعالج هو الفائز ولا يُستخدم توقيت العميل ---
  socket.on('buzz', () => {
    const x = room?.round;
    if (!active() || !x || !x.open || x.buzzer || x.tried.has(me.id)) return socket.emit('buzz:denied');
    x.buzzer = me.id; x.guessEndsAt = Date.now() + room.settings.guessTime * 1000;
    // لا يمكن أن يتجاوز وقت التخمين وقت السؤال المتبقي
    clearTimeout(x.guessTimer); x.guessTimer = setTimeout(() => wrong(room, me.id), room.settings.guessTime * 1000);
    io.to(room.code).emit('buzz:won', { playerId: me.id, name: me.name, guessMs: room.settings.guessTime * 1000 });
  });
  socket.on('answer', text => {
    const x = room?.round;
    if (!active() || !x || !x.open || x.buzzer !== me.id) return;
    const n = norm(text); if (!n) return;
    if (x.q.accepted.includes(n)) {
      let pts = 100;
      if (room.settings.speedBonus) pts += Math.round(50 * Math.max(0, (x.endsAt - Date.now()) / (x.endsAt - x.startedAt)));
      me.score += pts; io.to(room.code).emit('answer:correct', { playerId: me.id, name: me.name, points: pts });
      reveal(room, me.id);
    } else wrong(room, me.id);
  });
  socket.on('room:rematch', () => {
    if (!isHost() || room.state !== 'finished') return;
    clearTimers(room); room.state = 'lobby'; room.players.forEach(p => { p.score = 0; p.ready = p.id === room.host; });
    io.to(room.code).emit('rematch'); emitRoom(room);
  });
  const leave = reason => {
    if (!room || !me) return;
    const r = room, p = me; room = null; me = null; socket.leave(r.code);
    if (!r.players.delete(p.id)) return; // سبق طرده
    if (!r.players.size) { clearTimers(r); rooms.delete(r.code); return; }
    if (r.host === p.id) r.host = r.players.keys().next().value;
    io.to(r.code).emit('player:left', { name: p.name, reason });
    if (r.state === 'playing') {
      if (r.players.size < 2) { clearTimers(r); finish(r); }
      else if (r.round?.buzzer === p.id) wrong(r, p.id);
      else if (r.round?.open && [...r.players.values()].every(x => r.round.tried.has(x.id))) reveal(r, null);
    }
    emitRoom(r);
  };
  socket.on('room:leave', () => leave('left')); socket.on('disconnect', () => leave('disconnected'));
});

const PORT = process.env.PORT || 3000;
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('server/index.js')) server.listen(PORT, () => console.log('listening on', PORT));
export { server, io };
