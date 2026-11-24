// اختبار تكاملي حقيقي عبر HTTP وSocket.IO. بيانات الصور هنا اختبارية وتُضاف بقاعدة بيانات مؤقتة فقط.
// كل عميل يسجّل جميع الأحداث الواردة فور الاتصال (onAny) قبل إرسال أي حدث، والانتظار يتم على السجل فلا يضيع حدث.
process.env.DB_PATH = `/tmp/afq-test-${process.pid}-${Date.now()}.db`;
process.env.ADMIN_KEY = 'test-admin-key-123';
const { io: ioc } = await import('socket.io-client');
const { server } = await import('./index.js');
const { db, norm } = await import('./db.js');

await new Promise(r => server.listen(0, r));
const url = `http://localhost:${server.address().port}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (cond, msg) => { if (cond) { passed++; console.log('PASS ' + msg); } else { failed++; console.log('FAIL ' + msg); } return !!cond; };
const section = async (name, fn) => { console.log(`\n# ${name}`); try { await fn(); } catch (e) { failed++; console.log(`FAIL (${name}) استثناء: ${e.message}`); } };

function client(label) {
  const s = ioc(url, { forceNew: true, transports: ['websocket'], reconnection: false });
  s.label = label; s.log = []; s.onAny((e, d) => s.log.push({ e, d }));   // التسجيل قبل أي emit
  return s;
}
const connected = s => s.connected ? Promise.resolve() : new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
const until = async (s, ev, { pred = () => true, from = 0, timeout = 9000 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const x = s.log.slice(from).find(x => x.e === ev && pred(x.d)); if (x) return x.d;
    await wait(10);
  }
  throw new Error(`انتهت مهلة انتظار '${ev}' عند ${s.label}`);
};
const count = (s, ev, from = 0, pred = () => true) => s.log.slice(from).filter(x => x.e === ev && pred(x.d)).length;
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const marks = list => Object.fromEntries(list.map(s => [s.label, s.log.length]));
const post = (body, key) => fetch(`${url}/api/images`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key !== undefined ? { 'x-admin-key': key } : {}) }, body: JSON.stringify(body) });

const TEST = ['Naruto Uzumaki', 'Goku', 'Monkey D. Luffy'].map(n => db.prepare('SELECT * FROM characters WHERE name_en=?').get(n));
const imgChar = u => db.prepare('SELECT c.* FROM images i JOIN characters c ON c.id=i.character_id WHERE i.url=?').get(u);
const aliasesOf = id => db.prepare('SELECT alias FROM aliases WHERE character_id=?').all(id).map(x => x.alias);

await section('لوحة الإدارة: لا إضافة بدون ADMIN_KEY صحيح', async () => {
  const body = { character_id: TEST[0].id, url: 'https://test.invalid/x.jpg' };
  check((await post(body)).status === 401, 'بدون مفتاح → 401');
  check((await post(body, 'wrong-key')).status === 401, 'مفتاح خاطئ → 401');
  check(db.prepare('SELECT COUNT(*) c FROM images').get().c === 0, 'لم تُحفظ أي صورة بعد المحاولات المرفوضة');
  check((await post({ character_id: TEST[0].id, url: 'javascript:alert(1)' }, process.env.ADMIN_KEY)).status === 400, 'رابط غير https/http → 400');
  check((await post({ character_id: 999999, url: 'https://test.invalid/y.jpg' }, process.env.ADMIN_KEY)).status === 400, 'شخصية غير موجودة → 400');
  for (const [i, c] of TEST.entries()) check((await post({ character_id: c.id, url: `https://test.invalid/${i}.jpg` }, process.env.ADMIN_KEY)).status === 200, `إضافة صورة اختبارية للشخصية ${c.name_en} بمفتاح صحيح → 200`);
  check((await post({ character_id: TEST[0].id, url: 'https://test.invalid/0.jpg' }, process.env.ADMIN_KEY)).status === 409, 'رابط مكرر → 409');
});

