import { api } from '../api/client';
import { useAsync, useInterval } from '../lib/hooks';
import { Link } from '../lib/router';
import { Icon } from './Icon';
import { Spinner } from './ui';

/** Desktop overview uses the same endpoint and navigation as the regular mix card. */
export function HomeMix() {
  const res = useAsync((signal) => api.mixToday(signal), []);
  const today = res.data;
  useInterval(() => res.reload(true), today && (today.building || (today.mix && today.mix.ready < today.mix.total)) ? 8000 : null);
  const card = 'flex min-h-56 flex-col items-start rounded-2xl border border-[#48403a] bg-[#292624] p-6';
  if (res.loading && !today) return <div className={card} role="status"><Spinner /> <span className="mt-3 text-sm text-muted">Загружаем микс…</span></div>;
  if (res.error && !today) return <div className={card}><h2 className="text-xl font-bold">Микс дня</h2><p className="mt-3 text-sm text-muted">Не удалось загрузить микс.</p><button type="button" className="mt-4 text-sm text-[#ffad78] underline" onClick={() => res.reload()}>Попробовать снова</button></div>;
  if (!today) return null;
  if (today.mix) return <Link to={`/mix/${today.mix.id}`} className={`${card} transition hover:bg-[#35302c]`}>
    <span className="text-xs font-semibold uppercase tracking-wide text-[#edb587]">Ваша подборка</span>
    <h2 className="mt-4 text-2xl font-bold">Микс дня</h2>
    <p className="mt-2 line-clamp-2 text-sm text-[#c2bcb7]">{today.mix.description || today.mix.title}</p>
    <span className="mt-2 text-xs text-[#b8aca3]">{today.mix.ready < today.mix.total ? `Готово ${today.mix.ready} из ${today.mix.total}` : `${today.mix.total} треков`}</span>
    <span className="mt-auto inline-flex items-center gap-2 rounded-full bg-[#f0efeb] px-4 py-2 text-sm font-semibold text-[#211b18]"><Icon name="play" size={15} /> Открыть микс</span>
  </Link>;
  if (today.building) return <div className={card} role="status"><Spinner className="text-[#ff9349]"/><h2 className="mt-4 text-xl font-bold">Собираем микс дня</h2><p className="mt-2 text-sm text-muted">Подбираем музыку по вашему вкусу.</p></div>;
  if (today.onboarding) return <Link to="/taste" className={`${card} transition hover:bg-[#35302c]`}><Icon name="sparkle" className="text-[#ff9349]"/><h2 className="mt-4 text-xl font-bold">Что вы слушаете?</h2><p className="mt-2 text-sm text-muted">Выберите исполнителей, чтобы собрать первый микс.</p><span className="mt-auto pt-4 text-sm text-[#ffad78]">Выбрать исполнителей →</span></Link>;
  return <div className={card}><h2 className="text-xl font-bold">Микс дня</h2><p className="mt-3 text-sm text-muted">Следующий микс появится в {today.settings.mix_hour}:00.</p></div>;
}
