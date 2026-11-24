import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Background from './Background.jsx';
import { sfx, isMuted, setMuted } from './sound.js';

const ANIMES = { naruto: 'Naruto', dragonball: 'Dragon Ball', onepiece: 'One Piece', bleach: 'Bleach' };
const DIFF = { all: 'الكل', easy: 'سهل', medium: 'متوسط', hard: 'صعب' };
const AVATARS = ['🦊', '🐉', '🏴‍☠️', '⚔️', '🍥', '🔥', '🌙', '⚡', '🐺', '👑', '🎭', '🌸'];
const socket = io({ reconnectionDelayMax: 4000, timeout: 8000 });

function useCountdown(ms, key) {
  const [left, setLeft] = useState(ms);
  useEffect(() => { if (ms == null) return; const end = performance.now() + ms; setLeft(ms); const t = setInterval(() => setLeft(Math.max(0, end - performance.now())), 100); return () => clearInterval(t); }, [ms, key]);
  return left;
}
const Bar = ({ left, total, cls }) => <div className={'bar ' + (cls || '')}><i style={{ width: `${Math.max(0, Math.min(100, left / total * 100))}%` }} /></div>;
const Av = ({ p, big }) => <span className={'av' + (big ? ' big' : '')}>{p.avatar || p.name?.[0]?.toUpperCase()}</span>;

export default function App() {
  const [page, setPage] = useState('home');
  const [room, setRoom] = useState(null);
  const [me, setMe] = useState(null);
  const [toast, setToast] = useState('');
  const [muted, setM] = useState(isMuted());
  const [profile, setProfile] = useState({ name: localStorage.getItem('afq-name') || '', avatar: localStorage.getItem('afq-av') || AVATARS[0] });
  const [game, setGame] = useState(null);      // الجولة الحالية
  const [final, setFinal] = useState(null);
  const [fx, setFx] = useState(null);
  const [online, setOnline] = useState(socket.connected);
  const [connErr, setConnErr] = useState(false);
  const inRoom = useRef(false);
  const say = m => { setToast(m); setTimeout(() => setToast(''), 3000); };

  useEffect(() => {
    socket.on('connect', () => {
      setOnline(true); setConnErr(false);
      // بعد إعادة الاتصال يكون الخادم قد أزال اللاعب من الغرفة (هوية الاتصال تتغير) فنعيده للرئيسية بوضوح
      if (inRoom.current) { inRoom.current = false; setRoom(null); setGame(null); setFinal(null); setPage('home'); say('انقطع اتصالك وخرجت من الغرفة. انضم من جديد بالكود.'); }
    });
    socket.on('disconnect', () => setOnline(false));
    socket.on('connect_error', () => { setOnline(false); setConnErr(true); });
    socket.on('player:left', d => say(d.reason === 'kicked' ? `تم طرد ${d.name}` : d.reason === 'disconnected' ? `انقطع اتصال ${d.name}` : `غادر ${d.name} الغرفة`));
    socket.on('room', r => { setRoom(r); setPage(p => (p === 'game' || p === 'results') ? p : 'lobby'); });
    socket.on('err', say);
    socket.on('kicked', () => { inRoom.current = false; setRoom(null); setGame(null); setPage('home'); say('تم طردك من الغرفة'); });
    socket.on('game:started', d => { setFinal(null); setPage('game'); if (d.reduced) say(`الصور المتاحة أقل من المطلوب؛ سيتم لعب ${d.total} جولة`); });
    socket.on('round:start', d => setGame({ ...d, phase: 'open', buzzer: null, locked: [], reveal: null, key: d.index }));
    socket.on('buzz:won', d => { sfx.buzz(); setGame(g => g && { ...g, buzzer: d, phase: 'guess', gkey: Date.now() }); setFx('buzz'); setTimeout(() => setFx(null), 700); });
    socket.on('buzz:wrong', d => { sfx.wrong(); setFx('wrong'); setTimeout(() => setFx(null), 700); setGame(g => g && { ...g, locked: [...g.locked, d.playerId] }); });
    socket.on('buzz:open', () => setGame(g => g && { ...g, buzzer: null, phase: 'open' }));
    socket.on('answer:correct', () => { sfx.correct(); setFx('correct'); setTimeout(() => setFx(null), 900); });
    socket.on('round:reveal', d => setGame(g => g && { ...g, phase: 'reveal', reveal: d, buzzer: null }));
    socket.on('game:finished', d => { setFinal(d); setPage('results'); sfx.win(); });
    socket.on('rematch', () => { setFinal(null); setGame(null); setPage('lobby'); });
    return () => socket.off();
  }, []);

  const saveProfile = p => { setProfile(p); localStorage.setItem('afq-name', p.name); localStorage.setItem('afq-av', p.avatar); };
  const enter = (ev, payload) => !socket.connected ? say('لا يوجد اتصال بالخادم') : socket.emit(ev, { ...payload, name: profile.name, avatar: profile.avatar }, r => {
    if (r?.error) return say(r.error); inRoom.current = true; setMe(r.me); setPage('lobby'); sfx.click();
  });
  const leave = () => { inRoom.current = false; socket.emit('room:leave'); setRoom(null); setGame(null); setFinal(null); setPage('home'); };

  return <div className="app" dir="rtl">
    <Background />
    <button className="mute glass" aria-label="الصوت" onClick={() => { setMuted(!muted); setM(!muted); }}>{muted ? '🔇' : '🔊'}</button>
    {!online && <div className="conn glass" role="alert"><span className="spin" />{connErr ? 'تعذّر الاتصال بالخادم… نعيد المحاولة تلقائيًا' : 'انقطع الاتصال… جارٍ إعادة الاتصال'}</div>}
    {fx && <div className={'fx ' + fx} />}
    {toast && <div className="toast glass">{toast}</div>}
    <main className={online ? '' : 'offline'}>
      {page === 'home' && <Home profile={profile} setProfile={saveProfile} go={setPage} />}
      {page === 'create' && <Entry title="إنشاء غرفة" btn="إنشاء" profile={profile} setProfile={saveProfile} back={() => setPage('home')} onSubmit={() => enter('room:create', {})} />}
      {page === 'join' && <Entry title="الانضمام إلى غرفة" btn="انضمام" code profile={profile} setProfile={saveProfile} back={() => setPage('home')} onSubmit={c => enter('room:join', { code: c })} />}
      {page === 'admin' && <Admin back={() => setPage('home')} say={say} />}
      {page === 'lobby' && room && <Lobby room={room} me={me} say={say} leave={leave} />}
      {page === 'game' && room && game && <Play room={room} me={me} g={game} />}
      {page === 'results' && final && room && <Results f={final} room={room} me={me} leave={leave} />}
    </main>
  </div>;
}