const [A, B, C, D, E] = ['Host', 'Ali', 'Sara', 'Dan', 'Eve'].map(client); A.label = 'A'; B.label = 'B'; C.label = 'C'; D.label = 'D'; E.label = 'E';
await Promise.all([A, B, C, D, E].map(connected));
const sockets = [A, B, C], byId = id => sockets.find(s => s.id === id);

await section('الغرف: الإنشاء والانضمام والطرد والانقطاع', async () => {
  const cr = await emit(A, 'room:create', { name: 'Host', avatar: '🦊' });
  check(/^[A-Z0-9]{5}$/.test(cr.code), 'إنشاء غرفة بكود من 5 أحرف'); globalThis.CODE = cr.code;
  check((await emit(B, 'room:join', { code: cr.code, name: 'Ali' })).ok, 'انضمام بالكود');
  check((await emit(C, 'room:join', { code: 'ZZZZZ', name: 'X' })).error, 'رفض كود غير موجود');
  check((await emit(C, 'room:join', { code: cr.code, name: 'ali' })).error, 'رفض اسم مكرر');
  check((await emit(C, 'room:join', { code: cr.code, name: 'Sara' })).ok, 'انضمام لاعب ثالث');
  // الطرد
  await emit(D, 'room:join', { code: cr.code, name: 'Dan' });
  const mA = A.log.length; A.emit('room:kick', D.id);
  await until(D, 'kicked'); check(true, 'اللاعب المطرود يستقبل kicked');
  const left = await until(A, 'player:left', { from: mA }); check(left.name === 'Dan' && left.reason === 'kicked', 'الآخرون يُبلَّغون بالطرد');
  const mD = D.log.length; D.emit('buzz'); D.emit('player:ready', true); await wait(150);
  check(count(D, 'room', mD) === 0, 'المطرود لا يستطيع التأثير على الغرفة');
  const mB = B.log.length; B.emit('room:kick', A.id); await wait(200);
  const rNow = [...A.log].reverse().find(x => x.e === 'room').d;
  check(count(A, 'kicked') === 0 && rNow.players.some(p => p.name === 'Host'), 'غير المضيف لا يستطيع طرد المضيف');
  // الانقطاع
  await emit(E, 'room:join', { code: cr.code, name: 'Eve' });
  const mA2 = A.log.length; E.disconnect();
  const dl = await until(A, 'player:left', { from: mA2 }); check(dl.name === 'Eve' && dl.reason === 'disconnected', 'انقطاع لاعب يُبلَّغ به الجميع');
  await wait(100);
  const room = [...A.log].reverse().find(x => x.e === 'room').d;
  check(room.players.length === 3 && room.players.map(p => p.name).sort().join() === 'Ali,Host,Sara', 'قائمة اللاعبين محدّثة بعد الطرد والانقطاع');
});

