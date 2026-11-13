import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, request, withQuery } from '../api/client';
import { Button, Empty, ErrorState, Field, Loading, Notice, PageHeader } from '../components/ui';
import { pauseNative } from '../lib/player';
import { stopListening } from '../lib/listen';

interface Connection {
  connected: boolean; server_url: string; username: string; folder: string;
  has_password: boolean; allowed_servers: string[]; can_add_server: boolean;
}
interface CloudFile { id: string; artist: string; title: string; album?: string; cover_url?: string }
interface CloudFolder { id: string; name: string }
interface CloudPlaylist { id: number; name: string; available: boolean; files: CloudFile[] }
const audioUrl = (file: CloudFile, download = false) => withQuery('/api/nextcloud/audio', { file: file.id, download: download || undefined });

export function NextcloudPage() {
  const [connection, setConnection] = useState<Connection>();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState('Music');
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<CloudFile>();
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [trail, setTrail] = useState<CloudFolder[]>([]);
  const [playlists, setPlaylists] = useState<CloudPlaylist[]>([]);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistId, setPlaylistId] = useState('');
  const [playQueue, setPlayQueue] = useState<CloudFile[]>([]);
  const reloadPlaylists = async () => setPlaylists(await request<CloudPlaylist[]>('GET', '/api/nextcloud/playlists'));
  const browse = async (path: CloudFolder[]) => {
    setBusy(true); setError(undefined);
    try {
      const data = await request<{files: CloudFile[]; folders: CloudFolder[]}>('GET', withQuery('/api/nextcloud/browse', {folder: path.at(-1)?.id}));
      setFiles(data.files); setFolders(data.folders); setTrail(path); setSearched(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const play = (file: CloudFile, queue: CloudFile[] = files) => {
    setSelected(file); setPlayQueue(queue); setError(undefined);
    void request<Omit<CloudFile, 'id'>>('GET', withQuery('/api/nextcloud/metadata', {file: file.id})).then((tags) => {
      setSelected((current) => current?.id === file.id ? {...current, ...tags} : current);
    }).catch(() => {});
  };
  const changePlaylist = async (action: 'create' | 'add' | 'delete', file?: CloudFile) => {
    setBusy(true); setError(undefined);
    try {
      if (action === 'create') {
        const created = await request<{id: number}>('POST', '/api/nextcloud/playlists', {json: {name: playlistName.trim(), files: []}});
        setPlaylistName(''); setPlaylistId(String(created.id));
      } else if (action === 'delete') {
        await request('DELETE', `/api/nextcloud/playlists/${playlistId}`); setPlaylistId('');
      } else if (file) {
        await request('POST', `/api/nextcloud/playlists/${playlistId}/items`, {json: {name: 'Плейлист', files: [file.id]}});
        setMessage('Трек добавлен в личный плейлист.');
      }
      await reloadPlaylists();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (connection?.connected) void reloadPlaylists().catch((e) => setError(errorMessage(e)));
    else { setPlaylists([]); setPlaylistId(''); setFolders([]); setTrail([]); }
  }, [connection]);

  const load = async (signal?: AbortSignal) => {
    const data = await request<Connection>('GET', '/api/nextcloud/connection', { signal });
    setConnection(data); setServer(data.server_url || data.allowed_servers[0] || '');
    setUsername(data.username); setFolder(data.folder);
  };
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal).catch((e) => { if (!ctl.signal.aborted) setError(errorMessage(e)); });
    return () => ctl.abort();
  }, []);

  const save = async (test: boolean) => {
    setBusy(true); setError(undefined); setMessage('');
    try {
      await request('PUT', '/api/nextcloud/connection', { json: { server_url: server.trim(), username: username.trim(), password, folder } });
      setPassword(''); setSelected(undefined); setFiles([]); setSearched(false); setFolders([]); setTrail([]); setPlayQueue([]);
      await load();
      setMessage('Настройки сохранены.');
      if (test) {
        await request('POST', '/api/nextcloud/test');
        setMessage('Подключение работает. Можно искать музыку в вашей папке.');
      }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError(undefined); setMessage('');
    try {
      await request('DELETE', '/api/nextcloud/connection');
      setPassword(''); setSelected(undefined); setFiles([]); setSearched(false); setFolders([]); setTrail([]); setPlayQueue([]);
      await load(); setMessage('Nextcloud отключён. Файлы в облаке сохранены.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const search = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined); setMessage('');
    try {
      const data = await request<{ files: CloudFile[] }>('GET', withQuery('/api/nextcloud/files', { q: q.trim() }));
      setFiles(data.files); setFolders([]); setSearched(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return <div className="mx-auto max-w-5xl pb-10">
    <PageHeader title="Nextcloud" sub="Ваша личная музыка" back="/more" />
    <div className="space-y-6 px-4">
      <p className="max-w-3xl text-sm leading-6 text-muted">Файлы доступны только вашему аккаунту QQMusic. Вы можете слушать и скачивать их; музыка из облака не добавляется в общую библиотеку автоматически.</p>
      {!connection ? error ? <ErrorState text={error} onRetry={() => { setError(undefined); void load().catch((e) => setError(errorMessage(e))); }} /> : <Loading /> : <>
        <form className="space-y-4 rounded-2xl border border-line bg-surface p-5" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">Подключение</h2><span className="text-sm text-muted">{connection.connected ? 'Настроено' : 'Не подключено'}</span></div>
          <div className="grid gap-4 min-[1280px]:grid-cols-2">
            <Field label="Адрес сервера">
              {connection.can_add_server ? <input className="input" type="url" required value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://cloud.example.com" /> : <select className="input" required value={server} onChange={(e) => setServer(e.target.value)}><option value="" disabled>Выберите сервер</option>{connection.allowed_servers.map((url) => <option key={url}>{url}</option>)}</select>}
            </Field>
            <Field label="Имя пользователя Nextcloud"><input className="input" required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
            <Field label="Пароль приложения"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!connection.has_password} autoComplete="new-password" placeholder={connection.has_password ? 'Сохранён. Оставьте пустым, чтобы не менять' : 'Создайте в настройках безопасности Nextcloud'} /></Field>
            <Field label="Музыкальная папка"><input className="input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Music или Музыка/Рок" /></Field>
          </div>
          {!connection.can_add_server && !connection.allowed_servers.length && <Notice>Администратору нужно сначала добавить адрес сервера Nextcloud.</Notice>}
          <p className="text-xs leading-5 text-muted">Укажите корень сервера без /remote.php/dav. Поиск идёт по именам файлов; удобный формат — «Исполнитель - Трек». Пустой путь означает корень ваших файлов.</p>
          <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" busy={busy} disabled={!server || !username}>Сохранить и проверить</Button>
            {connection.connected && <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>Отключить</Button>}</div>
        </form>
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice kind="info">{message}</Notice>}
        {connection.connected && <section className="space-y-4" aria-label="Файлы Nextcloud">
          <h2 className="text-xl font-semibold">Музыка в облаке</h2>
          <div className="flex flex-wrap items-center gap-2"><Button disabled={busy} onClick={() => void browse([])}>Открыть папки</Button>{trail.length > 0 && <Button disabled={busy} onClick={() => void browse(trail.slice(0, -1))}>На уровень выше</Button>}<span className="break-all text-sm text-muted">{[folder || 'Корень', ...trail.map((part) => part.name)].join(' / ')}</span></div>
          <form className="flex gap-2" onSubmit={(e) => void search(e)}><input className="input min-w-0" type="search" aria-label="Поиск в Nextcloud" placeholder="Исполнитель или название файла" maxLength={512} value={q} onChange={(e) => setQ(e.target.value)} required /><Button type="submit" busy={busy} disabled={!q.trim()} icon="search">Найти</Button></form>
          {selected && <div className="space-y-3 rounded-xl border border-line bg-raised p-4"><div className="flex items-center gap-3">{selected.cover_url && <img src={selected.cover_url} alt="Обложка альбома" className="h-20 w-20 rounded-lg object-cover" />}<div><strong className="block break-words">{selected.title}</strong><span className="text-sm text-muted">{selected.artist}{selected.album && ` · ${selected.album}`}</span></div></div><audio key={selected.id} controls autoPlay preload="none" src={audioUrl(selected)} className="w-full" onPlay={() => { stopListening(); pauseNative(); }} onEnded={() => { const next = playQueue[playQueue.findIndex((file) => file.id === selected.id) + 1]; if (next) play(next, playQueue); }} onError={() => setError('Не удалось открыть аудио. Проверьте подключение или выполните поиск заново.')} /></div>}
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4"><h3 className="font-semibold">Личные плейлисты</h3><form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void changePlaylist('create'); }}><input className="input min-w-0" aria-label="Название личного плейлиста" maxLength={128} value={playlistName} onChange={(e) => setPlaylistName(e.target.value)} placeholder="Название нового плейлиста" required /><Button type="submit" disabled={busy || !playlistName.trim()}>Создать</Button></form><div className="flex flex-wrap gap-2"><select className="input min-w-0 flex-1" aria-label="Личный плейлист" value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}><option value="">Выберите плейлист</option>{playlists.map((list) => <option key={list.id} value={list.id}>{list.name} · {list.files.length}{!list.available ? ' · другое подключение' : ''}</option>)}</select><Button disabled={busy || !playlistId} onClick={() => { const list = playlists.find((item) => String(item.id) === playlistId); if (list) { setFiles(list.files); setFolders([]); setSearched(true); } }}>Открыть</Button><Button variant="danger" disabled={busy || !playlistId} onClick={() => void changePlaylist('delete')}>Удалить</Button></div><p className="text-xs text-muted">До 100 треков в плейлисте. Ссылки обновляются при открытии страницы. После смены подключения старые плейлисты доступны при возврате к тому же серверу и папке.</p></div>
          {folders.map((entry) => <Button key={entry.id} disabled={busy} onClick={() => void browse([...trail, entry])}>Папка: {entry.name}</Button>)}
          {searched && !files.length && !folders.length && <Empty icon="search" title="Файлы не найдены" text="Попробуйте другую папку или часть имени файла." />}
          <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface">{files.map((file) => <li key={file.id} className="flex flex-wrap items-center gap-3 p-4"><span className="min-w-0 flex-1"><strong className="block break-words">{file.title}</strong><span className="text-sm text-muted">{file.artist}</span></span><Button small icon="play" onClick={() => play(file)}>Слушать</Button>{playlistId && <Button small disabled={busy} onClick={() => void changePlaylist('add', file)}>В плейлист</Button>}<a className="rounded-full border border-line px-4 py-2 text-sm hover:bg-hover" href={audioUrl(file, true)}>Скачать</a></li>)}</ul>
        </section>}
      </>}
    </div>
  </div>;
}
