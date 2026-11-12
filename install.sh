#!/bin/sh
# Keenetic DNS Router: установка и обновление (в том числе с 4.x). Запуск: sh install.sh
# MANUAL=1 sh install.sh: не трогать nginx, php.ini, php-fpm и пакеты (ручная настройка). WWW=/путь: каталог панели.
PATH=/opt/sbin:/opt/bin:$PATH
WWW_ENV=${WWW:-}
WWW=${WWW:-/opt/share/www/dns-router}
NGX=/opt/etc/nginx/nginx.conf
BACKUP_DIR=/opt/var/dns-router-backup
PORT_ENV=${PORT:-}
PORT=${PORT:-880}
RCI=${RCI:-http://127.0.0.1:79}
CONF_DIR=/opt/etc/dns-router

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }
ask_secret() {
    printf '%s' "$1" >&2
    stty -echo 2>/dev/null
    IFS= read -r SECRET
    stty echo 2>/dev/null
    printf '\n' >&2
}

# Returns 0 when the web user can become root with this password, 2 when the check itself cannot run
check_su() {
    SU_OUT=$(PW="$1" su -s /bin/sh nobody -c 'printf "%s\n" "$PW" | /opt/bin/su -c id 2>&1' 2>&1)
    case $SU_OUT in
        *uid=0*) return 0 ;;
        *"invalid option"*|*"applet not found"*|*"not found"*) return 2 ;;
    esac
    return 1
}

[ "$(id -u)" = 0 ] || die "запустите от root"
[ -x /opt/bin/opkg ] || die "Entware не найден (нет /opt/bin/opkg)"

UPGRADE=0
WITH_BIRD=${WITH_BIRD:-0}
GENERATED=0
NEED_PANEL_PASS=0

# Panel 4.x lives somewhere in the web folders (api.php/lib.php), its config.php and routes.db are next to it
if [ -z "$WWW_ENV" ] && [ ! -f "$WWW/app.php" ] && [ ! -f "$CONF_DIR/config.php" ]; then
    for d in $(find /opt/share/www /opt/var/www /opt/www /opt/share/nginx/html -maxdepth 2 -name api.php 2>/dev/null); do
        WWW=$(dirname "$d")
        echo "Найдена панель 4.x: $WWW"
        break
    done
fi
HAD4=0
[ -f "$WWW/api.php" ] || [ -f "$WWW/lib.php" ] && HAD4=1

CONF_FILE=
[ -f "$CONF_DIR/config.php" ] && CONF_FILE="$CONF_DIR/config.php"
[ -z "$CONF_FILE" ] && [ -f "$WWW/config.php" ] && CONF_FILE="$WWW/config.php"
[ -n "$CONF_FILE" ] && UPGRADE=1

# nginx.conf of the installer has the deny rule for ext.php; anything else was written by hand
if [ -z "${MANUAL:-}" ]; then
    MANUAL=0
    if [ $UPGRADE = 1 ] && [ -f "$NGX" ] && ! grep -q 'ext\.php' "$NGX"; then
        echo "Найдена настроенная система (nginx.conf не от установщика)."
        printf 'Оставить nginx, php.ini и php-fpm как есть, пакеты не трогать? [Y/n]: '
        read -r ANS
        case $ANS in n|N|н|Н) MANUAL=0 ;; *) MANUAL=1 ;; esac
    fi
fi
[ $MANUAL = 1 ] && echo "Режим ручной настройки: nginx, php.ini, php-fpm и пакеты не меняются."

