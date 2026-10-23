// Piano Fall 主程序：曲库、下落渲染、MIDI 输入、等待 / 跟弹判定
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SOLFEGE = ['do', 'do#', 're', 're#', 'mi', 'fa', 'fa#', 'sol', 'sol#', 'la', 'la#', 'si'];
  const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const isBlack = p => BLACK[p % 12] === 1;
  const noteName = p => NAMES[p % 12] + (Math.floor(p / 12) - 1);
  const COLORS = {
    R: { w: '#4da3ff', b: '#2c78cf' },
    L: { w: '#ff9f43', b: '#d6781c' },
    X: { w: '#4a5263', b: '#3a4150' },
  };
  const RANGES = { 49: [36, 84], 61: [36, 96], 76: [28, 103], 88: [21, 108] };
  const PERFECT = 0.08, GOOD = 0.2; // 跟弹判定窗口（真实秒）
  const EARLY = 0.35;               // 等待模式允许提前按下（真实秒）
  const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };

  // ---------- 本地存储 ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pf:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pf:' + k, JSON.stringify(v)); } catch (e) { /* 隐私模式等 */ } },
  };

  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('pianofall', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
        r.onsuccess = () => res(this.db = r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('songs', mode);
        const req = fn(tx.objectStore('songs'));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      });
    },
    all() { return this.run('readonly', s => s.getAll()).catch(() => []); },
    get(id) { return this.run('readonly', s => s.get(id)); },
    put(rec) { return this.run('readwrite', s => s.put(rec)); },
    del(id) { return this.run('readwrite', s => s.delete(id)); },
  };

  const settings = Object.assign({
    speed: 0.6, mode: 'wait', hands: 'both', lookahead: 2.5, labels: 'name', range: 'auto',
    accomp: true, mySound: false, metronome: false, volume: 0.7, octave: 4,
  }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ---------- 状态 ----------
  const S = {
    song: null, songId: null, partHands: {},
    notes: [], active: [],
    t: 0, playing: false, waiting: false, finished: false,
    playIdx: 0, waitIdx: 0, missIdx: 0, beatIdx: 0,
    pressed: new Set(), voices: new Map(), wrongFlash: new Map(), popups: [],
    stats: null, loopA: null, loopB: null, seeking: false,
  };
  const synth = new PF_Synth();
  synth.setVolume(settings.volume);

  const resetStats = () => { S.stats = { perfect: 0, good: 0, hit: 0, miss: 0, wrong: 0, combo: 0, maxCombo: 0 }; };
  resetStats();

  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].start < t) lo = m + 1; else hi = m; }
    return lo;
  }
  function lowerBoundBeat(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; }
    return lo;
  }

  // ---------- 曲子 ----------
  function finalize(song) {
    song.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const info = {};
    let dur = 0, maxDur = 0;
    for (const n of song.notes) {
      dur = Math.max(dur, n.start + n.dur);
      maxDur = Math.max(maxDur, n.dur);
      const i = info[n.part] || (info[n.part] = { count: 0, sum: 0 });
      i.count++; i.sum += n.pitch;
    }
    song.parts.forEach(p => {
      const i = info[p.id] || { count: 0, sum: 0 };
      p.count = i.count;
      p.avgPitch = i.count ? i.sum / i.count : 60;
    });
    song.parts = song.parts.filter(p => p.count > 0);
    song.duration = dur;
    song.maxDur = maxDur;
    return song;
  }

  function defaultHands(song) {
    if (song.defaultHands) return Object.assign({}, song.defaultHands);
    const ps = song.parts, h = {};
    if (ps.length === 1) h[ps[0].id] = 'split';
    else if (ps.length === 2) {
      const hi = ps[0].avgPitch >= ps[1].avgPitch ? 0 : 1;
      h[ps[hi].id] = 'R';
      h[ps[1 - hi].id] = 'L';
    } else ps.forEach(p => { h[p.id] = p.avgPitch >= 60 ? 'R' : 'L'; });
    return h;
  }

  function setSong(song, id, title) {
    S.song = finalize(song);
    S.song.title = title;
    S.songId = id;
    S.partHands = Object.assign(defaultHands(S.song), store.get('hands:' + id, {}));
    S.loopA = S.loopB = null;
    store.set('lastSong', id);
    renderTracks();
    applyHands();
    restart();
    updateLoopBand();
    $('#timeTotal').textContent = fmtTime(S.song.duration);
    $('#seek').max = S.song.duration.toFixed(2);
    $('#songSelect').value = id;
    $('#deleteSong').disabled = !id.startsWith('user:');
  }

  // 根据左右手设置重建可见音符
  function applyHands() {
    if (!S.song) return;
    const notes = [];
    for (const n of S.song.notes) {
      const ph = S.partHands[n.part] || 'R';
      if (ph === 'off') continue;
      const hand = ph === 'split' ? (n.pitch >= 60 ? 'R' : 'L') : ph;
      notes.push({ pitch: n.pitch, start: n.start, dur: n.dur, vel: n.vel, hand, state: 0, active: false });
    }
    for (const n of notes) n.active = settings.hands === 'both' || n.hand === settings.hands;
    S.notes = notes;
    S.active = notes.filter(n => n.active);
    computeRange();
    seek(S.t);
  }

  function startTime() {
    if (S.loopA != null) return S.loopA - 1.5 * settings.speed;
    const first = S.notes.length ? S.notes[0].start : 0;
    return Math.min(0, first - Math.min(settings.lookahead, 2.5) * settings.speed);
  }

  function restart() {
    resetStats();
    S.finished = false;
    S.notes.forEach(n => { n.state = 0; });
    S.popups = [];
    seek(startTime());
    hideSummary();
  }

  function seek(t) {
    if (!S.song) return;
    S.t = t;
    for (const n of S.notes) {
      if (n.start < t) { if (n.state === 0) n.state = 3; } else n.state = 0;
    }
    S.playIdx = lowerBound(S.notes, t);
    S.waitIdx = S.missIdx = lowerBound(S.active, t);
    S.beatIdx = lowerBoundBeat(S.song.beats, t);
    synth.stopAll();
  }

  // ---------- 播放 ----------
  function play() {
    if (!S.song) return;
    synth.ensure();
    if (S.finished) restart();
    S.playing = true;
    updatePlayBtn();
  }
  function pause() {
    S.playing = false;
    synth.stopAll();
    updatePlayBtn();
  }
  const toggle = () => (S.playing ? pause() : play());

  function advanceWaitIdx() {
    while (S.waitIdx < S.active.length && S.active[S.waitIdx].state !== 0) S.waitIdx++;
  }

  function update(dt) {
    if (!S.playing || !S.song) return;
    const sp = settings.speed;
    let nt = S.t + dt * sp;
    S.waiting = false;
    if (settings.mode === 'wait') {
      advanceWaitIdx();
      const n = S.active[S.waitIdx];
      if (n && nt >= n.start) { nt = Math.max(S.t, n.start); S.waiting = true; }
    }

    // 触发伴奏 / 演示音
    const notes = S.notes;
    while (S.playIdx < notes.length && notes[S.playIdx].start < nt) {
      const n = notes[S.playIdx++];
      if (n.start < S.t - 0.05) continue;
      const audible = settings.mode === 'demo' || (!n.active && settings.accomp);
      if (audible) synth.play(n.pitch, n.dur / sp, n.vel / 127);
    }
    // 节拍器
    const beats = S.song.beats;
    while (S.beatIdx < beats.length && beats[S.beatIdx].t < nt) {
      const b = beats[S.beatIdx++];
      if (settings.metronome && b.t >= S.t - 0.05) synth.click(b.down);
    }
    // 跟弹模式：漏掉的音
    if (settings.mode === 'play') {
      const lim = nt - GOOD * sp;
      while (S.missIdx < S.active.length && S.active[S.missIdx].start < lim) {
        const n = S.active[S.missIdx++];
        if (n.state === 0) {
          n.state = 2;
          S.stats.miss++;
          S.stats.combo = 0;
          popup('Miss', n.pitch, '#ff5c5c');
        }
      }
    }

    S.t = nt;
    if (S.loopA != null && S.loopB != null && S.t >= S.loopB) {
      seek(S.loopA - 1.5 * sp);
      return;
    }
    if (S.t > S.song.duration + 1) finish();
  }

  function finish() {
    pause();
    S.finished = true;
    const st = S.stats;
    const acc = accuracy();
    const key = 'best:' + S.songId + ':' + settings.mode + ':' + settings.hands;
    const prev = store.get(key, null);
    const isBest = acc != null && (!prev || acc > prev.acc || (acc === prev.acc && settings.speed > prev.speed));
    if (isBest) store.set(key, { acc, speed: settings.speed, at: Date.now() });
    const rows = [
      ['模式', modeLabel() + ' · ' + handLabel() + ' · ' + Math.round(settings.speed * 100) + '%'],
    ];
    if (settings.mode === 'play') {
      rows.push(['Perfect', st.perfect], ['Good', st.good], ['Miss', st.miss]);
    } else if (settings.mode === 'wait') {
      rows.push(['按对', st.hit]);
    }
    if (settings.mode !== 'demo') {
      rows.push(['按错', st.wrong], ['最大连击', st.maxCombo], ['准确率', acc == null ? '-' : acc + '%']);
      if (prev && !isBest) rows.push(['历史最佳', prev.acc + '% @ ' + Math.round(prev.speed * 100) + '%']);
      if (isBest) rows.push(['', '🎉 新纪录']);
    }
    $('#summaryBody').innerHTML = '<div class="stat-grid">' +
      rows.map(r => `<span class="k">${r[0]}</span><span>${r[1]}</span>`).join('') + '</div>';
    $('#summary').classList.remove('hidden');
  }
  function hideSummary() { $('#summary').classList.add('hidden'); }

  function accuracy() {
    const st = S.stats;
    if (settings.mode === 'play') {
      const tot = st.perfect + st.good + st.miss + st.wrong;
      return tot ? Math.round((st.perfect + st.good * 0.7) / tot * 1000) / 10 : null;
    }
    if (settings.mode === 'wait') {
      const tot = st.hit + st.wrong;
      return tot ? Math.round(st.hit / tot * 1000) / 10 : null;
    }
    return null;
  }

  // ---------- 输入判定 ----------
  function noteOn(p, vel) {
    if (S.pressed.has(p)) return;
    S.pressed.add(p);
    if (settings.mySound) S.voices.set(p, synth.start(p, vel / 127));
    if (!S.song || settings.mode === 'demo') return;
    if (!S.playing) {
      // 手在琴上时，按任意键即可开始
      if (!S.finished) play();
      return;
    }
    const sp = settings.speed;
    const a = S.active;
    if (settings.mode === 'wait') {
      advanceWaitIdx();
      for (let i = S.waitIdx; i < a.length && a[i].start <= S.t + EARLY * sp; i++) {
        if (a[i].state === 0 && a[i].pitch === p) {
          a[i].state = 1;
          S.stats.hit++;
          bumpCombo();
          popup('✓', p, '#3ddc84');
          return;
        }
      }
    } else {
      const win = GOOD * sp;
      let best = null, bd = Infinity;
      for (let i = lowerBound(a, S.t - win); i < a.length && a[i].start <= S.t + win; i++) {
        const n = a[i];
        if (n.state !== 0 || n.pitch !== p) continue;
        const d = Math.abs(n.start - S.t);
        if (d < bd) { bd = d; best = n; }
      }
      if (best) {
        best.state = 1;
        if (bd / sp <= PERFECT) { S.stats.perfect++; popup('Perfect', p, '#7fd4ff'); }
        else { S.stats.good++; popup('Good', p, '#3ddc84'); }
        bumpCombo();
        return;
      }
    }
    S.stats.wrong++;
    S.wrongFlash.set(p, performance.now());
  }

  function noteOff(p) {
    S.pressed.delete(p);
    const v = S.voices.get(p);
    if (v) { synth.stop(v); S.voices.delete(p); }
  }

  function bumpCombo() {
    S.stats.combo++;
    S.stats.maxCombo = Math.max(S.stats.maxCombo, S.stats.combo);
  }

  function popup(text, pitch, color) {
    S.popups.push({ text, pitch, color, at: performance.now() });
    if (S.popups.length > 40) S.popups.shift();
  }

  // ---------- Web MIDI ----------
  let midiAccess = null;
  async function initMidi() {
    const el = $('#midiStatus');
    if (!navigator.requestMIDIAccess) {
      el.textContent = 'MIDI：浏览器不支持，请用 Chrome / Edge';
      return;
    }
    try {
      midiAccess = await navigator.requestMIDIAccess();
      midiAccess.onstatechange = bindMidi;
      bindMidi();
    } catch (e) {
      el.textContent = 'MIDI：未授权（点此重试）';
      el.classList.remove('ok');
    }
  }
  function bindMidi() {
    const el = $('#midiStatus');
    const names = [];
    midiAccess.inputs.forEach(input => {
      input.onmidimessage = onMidiMessage;
      if (input.state !== 'disconnected') names.push(input.name);
    });
    if (names.length) {
      el.textContent = '🎹 ' + names.join(', ');
      el.classList.add('ok');
    } else {
      el.textContent = 'MIDI：未发现设备，接上琴后点此刷新';
      el.classList.remove('ok');
    }
  }
  function onMidiMessage(e) {
    const [st, d1, d2] = e.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) noteOn(d1, d2);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
  }

  // ---------- 画布 ----------
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const view = { w: 0, h: 0, dpr: 1, kbH: 120 };
  const geo = { lo: 21, hi: 108, x: new Float32Array(128), w: new Float32Array(128) };

  function resize() {
    const r = $('#stage').getBoundingClientRect();
    view.dpr = window.devicePixelRatio || 1;
    view.w = r.width;
    view.h = r.height;
    view.kbH = Math.round(Math.min(170, Math.max(80, r.height * 0.2)));
    canvas.width = Math.round(r.width * view.dpr);
    canvas.height = Math.round(r.height * view.dpr);
    computeRange();
  }

  function computeRange() {
    let lo, hi;
    if (settings.range !== 'auto' && RANGES[settings.range]) {
      [lo, hi] = RANGES[settings.range];
    } else if (S.notes.length) {
      let mn = 127, mx = 0;
      for (const n of S.notes) { if (n.pitch < mn) mn = n.pitch; if (n.pitch > mx) mx = n.pitch; }
      lo = mn - (mn % 12);
      hi = mx % 12 === 0 ? mx : mx + (12 - mx % 12);
      while (hi - lo < 24) { if (lo > 36) lo -= 12; else hi += 12; }
      lo = Math.max(21, lo);
      hi = Math.min(108, hi);
    } else {
      [lo, hi] = RANGES[61];
    }
    geo.lo = lo;
    geo.hi = hi;
    let whites = 0;
    for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites++;
    const ww = view.w / whites;
    const bw = ww * 0.62;
    let i = 0;
    for (let p = lo; p <= hi; p++) {
      if (!isBlack(p)) { geo.x[p] = i * ww; geo.w[p] = ww; i++; }
    }
    for (let p = lo; p <= hi; p++) {
      if (isBlack(p)) { geo.x[p] = geo.x[p - 1] + ww - bw / 2; geo.w[p] = bw; }
    }
  }

  const inRange = p => p >= geo.lo && p <= geo.hi;
  const label = p => settings.labels === 'solfege' ? SOLFEGE[p % 12] : settings.labels === 'name' ? NAMES[p % 12] : '';

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function draw(now) {
    const W = view.w, H = view.h;
    if (!W || !H) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, W, H);
    const kbH = view.kbH, hitY = H - kbH;
    const sp = settings.speed;
    const span = settings.lookahead * sp;
    const pps = hitY / span;
    const t = S.t;
    const { lo, hi } = geo;

    // 轨道
    for (let p = lo; p <= hi; p++) {
      if (isBlack(p)) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(geo.x[p], 0, geo.w[p], hitY); }
    }
    for (let p = lo; p <= hi; p++) {
      const pc = p % 12;
      if (pc === 0 || pc === 5) {
        ctx.fillStyle = pc === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
        ctx.fillRect(Math.round(geo.x[p]), 0, 1, hitY);
      }
    }

    // 需要按的键（等待模式的下一组和弦 / 跟弹模式窗口内的音）
    const expect = new Map();
    if (S.song && settings.mode === 'wait') {
      advanceWaitIdx();
      const a = S.active;
      if (S.waitIdx < a.length) {
        const g = a[S.waitIdx].start;
        for (let i = S.waitIdx; i < a.length && a[i].start <= g + 0.05; i++) if (a[i].state === 0) expect.set(a[i].pitch, a[i].hand);
      }
    } else if (S.song && settings.mode === 'play') {
      const a = S.active, win = GOOD * sp;
      for (let i = lowerBound(a, t - win); i < a.length && a[i].start <= t + win; i++) if (a[i].state === 0) expect.set(a[i].pitch, a[i].hand);
    }
    // 下一组音符的轨道高亮
    const pulse = 0.5 + 0.5 * Math.sin(now / 160);
    expect.forEach((hand, p) => {
      if (!inRange(p)) return;
      ctx.fillStyle = hexA(COLORS[hand].w, 0.07 + (S.waiting ? 0.08 * pulse : 0));
      ctx.fillRect(geo.x[p], 0, geo.w[p], hitY);
    });

    // 小节线 / 拍线
    if (S.song) {
      const beats = S.song.beats;
      for (let i = lowerBoundBeat(beats, t); i < beats.length && beats[i].t <= t + span; i++) {
        const y = Math.round(hitY - (beats[i].t - t) * pps);
        ctx.fillStyle = beats[i].down ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
        ctx.fillRect(0, y, W, 1);
      }
    }

    // 音符
    const sounding = new Map();
    if (S.song) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, hitY);
      ctx.clip();
      const notes = S.notes;
      const i0 = lowerBound(notes, t - S.song.maxDur - 0.01);
      let i1 = i0;
      while (i1 < notes.length && notes[i1].start <= t + span) i1++;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = i0; i < i1; i++) {
          const n = notes[i];
          if (isBlack(n.pitch) !== (pass === 1)) continue;
          if (n.start + n.dur < t) continue;
          if (n.start <= t) sounding.set(n.pitch, n);
          if (!inRange(n.pitch)) continue;
          drawNote(n, hitY, pps, t);
        }
      }
      ctx.restore();
    }

    // 判定线
    ctx.fillStyle = S.waiting ? `rgba(255,224,138,${0.55 + 0.45 * pulse})` : 'rgba(255,255,255,0.55)';
    ctx.fillRect(0, hitY - 2, W, 3);

    drawKeyboard(hitY, kbH, now, expect, sounding, pulse);

    // 判定弹字
    ctx.textAlign = 'center';
    ctx.font = 'bold 15px system-ui, sans-serif';
    S.popups = S.popups.filter(pp => now - pp.at < 700);
    for (const pp of S.popups) {
      if (!inRange(pp.pitch)) continue;
      const age = (now - pp.at) / 700;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = pp.color;
      ctx.fillText(pp.text, geo.x[pp.pitch] + geo.w[pp.pitch] / 2, hitY - 14 - age * 36);
    }
    ctx.globalAlpha = 1;
  }

  function drawNote(n, hitY, pps, t) {
    const x = geo.x[n.pitch], w = geo.w[n.pitch];
    const yBot = hitY - (n.start - t) * pps;
    const h = Math.max(4, n.dur * pps - 2);
    const yTop = yBot - h;
    const black = isBlack(n.pitch);
    const col = (n.active || settings.mode === 'demo') ? COLORS[n.hand] : COLORS.X;
    let fill = black ? col.b : col.w;
    let alpha = 1;
    if (n.state === 1) alpha = 0.4;
    else if (n.state === 2) fill = '#c9373c';
    else if (n.state === 3) alpha = 0.3;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    rr(x + 1.5, yTop, w - 3, h, Math.min(5, w / 4));
    ctx.fill();
    if (n.state === 1) {
      ctx.strokeStyle = '#3ddc84';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const lb = label(n.pitch);
    if (lb && w >= 12 && h >= 14 && n.state !== 3) {
      const fs = Math.min(13, Math.max(8, w * 0.42));
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(lb, x + w / 2, yBot - 4);
    }
  }

  function drawKeyboard(top, kbH, now, expect, sounding, pulse) {
    const { lo, hi } = geo;
    const keyFill = p => {
      const wf = S.wrongFlash.get(p);
      if (wf && now - wf < 250) return '#ff5c5c';
      if (S.pressed.has(p)) return '#3ddc84';
      if (expect.has(p)) return mix(COLORS[expect.get(p)].w, isBlack(p) ? '#1b1d22' : '#ffffff', 0.25 + 0.35 * pulse);
      const s = sounding.get(p);
      if (s) return (s.active || settings.mode === 'demo') ? COLORS[s.hand].w : '#8a93a6';
      return null;
    };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, top, view.w, kbH);
    ctx.textAlign = 'center';
    for (let p = lo; p <= hi; p++) {
      if (isBlack(p)) continue;
      const x = geo.x[p], w = geo.w[p];
      const f = keyFill(p);
      ctx.fillStyle = f || '#f2f2ee';
      rr(x + 0.5, top + 1, w - 1, kbH - 2, Math.min(4, w / 5));
      ctx.fill();
      if (p % 12 === 0 || expect.has(p)) {
        const fs = Math.min(12, Math.max(8, w * 0.42));
        ctx.font = `${expect.has(p) ? 700 : 500} ${fs}px system-ui, sans-serif`;
        ctx.fillStyle = expect.has(p) ? '#111' : '#8a8f99';
        ctx.fillText(expect.has(p) && settings.labels !== 'none' ? label(p) : noteName(p), x + w / 2, top + kbH - 8);
      }
    }
    const bh = kbH * 0.62;
    for (let p = lo; p <= hi; p++) {
      if (!isBlack(p)) continue;
      const x = geo.x[p], w = geo.w[p];
      const f = keyFill(p);
      ctx.fillStyle = f || '#1b1d22';
      rr(x, top, w, bh, [0, 0, 3, 3]);
      ctx.fill();
      if (!f) {
        ctx.fillStyle = '#3a3d45';
        ctx.fillRect(x + w * 0.2, top + bh - 6, w * 0.6, 3);
      } else if (expect.has(p) && settings.labels !== 'none' && w >= 10) {
        ctx.font = `700 ${Math.min(11, Math.max(7, w * 0.4))}px system-ui, sans-serif`;
        ctx.fillStyle = '#111';
        ctx.fillText(label(p).replace('#', '♯'), x + w / 2, top + bh - 8);
      }
    }
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function mix(h1, h2, k) {
    const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
    const c = s => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
    return `rgb(${c(16)},${c(8)},${c(0)})`;
  }

  // ---------- HUD ----------
  let hudCache = '';
  function updateHud() {
    const st = S.stats;
    let combo = '', stats = '', wait = '', msg = '';
    if (S.song && settings.mode !== 'demo') {
      combo = st.combo >= 3 ? st.combo + ' combo' : '';
      const acc = accuracy();
      stats = settings.mode === 'play'
        ? `Perfect ${st.perfect} · Good ${st.good} · Miss ${st.miss} · 错键 ${st.wrong}`
        : `按对 ${st.hit} · 错键 ${st.wrong}`;
      if (acc != null) stats += ` · 准确率 ${acc}%`;
    }
    if (S.waiting) {
      const need = [];
      advanceWaitIdx();
      const a = S.active;
      if (S.waitIdx < a.length) {
        const g = a[S.waitIdx].start;
        for (let i = S.waitIdx; i < a.length && a[i].start <= g + 0.05; i++) {
          if (a[i].state === 0) need.push((a[i].hand === 'L' ? '左 ' : '右 ') + noteName(a[i].pitch));
        }
      }
      wait = '等你按：' + need.join('  ');
    }
    if (!S.song) msg = '<b>加载中…</b>';
    else if (!S.playing && !S.finished) {
      msg = `<b>${escapeHtml(S.song.title)}</b>按 空格 / ▶ 开始` +
        (settings.mode !== 'demo' && midiAccess && $('#midiStatus').classList.contains('ok') ? '\n或者直接在琴上按任意键' : '');
    }
    const key = combo + '|' + stats + '|' + wait + '|' + msg;
    if (key === hudCache) return;
    hudCache = key;
    $('#hudCombo').textContent = combo;
    $('#hudStats').textContent = stats;
    $('#hudWait').textContent = wait;
    $('#centerMsg').innerHTML = msg;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(s) {
    s = Math.max(0, s);
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }

  let lastSeekUi = 0;
  function updateTransport(now) {
    if (!S.song || S.seeking || now - lastSeekUi < 100) return;
    lastSeekUi = now;
    $('#seek').value = Math.max(0, S.t).toFixed(2);
    $('#timeCur').textContent = fmtTime(S.t);
  }

  // ---------- 主循环 ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    update(dt);
    draw(now);
    updateHud();
    updateTransport(now);
    requestAnimationFrame(frame);
  }

  // ---------- 界面绑定 ----------
  function updatePlayBtn() { $('#playBtn').textContent = S.playing ? '⏸' : '▶'; }
  const modeLabel = () => ({ demo: '演示', wait: '等待', play: '跟弹' }[settings.mode]);
  const handLabel = () => ({ L: '左手', R: '右手', both: '双手' }[settings.hands]);

  function syncSegs() {
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));
    document.querySelectorAll('#handSeg button').forEach(b => b.classList.toggle('on', b.dataset.hands === settings.hands));
  }

  function setSpeed(v) {
    settings.speed = Math.min(1.5, Math.max(0.1, Math.round(v * 20) / 20));
    $('#speed').value = Math.round(settings.speed * 100);
    $('#speedVal').textContent = Math.round(settings.speed * 100) + '%';
    synth.stopAll();
    saveSettings();
  }

  function renderTracks() {
    const box = $('#tracks');
    box.innerHTML = '';
    if (!S.song) return;
    for (const p of S.song.parts) {
      const row = document.createElement('div');
      row.className = 'track';
      row.innerHTML = `<span class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span><span class="cnt">${p.count} 音</span>`;
      const sel = document.createElement('select');
      [['R', '右手'], ['L', '左手'], ['split', '按音高分'], ['off', '不显示']].forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      });
      sel.value = S.partHands[p.id] || 'R';
      sel.onchange = () => {
        S.partHands[p.id] = sel.value;
        store.set('hands:' + S.songId, S.partHands);
        applyHands();
      };
      row.appendChild(sel);
      box.appendChild(row);
    }
  }

  function updateLoopBand() {
    const band = $('#loopBand');
    if (!S.song || S.loopA == null) { band.classList.add('hidden'); return; }
    const d = S.song.duration || 1;
    const a = S.loopA / d * 100;
    const b = (S.loopB != null ? S.loopB : S.loopA) / d * 100;
    band.style.left = a + '%';
    band.style.width = Math.max(0.3, b - a) + '%';
    band.classList.remove('hidden');
    $('#setA').classList.toggle('active', S.loopA != null);
    $('#setB').classList.toggle('active', S.loopB != null);
  }

  // 曲库：内置示例 + 仓库 songs/ 目录 + 用户导入（IndexedDB）
  let repoSongs = [];
  async function refreshLibrary(selectId) {
    const sel = $('#songSelect');
    const user = await idb.all();
    sel.innerHTML = '';
    const group = (label, items) => {
      if (!items.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      items.forEach(([id, title]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = title;
        g.appendChild(o);
      });
      sel.appendChild(g);
    };
    group('我导入的', user.sort((a, b) => b.added - a.added).map(r => [r.id, r.name]));
    group('曲库（songs 文件夹）', repoSongs.map(s => ['repo:' + s.file, s.title || s.file]));
    group('示例 / 练习', PF_DEMOS.map(d => [d.id, d.title]));
    if (selectId) sel.value = selectId;
  }

  async function loadSongById(id) {
    try {
      if (id.startsWith('demo:')) {
        const d = PF_DEMOS.find(x => x.id === id);
        if (!d) throw new Error('找不到示例');
        setSong(d.build(), id, d.title);
      } else if (id.startsWith('repo:')) {
        const file = id.slice(5);
        const res = await fetch('songs/' + encodeURIComponent(file));
        if (!res.ok) throw new Error('下载失败 ' + res.status);
        const meta = repoSongs.find(s => s.file === file);
        setSong(PF_parseMidi(await res.arrayBuffer()), id, (meta && meta.title) || file);
      } else if (id.startsWith('user:')) {
        const rec = await idb.get(id);
        if (!rec) throw new Error('找不到该曲子');
        setSong(PF_parseMidi(rec.data), id, rec.name);
      }
      pause();
    } catch (e) {
      alert('加载失败：' + e.message);
      if (!S.song) loadSongById(PF_DEMOS[0].id);
    }
  }

  async function importFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const song = PF_parseMidi(buf);
      if (!song.notes.length) throw new Error('文件里没有音符');
      const id = 'user:' + Date.now();
      const name = file.name.replace(/\.(midi?|kar)$/i, '');
      try { await idb.put({ id, name, data: buf, added: Date.now() }); } catch (e) { /* 存不了也能先弹 */ }
      await refreshLibrary();
      const sel = $('#songSelect');
      if (![...sel.options].some(o => o.value === id)) {
        const o = document.createElement('option');
        o.value = id; o.textContent = name;
        sel.prepend(o);
      }
      setSong(song, id, name);
      pause();
    } catch (e) {
      alert('导入失败：' + e.message);
    }
  }

  function bindUi() {
    $('#playBtn').onclick = toggle;
    $('#restartBtn').onclick = () => { restart(); };
    $('#speed').oninput = e => setSpeed(e.target.value / 100);
    $('#songSelect').onchange = e => { loadSongById(e.target.value); e.target.blur(); };
    $('#importBtn').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; };
    $('#midiStatus').onclick = () => { if (midiAccess) bindMidi(); else initMidi(); };

    document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => {
      settings.mode = b.dataset.mode;
      saveSettings(); syncSegs();
      synth.stopAll();
      resetStats();
      seek(S.t);
    });
    document.querySelectorAll('#handSeg button').forEach(b => b.onclick = () => {
      settings.hands = b.dataset.hands;
      saveSettings(); syncSegs();
      resetStats();
      applyHands();
    });

    const panel = $('#settings');
    $('#settingsBtn').onclick = () => panel.classList.toggle('hidden');
    $('#closeSettings').onclick = () => panel.classList.add('hidden');

    document.querySelectorAll('[data-setting]').forEach(el => {
      const k = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!settings[k];
      else el.value = settings[k];
      const show = () => { const v = document.querySelector(`[data-val="${k}"]`); if (v) v.textContent = settings[k] + ' 秒'; };
      show();
      el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
        settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        saveSettings();
        show();
        if (k === 'range') computeRange();
        if (k === 'volume') synth.setVolume(settings.volume);
        if (k === 'accomp' && !settings.accomp) synth.stopAll();
      });
    });

    const seekEl = $('#seek');
    seekEl.oninput = () => {
      S.seeking = true;
      seek(Number(seekEl.value));
      $('#timeCur').textContent = fmtTime(S.t);
    };
    seekEl.onchange = () => { S.seeking = false; seekEl.blur(); };

    $('#setA').onclick = () => {
      S.loopA = Math.max(0, S.t);
      if (S.loopB != null && S.loopB <= S.loopA) S.loopB = null;
      updateLoopBand();
    };
    $('#setB').onclick = () => {
      if (S.loopA == null) S.loopA = 0;
      if (S.t > S.loopA) S.loopB = S.t;
      updateLoopBand();
    };
    $('#clearLoop').onclick = () => {
      S.loopA = S.loopB = null;
      $('#setA').classList.remove('active');
      $('#setB').classList.remove('active');
      updateLoopBand();
    };

    $('#againBtn').onclick = () => { restart(); play(); };
    $('#closeSummaryBtn').onclick = hideSummary;

    $('#deleteSong').onclick = async () => {
      if (!S.songId || !S.songId.startsWith('user:')) return;
      if (!confirm('确定从浏览器里删除「' + S.song.title + '」吗？')) return;
      await idb.del(S.songId).catch(() => {});
      await refreshLibrary();
      loadSongById(PF_DEMOS[0].id);
    };

    // 拖入 MIDI 文件
    let dragDepth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropHint').classList.remove('hidden'); });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      dragDepth = 0;
      $('#dropHint').classList.add('hidden');
      const f = e.dataTransfer.files[0];
      if (f) importFile(f);
    });

    // 键盘：快捷键 + 电脑键盘弹琴
    const kbHeld = new Map();
    window.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) toggle(); return; }
      if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); jumpBar(k === 'arrowleft' ? -1 : 1); return; }
      if (k === 'arrowup' || k === 'arrowdown') { e.preventDefault(); setSpeed(settings.speed + (k === 'arrowup' ? 0.05 : -0.05)); return; }
      if (k === 'home') { e.preventDefault(); restart(); return; }
      if (k === 'z' || k === 'x') { settings.octave = Math.min(7, Math.max(1, settings.octave + (k === 'z' ? -1 : 1))); saveSettings(); return; }
      if (k in KEYMAP && !e.repeat) {
        const p = (settings.octave + 1) * 12 + KEYMAP[k];
        kbHeld.set(k, p);
        noteOn(p, 90);
      }
    });
    window.addEventListener('keyup', e => {
      const k = e.key.toLowerCase();
      if (kbHeld.has(k)) { noteOff(kbHeld.get(k)); kbHeld.delete(k); }
    });
    window.addEventListener('blur', () => { kbHeld.forEach(p => noteOff(p)); kbHeld.clear(); });

    // 点 / 触摸屏幕上的琴键
    const ptr = new Map();
    canvas.addEventListener('pointerdown', e => {
      const p = keyAt(e.offsetX, e.offsetY);
      if (p == null) return;
      canvas.setPointerCapture(e.pointerId);
      ptr.set(e.pointerId, p);
      synth.ensure();
      noteOn(p, 90);
    });
    const up = e => { if (ptr.has(e.pointerId)) { noteOff(ptr.get(e.pointerId)); ptr.delete(e.pointerId); } };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    new ResizeObserver(resize).observe($('#stage'));
  }

  function keyAt(x, y) {
    const top = view.h - view.kbH;
    if (y < top) return null;
    if (y < top + view.kbH * 0.62) {
      for (let p = geo.lo; p <= geo.hi; p++) if (isBlack(p) && x >= geo.x[p] && x < geo.x[p] + geo.w[p]) return p;
    }
    for (let p = geo.lo; p <= geo.hi; p++) if (!isBlack(p) && x >= geo.x[p] && x < geo.x[p] + geo.w[p]) return p;
    return null;
  }

  function jumpBar(dir) {
    if (!S.song) return;
    const bars = S.song.beats.filter(b => b.down).map(b => b.t);
    if (!bars.length) { seek(Math.max(startTime(), S.t + dir * 2)); return; }
    let target;
    if (dir < 0) {
      const prev = bars.filter(b => b < S.t - 0.3);
      target = prev.length ? prev[prev.length - 1] : startTime();
    } else {
      target = bars.find(b => b > S.t + 0.01);
      if (target == null) return;
    }
    seek(target);
  }

  // ---------- 启动 ----------
  async function boot() {
    bindUi();
    syncSegs();
    setSpeed(settings.speed);
    resize();
    requestAnimationFrame(frame);
    try {
      const res = await fetch('songs/index.json', { cache: 'no-cache' });
      if (res.ok) repoSongs = await res.json();
    } catch (e) { /* 本地 file:// 打开时没有曲库 */ }
    await refreshLibrary();
    const lastId = store.get('lastSong', null);
    const sel = $('#songSelect');
    const ok = lastId && [...sel.options].some(o => o.value === lastId);
    await loadSongById(ok ? lastId : PF_DEMOS[0].id);
    initMidi();
  }

  // 方便在控制台调试
  window.PF = { S, settings, update, draw, noteOn, noteOff, seek, restart, play, pause };

  boot();
})();
