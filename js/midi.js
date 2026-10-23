// 极简 Standard MIDI File 解析器：把 .mid 转成 { notes, parts, beats }
// notes: [{ pitch, start(秒), dur(秒), vel, part }]
(function (global) {
  'use strict';

  function decodeText(bytes) {
    for (const enc of ['utf-8', 'gbk']) {
      try { return new TextDecoder(enc, { fatal: true }).decode(bytes).trim(); } catch (e) { /* 试下一个 */ }
    }
    return String.fromCharCode.apply(null, bytes).trim();
  }

  function parseMidi(buffer) {
    const b = new Uint8Array(buffer);
    let pos = -1;
    // 有些文件包了一层 RIFF (RMID)，直接找 MThd
    for (let i = 0; i < Math.min(b.length - 4, 4096); i++) {
      if (b[i] === 0x4d && b[i + 1] === 0x54 && b[i + 2] === 0x68 && b[i + 3] === 0x64) { pos = i; break; }
    }
    if (pos < 0) throw new Error('不是有效的 MIDI 文件');

    const u8 = () => b[pos++];
    const u16 = () => { const v = (b[pos] << 8) | b[pos + 1]; pos += 2; return v; };
    const u32 = () => { const v = ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0; pos += 4; return v; };
    const id4 = () => { const s = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]); pos += 4; return s; };
    const vlq = () => { let v = 0, c; do { c = b[pos++]; v = v * 128 + (c & 0x7f); } while ((c & 0x80) && pos < b.length); return v; };

    id4();
    const hlen = u32();
    const hstart = pos;
    u16(); // format
    const ntrks = u16();
    const division = u16();
    pos = hstart + hlen;

    let smpte = 0;
    if (division & 0x8000) smpte = (256 - (division >> 8)) * (division & 0xff);

    const tempos = [], sigs = [], names = [], raw = [];
    let maxTick = 0;

    for (let tr = 0; tr < ntrks && pos + 8 <= b.length;) {
      const cid = id4();
      const len = u32();
      const end = Math.min(b.length, pos + len);
      if (cid !== 'MTrk') { pos = end; continue; }

      let tick = 0, status = 0;
      const open = new Map();
      while (pos < end) {
        tick += vlq();
        let st = b[pos];
        if (st & 0x80) pos++;
        else if (status) st = status;
        else break;

        if (st === 0xff) {
          const type = u8();
          const l = vlq();
          const ds = pos;
          if (type === 0x51 && l >= 3) tempos.push({ tick, us: (b[ds] << 16) | (b[ds + 1] << 8) | b[ds + 2] });
          else if (type === 0x58 && l >= 2) sigs.push({ tick, num: b[ds] || 4, den: Math.pow(2, b[ds + 1]) });
          else if (type === 0x03 && !names[tr]) names[tr] = decodeText(b.subarray(ds, ds + l));
          pos = ds + l;
          if (type === 0x2f) break;
        } else if (st === 0xf0 || st === 0xf7) {
          pos += vlq();
        } else {
          status = st;
          const cmd = st & 0xf0, ch = st & 0x0f;
          if (cmd === 0x90 || cmd === 0x80) {
            const p = u8(), v = u8();
            const key = ch * 128 + p;
            if (cmd === 0x90 && v > 0) {
              const n = { tick, endTick: -1, pitch: p, vel: v, ch, trk: tr };
              raw.push(n);
              if (!open.has(key)) open.set(key, []);
              open.get(key).push(n);
            } else {
              const q = open.get(key);
              if (q && q.length) q.shift().endTick = tick;
            }
          } else if (cmd === 0xc0 || cmd === 0xd0) pos += 1;
          else pos += 2;
        }
      }
      pos = end;
      for (const q of open.values()) for (const n of q) n.endTick = tick;
      if (tick > maxTick) maxTick = tick;
      tr++;
    }

    // 速度表：tick -> 秒
    tempos.sort((x, y) => x.tick - y.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
    const segs = [];
    let sec = 0;
    for (let i = 0; i < tempos.length; i++) {
      if (i > 0) sec += (tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].us / 1e6 / division;
      segs.push({ tick: tempos[i].tick, sec, spt: tempos[i].us / 1e6 / division });
    }
    const toSec = smpte ? (t => t / smpte) : (t => {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].tick <= t) lo = m; else hi = m - 1; }
      const s = segs[lo];
      return s.sec + (t - s.tick) * s.spt;
    });

    // 声部 = 轨道 + 通道（跳过 10 通道打击乐）
    const partMap = new Map();
    const notes = [];
    for (const n of raw) {
      if (n.ch === 9) continue;
      const id = n.trk + ':' + n.ch;
      if (!partMap.has(id)) partMap.set(id, { id, trk: n.trk, ch: n.ch });
      const s = toSec(n.tick);
      const e = toSec(Math.max(n.endTick, n.tick));
      notes.push({ pitch: n.pitch, start: s, dur: Math.max(0.03, e - s), vel: n.vel, part: id });
    }
    const parts = [...partMap.values()].sort((x, y) => x.trk - y.trk || x.ch - y.ch);
    const perTrk = {};
    parts.forEach(p => { perTrk[p.trk] = (perTrk[p.trk] || 0) + 1; });
    parts.forEach(p => {
      p.name = (names[p.trk] || '轨道 ' + (p.trk + 1)) + (perTrk[p.trk] > 1 ? ' · 通道 ' + (p.ch + 1) : '');
    });

    // 节拍线
    const beats = [];
    if (!smpte) {
      sigs.sort((x, y) => x.tick - y.tick);
      if (!sigs.length || sigs[0].tick > 0) sigs.unshift({ tick: 0, num: 4, den: 4 });
      let tick = 0, si = 0;
      while (tick <= maxTick && beats.length < 50000) {
        while (si + 1 < sigs.length && sigs[si + 1].tick <= tick) si++;
        const sg = sigs[si];
        const beatTicks = division * 4 / sg.den;
        for (let k = 0; k < sg.num; k++) beats.push({ t: toSec(tick + k * beatTicks), down: k === 0 });
        tick += beatTicks * sg.num;
      }
    }

    return { notes, parts, beats };
  }

  global.PF_parseMidi = parseMidi;
})(window);