if [ $UPGRADE = 0 ]; then
    ask_secret "Пароль admin роутера (панель использует его для su): "
    ROUTER_PASS=$SECRET
    [ -n "$ROUTER_PASS" ] || die "пароль пустой"
    ask_secret "Пароль для входа в панель (Enter - сгенерировать): "
    PANEL_PASS=$SECRET
    GENERATED=0
    if [ -z "$PANEL_PASS" ]; then
        PANEL_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)
        GENERATED=1
    fi
    [ ${#PANEL_PASS} -ge 4 ] || die "пароль панели короче 4 символов"
    printf 'Поставить bird (BGP)? Его маршрутизация настраивается потом в панели [y/N]: '
    read -r ANS
    case $ANS in
        y|Y|д|Д) WITH_BIRD=1 ;;
    esac
    printf 'Порт панели [%s]: ' "$PORT"
    read -r ANS
    [ -z "$ANS" ] || PORT=$ANS
else
    echo "Найден $CONF_FILE: пароль роутера не спрашиваю, обновляю файлы и чиню недостающее."
    if ! grep -q '\$2[aby]\$' "$CONF_FILE"; then
        echo "В конфиге нет пароля панели (старый формат): задайте его сейчас."
        NEED_PANEL_PASS=1
        ask_secret "Пароль для входа в панель (Enter - сгенерировать): "
        PANEL_PASS=$SECRET
        if [ -z "$PANEL_PASS" ]; then
            PANEL_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)
            GENERATED=1
        fi
        [ ${#PANEL_PASS} -ge 4 ] || die "пароль панели короче 4 символов"
    fi
    if [ -z "$PORT_ENV" ]; then
        OLD_PORT=$(sed -n 's/^[[:space:]]*listen[[:space:]]*\([0-9][0-9]*\);.*/\1/p' "$NGX" 2>/dev/null | head -1)
        [ -z "$OLD_PORT" ] || PORT=$OLD_PORT
    fi
fi

while :; do
    case $PORT in
        ''|*[!0-9]*) echo "Порт должен быть числом от 1 до 65535." ;;
        *)
            if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
                echo "Порт должен быть числом от 1 до 65535."
            elif netstat -ltn 2>/dev/null | grep -q "[:.]$PORT " && ! pidof nginx >/dev/null 2>&1; then
                echo "Порт $PORT занят:"
                netstat -ltn 2>/dev/null | grep "[:.]$PORT "
            else
                break
            fi
            ;;
    esac
    printf 'Другой порт панели: '
    read -r PORT
done

PHPCLI=/opt/bin/php-cli
if [ $MANUAL = 1 ]; then
    say "Пакеты: не меняю"
    for c in /opt/bin/php-cli /opt/bin/php8-cli /opt/bin/php; do
        [ -x $c ] && { PHPCLI=$c; break; }
    done
    [ -x $PHPCLI ] || die "не найден php-cli в /opt/bin"
    $PHPCLI -r 'exit(class_exists("SQLite3") ? 0 : 1);' || die "в $PHPCLI нет модуля sqlite3"
    IPFULL=$(readlink -f /opt/sbin/ip 2>/dev/null)
    case $IPFULL in ''|*busybox*) echo "Внимание: нет ip-full (Test Route и Clients с меткой не заработают): opkg install ip-full" ;; esac
else
    say "Пакеты Entware"
    opkg update || die "opkg update не выполнился: нет интернета на роутере?"
    PV=$(opkg list 2>/dev/null | sed -n 's/^\(php[0-9]*\)-mod-sqlite3 .*/\1/p' | tail -1)
    [ -n "$PV" ] || die "в репозитории Entware не найден php-mod-sqlite3"
    PKGS="nginx $PV $PV-cli $PV-fpm $PV-mod-sqlite3 ip-full"
    [ $WITH_BIRD = 1 ] && PKGS="$PKGS bird1-ipv4"
    opkg install $PKGS || die "не удалось установить пакеты"
    [ $WITH_BIRD = 1 ] && { opkg install bird1cl-ipv4 >/dev/null 2>&1 || echo "bird1cl-ipv4 (клиент birdcl4) не установился: панель покажет BGP без состояния сессии"; }
    [ -x $PHPCLI ] || die "нет $PHPCLI после установки ${PV}-cli"
    if ! $PHPCLI -v >/dev/null 2>&1; then
        echo "php не запускается (новому php нужны свежие библиотеки): обновляю пакеты Entware"
        opkg upgrade
        $PHPCLI -v >/dev/null 2>&1 || die "php не запускается и после opkg upgrade: $($PHPCLI -v 2>&1 | head -1)"
    fi
fi

