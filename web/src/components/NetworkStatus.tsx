import { useEffect, useState } from 'react';
import { pause, useListen } from '../lib/listen';
import { Button } from './ui';
export function NetworkStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const phase = useListen((s) => s.phase);
  const track = useListen((s) => s.track);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  if (online) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex flex-wrap items-center justify-center gap-3 border-b border-warn/30 bg-bg px-4 py-2 text-sm text-warn"
    >
      Нет сети. Очередь и позиция сохраняются.
      {track && phase !== 'paused' && (
        <Button small onClick={pause}>
          Не возобновлять автоматически
        </Button>
      )}
    </div>
  );
}
