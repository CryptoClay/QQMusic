import { toggle, useListen } from '../lib/listen';
import { canWave, startWave, useWave } from '../lib/wave';
import { Icon } from './Icon';
import { Spinner } from './ui';

export function WaveHero() {
  const { title, starting } = useWave();
  const wave = useListen((s) => !!s.track && s.context.startsWith('wave:'));
  const phase = useListen((s) => s.phase);
  if (!canWave())
    return (
      <div className="flex min-h-56 items-center rounded-2xl bg-[#292624] p-6 text-sm text-muted">
        Моя волна пока недоступна.
      </div>
    );
  const busy = starting === '';
  const on = wave && title === 'Моя волна';
  const running = on && (phase === 'playing' || phase === 'loading' || phase === 'resolving');
  const caption = busy
    ? 'Подбираем первые треки…'
    : running
      ? 'Подстраивается под каждый пропуск и ♥'
      : on
        ? 'На паузе — продолжим с того же места'
        : 'Музыка под ваш вкус и новые открытия';
  const label = busy
    ? 'Моя волна: запускаем'
    : running
      ? 'Моя волна: пауза'
      : on
        ? 'Моя волна: продолжить'
        : 'Моя волна: слушать';
  return (
    <section
      className={`home-frequency relative isolate flex min-h-[330px] overflow-hidden rounded-3xl p-6 text-white sm:min-h-[360px] sm:p-8 ${running ? 'is-playing' : ''}`}
    >
      <div aria-hidden="true" className="home-frequency-art">
        <div className="home-frequency-orbit" />
        <div className="home-frequency-core" />
        <div className="home-frequency-rings" />
      </div>
      <div className="relative z-10 flex max-w-[85%] flex-col items-start sm:max-w-[70%]">
        <span className="text-[10px] font-semibold uppercase tracking-[.24em] text-[#9bd7d2]">QQMusic / Моя волна</span>
        <h2 className="mt-7 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
          Твоя
          <br />
          частота
        </h2>
        <p className="mt-4 max-w-56 text-sm leading-relaxed text-[#d4dfde]" role="status">
          {caption}
        </p>
        <button
          type="button"
          onClick={() => (on ? toggle() : void startWave(null, 'home_card'))}
          disabled={starting !== null}
          aria-label={label}
          className="mt-7 inline-flex min-h-12 items-center gap-3 rounded-full bg-[#ff9349] py-3 pl-4 pr-6 text-sm font-bold text-[#291406] transition hover:bg-[#ffa86d] disabled:opacity-70"
        >
          {busy ? <Spinner size={19} /> : running ? <Icon name="pause" size={19} /> : <Icon name="play" size={19} />}{' '}
          {running ? 'Пауза' : on ? 'Продолжить' : 'Поймать волну'}
        </button>
      </div>
      <span
        aria-hidden="true"
        className="absolute bottom-6 right-6 text-[10px] uppercase tracking-[.2em] text-white/40"
      >
        На одной волне с тобой
      </span>
    </section>
  );
}
