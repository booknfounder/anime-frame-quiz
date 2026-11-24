import { useEffect, useRef } from 'react';
// خلفية Canvas خفيفة: عدد جزيئات صغير، تتوقف عند إخفاء التبويب، وتحترم reduced-motion
export default function Background() {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current, cx = cv.getContext('2d');
    const small = matchMedia('(max-width:900px)').matches, N = small ? 36 : 70;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w, h, raf, ptr = { x: -999, y: -999 };
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const resize = () => { w = innerWidth; h = innerHeight; cv.width = w * dpr; cv.height = h * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize(); addEventListener('resize', resize);
    const P = Array.from({ length: N }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3, r: 1 + Math.random() * 2.2, c: Math.random() < .5 ? '167,139,250' : '96,165,250' }));
    const move = e => { const t = e.touches?.[0] || e; ptr = { x: t.clientX, y: t.clientY }; };
    addEventListener('pointermove', move); addEventListener('touchmove', move, { passive: true });
    const draw = () => {
      cx.clearRect(0, 0, w, h);
      const g1 = cx.createRadialGradient(w * .2, h * .15, 0, w * .2, h * .15, w * .6); g1.addColorStop(0, 'rgba(124,58,237,.22)'); g1.addColorStop(1, 'transparent');
      const g2 = cx.createRadialGradient(w * .85, h * .85, 0, w * .85, h * .85, w * .6); g2.addColorStop(0, 'rgba(37,99,235,.20)'); g2.addColorStop(1, 'transparent');
      cx.fillStyle = g1; cx.fillRect(0, 0, w, h); cx.fillStyle = g2; cx.fillRect(0, 0, w, h);
      for (const p of P) {
        const dx = p.x - ptr.x, dy = p.y - ptr.y, d2 = dx * dx + dy * dy;
        if (d2 < 22500) { const d = Math.sqrt(d2) || 1; p.vx += dx / d * .06; p.vy += dy / d * .06; }
        p.vx *= .985; p.vy *= .985; if (!reduce) { p.x += p.vx; p.y += p.vy; }
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0; if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        cx.beginPath(); cx.fillStyle = `rgba(${p.c},.7)`; cx.arc(p.x, p.y, p.r, 0, 6.283); cx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden) draw(); };
    document.addEventListener('visibilitychange', vis); draw();
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); removeEventListener('pointermove', move); removeEventListener('touchmove', move); document.removeEventListener('visibilitychange', vis); };
  }, []);
  return <canvas ref={ref} className="bg" />;
}
