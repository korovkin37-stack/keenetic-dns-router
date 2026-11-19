# Keenetic DNS Router

A self-hosted panel for a Keenetic router that routes chosen domains, IP lists and whole
services through the policy you pick — a VPN tunnel, a second provider, or a BGP feed.

The panel keeps its targets in SQLite, resolves them through the DNS servers you choose,
downloads IP lists from a source such as [iplist.opencck.org](https://iplist.opencck.org),
and writes the routes into the policy tables of the router with `ip rule` / `ip route`.
It runs on the router itself under Entware: PHP + nginx, no cloud, no build step.

**Version 5.45.6** · [Changelog](CHANGELOG.md) · [Изменения по-русски](CHANGELOG.ru.md)

---

## What it does

| Tab | Purpose |
|---|---|
| **Targets** | Domains, IPs and networks, each with its policy and exit (interface and gateway). Resolved on a schedule, grouped by policy, bulk editing, backup exit. |
| **Policies** | Keenetic policies with their fwmark and routing table, live traffic and route counts. |
| **Lists** | IP/domain lists from a source, a catalog of services, and your own lists from pasted text or a link. Subnets are aggregated, a list that lost half its entries is held back. |
| **Clients** | Devices from the router, their policy, live connections, registration. |
| **Interfaces** | Router interfaces, addresses, statistics, WireGuard peers, Keenetic connectivity checks (ping-check). |
| **Routing tables** | Live kernel tables and rules, the router's own static routes, and the routing order. |
| **Diagnostics** | DPI check after [dpi-detector](https://github.com/Runnin4ik/dpi-detector): spoofed DNS, TLS reset by SNI, the 16–20 KB cut, QUIC, white SNI, Telegram data centres. |
| **Tools** | Test route (a real `curl` through the interface of a route), bird4/BGP with a config wizard, ndm hooks, system checks. |
| **Settings** | DNS for lookups, downloads through an interface, task pause, panel update from GitHub. |

Routes are applied without a gap: new routes are written over the old ones and only then
are the stale ones removed, so traffic keeps its route the whole time. When nothing
changed, nothing is written and no root call is made.

Long work (resolving, downloading, applying) runs as a background task on the router with
a queue and a log — the page can be closed. ndm hooks re-apply the routes when the
firewall is rebuilt or an interface changes.

## Requirements

* Keenetic with the **OPKG packages** component enabled, and Entware installed on a drive.
* nginx + `php-fpm` and `php-cli`, **PHP 8.1 or newer** (`array_is_list()` is used), with `php-mod-sqlite3`.
* `ip-full` (the busybox `ip` cannot do `route get ... mark`), `curl`, `ca-bundle`.
* Optional: `php-mod-openssl` and `php-mod-sockets` for the DoT and QUIC columns of the DPI
  check, `bird1-ipv4` for BGP.
* The admin password of the Keenetic web UI — it is used for `su` to run `ip rule`/`ip route`.

The panel checks all of this itself: **Tools → System checks**, or `app.php checks` from
the shell. Every failed check comes with the command that fixes it.

## Install

Put the panel files in a directory served by nginx (for example `/opt/www/dns-router`),
then as root:

```sh
DNSR_ROUTER_PASS='keentic-admin-password' \
DNSR_PANEL_PASS='panel-password' \
DNSR_WEB_USER=nobody \
/opt/bin/php-cli /opt/www/dns-router/app.php install
```

| Variable | Meaning | Default |
|---|---|---|
| `DNSR_ROUTER_PASS` | Keenetic admin password, used for `su` | required |
| `DNSR_PANEL_PASS` | Password for the panel itself (4+ characters) | required |
| `DNSR_PANEL_USER` | Panel login | `admin` |
| `DNSR_WEB_USER` | User that nginx/php-fpm runs as | `nobody` |
| `DNSR_CONF_DIR` | Where `config.php` and the database live | `/opt/etc/dns-router` |
| `DNSR_RCI` | Local Keenetic RCI address | `http://127.0.0.1:79` |

The installer writes `config.php`, creates the database, installs the ndm hooks and fixes
the ownership so the web user can write. It keeps an existing config and database.

Alternatively open the panel in a browser and follow the two-step setup wizard: it shows
the system checks, asks for the router access and the panel login, then creates the database.

`config.php` is looked up in this order: `$DNSR_CONFIG`, `/opt/etc/dns-router/config.php`,
`config.php` next to `app.php`. See [config.example.php](config.example.php).

### nginx

Serve the panel directory over HTTPS if it is reachable from outside the LAN. `app.php`
sends `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` itself, and the page
carries a Content-Security-Policy that forbids foreign scripts.

The installer does **not** touch your nginx configuration. Make sure `config.php` (it holds
the router password) and the database are not served — keep them outside the web directory
(the default `/opt/etc/dns-router` already is), or deny them explicitly:

```nginx
location ~ /(config\.php|routes\.db|dpi/.*) { deny all; }
```

## Command line

```
app.php <apply|update|event|sync|listsync|job|fetch|passwd|hooks|checks|install>
```

| Command | What it does |
|---|---|
| `apply` | Write the routes from what is stored — no DNS lookups, no downloads. |
| `update` / `event` | Queue a task (this is what the ndm hooks call). |
| `sync` | Re-read the policies from Keenetic. |
| `fetch <url>` | Check the download path with the panel's own settings: folder, curl, interface, seconds, bytes and the reason it failed. |
| `checks` | System checks with the commands that fix them. |
| `hooks` | Reinstall the ndm hooks. |
| `passwd <new>` | Change the panel password. |
| `install` | Install or repair the panel (see above). |

## Updates

**Settings → Panel update** shows the newest release and what changed, downloads
`dns-router.tar.gz` from GitHub, verifies it against the sha256 that GitHub publishes,
checks the PHP syntax of every file, and installs it with a rollback. An older or the same
version is refused. A `.tar.gz` can also be uploaded by hand.

Only these files are ever taken from an archive: `app.php`, `ext.php`, `index.html`,
`app.js`, `style.css` and `lang.<code>.json`. Anything else — including directory entries —
makes the panel reject the whole archive.

### Making a release

Tag the commit `vX.Y.Z` (the version must match `APP_VERSION` in `app.php`, `JS_VERSION`
in `app.js` and the badge in `index.html`) and push the tag. The workflow in
[.github/workflows/release.yml](.github/workflows/release.yml) builds `dns-router.tar.gz`
with exactly the allowed files and publishes the release with the notes taken from
`CHANGELOG.md`.

To build the same archive by hand:

```sh
tar --no-recursion --format=gnu -czf dns-router.tar.gz \
    app.php ext.php index.html app.js style.css lang.ru.json
```

`--no-recursion` with an explicit file list matters: a directory entry inside the archive
is enough for the panel to refuse it.

## Languages

English is built in — every string in the code is English. A language is a file
`lang.<code>.json` next to `app.php`:

```json
{ "_name": "Русский", "strings": { "English text": "Перевод" } }
```

Keys may contain `{0}`, `{1}`… for values. The DOM is translated as it appears, so the rest
of the code writes plain English. Russian ships with the panel.

## Notes

* All temporary files — task state and logs, locks, downloads, update stages — live in one
  folder: `/opt/tmp` when it is available, otherwise the system one. **Tools → System
  checks** shows which one is in use.
* The router's own traffic does not follow Keenetic policies. That is why the DPI check,
  the Test route curl and the panel downloads choose their interface explicitly.
* Sign-in is a signed cookie (no PHP sessions — `ext-session` is often missing on Entware);
  changing the panel password invalidates every cookie. Five wrong passwords from one
  address lock the sign-in for five minutes.

## Third-party material

See [NOTICE.md](NOTICE.md). The DPI check follows the idea and the built-in lists of
[Runnin4ik/dpi-detector](https://github.com/Runnin4ik/dpi-detector) (MIT); the checks
themselves are written anew in PHP. List data is downloaded from the source at run time and
is not part of this repository.

## Tests

`tests/` holds the checks used while changing the panel: `php tests/harness.php` exercises
the temporary folder and the download function against a stub `curl`, `node tests/i18n_run.js`
runs the panel's own translation engine over the message strings. See [tests/README.md](tests/README.md).