say "Настройка PHP"
PHP_OK='exit(function_exists("shell_exec") && class_exists("SQLite3") && ini_get("allow_url_fopen") && ini_get("open_basedir") === "" ? 0 : 1);'
if ! $PHPCLI -r "$PHP_OK" && [ $MANUAL = 1 ]; then
    echo "Внимание: у php-cli отключены shell_exec/allow_url_fopen или задан open_basedir. php.ini не меняю: итоговую проверку покажет System checks."
elif ! $PHPCLI -r "$PHP_OK"; then
    INI=$($PHPCLI -r 'echo php_ini_loaded_file();')
    [ -n "$INI" ] && [ -f "$INI" ] || die "PHP не готов (shell_exec, sqlite3, allow_url_fopen), а php.ini не найден"
    cp -n "$INI" "$INI.orig"
    sed -i -e 's/^[; ]*disable_functions *=.*/disable_functions =/' \
           -e 's/^[; ]*allow_url_fopen *=.*/allow_url_fopen = On/' \
           -e 's/^[; ]*open_basedir *=.*/;open_basedir =/' "$INI"
    $PHPCLI -r "$PHP_OK" || die "PHP всё ещё не готов: проверьте $INI (disable_functions, open_basedir, модуль sqlite3)"
    echo "Исправлен $INI (копия: $INI.orig)"
else
    echo "ok"
fi

DOCROOT=$($PHPCLI -r 'echo rtrim((string)ini_get("doc_root"), "/");')
if [ -n "$DOCROOT" ] && [ "$DOCROOT" != "$WWW" ]; then
    echo "В php.ini задан doc_root=$DOCROOT, PHP ищет скрипты только там: ставлю панель в $DOCROOT"
    OLD_WWW=$WWW
    WWW=$DOCROOT
fi

