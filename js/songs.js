// 内置示例曲（公有领域旋律 / 原创练习），用简易文本谱写成。
// 记法：音名+八度/拍数，和弦用 + 连接，休止符用 -，| 只是方便阅读的小节线。
//   例：E4/1  C3+E3+G3/2  -/0.5
(function (global) {
  'use strict';

  const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function nameToMidi(name) {
    const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
    if (!m) throw new Error('无法识别的音名: ' + name);
    return (Number(m[3]) + 1) * 12 + BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }

  function buildText(def) {
    const spb = 60 / def.bpm;
    const notes = [];
    let maxBeat = 0;
    for (const part of def.parts) {
      let beat = 0;
      for (const tok of part.text.split(/\s+/)) {
        if (!tok || tok === '|') continue;
        const [pitches, len] = tok.split('/');
        const beats = parseFloat(len || '1');
        if (pitches !== '-') {
          for (const pn of pitches.split('+')) {
            notes.push({ pitch: nameToMidi(pn), start: beat * spb, dur: beats * spb * 0.92, vel: 88, part: part.id });
          }
        }
        beat += beats;
      }
      maxBeat = Math.max(maxBeat, beat);
    }
    const per = def.beatsPerBar || 4;
    const beats = [];
    for (let k = 0; k < maxBeat; k++) beats.push({ t: k * spb, down: k % per === 0 });
    return {
      notes,
      beats,
      parts: def.parts.map(p => ({ id: p.id, name: p.name })),
      defaultHands: Object.fromEntries(def.parts.map(p => [p.id, p.hand])),
    };
  }

  const rep = (tok, n) => Array(n).fill(tok).join(' ');

  const DEMOS = [
    {
      id: 'demo:scale',
      title: '入门 · C 大调音阶（双手）',
      build: () => buildText({
        bpm: 80,
        parts: [
          { id: 'R', name: '右手', hand: 'R', text: 'C4 D4 E4 F4 | G4 A4 B4 C5 | B4 A4 G4 F4 | E4 D4 C4/2' },
          { id: 'L', name: '左手', hand: 'L', text: 'C3 D3 E3 F3 | G3 A3 B3 C4 | B3 A3 G3 F3 | E3 D3 C3/2' },
        ],
      }),
    },
    {
      id: 'demo:twinkle',
      title: '小星星（法国民谣）',
      build: () => buildText({
        bpm: 100,
        parts: [
          {
            id: 'R', name: '右手', hand: 'R',
            text: 'C4 C4 G4 G4 | A4 A4 G4/2 | F4 F4 E4 E4 | D4 D4 C4/2 |' +
              ' G4 G4 F4 F4 | E4 E4 D4/2 | G4 G4 F4 F4 | E4 E4 D4/2 |' +
              ' C4 C4 G4 G4 | A4 A4 G4/2 | F4 F4 E4 E4 | D4 D4 C4/2',
          },
          {
            id: 'L', name: '左手', hand: 'L',
            text: 'C3/4 | F3/2 C3/2 | F3/2 C3/2 | G2/2 C3/2 |' +
              ' C3/2 F3/2 | C3/2 G2/2 | C3/2 F3/2 | C3/2 G2/2 |' +
              ' C3/4 | F3/2 C3/2 | F3/2 C3/2 | G2/2 C3/2',
          },
        ],
      }),
    },
    {
      id: 'demo:ode',
      title: '欢乐颂（贝多芬）',
      build: () => buildText({
        bpm: 100,
        parts: [
          {
            id: 'R', name: '右手', hand: 'R',
            text: 'E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4/1.5 D4/0.5 D4/2 |' +
              ' E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4/1.5 C4/0.5 C4/2 |' +
              ' D4 D4 E4 C4 | D4 E4/0.5 F4/0.5 E4 C4 | D4 E4/0.5 F4/0.5 E4 D4 | C4 D4 G3/2 |' +
              ' E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4/1.5 C4/0.5 C4/2',
          },
          {
            id: 'L', name: '左手', hand: 'L',
            text: 'C3/4 | G2/4 | C3/4 | G2/4 | C3/4 | G2/4 | C3/4 | G2/2 C3/2 |' +
              ' G2/4 | G2/2 C3/2 | G2/4 | C3/2 G2/2 | C3/4 | G2/4 | C3/4 | G2/2 C3/2',
          },
        ],
      }),
    },
    {
      // 原创练习：快速同音连打 + 和弦跳跃，为 Rush E 这类曲子热身
      id: 'demo:repeat',
      title: '热身 · 快速连打 + 和弦（为 Rush E 准备）',
      build: () => buildText({
        bpm: 90,
        parts: [
          {
            id: 'R', name: '右手', hand: 'R',
            text: [
              rep('E5/0.25', 16), rep('D5/0.25', 16), rep('C5/0.25', 16), rep('B4/0.25', 16),
              rep('E5/0.25', 8), rep('G5/0.25', 8), rep('C5+E5/0.5', 4), 'C5+E5+G5/2', '-/2',
            ].join(' '),
          },
          {
            id: 'L', name: '左手', hand: 'L',
            text: [
              rep('A2/1', 4), rep('G2/1', 4), rep('F2/1', 4), rep('E2/1', 4),
              'C3+G3/2 C3+G3/2 G2+D3/2 C3+G3/2', '-/2',
            ].join(' '),
          },
        ],
      }),
    },
  ];

  global.PF_DEMOS = DEMOS;
})(window);
