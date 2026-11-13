import { useEffect, useState } from 'react';
import { Button, Empty, PageHeader, Spinner } from '../components/ui';
import { navigate } from '../lib/router';
import { clearShare, readShare } from '../lib/shareStore';
import { toast } from '../lib/ui';
import { isAudioFile, queueFilesForUpload } from './Upload';

type Phase = { kind: 'working'; text: string } | { kind: 'empty' } | { kind: 'error'; text: string };

// Guards against double processing (StrictMode effects, re-renders).
let running: Promise<void> | null = null;

/**
 * Android "Share" → QQMusic. The service worker stored the shared payload in IndexedDB and redirected here:
 * images, text / link → a new assistant chat with them ready to send, audio → upload form.
 */
export function SharePage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'working', text: 'Открываю то, чем вы поделились…' });

  useEffect(() => {
    if (running) return;
    running = (async () => {
      let payload;
      try {
        payload = await readShare();
      } catch {
        payload = null;
      }
      if (!payload) {
        setPhase({ kind: 'empty' });
        return;
      }
      await clearShare().catch(() => undefined);

      const audio = payload.files.filter(isAudioFile);
      if (audio.length) {
        queueFilesForUpload(audio);
        if (audio.length !== payload.files.length) toast('Загружены только аудиофайлы', 'info');
        navigate('/upload', { replace: true });
        return;
      }
      setPhase({ kind: 'error', text: 'Поддерживаются только аудиофайлы. Скриншоты и текст больше не обрабатываются.' });
    })().finally(() => {
      running = null;
    });
  }, []);

  return (
    <div>
      <PageHeader title="Поделиться" back="/search" />
      {phase.kind === 'working' ? (
        <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
          <Spinner size={32} className="text-accent" />
          <p className="text-muted">{phase.text}</p>
        </div>
      ) : phase.kind === 'empty' ? (
        <Empty icon="note" title="Нечего обрабатывать" text="Поделитесь аудиофайлом из другого приложения и выберите QQMusic.">
          <Button small onClick={() => navigate('/upload', { replace: true })}>
            Загрузить файлы
          </Button>
        </Empty>
      ) : (
        <Empty icon="alert" title="Не получилось" text={phase.text}>
          <Button small onClick={() => navigate('/upload', { replace: true })}>
            Загрузить файлы
          </Button>
        </Empty>
      )}
    </div>
  );
}
