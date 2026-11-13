import { musicSettings } from './music';

export const EQ_FREQUENCIES = [60, 170, 350, 1000, 3500, 10000];
interface Channel {
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
  preamp: GainNode;
  normal: GainNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  fade: GainNode;
  samples: Float32Array<ArrayBuffer>;
}
let context: AudioContext | null = null;
const nodes = new WeakMap<HTMLMediaElement, Channel>();
const live = new Set<Channel>();
function configure(channel: Channel) {
  if (!context) return;
  const s = musicSettings();
  const t = context.currentTime;
  channel.filters.forEach((filter, i) => filter.gain.setTargetAtTime(s.eq_enabled ? (s.eq_gains[i] ?? 0) : 0, t, 0.05));
  channel.preamp.gain.setTargetAtTime(10 ** (-(s.eq_enabled ? Math.max(0, ...s.eq_gains) : 0) / 20), t, 0.05);
  channel.limiter.threshold.setTargetAtTime(s.normalization || s.eq_enabled ? -2 : 0, t, 0.05);
  if (!s.normalization) channel.normal.gain.setTargetAtTime(1, t, 0.3);
}
export function attachEffects(audio: HTMLAudioElement) {
  if (nodes.has(audio)) return;
  try {
    context ??= new AudioContext();
    const source = context.createMediaElementSource(audio);
    const filters = EQ_FREQUENCIES.map((frequency) => {
      const filter = context!.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = frequency;
      filter.Q.value = 0.8;
      return filter;
    });
    const preamp = context.createGain(),
      normal = context.createGain(),
      fade = context.createGain(),
      limiter = context.createDynamicsCompressor(),
      analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    const chain: AudioNode[] = [source, preamp, ...filters, analyser, normal, limiter, fade, context.destination];
    chain.slice(0, -1).forEach((node, i) => node.connect(chain[i + 1]));
    const channel = {
      source,
      filters,
      preamp,
      normal,
      limiter,
      analyser,
      fade,
      samples: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
    };
    nodes.set(audio, channel);
    live.add(channel);
    configure(channel);
  } catch {
    /* Browsers without Web Audio keep the ordinary HTML audio path. */
  }
}
export function resumeEffects() {
  void context?.resume().catch(() => {});
}
export function effectsReady(audio: HTMLAudioElement) {
  return nodes.has(audio) && context?.state === 'running';
}
export function fadeLevel(audio: HTMLAudioElement, value: number, seconds = 0) {
  const channel = nodes.get(audio);
  if (channel && context) {
    const gain = channel.fade.gain;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(gain.value, context.currentTime);
    gain.linearRampToValueAtTime(value, context.currentTime + seconds);
  } else audio.volume = Math.max(0, Math.min(1, value));
}
export function releaseEffects(audio: HTMLAudioElement) {
  const channel = nodes.get(audio);
  if (channel) {
    live.delete(channel);
    channel.source.disconnect();
    channel.filters.forEach((f) => f.disconnect());
    channel.preamp.disconnect();
    channel.normal.disconnect();
    channel.fade.disconnect();
    channel.analyser.disconnect();
    channel.limiter.disconnect();
  }
}
window.addEventListener('qqmusic-audio-settings', () => live.forEach(configure));
window.setInterval(() => {
  if (!context || context.state !== 'running' || !musicSettings().normalization) return;
  for (const c of live) {
    c.analyser.getFloatTimeDomainData(c.samples);
    const rms = Math.sqrt(c.samples.reduce((sum, v) => sum + v * v, 0) / c.samples.length);
    if (rms > 0.005) {
      const target = Math.max(0.25, Math.min(4, 0.12 / rms));
      c.normal.gain.setTargetAtTime(target, context.currentTime, 1.5);
    }
  }
}, 250);