const CODE = globalThis.CODE;
const R = {}; // نتائج الجولات
await section('اللعبة الكاملة: Buzzer المتزامن، الإجابات، المؤقتات، النتائج', async () => {
  check((await emit(A, 'game:start')).error, 'منع البدء قبل جاهزية الجميع');
  A.emit('room:settings', { rounds: 3, time: 5, guessTime: 3, animes: ['naruto', 'dragonball', 'onepiece'] });
  B.emit('player:ready', true); C.emit('player:ready', true);
  await until(A, 'room', { pred: r => r.players.every(p => p.ready) && r.settings.rounds === 3 });
  const m0 = marks(sockets); const t = Date.now();
  check((await emit(A, 'game:start')).ok, 'بدء اللعبة');
  const rs1 = await until(A, 'round:start', { from: m0.A });
  const q1 = imgChar(rs1.image); R.urls = [rs1.image];
  check(q1 && !JSON.stringify(rs1).includes(q1.name_en) && !JSON.stringify(rs1).includes(q1.name_ar), 'حدث round:start لا يسرّب الإجابة');

  // ===== الجولة 1: ضغط متزامن من 3 لاعبين =====
  const m1 = marks(sockets);
  for (const s of sockets) s.emit('buzz');            // نفس اللحظة
  await until(A, 'buzz:won', { from: m1.A }); await wait(400);
  const won = sockets.map(s => count(s, 'buzz:won', m1[s.label]));
  const ids = new Set(sockets.map(s => s.log.slice(m1[s.label]).find(x => x.e === 'buzz:won')?.d.playerId));
  check(won.every(n => n === 1) && ids.size === 1, 'ضغط متزامن (3 لاعبين): حدث فوز واحد فقط، وكل الأجهزة ترى الفائز نفسه');
  const W = byId([...ids][0]);
  check(sockets.reduce((n, s) => n + count(s, 'buzz:denied', m1[s.label]), 0) === 2 && count(W, 'buzz:denied', m1[W.label]) === 0, 'اللاعبان الآخران رُفض ضغطهما فورًا، والفائز لم يُرفض');
  // إجابة خاطئة = اسم شخصية أخرى حقيقية من قاعدة البيانات
  const otherChar = TEST.find(c => c.id !== q1.id);
  W.emit('answer', otherChar.name_en);
  await until(A, 'buzz:wrong', { from: m1.A, pred: d => d.playerId === W.id });
  await until(B, 'buzz:open', { from: m1[B.label] }); await until(C, 'buzz:open', { from: m1[C.label] });
  check(true, 'إجابة خاطئة (اسم شخصية أخرى) تُرفض ويُعاد فتح الزر لدى الجميع');
  const m1b = marks(sockets); W.emit('buzz'); await until(W, 'buzz:denied', { from: m1b[W.label] });
  check(true, 'المخطئ لا يستطيع الضغط ثانية في نفس السؤال');
  const X = sockets.find(s => s !== W); X.emit('buzz');
  const w2 = await until(A, 'buzz:won', { from: m1b.A, pred: d => d.playerId === X.id });
  check(w2.name && w2.guessMs === 3000, 'لاعب آخر يحصل على الفرصة مباشرة بعد التحرير مع وقت التخمين المضبوط');
  // إجابة صحيحة: نقرأ الشخصية المختارة فعلًا من الصورة ونُرسل اسمها العربي
  const acc = aliasesOf(q1.id); check(acc.includes(norm(q1.name_ar)) && acc.includes(norm(q1.name_en)), `الشخصية المختارة (${q1.name_en}) لها إجابات مقبولة عربية وإنجليزية في قاعدة البيانات`);
  X.emit('answer', q1.name_ar);
  const cor = await until(A, 'answer:correct', { from: m1.A });
  check(cor.playerId === X.id && cor.points >= 100 && cor.points <= 150, `إجابة صحيحة بالعربية (${q1.name_ar}) تمنح 100 + مكافأة سرعة (${cor.points})`);
  const rv1 = await until(A, 'round:reveal', { from: m1.A });
  check(rv1.winnerId === X.id && rv1.answer.en === q1.name_en && rv1.answer.ar === q1.name_ar, 'كشف الإجابة الصحيحة يطابق الشخصية في قاعدة البيانات');
  check(rv1.board.find(p => p.id === X.id).score === cor.points && rv1.board.find(p => p.id === W.id).score === 0, 'النقاط: الفائز بالنقاط، والمخطئ صفر');
  R.winner = X.id; R.points = cor.points;

  // ===== الجولة 2: انتهاء الوقت بلا ضغط =====
  const rs2 = await until(A, 'round:start', { from: m1.A, pred: d => d.index === 2 }); R.urls.push(rs2.image);
  const q2 = imgChar(rs2.image);
  const rv2 = await until(A, 'round:reveal', { from: m1.A, pred: d => d.board && d.winnerId === null, timeout: 8000 });
  check(rv2.answer.en === q2.name_en, 'انتهاء الوقت: تُكشف الإجابة الصحيحة بلا فائز');

  // ===== الجولة 3: ضغط متزامن، خطأ، ضغط متزامن ثانٍ، ثم انتهاء وقت التخمين =====
  const rs3 = await until(A, 'round:start', { from: m1.A, pred: d => d.index === 3 }); R.urls.push(rs3.image);
  check(new Set(R.urls).size === 3, 'لا تكرار للفريمات في المباراة');
  const q3 = imgChar(rs3.image), wrongName = TEST.find(c => c.id !== q3.id).name_en;
  const m3 = marks(sockets); for (const s of sockets) s.emit('buzz');
  await until(A, 'buzz:won', { from: m3.A }); await wait(300);
  const w1 = byId(A.log.slice(m3.A).find(x => x.e === 'buzz:won').d.playerId); w1.emit('answer', wrongName);
  await until(A, 'buzz:open', { from: m3.A });
  const m3b = marks(sockets); for (const s of sockets) s.emit('buzz');   // ضغط متزامن ثانٍ (الأول ممنوع)
  await until(A, 'buzz:won', { from: m3b.A }); await wait(300);
  const wonB = sockets.map(s => count(s, 'buzz:won', m3b[s.label]));
  const w2b = byId(A.log.slice(m3b.A).find(x => x.e === 'buzz:won').d.playerId);
  check(wonB.every(n => n === 1) && w2b !== w1 && count(w1, 'buzz:denied', m3b[w1.label]) === 1, 'ضغط متزامن ثانٍ: فائز واحد جديد، والمخطئ السابق ممنوع');
  w2b.emit('answer', wrongName); await until(A, 'buzz:open', { from: m3b.A });
  const w3 = sockets.find(s => s !== w1 && s !== w2b), m3c = marks(sockets), tb = Date.now();
  w3.emit('buzz'); await until(A, 'buzz:won', { from: m3c.A, pred: d => d.playerId === w3.id });
  await until(A, 'buzz:wrong', { from: m3c.A, pred: d => d.playerId === w3.id, timeout: 5000 });
  const el = Date.now() - tb;
  check(el >= 2800 && el < 4500, `انتهاء وقت التخمين (3ث) يُسقط المحاولة تلقائيًا (${el}ms)`);
  const rv3 = await until(A, 'round:reveal', { from: m3c.A, timeout: 2000 });
  check(rv3.winnerId === null && rv3.answer.en === q3.name_en && rv3.last === true, 'بعد استنفاد كل اللاعبين تُكشف الإجابة فورًا (دون انتظار نهاية الوقت)');

  // ===== النتائج النهائية =====
  const fin = await until(A, 'game:finished', { from: m1.A, timeout: 8000 });
  check(fin.board.length === 3 && fin.winners.length === 1 && fin.winners[0] === R.winner && fin.board[0].score === R.points, 'النتيجة النهائية: الفائز الصحيح والنقاط الصحيحة');
  check(sockets.every(s => count(s, 'game:finished', m1[s.label]) === 1), 'شاشة النتائج تصل لجميع اللاعبين');
  const prof = db.prepare('SELECT * FROM profiles').all();
  check(prof.length === 3 && prof.find(p => p.name === byName(R.winner)).wins === 1 && prof.every(p => p.games === 1), 'حفظ إحصائيات الملف الشخصي (مباريات/انتصارات)');
  function byName(id) { return fin.board.find(p => p.id === id).name; }
  // إعادة المباراة
  const mr = marks(sockets); A.emit('room:rematch');
  const room = await until(B, 'room', { from: mr.B, pred: r => r.state === 'lobby' });
  check(room.players.length === 3 && room.players.every(p => p.score === 0), 'إعادة المباراة بنفس اللاعبين وبنقاط مصفّرة');
  check(Date.now() - t < 60000, 'زمن الاختبار الكلي معقول');
});

console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
process.exit(failed ? 1 : 0);
