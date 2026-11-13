import { toggle, useListen } from '../lib/listen';
import { canWave, startWave, useWave } from '../lib/wave';
import { Icon } from './Icon';
import { Spinner } from './ui';

/** Desktop home wave: the same live wave state and actions as the original hero. */
export function WaveHero() {
  const { title, starting } = useWave();
  const wave = useListen((s) => !!s.track && s.context.startsWith('wave:'));
  const phase = useListen((s) => s.phase);
  if (!canWave()) return <div className="flex min-h-56 items-center rounded-2xl bg-[#292624] p-6 text-sm text-muted">Моя волна пока недоступна.</div>;
  const busy = starting === '';
  const on = wave && title === 'Моя волна';
  const running = on && (phase === 'playing' || phase === 'loading' || phase === 'resolving');
  const caption = busy ? 'Подбираем первые треки…' : running ? 'Подстраивается под каждый пропуск и ♥' : on ? 'На паузе — продолжим с того же места' : 'Музыка под ваш вкус и новые открытия';
  const label = busy ? 'Моя волна: запускаем' : running ? 'Моя волна: пауза' : on ? 'Моя волна: продолжить' : 'Моя волна: слушать';
  return <section className="relative flex min-h-56 overflow-hidden rounded-2xl bg-[#493023] p-6 text-white">
    <div aria-hidden="true" className="pointer-events-none absolute right-10 top-1/2 h-44 w-44 -translate-y-1/2 rounded-full border-[16px] border-[#a8663a]/50 bg-[#73452b] opacity-80"><div className="absolute inset-8 rounded-full border-2 border-[#d28147]" /></div>
    <div className="relative z-10 flex max-w-[70%] flex-col items-start">
      <span className="text-xs font-semibold uppercase tracking-wide text-[#f7b989]">Персонально для вас</span>
      <h2 className="mt-4 text-3xl font-bold">Моя волна</h2>
      <p className="mt-2 text-sm text-[#e3d2c6]" role="status">{caption}</p>
      <button type="button" onClick={() => (on ? toggle() : void startWave(null, 'home_card'))} disabled={starting !== null} aria-label={label}
        className="mt-auto inline-flex items-center gap-2 rounded-full bg-[#ff9349] px-5 py-2 text-sm font-bold text-[#291406] transition hover:bg-[#ffa86d] disabled:opacity-70">
        {busy ? <Spinner size={17} /> : running ? <Icon name="pause" size={17} /> : <Icon name="play" size={17} />} {running ? 'Пауза' : on ? 'Продолжить' : 'Слушать'}
      </button>
    </div>
  </section>;
}
