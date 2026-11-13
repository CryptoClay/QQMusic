# QQMusic

Музыкальный сервис для нескольких пользователей: общая библиотека, личные плейлисты, лайки, история и настройки. Сервер хранит музыку локально, браузер работает как полноценный плеер и устанавливаемая PWA. Android сейчас отложен; здесь развиваем сервер и веб.

Репозиторий: [CryptoClay/QQMusic](https://github.com/CryptoClay/QQMusic), рабочая ветка — `main`.

## Возможности и принцип работы

Поиск по каталогам, прослушивание и загрузка треков, импорт своих файлов, личные подключения Nextcloud, очередь, плейлисты, миксы и «Моя волна». Есть тексты песен, страницы исполнителей и альбомов, личные заметки, эквалайзер, выравнивание громкости, плавные переходы и экономия трафика. Администратор управляет пользователями, приглашениями, источниками и загрузками.

Браузер обращается к **Hub** по `/api`. Hub получает метаданные, выбирает источник аудио и готовит поток либо задание загрузки. Скачанный файл получает теги и постоянные UUID, попадает в `library/`, затем запускается сканирование **Navidrome**. Navidrome обслуживает библиотеку, учётные записи и Subsonic API; Hub хранит задания и личные данные в собственной SQLite. Базы находятся в Docker-томах, файлы — в `MUSIC_ROOT`.

**Стек:** Python 3.12, FastAPI, SQLAlchemy, Alembic, SQLite, yt-dlp, FFmpeg, mutagen; React 19, TypeScript, Vite 8, Tailwind CSS 4, Web Audio API, PWA; Docker Compose и Navidrome. Дополнительно: MuQ-MuLan для аудиорекомендаций на NVIDIA GPU, SSH-туннель и Caddy для внешнего HTTPS.

## Первый запуск на Windows

Нужны Docker Desktop с Linux-контейнерами и Python для генерации ключей.

```powershell
Copy-Item .env.example .env
Copy-Item config.example.yaml config.yaml
python -c "import base64,secrets; print('HUB_SECRET_KEY=' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()); print('ND_PASSWORDENCRYPTIONKEY=' + secrets.token_hex(32))"
```

В `.env` вписать выведенные ключи, `MUSIC_ROOT` (например, `C:/Music`) и будущие `NAVIDROME_ADMIN_USER` / `NAVIDROME_ADMIN_PASSWORD`. Ключи после запуска не менять: ими зашифрованы пароли и личные подключения. Создать `library/` в папке с музыкой и предоставить Docker Desktop доступ к этой папке.

```powershell
docker compose up -d --build
docker compose ps
```

Открыть [Navidrome](http://localhost:4533), создать администратора с теми же данными, затем войти в [QQMusic](http://localhost:8081). Остальных пользователей приглашать из веба. Проверка сервера: [healthz](http://localhost:8081/healthz). Основной запуск не требует GPU или VPS.

Дополнительные сервисы включаются профилями или `COMPOSE_PROFILES` в `.env`:

```powershell
docker compose --profile recommendations up -d --build  # NVIDIA GPU, около 3 ГБ весов
# После настройки VPS, ключа и known_hosts в gateway/tunnel/:
docker compose --profile gateway up -d --build
```

## Обновление

**При первом переходе со старых контейнеров HomeMusic использовать миграцию**, чтобы сохранить исходные тома и освободить порты:

```powershell
git pull --ff-only
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Migrate-QQMusic.ps1         # только проверка
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Migrate-QQMusic.ps1 -Apply  # сборка и переключение
```

Скрипт сохраняет базы и старые контейнеры, записывает привязки томов в `.env` и сохраняет включённые дополнительные сервисы. Подробности и откат: [переименование](docs/renaming.md). Прежние названия в совместимых cookie, тегах, томах и Android-мосте оставлены намеренно.

Обычное обновление после перехода:

```powershell
git pull --ff-only
docker compose up -d --build
docker compose logs --tail 100 hub
```

`QQMusic.bat` включает/останавливает стек; `HomeMusic.bat` оставлен как совместимый ярлык. Остановка — `docker compose stop`. Не удалять Docker-тома при обновлении: в них базы пользователей и библиотеки.

## Разработка

Сервер — `hub/app/`, миграции — `hub/migrations/`, веб — `web/src/`, рекомендации — `embedder/`, внешний доступ — `gateway/`. Секреты, музыка и сборки в Git не попадают. Для разработки вне Docker нужны Node.js 22+, Python 3.12, uv и FFmpeg в PATH.

```powershell
cd web
npm ci
npm run dev       # localhost:5173; API проксируется на localhost:8081
npm run build     # TypeScript + сборка в hub/app/static
node --experimental-strip-types --test scripts/test-*.mjs
cd ../hub
uv sync --frozen --group dev
uv run pytest -q
```

Для отдельного сервера разработки задать `QQMUSIC_DEV_BACKEND`; настройки описаны в `.env.example` и `config.example.yaml`. После законченного обновления: проверки, затем осмысленный коммит в `main` и push.

Подробнее: [источники аудио](docs/audio-sources.md), [плеер и тексты](docs/music-experience.md), [резервные копии и восстановление](docs/recovery.md), [миксы](MIXES.md), [аналитика](INSIGHTS.md).
