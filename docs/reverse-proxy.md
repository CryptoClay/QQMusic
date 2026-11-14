# QQMusic за отдельным Nginx Proxy Manager

Схема: браузер → HTTPS qqmusic.ru → NPM → HTTP по LAN/VPN → сервер QQMusic:8081.
Домен указывает на внешний адрес NPM. Сертификат и перенаправление HTTP на HTTPS настраиваются в NPM.

Установить Docker, клонировать проект, создать `.env` и `config.yaml`, сгенерировать ключи и настроить администратора по README. Для чистой Linux-установки задать:

```dotenv
MUSIC_ROOT=/srv/qqmusic/music
QQM_DOMAIN=qqmusic.ru
QQM_BIND_IP=192.168.88.10
PUBLIC_MODE=true
PUBLIC_HUB_URL=https://qqmusic.ru
PUBLIC_MUSIC_URL=
```

QQM_BIND_IP заменить адресом самого сервера QQMusic в LAN/VPN, доступным с NPM. Создать каталог MUSIC_ROOT/library.
В межсетевом экране разрешить TCP 8081 только от сервера NPM; учитывать правила Docker для опубликованных портов. Прямой доступ извне к upstream не открывать: Hub доверяет заголовкам прокси. Если серверы в разных сетях, соединить их через VPN и использовать его адреса.

Запуск и последующие обновления выполнять с одной и той же парой файлов:

```bash
sudo docker compose -f docker-compose.yml -f deploy/compose.proxy.yml config --quiet
sudo docker compose -f docker-compose.yml -f deploy/compose.proxy.yml up -d --build
sudo docker compose -f docker-compose.yml -f deploy/compose.proxy.yml ps
```

compose.public.yml в этом варианте не подключать: он запускает Caddy. Если уже запущен прежний Caddy этого проекта, перед переключением остановить и удалить только его контейнер через прежнюю пару compose-файлов; тома и базы сохранять.

В NPM добавить Proxy Host:

| Поле | Значение |
| --- | --- |
| Domain Names | qqmusic.ru |
| Scheme | http |
| Forward Hostname / IP | LAN/VPN IP сервера QQMusic |
| Forward Port | 8081 |
| Cache Assets | выключено |
| SSL | сертификат qqmusic.ru, Force SSL |

Прокси должен передавать исходный Host (qqmusic.ru), X-Forwarded-Proto=https и адрес клиента в X-Forwarded-For. Стандартный конфиг NPM уже задаёт эти заголовки; после изменения проверить сгенерированный location. Не заменять Host внутренним IP. В Advanced задать:

```nginx
client_max_body_size 500m;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
```

Буферизация отключается для своевременной доставки SSE. Для авторизации можно ограничить размер запроса отдельно на прокси; общий лимит 500m нужен для импорта аудиофайлов.

Navidrome остаётся на 127.0.0.1:4533. Первого администратора создать через SSH-туннель с ПК:

```bash
ssh -N -L 14533:127.0.0.1:4533 user@QQMUSIC_SERVER
```

Открыть http://127.0.0.1:14533, создать администратора с данными из .env, затем войти в https://qqmusic.ru.
Проверить https://qqmusic.ru/healthz, вход, воспроизведение, загрузку, живые события и работу с телефона. Запрос к внутреннему IP без Host qqmusic.ru может получить 400 — это проверка домена, а не отказ сервиса.

Источники: [NPM](https://nginxproxymanager.com/guide/), [буферизация и заголовки Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
