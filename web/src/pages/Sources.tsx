import { useState } from 'react';
import { request } from '../api/client';
import { Button, ErrorState, IconButton, Loading, Notice, PageHeader } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { useAsync } from '../lib/hooks';
import { fmtWhen, providerLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { Link } from '../lib/router';
import { attempt } from '../lib/ui';

interface Check {ok: boolean; at: string; reason: string | null}
interface Sources {sources: {name: string; search?: Check; audio?: Check; last_issue?: Check & {kind:string}; cooldown_s: number}[]; cookies_configured: boolean}
const reasons: Record<string,string> = {session:'Нужно обновить cookies',login:'Источник требует вход',forbidden:'Отказ в выдаче файла',limited:'Лимит запросов',tls:'Ошибка защищённого соединения',unavailable:'Источник недоступен'};
export function SourcesPage() {
  const {me} = useSession();
  const desktop = useDesktop();
  const res = useAsync((signal) => request<Sources>('GET','/api/system/sources',{signal}), []);
  const [busy,setBusy] = useState(false);
  const check = async () => { setBusy(true); const data=await attempt(()=>request<Sources>('POST','/api/system/sources/check')); if(data)res.setData(data); setBusy(false); };
  const refresh = () => me.is_admin ? void check() : res.reload();
  return <div className="mx-auto max-w-5xl pb-10"><PageHeader title="Состояние источников" back="/more" right={desktop ? <Button small icon="refresh" busy={busy} onClick={refresh}>{me.is_admin ? 'Проверить поиск' : 'Обновить'}</Button> : <IconButton icon="refresh" label={me.is_admin ? 'Проверить поиск' : 'Обновить'} busy={busy} onClick={refresh}/>} />
    <div className="space-y-4 px-4"><p className="text-sm leading-6 text-muted">Результаты наблюдений с последнего запуска сервера. Проверка поиска не гарантирует доступность полного аудио.</p>
    {res.loading ? <Loading/> : res.error ? <ErrorState text={res.error} onRetry={()=>res.reload()}/> : res.data && <>
      <Notice kind="info">YouTube cookies: {res.data.cookies_configured ? 'указаны в настройках' : 'не настроены'}. Состояние авторизации определяется при обращении к YouTube.</Notice>
      {res.data.sources.map((source)=><section key={source.name} className="space-y-2 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">{providerLabel(source.name)}</h2>{(['search','audio'] as const).map((kind)=>{ const c=source[kind]; return <p key={kind} className="text-sm text-muted">{kind==='search'?'Поиск':'Полное аудио'}: <span className={c ? c.ok?'text-accent':'text-warn':'text-muted'}>{c ? c.ok?'успешно':reasons[c.reason??'']??'Ошибка':'ещё не проверено'}</span>{c && <span className="ml-2 text-xs">{fmtWhen(c.at)}</span>}</p>; })}{source.cooldown_s>0 && <p className="text-sm text-warn">Пауза запросов: ещё {source.cooldown_s} сек.</p>}</section>)}
      {res.data.sources.some((source)=>source.last_issue) && <section className="space-y-2 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Последние проблемы</h2>{res.data.sources.filter((source)=>source.last_issue).map((source)=><p key={source.name} className="text-sm text-muted">{providerLabel(source.name)} · {source.last_issue?.kind==='search'?'поиск':'аудио'}: {reasons[source.last_issue?.reason??'']??'Ошибка'} · {fmtWhen(source.last_issue!.at)}</p>)}</section>}
    </>}
    <Link to="/nextcloud" className="block rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-hover">Nextcloud · проверить личное подключение →</Link></div></div>;
}
