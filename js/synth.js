// 简易 WebAudio 合成器：用于伴奏、示范播放、节拍器
(function (global) {
  'use strict';

  class Synth {
    constructor() {
      this.ctx = null;
      this.voices = [];
      this.volume = 0.7;
      this.maxVoices = 48;
    }

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.ratio.value = 4;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.value = v;
    }

    _voice(pitch, vel) {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const f = 440 * Math.pow(2, (pitch - 69) / 12);
      const out = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(12000, f * 8);
      const o1 = ctx.createOscillator();
      o1.type = 'triangle';
      o1.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2;
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(out); out.connect(this.master);

      const peak = 0.22 * (0.35 + 0.65 * vel);
      const decay = 0.25 + 1.6 * Math.max(0, 96 - pitch) / 60; // 低音衰减更慢
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(peak, t + 0.006);
      out.gain.setTargetAtTime(peak * 0.15, t + 0.006, decay);
      lp.frequency.setTargetAtTime(Math.min(12000, f * 3), t, decay * 0.6);
      o1.start(t);
      o2.start(t);

      const v = { out, oscs: [o1, o2], relAt: null };
      o1.onended = () => {
        out.disconnect();
        const i = this.voices.indexOf(v);
        if (i >= 0) this.voices.splice(i, 1);
      };
      this.voices.push(v);
      if (this.voices.length > this.maxVoices) this.release(this.voices[0], t, 0.02);
      return v;
    }

    release(v, at, rel = 0.12) {
      if (!v) return;
      at = Math.max(at, this.ctx.currentTime);
      if (v.relAt != null && at >= v.relAt) return;
      v.relAt = at;
      v.out.gain.cancelScheduledValues(at);
      v.out.gain.setTargetAtTime(0, at, rel);
      v.oscs.forEach(o => o.stop(at + rel * 8));
    }

    // 播放固定时长的音（秒）
    play(pitch, dur, vel = 0.7) {
      if (!this.ensure()) return;
      const v = this._voice(pitch, vel);
      this.release(v, this.ctx.currentTime + Math.max(0.05, dur));
    }

    // 按住发声，返回句柄，松开时调用 stop
    start(pitch, vel = 0.7) {
      if (!this.ensure()) return null;
      return this._voice(pitch, vel);
    }

    stop(v) {
      if (v && this.ctx) this.release(v, this.ctx.currentTime);
    }

    stopAll() {
      if (!this.ctx) return;
      this.voices.slice().forEach(v => this.release(v, this.ctx.currentTime, 0.03));
    }

    click(accent) {
      if (!this.ensure()) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = accent ? 1600 : 1000;
      g.gain.setValueAtTime(accent ? 0.18 : 0.1, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      o.connect(g); g.connect(this.master);
      o.start(t);
      o.stop(t + 0.06);
    }
  }

  global.PF_Synth = Synth;
})(window);