function ProfileBox({ profile, setProfile }) {
  const [st, setSt] = useState(null);
  useEffect(() => { if (profile.name.length > 1) { const t = setTimeout(() => fetch('/api/profile/' + encodeURIComponent(profile.name)).then(r => r.json()).then(setSt).catch(() => {}), 400); return () => clearTimeout(t); } }, [profile.name]);
  return <div className="glass card">
    <input className="in" maxLength={16} placeholder="اسمك المستعار" value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} />
    <div className="avs">{AVATARS.map(a => <button key={a} className={'avb' + (profile.avatar === a ? ' on' : '')} onClick={() => setProfile({ ...profile, avatar: a })}>{a}</button>)}</div>
    {st && <div className="stats"><div><b>{st.games}</b>مباريات</div><div><b>{st.wins}</b>انتصارات</div><div><b>{st.total_points}</b>مجموع النقاط</div><div><b>{st.best}</b>أفضل نتيجة</div></div>}
  </div>;
}

function Home({ profile, setProfile, go }) {
  const ok = profile.name.trim().length > 0;
  return <section className="center fade">
    <h1 className="logo">Anime <span>Frame</span> Quiz</h1>
    <p className="sub">خمّن الشخصية من الفريم… وكن الأسرع!</p>
    <ProfileBox profile={profile} setProfile={setProfile} />
    <div className="row"><button className="btn pri" disabled={!ok} onClick={() => { sfx.click(); go('create'); }}>إنشاء غرفة</button>
      <button className="btn" disabled={!ok} onClick={() => { sfx.click(); go('join'); }}>انضمام بكود</button></div>
    <button className="link" onClick={() => go('admin')}>إدارة الشخصيات والصور</button>
  </section>;
}

