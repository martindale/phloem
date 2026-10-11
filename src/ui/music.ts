// SPDX-License-Identifier: AGPL-3.0-only
import { ICON } from './chrome/icons';
import { BeatTracker, beatState } from '../util/beat';
import './music.css';

export interface Track {
  title: string;
  file: string;
}

/** Soundtrack generated with Suno for Phloem. Hosted on a Cloudflare R2 bucket (EU) behind this host, so the audio is not in the repository. */
const AUDIO_BASE = 'https://audio.stemdeck.app/audio/';

export const TRACKS: readonly Track[] = [
  { title: 'Heartbeat Drip', file: 'heartbeat-drip.mp3' },
  { title: 'Earth Pulse', file: 'earth-pulse.mp3' },
  { title: 'Life Blossoming', file: 'life-blossoming.mp3' },
  { title: 'Life in Bloom', file: 'life-in-bloom.mp3' },
];

/**
 * A small music player. Nothing is requested until the first press of play (no audio element exists before that), so a visitor
 * who never presses it downloads nothing. Tracks play in turn and the list loops.
 */
export class MusicPlayer {
  readonly el: HTMLElement;
  private audio: HTMLAudioElement | null = null;
  private index = 0;
  private btn: HTMLButtonElement;
  private name: HTMLElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private bins = new Uint8Array(0);
  private beat = new BeatTracker();
  private raf = 0;
  private last = 0;

  constructor(root: HTMLElement, private tracks: readonly Track[] = TRACKS) {
    this.el = document.createElement('div');
    this.el.className = 'gm-music';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Music');

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'gm-music-btn';
    this.btn.addEventListener('click', () => this.toggle());

    this.name = document.createElement('span');
    this.name.className = 'gm-music-name';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'gm-music-btn gm-music-next';
    next.setAttribute('aria-label', 'Next track');
    next.textContent = '»';
    next.addEventListener('click', () => this.skip());

    this.el.append(this.btn, this.name, next);
    root.append(this.el);
    this.render(false);
  }

  private src(i: number): string {
    return new URL(this.tracks[i].file, AUDIO_BASE).href;
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = new Audio();
    a.preload = 'none';
    a.crossOrigin = 'anonymous'; // the bucket sends CORS headers; without them Web Audio would mute the beat analysis and the sound
    a.addEventListener('ended', () => this.skip());
    a.addEventListener('play', () => (this.sync(), this.startBeat(a)));
    for (const ev of ['playing', 'pause', 'emptied', 'error']) a.addEventListener(ev, () => this.sync());
    a.src = this.src(this.index);
    this.audio = a;
    return a;
  }

  toggle(): void {
    const a = this.ensureAudio();
    if (a.paused) void a.play().then(() => this.sync(), () => this.sync());
    else a.pause();
  }

  /** Start the music if it is not playing (called from a click, which browsers need before they allow sound). Never restarts a track. */
  start(): void {
    const a = this.ensureAudio();
    if (a.paused) void a.play().then(() => this.sync(), () => this.sync());
  }

  skip(): void {
    const wasPlaying = !!this.audio && !this.audio.paused;
    this.index = (this.index + 1) % this.tracks.length;
    if (this.audio) {
      this.audio.src = this.src(this.index);
      if (wasPlaying || this.audio.ended) void this.audio.play().then(() => this.sync(), () => this.sync());
    }
    this.sync();
  }

  /** Kick energy (about 40 to 200 Hz) drives the pulse. If Web Audio is unavailable the music still plays, just without the pulse. */
  private startBeat(a: HTMLAudioElement): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        const src = this.ctx.createMediaElementSource(a);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024; // 43 Hz per bin at 44.1 kHz
        this.analyser.smoothingTimeConstant = 0;
        this.bins = new Uint8Array(this.analyser.frequencyBinCount);
        src.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);
      }
      void this.ctx.resume();
    } catch {
      return;
    }
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      const dt = (now - this.last) / 1000;
      this.last = now;
      const playing = !!this.audio && !this.audio.paused;
      let e = 0;
      if (playing && this.analyser) {
        this.analyser.getByteFrequencyData(this.bins);
        // the bytes are decibels (default -100..-30 dB) squeezed into 0..255: a kick on a steady bed moves them by only a few
        // percent, so a ratio test on them never fires. Back to linear amplitude (0..1), where a kick stands out.
        for (let i = 1; i <= 4; i++) e += 10 ** ((-100 + (this.bins[i] / 255) * 70) / 20);
        e = Math.min(1, e / 4 / 0.0316); // 0.0316 = -30 dB, the top of the analyser range
      }
      beatState.level = this.beat.update(e, dt);
      if (!playing && beatState.level === 0) {
        this.beat.reset();
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Paint from the audio element's own state, so the button can never disagree with what is playing. */
  private sync(): void {
    const a = this.audio;
    this.render(!!a && !a.paused && !a.ended && !a.error);
    // a track that cannot load (blocked, offline) says so, instead of a play button that silently does nothing
    if (a?.error) this.name.textContent = 'Music unavailable';
  }

  private render(playing: boolean): void {
    this.btn.innerHTML = playing ? ICON.pause : ICON.play;
    this.btn.setAttribute('aria-label', playing ? 'Pause music' : 'Play music');
    this.btn.setAttribute('aria-pressed', String(playing));
    this.name.textContent = this.tracks[this.index].title;
  }
}
