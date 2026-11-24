let ctx, muted = localStorage.getItem('afq-muted') === '1';
export const isMuted = () => muted;
export const setMuted = v => { muted = v; localStorage.setItem('afq-muted', v ? '1' : '0'); };
const tone = (f, d = .12, t = 'sine', v = .08, at = 0) => {
  if (muted) return; ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator(), g = ctx.createGain(), s = ctx.currentTime + at;
  o.type = t; o.frequency.value = f; g.gain.setValueAtTime(v, s); g.gain.exponentialRampToValueAtTime(.0001, s + d);
  o.connect(g).connect(ctx.destination); o.start(s); o.stop(s + d);
};
export const sfx = {
  click: () => tone(520, .06, 'triangle'),
  buzz: () => { tone(880, .12, 'square', .06); tone(1320, .15, 'square', .05, .08); },
  correct: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, .18, 'triangle', .09, i * .09)),
  wrong: () => { tone(220, .2, 'sawtooth', .07); tone(165, .3, 'sawtooth', .07, .15); },
  win: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, .22, 'triangle', .09, i * .11)),
};