function Entry({ title, btn, code, onSubmit, back, profile, setProfile }) {
  const [c, setC] = useState('');
  return <section className="center fade"><h2>{title}</h2>
    <ProfileBox profile={profile} setProfile={setProfile} />
    {code && <input className="in code" dir="ltr" maxLength={5} placeholder="كود الغرفة" value={c} onChange={e => setC(e.target.value.toUpperCase())} />}
    <div className="row"><button className="btn pri" disabled={!profile.name.trim() || (code && c.length < 5)} onClick={() => onSubmit(c)}>{btn}</button><button className="btn" onClick={back}>رجوع</button></div></section>;
}

function Lobby({ room, me, say, leave }) {
  const host = room.host === me, s = room.settings, mine = room.players.find(p => p.id === me);
  const set = o => socket.emit('room:settings', o);
  const toggleAnime = a => { const n = s.animes.includes(a) ? s.animes.filter(x => x !== a) : [...s.animes, a]; if (n.length) set({ animes: n }); };
  const [custom, setCustom] = useState('');
  const everyoneReady = room.players.length > 1 && room.players.every(p => p.ready);
  return <section className="lobby fade">
    <div className="glass card"><div className="muted">كود الغرفة</div>
      <button className="roomcode" dir="ltr" onClick={() => navigator.clipboard?.writeText(room.code).then(() => say('تم نسخ الكود'))}>{room.code}</button>
      <div className="muted">{room.players.length} / {s.maxPlayers} لاعبين</div>
      <ul className="players">{room.players.map(p => <li key={p.id} className="glass pl"><Av p={p} /><b>{p.name}{p.id === me ? ' (أنت)' : ''}</b>
        {p.id === room.host ? <em className="tag">المضيف</em> : <em className={'tag ' + (p.ready ? 'ok' : '')}>{p.ready ? 'جاهز' : 'غير جاهز'}</em>}
        {host && p.id !== me && <button className="x" title="طرد" onClick={() => socket.emit('room:kick', p.id)}>✕</button>}</li>)}</ul></div>
    <div className="glass card settings"><h3>الإعدادات {host ? '' : '(للمضيف فقط)'}</h3>
      <div className="chips">{Object.entries(ANIMES).map(([k, v]) => <button key={k} disabled={!host} className={'chip' + (s.animes.includes(k) ? ' on' : '')} onClick={() => toggleAnime(k)}>{v}</button>)}</div>
      <div className="chips">{Object.entries(DIFF).map(([k, v]) => <button key={k} disabled={!host} className={'chip' + (s.difficulty === k ? ' on' : '')} onClick={() => set({ difficulty: k })}>{v}</button>)}</div>
      <label>الجولات<div className="chips">{[5, 10, 20].map(n => <button key={n} disabled={!host} className={'chip' + (s.rounds === n ? ' on' : '')} onClick={() => set({ rounds: n })}>{n}</button>)}
        <input className="in mini" disabled={!host} type="number" min="1" max="100" placeholder={[5, 10, 20].includes(s.rounds) ? 'مخصص' : s.rounds} value={custom} onChange={e => { setCustom(e.target.value); if (+e.target.value > 0) set({ rounds: +e.target.value }); }} /></div></label>
      <label>وقت السؤال: {s.time} ث<input type="range" min="5" max="60" disabled={!host} value={s.time} onChange={e => set({ time: +e.target.value })} /></label>
      <label>وقت التخمين: {s.guessTime} ث<input type="range" min="3" max="20" disabled={!host} value={s.guessTime} onChange={e => set({ guessTime: +e.target.value })} /></label>
      <label>أقصى عدد لاعبين: {s.maxPlayers}<input type="range" min="2" max="30" disabled={!host} value={s.maxPlayers} onChange={e => set({ maxPlayers: +e.target.value })} /></label>
      <label className="chk"><input type="checkbox" disabled={!host} checked={s.speedBonus} onChange={e => set({ speedBonus: e.target.checked })} /> مكافأة السرعة</label>
      <div className="row">
        {host ? <button className="btn pri" disabled={!everyoneReady} onClick={() => socket.emit('game:start', r => r?.error && say(r.error))}>{everyoneReady ? 'ابدأ اللعبة' : 'بانتظار جاهزية الجميع'}</button>
          : <button className={'btn ' + (mine?.ready ? '' : 'pri')} onClick={() => socket.emit('player:ready', !mine?.ready)}>{mine?.ready ? 'إلغاء الجاهزية' : 'أنا جاهز'}</button>}
        <button className="btn" onClick={leave}>مغادرة</button></div></div>
  </section>;
}

