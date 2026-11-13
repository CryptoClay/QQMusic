import { AmbientArt } from './AmbientArt';
import { api } from '../api/client';
import { useAsync, useInterval } from '../lib/hooks';
import { Link } from '../lib/router';
import { Icon } from './Icon';
import { Spinner } from './ui';

export function HomeMix() {
  const res = useAsync((signal) => api.mixToday(signal), []);
  const today = res.data;
  useInterval(
    () => res.reload(true),
    today && (today.building || (today.mix && today.mix.ready < today.mix.total)) ? 8000 : null,
  );
  const card =
    'home-mix relative isolate flex min-h-[180px] flex-col items-start overflow-hidden rounded-3xl border border-white/[.06] bg-[#252132] p-6 min-[1100px]:min-h-[360px] sm:p-8';
  if (res.loading && !today)
    return (
      <div className={card} role="status">
        <AmbientArt variant="mix" />
        <Spinner /> <span className="mt-3 text-sm text-muted">Загружаем микс…</span>
      </div>
    );
  if (res.error && !today)
    return (
      <div className={card}>
        <AmbientArt variant="mix" />
        <h2 className="text-xl font-bold">Микс дня</h2>
        <p className="mt-3 text-sm text-muted">Не удалось загрузить микс.</p>
        <button type="button" className="mt-4 text-sm text-[#d2b7ff] underline" onClick={() => res.reload()}>
          Попробовать снова
        </button>
      </div>
    );
  if (!today) return null;
  if (today.mix)
    return (
      <Link to={`/mix/${today.mix.id}`} className={`${card} transition hover:bg-[#30293e]`}>
        <AmbientArt variant="mix" />
        <span className="text-xs font-semibold uppercase tracking-wide text-[#c8b9e5]">Ваша подборка</span>
        <h2 className="mt-4 text-2xl font-bold">Микс дня</h2>
        <p className="mt-2 line-clamp-2 text-sm text-[#c7c0d5]">{today.mix.description || today.mix.title}</p>
        <span className="mt-2 text-xs text-[#aaa0ba]">
          {today.mix.ready < today.mix.total
            ? `Готово ${today.mix.ready} из ${today.mix.total}`
            : `${today.mix.total} треков`}
        </span>
        <span className="mt-6 inline-flex min-[1100px]:mt-auto items-center gap-2 rounded-full bg-[#f0efeb] px-4 py-2 text-sm font-semibold text-[#211b18]">
          <Icon name="play" size={15} /> Открыть микс
        </span>
      </Link>
    );
  if (today.building)
    return (
      <div className={card} role="status">
        <AmbientArt variant="mix" />
        <Spinner className="text-[#ff9349]" />
        <h2 className="mt-4 text-xl font-bold">Собираем микс дня</h2>
        <p className="mt-2 text-sm text-muted">Подбираем музыку по вашему вкусу.</p>
      </div>
    );
  if (today.onboarding)
    return (
      <Link to="/taste" className={`${card} transition hover:bg-[#30293e]`}>
        <AmbientArt variant="mix" />
        <Icon name="sparkle" className="text-[#ff9349]" />
        <h2 className="mt-4 text-xl font-bold">Что вы слушаете?</h2>
        <p className="mt-2 text-sm text-muted">Выберите исполнителей, чтобы собрать первый микс.</p>
        <span className="mt-6 pt-4 min-[1100px]:mt-auto text-sm text-[#d2b7ff]">Выбрать исполнителей →</span>
      </Link>
    );
  return (
    <div className={card}>
      <AmbientArt variant="mix" />
      <h2 className="text-xl font-bold">Микс дня</h2>
      <p className="mt-3 text-sm text-muted">Следующий микс появится в {today.settings.mix_hour}:00.</p>
    </div>
  );
}
