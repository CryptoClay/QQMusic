import { Icon } from '../components/Icon';
import type { ReactNode, RefObject } from 'react';
import { Button } from '../components/ui';
import type { SearchTab } from '../pages/Search';

export function DesktopSearchHeader({ tab, onTab, query, onQuery, inputRef }: { tab: SearchTab; onTab: (tab: SearchTab) => void; query: string; onQuery: (query: string) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  return (
    <header className="px-8 pb-5 pt-2">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.12em] text-accent">Каталог QQMusic</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Поиск</h1>
          <p className="mt-1 text-sm text-muted">Найдите музыку в каталоге, своей библиотеке или среди файлов источников.</p>
        </div>
        <div className="hidden items-center gap-2 text-xs text-dim xl:flex"><Icon name="search" size={16} />Поиск по названию или исполнителю</div>
      </div>
      <div className="mt-5 relative max-w-3xl">
        <Icon name="search" size={19} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dim" />
        <input ref={inputRef} type="search" maxLength={512} className="input h-12 rounded-xl pl-11 pr-11" placeholder="Исполнитель, альбом или трек" aria-label="Поиск" value={query} onChange={(e) => onQuery(e.target.value)} />
        {query && <button type="button" aria-label="Очистить поиск" onClick={() => onQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">×</button>}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Где искать">
        {([
          ['catalog', 'Всё', 'Библиотека, артисты, альбомы и треки'],
          ['library', 'Библиотека', 'Локальные файлы и качество'],
          ['files', 'Файлы', 'Доступные исходники'],
          ['reuploads', 'Без цензуры', 'Перезаливы'],
        ] as const).map(([value, label, hint]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            title={hint}
            onClick={() => onTab(value)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${tab === value ? 'border-accent bg-accent text-on-accent' : 'border-line bg-raised text-muted hover:border-accent/60 hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </header>
  );
}

export function DesktopSearchEmpty({ onSearch }: { onSearch: () => void }) {
  return (
    <section className="mx-8 mt-4 rounded-2xl border border-line bg-surface/60 px-8 py-14 text-center" aria-label="Пустой поиск">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Icon name="search" size={30} /></div>
      <h2 className="mt-5 text-xl font-bold">Начните с поиска</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">Введите исполнителя, альбом или трек в поле поиска. Здесь появятся результаты и история ваших запросов.</p>
      <Button small variant="secondary" icon="search" className="mt-5" onClick={onSearch}>Открыть поиск</Button>
    </section>
  );
}

export function DesktopSearchResults({ children }: { children: ReactNode }) {
  return <div className="desktop-search-results mx-auto max-w-[1180px] px-8 pb-12">{children}</div>;
}