FPMCONF=$(ls /opt/etc/php*-fpm.conf /opt/etc/php*-fpm.d/*.conf /opt/etc/php-fpm.conf /opt/etc/php-fpm.d/*.conf 2>/dev/null)
LISTEN=$(sed -n 's/^[[:space:]]*listen[[:space:]]*=[[:space:]]*//p' $FPMCONF 2>/dev/null | head -1 | tr -d '[:space:]')
WEBUSER=$(sed -n 's/^[[:space:]]*user[[:space:]]*=[[:space:]]*//p' $FPMCONF 2>/dev/null | head -1 | tr -d '[:space:]')
if [ $MANUAL = 1 ]; then
    # the account that already owns the 4.x config is the one php-fpm runs as
    [ -n "${WEBUSER_ENV:-}" ] && WEBUSER=$WEBUSER_ENV
    [ -z "$WEBUSER" ] && [ -n "$CONF_FILE" ] && WEBUSER=$(ls -l "$CONF_FILE" | awk '{print $3}')
    [ -z "$WEBUSER" ] || [ "$WEBUSER" = root ] && WEBUSER=$(sed -n 's/^[[:space:]]*user[[:space:]]\+\([A-Za-z0-9_-]*\).*/\1/p' "$NGX" 2>/dev/null | head -1)
fi
[ -n "$WEBUSER" ] || WEBUSER=nobody
if [ $MANUAL = 0 ]; then
    [ -n "$FPMCONF" ] || die "не найдены конфиги php-fpm в /opt/etc"
    [ -n "$LISTEN" ] || die "в конфигах php-fpm не найден listen (искал: $FPMCONF)"
    case $LISTEN in
        /*) FCGI="unix:$LISTEN" ;;
        *[!0-9]*) FCGI=$LISTEN ;;
        *) FCGI="127.0.0.1:$LISTEN" ;;
    esac
    echo "php-fpm: $FCGI, пользователь $WEBUSER"
else
    echo "Пользователь php-fpm: $WEBUSER (владелец config.php, можно задать WEBUSER_ENV=имя)"
fi

if [ $UPGRADE = 0 ]; then
    say "Проверка пароля роутера"
    n=0
    while :; do
        check_su "$ROUTER_PASS"
        rc=$?
        [ $rc = 0 ] && { echo "ok"; break; }
        [ $rc = 2 ] && { echo "Не могу проверить su отсюда, продолжаю. Итоговая проверка в конце."; break; }
        n=$((n + 1))
        printf 'su не принял пароль:\n%s\n' "$SU_OUT" >&2
        [ $n -lt 3 ] || die "пароль admin роутера не подошёл"
        ask_secret "Пароль admin роутера ещё раз: "
        ROUTER_PASS=$SECRET
    done
fi

say "Файлы панели в $WWW"
mkdir -p "$WWW"
if [ $UPGRADE = 1 ] || [ $HAD4 = 1 ] || [ -f "$WWW/app.php" ]; then
    BK="$BACKUP_DIR/before-install-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BK" && tar -czf "$BK/panel.tar.gz" -C "$WWW" . 2>/dev/null
    [ -d "$CONF_DIR" ] && tar -czf "$BK/conf.tar.gz" -C "$CONF_DIR" . 2>/dev/null
    chmod -R go-rwx "$BK" 2>/dev/null
    echo "Резервная копия старой панели, конфига и базы: $BK"
fi
SRC=$(cd "$(dirname "$0")" && pwd)
DATA="$SRC/dns-router.tar.gz"
# Without the archive next to install.sh the last release is downloaded from GitHub
RELEASE_URL=${RELEASE_URL:-https://github.com/korovkin37-stack/keenetic-dns-router/releases/latest/download/dns-router.tar.gz}
if [ ! -f "$DATA" ]; then
    DATA=/opt/tmp/dns-router.tar.gz
    mkdir -p /opt/tmp
    say "Скачиваю панель: $RELEASE_URL"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$DATA" "$RELEASE_URL" || die "не удалось скачать $RELEASE_URL (нужен curl с ca-bundle: opkg install curl ca-bundle)"
    else
        wget -q -O "$DATA" "$RELEASE_URL" || die "не удалось скачать $RELEASE_URL (поставьте curl: opkg install curl ca-bundle)"
    fi
fi
gzip -dc "$DATA" | tar -x -C "$WWW" || die "не удалось распаковать $DATA"
for f in app.php ext.php index.html app.js style.css; do
    [ -f "$WWW/$f" ] || die "в архиве нет файла $f"
done
for f in app.php ext.php index.html app.js style.css; do chmod 644 "$WWW/$f"; done
chmod 644 "$WWW"/lang.*.json 2>/dev/null
# php.ini doc_root moved the panel: config and database stay with it
if [ -n "${OLD_WWW:-}" ] && [ -n "$CONF_FILE" ] && [ "$(dirname "$CONF_FILE")" = "$OLD_WWW" ]; then
    cp -a "$CONF_FILE" "$WWW/config.php" && CONF_FILE="$WWW/config.php"
    for f in "$OLD_WWW"/routes.db*; do [ -f "$f" ] && cp -a "$f" "$WWW/"; done
fi
# files of panel 4.x are not used any more (a copy is in the backup)
if [ $HAD4 = 1 ]; then
    for f in lib.php api.php login.php logout.php setup.php setup_api.php create_db.php check_ip.php update_route.php sync_policies.php generate_password_hash.php; do
        rm -f "$WWW/$f"
    done
    rm -rf "$WWW/css" "$WWW/js"
    echo "Удалены файлы панели 4.x (lib.php, api.php, css/, js/ и др.)"
fi
if [ -n "${OLD_WWW:-}" ] && [ -f "$OLD_WWW/app.php" ]; then
    for f in app.php ext.php index.html app.js style.css; do rm -f "$OLD_WWW/$f"; done
    rmdir "$OLD_WWW" 2>/dev/null
fi
echo "app.php ext.php index.html app.js style.css"

if [ $MANUAL = 0 ]; then
    WEBGROUP=$(id -gn "$WEBUSER" 2>/dev/null)
    case $WEBGROUP in
        ''|*[!A-Za-z_]*) WEBGROUP= ;;
    esac
    GID=$(id -g "$WEBUSER" 2>/dev/null)
    if [ -z "$WEBGROUP" ]; then
        [ -n "$GID" ] || die "не удалось определить группу пользователя $WEBUSER"
        WEBGROUP=$(awk -F: -v g="$GID" '$3 == g { print $1; exit }' /opt/etc/group 2>/dev/null)
        if [ -z "$WEBGROUP" ]; then
            echo "nogroup:x:$GID:" >> /opt/etc/group
            WEBGROUP=nogroup
            echo "В /opt/etc/group добавлена группа nogroup (gid $GID)"
        fi
    fi
    FPMGROUP=$(sed -n 's/^[[:space:]]*group[[:space:]]*=[[:space:]]*//p' $FPMCONF | head -1 | tr -d '[:space:]')
    if [ -n "$FPMGROUP" ] && ! grep -q "^$FPMGROUP:" /opt/etc/group 2>/dev/null; then
        echo "$FPMGROUP:x:$GID:" >> /opt/etc/group
        echo "В /opt/etc/group добавлена группа $FPMGROUP (gid $GID) для php-fpm"
    fi

    case $LISTEN in
        /*)
            LFILE=$(grep -l '^[[:space:]]*listen[[:space:]]*=' $FPMCONF | head -1)
            cp -n "$LFILE" "$LFILE.orig"
            sed -i -e '/^[[:space:]]*listen\.owner[[:space:]]*=/d' -e '/^[[:space:]]*listen\.group[[:space:]]*=/d' -e '/^[[:space:]]*listen\.mode[[:space:]]*=/d' "$LFILE"
            sed -i -e "/^[[:space:]]*listen[[:space:]]*=/a listen.mode = 0660" \
                   -e "/^[[:space:]]*listen[[:space:]]*=/a listen.group = $WEBGROUP" \
                   -e "/^[[:space:]]*listen[[:space:]]*=/a listen.owner = $WEBUSER" "$LFILE"
            echo "Права сокета php-fpm: $WEBUSER:$WEBGROUP, 0660 ($LFILE)"
            ;;
    esac
else
    WEBGROUP=$(id -gn "$WEBUSER" 2>/dev/null)
fi

if [ $MANUAL = 1 ]; then
    say "nginx: не меняю"
    if [ -f "$NGX" ] && ! grep -q 'ext\.php' "$NGX"; then
        echo "Добавьте в server панели (и перезагрузите nginx: nginx -s reload):"
        echo '    location ~ ^/(config\.php|routes\.db|ext\.php|dpi/.*)$ { return 404; }'
        echo '    add_header X-Content-Type-Options nosniff always;'
        echo '    add_header X-Frame-Options DENY always;'
        echo '    client_max_body_size 8m;   # загрузка обновления через вкладку Settings'
        echo "Файлы lang.*.json отдаются как обычная статика из каталога панели."
    fi
    nginx -t 2>&1 | tail -2
else
    say "nginx на порту $PORT"
    NGX=/opt/etc/nginx/nginx.conf
    mkdir -p /opt/etc/nginx /opt/var/log/nginx /opt/var/run
    [ -f "$NGX" ] && cp -n "$NGX" "$NGX.orig"
    cat > "$NGX" <<EOF
user $WEBUSER $WEBGROUP;
worker_processes 1;
pid /opt/var/run/nginx.pid;
error_log /opt/var/log/nginx/error.log;
events { worker_connections 128; }
http {
    include /opt/etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log off;
    sendfile on;
    client_max_body_size 8m;
    server {
        listen $PORT;
        root $WWW;
        index index.html;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        location ~ ^/(config\.php|routes\.db|ext\.php|dpi/.*)\$ { return 404; }
        location ~ \.php\$ {
            include /opt/etc/nginx/fastcgi_params;
            fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
            fastcgi_pass $FCGI;
        }
    }
}
EOF
    if ! nginx -t; then
        [ -f "$NGX.orig" ] && cp "$NGX.orig" "$NGX"
        die "nginx не принял конфиг (оригинал восстановлен из $NGX.orig)"
    fi
fi

say "Конфиг, база и ndm-хуки"
DNSR_CONFIG="$CONF_FILE" DNSR_ROUTER_PASS="${ROUTER_PASS:-}" DNSR_PANEL_PASS="${PANEL_PASS:-}" DNSR_RCI="$RCI" DNSR_WEB_USER="$WEBUSER" \
    $PHPCLI "$WWW/app.php" install || die "app.php install не выполнился. Если RCI на другом порту: RCI=http://127.0.0.1:ПОРТ sh install.sh"

if [ $GENERATED = 1 ]; then
    echo "Пароль панели (логин admin): $PANEL_PASS  <- сохраните"
fi

say "Перезапуск сервисов"
for s in /opt/etc/init.d/S*php*fpm*; do
    [ -x "$s" ] && "$s" restart
done
if [ $MANUAL = 0 ]; then
    PIDF=/opt/var/run/nginx.pid
    # opkg may have started nginx with its stock config (and an empty pid file): stop it by hand so the new config is read cleanly
    for s in /opt/etc/init.d/S*nginx*; do
        [ -x "$s" ] && "$s" stop >/dev/null 2>&1
    done
    NP=$(pidof nginx 2>/dev/null)
    if [ -n "$NP" ]; then
        kill $NP 2>/dev/null
        sleep 1
        NP=$(pidof nginx 2>/dev/null)
        [ -n "$NP" ] && kill -9 $NP 2>/dev/null
    fi
    rm -f "$PIDF"
    for s in /opt/etc/init.d/S*nginx*; do
        [ -x "$s" ] && "$s" start
    done
    if ! pidof nginx >/dev/null 2>&1; then
        nginx 2>&1
    fi
else
    echo "nginx не перезапускаю (ручная настройка)."
fi

say "Проверка"
n=0
while [ $n -lt 10 ]; do
    OUT=$(wget -q -O - "http://127.0.0.1:$PORT/app.php?action=state" 2>&1) && break
    n=$((n + 1))
    sleep 1
done
echo "$OUT"
case $OUT in
    *'"state"'*) ;;
    *)
        if [ $MANUAL = 1 ]; then
            echo "Панель не ответила на 127.0.0.1:$PORT (при ручной настройке порт мог быть другим): проверьте адрес сами."
        else
            die "панель не отвечает на порту $PORT. Лог: /opt/var/log/nginx/error.log. Порт $PORT может быть занят"
        fi
        ;;
esac
CHK=$(su -s /bin/sh "$WEBUSER" -c "$PHPCLI $WWW/app.php checks" 2>&1)
echo "$CHK"
case $CHK in
    *"[!!]"*)
        echo
        echo "Красные пункты выше: обязательные нужно исправить по подсказкам, bird и BGP-хук необязательные и настраиваются в панели."
        echo "Если проблема в su (пароль admin роутера сменился): удалите $CONF_FILE и запустите install.sh ещё раз, база с целями сохранится."
        ;;
esac

# Leftovers of the old panel that would run old scripts or fight over routes
if [ $UPGRADE = 1 ]; then
    CRON=$( { crontab -l 2>/dev/null; cat /opt/etc/crontab /opt/var/spool/cron/crontabs/root /opt/etc/cron.d/* 2>/dev/null; } | grep -E 'check_ip|update_route|sync_policies|dns-router' )
    if [ -n "$CRON" ]; then
        echo
        echo "В cron остались задания старой панели: удалите их (crontab -e), хуки ndm их заменяют:"
        echo "$CRON"
    fi
    OLDHOOKS=$(grep -lE 'check_ip|update_route|api\.php|dns-router' /opt/etc/ndm/*/* 2>/dev/null | grep -v -e '/50-dns-router.sh$' -e '/60-dns-router-bird.sh$')
    if [ -n "$OLDHOOKS" ]; then
        echo
        echo "Найдены чужие ndm-хуки со старой панелью: проверьте и удалите ненужные (панель ставит свои 50-dns-router.sh и 60-dns-router-bird.sh):"
        echo "$OLDHOOKS"
    fi
fi

IP=$(ip -4 addr show br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
printf '\nГотово. Панель: http://%s:%s/\n' "${IP:-192.168.1.1}" "$PORT"
if [ $UPGRADE = 0 ] || [ $NEED_PANEL_PASS = 1 ]; then
    echo "Логин: admin"
    [ $GENERATED = 1 ] && echo "Пароль: $PANEL_PASS"
fi
[ -z "${BK:-}" ] || echo "Откат: старая панель, конфиг и база в $BK"
exit 0