function Play({ room, me, g }) {
  const [txt, setTxt] = useState('');
  const total = room.settings.time * 1000;
  const left = useCountdown(g.phase === 'open' || g.phase === 'guess' ? g.remainingMs : 0, g.key);
  const gl = useCountdown(g.phase === 'guess' ? g.buzzer.guessMs : 0, g.gkey);
  const iAmBuzzer = g.buzzer?.playerId === me, locked = g.locked.includes(me);
  const inp = useRef(null);
  useEffect(() => { if (iAmBuzzer) { setTxt(''); inp.current?.focus(); } }, [iAmBuzzer, g.gkey]);
  const lb = g.reveal?.board || [...room.players].sort((a, b) => b.score - a.score);
  const submit = e => { e.preventDefault(); if (txt.trim()) { socket.emit('answer', txt); setTxt(''); } };
  return <section className="play fade">
    <div className="top glass"><span>جولة {g.index} / {g.total}</span><span className="pill">{ANIMES[g.anime]} · {DIFF[g.difficulty]}</span></div>
    <Bar left={g.phase === 'reveal' ? 0 : left} total={total} />
    <div className="frame glass"><img key={g.key} src={g.image} alt="فريم الشخصية" referrerPolicy="no-referrer" draggable="false" /></div>
    {g.phase === 'open' && <button className="buzz" disabled={locked} onClick={() => socket.emit('buzz')}>{locked ? 'أخطأت — انتظر' : 'أجاوب!'}</button>}
    {g.phase === 'guess' && <div className="glass guess">
      <div className="who">🔔 <b>{g.buzzer.name}</b> حصل على الفرصة</div><Bar left={gl} total={g.buzzer.guessMs} cls="g" />
      {iAmBuzzer ? <form onSubmit={submit}><input ref={inp} className="in" placeholder="اكتب اسم الشخصية (عربي/English)" value={txt} onChange={e => setTxt(e.target.value)} autoComplete="off" /><button className="btn pri">إرسال</button></form> : <div className="muted">بانتظار إجابته…</div>}</div>}
    {g.phase === 'reveal' && <div className={'glass guess reveal ' + (g.reveal.winnerId ? 'good' : 'bad')}>
      <div className="muted">{g.reveal.winnerId ? `أجاب ${room.players.find(p => p.id === g.reveal.winnerId)?.name ?? ''} بشكل صحيح` : 'لم يجب أحد بشكل صحيح'}</div>
      <div className="ans">{g.reveal.answer.ar} <small dir="ltr">{g.reveal.answer.en}</small></div></div>}
    <ol className="lb glass">{lb.map((p, i) => <li key={p.id} className={p.id === me ? 'me' : ''}><span>{i + 1}</span><Av p={p} /><b>{p.name}</b><em>{p.score}</em></li>)}</ol>
  </section>;
}

function Results({ f, room, me, leave }) {
  const host = room.host === me;
  const confetti = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ l: Math.random() * 100, d: Math.random() * 2, c: ['#a78bfa', '#60a5fa', '#f0abfc', '#fff'][i % 4] })), []);
  const w = f.board.find(p => f.winners.includes(p.id));
  return <section className="center fade results">
    {confetti.map((c, i) => <i key={i} className="cf" style={{ left: c.l + '%', animationDelay: c.d + 's', background: c.c }} />)}
    <div className="trophy">🏆</div><h2>{w ? `الفائز: ${w.name}` : 'انتهت المباراة'}</h2>
    <ol className="podium">{f.board.map((p, i) => <li key={p.id} className={'glass pod p' + i}><span className="rank">{i + 1}</span><Av p={p} big /><b>{p.name}</b><em>{p.score} نقطة</em></li>)}</ol>
    <div className="row">{host ? <button className="btn pri" onClick={() => socket.emit('room:rematch')}>إعادة المباراة</button> : <span className="muted">بانتظار المضيف لإعادة المباراة…</span>}<button className="btn" onClick={leave}>مغادرة</button></div>
  </section>;
}

