// 曲子适配：和弦简化、整体移调、按段挪进小键盘音域。
// 输入音符需要带 hand（'R' / 'L'），返回新的音符和修改记录，原数组不变。
(function (global) {
  'use strict';

  const CHORD_EPS = 0.03; // 起音相差 30ms 以内算同一个和弦

  function adapt(input, beats, o) {
    let notes = input.map(n => Object.assign({}, n, { orig: n.pitch, moved: 0 }));
    const ghosts = [];  // 修改前的位置：{ pitch, start, dur, hand, kind: 'moved' | 'dropped' | 'simplified' }
    const changes = []; // 修改记录，供列表显示

    const bars = beats.filter(b => b.down).map(b => b.t);
    const barOf = t => {
      if (!bars.length) return Math.max(0, Math.floor(t / 2));
      let lo = 0, hi = bars.length - 1;
      if (t < bars[0]) return 0;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m] <= t + 1e-6) lo = m; else hi = m - 1; }
      return lo;
    };
    const barStart = i => bars.length ? bars[Math.min(i, bars.length - 1)] : i * 2;
    notes.forEach(n => { n.bar = barOf(n.start); });

    // 1. 简化：同一只手的和弦只保留几个音（右手留高音，左手留低音），每个起音点都保留，不降低密度
    if (o.simplify) {
      const removed = new Set();
      const tally = new Map();
      for (const hand of ['R', 'L']) {
        const hs = notes.filter(n => n.hand === hand);
        for (let i = 0; i < hs.length;) {
          let j = i + 1;
          while (j < hs.length && hs[j].start - hs[i].start <= CHORD_EPS) j++;
          if (j - i > o.chordMax) {
            const g = hs.slice(i, j).sort((a, b) => hand === 'R' ? b.pitch - a.pitch : a.pitch - b.pitch);
            for (const n of g.slice(o.chordMax)) {
              removed.add(n);
              ghosts.push({ pitch: n.pitch, start: n.start, dur: n.dur, hand, kind: 'simplified' });
              const key = n.bar + hand;
              tally.set(key, (tally.get(key) || { bar: n.bar, hand, count: 0 }));
              tally.get(key).count++;
            }
          }
          i = j;
        }
      }
      notes = notes.filter(n => !removed.has(n));
      tally.forEach(c => changes.push({ type: 'simplify', bar: c.bar, t: barStart(c.bar), hand: c.hand, count: c.count }));
    }

    let shift = 0;
    if (o.fit && notes.length) {
      // 2. 整体移调：选一个让最多音落进音域的移调量，平手时选移得少的
      const inRange = s => { let c = 0; for (const n of notes) if (n.pitch + s >= o.lo && n.pitch + s <= o.hi) c++; return c; };
      let best = -1;
      const cands = [];
      for (let s = -48; s <= 48; s++) if (!o.octaveOnly || s % 12 === 0) cands.push(s);
      cands.sort((a, b) => Math.abs(a) - Math.abs(b) || (a % 12 === 0 ? -1 : 1) - (b % 12 === 0 ? -1 : 1));
      for (const s of cands) { const c = inRange(s); if (c > best) { best = c; shift = s; } }
      if (shift) {
        notes.forEach(n => { n.pitch += shift; });
        ghosts.forEach(g => { g.pitch += shift; });
        changes.push({ type: 'transpose', bar: 0, t: barStart(0), shift });
      }

      // 3. 还超出音域的段（同一只手的一个小节）整段按八度挪进来，挪不进来就整段删掉
      const segs = new Map();
      for (const n of notes) {
        const key = n.bar + n.hand;
        if (!segs.has(key)) segs.set(key, []);
        segs.get(key).push(n);
      }
      const dropped = new Set();
      segs.forEach(seg => {
        let mn = 127, mx = 0;
        for (const n of seg) { mn = Math.min(mn, n.pitch); mx = Math.max(mx, n.pitch); }
        if (mn >= o.lo && mx <= o.hi) return;
        const { bar, hand } = seg[0];
        let k = null;
        for (let d = 1; d <= 8 && k == null; d++) {
          for (const kk of [d, -d]) {
            if (mn + kk * 12 >= o.lo && mx + kk * 12 <= o.hi) { k = kk; break; }
          }
        }
        if (k != null) {
          for (const n of seg) {
            ghosts.push({ pitch: n.pitch, start: n.start, dur: n.dur, hand, kind: 'moved' });
            n.pitch += k * 12;
            n.moved = k;
          }
          changes.push({ type: 'move', bar, t: barStart(bar), hand, count: seg.length, octaves: k });
        } else {
          for (const n of seg) {
            dropped.add(n);
            ghosts.push({ pitch: n.pitch, start: n.start, dur: n.dur, hand, kind: 'dropped' });
          }
          changes.push({ type: 'drop', bar, t: barStart(bar), hand, count: seg.length, span: [mn, mx] });
        }
      });
      notes = notes.filter(n => !dropped.has(n));

      // 挪动后可能和另一只手撞在同一个音上，合并成一个
      notes.sort((a, b) => a.pitch - b.pitch || a.start - b.start);
      const dup = new Set();
      const tally = new Map();
      for (let i = 1; i < notes.length; i++) {
        const a = notes[i - 1], b = notes[i];
        if (a.pitch === b.pitch && b.start - a.start < 0.02 && !dup.has(a)) {
          dup.add(b);
          tally.set(b.bar, (tally.get(b.bar) || 0) + 1);
        }
      }
      if (dup.size) {
        notes = notes.filter(n => !dup.has(n));
        tally.forEach((count, bar) => changes.push({ type: 'merge', bar, t: barStart(bar), count }));
      }
    }

    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    ghosts.sort((a, b) => a.start - b.start);
    changes.sort((a, b) => a.t - b.t || (a.type === 'transpose' ? -1 : 0));
    return { notes, ghosts, changes, shift };
  }

  global.PF_adapt = adapt;
})(window);