function Admin({ back, say }) {
  const [chars, setChars] = useState([]), [key, setKey] = useState(sessionStorage.getItem('afq-key') || ''), [cid, setCid] = useState(''), [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false), [importResult, setImportResult] = useState(null);
  const load = () => fetch('/api/characters').then(r => r.json()).then(setChars).catch(() => say('تعذر تحميل الشخصيات'));
  useEffect(() => { load(); }, []);
  const add = async () => {
    sessionStorage.setItem('afq-key', key);
    const r = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ character_id: +cid, url }) });
    const j = await r.json(); if (!r.ok) return say(j.error); say('تمت إضافة الصورة'); setUrl(''); load();
  };
  const importAniList = async () => {
    if (!key.trim()) return say('أدخل مفتاح الإدارة أولًا');
    if (!window.confirm('سيتم جلب صور ملفات الشخصيات من AniList للأنميات الأربعة. هذه ليست لقطات من الحلقات. هل تريد المتابعة؟')) return;
    setBusy(true); setImportResult(null); sessionStorage.setItem('afq-key', key);
    try {
      const r = await fetch('/api/import/anilist', { method: 'POST', headers: { 'x-admin-key': key } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل الاستيراد');
      setImportResult(j); await load();
      if (j.addedImages > 0) say(`تم استيراد ${j.addedImages} صورة شخصية من AniList`);
      else say('اكتمل الاتصال، لكن لم تتم إضافة صور جديدة');
    } catch (e) { say(e.message || 'تعذر الاتصال بـ AniList'); }
    finally { setBusy(false); }
  };
  const total = chars.reduce((a, c) => a + c.images, 0);
  return <section className="center fade"><h2>إدارة الصور</h2>
    <div className="glass card">
      <p className="muted">إجمالي الصور: {total}. الشخصية بلا صور لا تظهر في اللعب.</p>
      <input className="in" type="password" placeholder="ADMIN_KEY" value={key} onChange={e => setKey(e.target.value)} />
      <div className="glass card" style={{ margin: '12px 0', padding: 16 }}>
        <h3>استيراد تلقائي من AniList</h3>
        <p className="muted">يجلب صور ملفات الشخصيات وأسماءها تلقائيًا للأنميات الأربعة. تنبيه: هذه صور شخصيات رسمية وليست لقطات من الحلقات.</p>
        <button className="btn pri" disabled={!key.trim() || busy} onClick={importAniList}>{busy ? 'جارٍ جلب الشخصيات والصور…' : 'جلب الشخصيات والصور تلقائيًا'}</button>
        {importResult && <div className="stats" style={{ marginTop: 12 }}>
          <div><b>{importResult.addedImages}</b>صور جديدة</div>
          <div><b>{importResult.addedCharacters}</b>شخصيات جديدة</div>
          <div><b>{importResult.totalImages}</b>إجمالي الصور</div>
          <div><b>{importResult.skipped}</b>تم تجاوزها</div>
          {importResult.errors?.length > 0 && <p className="muted">بعض المصادر لم تكتمل: {importResult.errors.map(x => `${ANIMES[x.anime]}: ${x.message}`).join(' — ')}</p>}
        </div>}
      </div>
      <h3>إضافة صورة يدويًا</h3>
      <select className="in" value={cid} onChange={e => setCid(e.target.value)}><option value="">اختر الشخصية</option>{chars.map(c => <option key={c.id} value={c.id}>{ANIMES[c.anime]} — {c.name_ar} / {c.name_en} ({DIFF[c.difficulty]}) [{c.images}]</option>)}</select>
      <input className="in" dir="ltr" placeholder="https://…/frame.jpg" value={url} onChange={e => setUrl(e.target.value)} />
      <div className="row"><button className="btn pri" disabled={!cid || !url || !key} onClick={add}>إضافة</button><button className="btn" onClick={back}>رجوع</button></div>
    </div>
  </section>;
}
