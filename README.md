# Keenetic DNS Router

**English** · [Русский](README.ru.md)

A web panel for Keenetic routers with Entware. It routes chosen domains, IP addresses and whole IP lists through Keenetic policies (fwmark plus its own routing tables), keeps the addresses up to date by itself, manages BGP (bird4) and shows what the provider blocks. PHP + SQLite on the router, no cron. The interface is in English and Russian.

## Features

- **Targets**: domains, IPs and CIDRs bound to Keenetic policies. Domains are resolved through the DNS you choose (the router's DoH proxy or your own servers); routes go into the panel's tables `400+` with `fwmark` rules of the policy.
- **Lists**: ready sets of addresses and domains of sites (YouTube, Telegram, …) from [iplist.opencck.org](https://iplist.opencck.org), with subnet aggregation and a guard against "half of the list suddenly vanished".
- **Task dispatcher** without cron: ndm hooks (firewall rebuilt, interface state changed) only queue a task; the dispatcher decides what is due and applies the routes. Edits in the panel never block the interface.
- **BGP (bird4)**: a `bird4.conf` wizard, a hook that starts bird together with the tunnel, the rule for the BGP table and a route to the neighbor through the tunnel.
- **Clients**: devices and their connections, client registration and policy through RCI.
- **Tables and interfaces**: routing tables, Keenetic static routes, turning interfaces on and off and their descriptions through RCI (with a preview of the request).
- **Diagnostics**:
  - DPI check: DNS spoofing, blocking by SNI (HTTP / TLS 1.2 / TLS 1.3 / QUIC), connections frozen after 16–20 KB on foreign hostings, a search for "white" SNI names, Telegram reachability; through the provider and through the tunnel side by side;
  - Test Route: where an address goes under a policy mark, plus a real curl request through that interface with any SNI.
- **Updates**: from GitHub releases or from an uploaded archive, with checks and rollback.

## Requirements

- A Keenetic router with Entware and the "OPKG packages" component;
- nginx, PHP 8 (`php8-fpm`, `php8-cli`, the `sqlite3` module), `ip-full`: the installer puts them in;
- optional: `curl` (lists, DPI check, updates), PHP modules `openssl` and `sockets` (DoT and QUIC in the DPI check), `bird1-ipv4` (BGP). The panel shows what is missing in Service → System checks and can install it.

## Install

As root on the router:

```sh
mkdir -p /opt/tmp && cd /opt/tmp
curl -fsSLO https://github.com/korovkin37-stack/keenetic-dns-router/releases/latest/download/install.sh
sh install.sh
```

The installer asks for the router admin password (needed for `su`) and a panel password, downloads the latest release (`dns-router.tar.gz`), installs the packages, sets up nginx and php-fpm, creates the config and the database in `/opt/etc/dns-router/` and the ndm hooks. At the end it prints the panel address, by default `http://router-ip:880/`.

No `curl` on the router: `opkg update && opkg install curl ca-bundle`. Without internet on the router: put `install.sh` and `dns-router.tar.gz` from the [release](https://github.com/korovkin37-stack/keenetic-dns-router/releases/latest) into one folder and run `sh install.sh`.

Installer variables: `PORT=8081` (panel port), `RCI=http://127.0.0.1:79` (RCI address), `WITH_BIRD=1` (install bird), `MANUAL=1` (leave nginx, php and packages alone), `WWW=/path` (panel folder), `RELEASE_URL=…` (where to download the archive from).

## Update

- **From the panel**: Settings → Panel update. "Check for updates" asks GitHub for a new release and shows what changed; "Download and check" fetches the archive (through the interface set for list downloads). You can also drop `dns-router.tar.gz` from a release by hand. Either way the panel checks the archive, lists the changed files and keeps the previous version for rollback. The version badge in the corner lights up when a new release is out.
- **With the installer**: running `sh install.sh` again updates the files and the hooks without asking for passwords. Needed when packages, nginx or php change.

## Security

- `config.php` keeps the router admin password in plain text (the panel runs `ip route/rule` as root through `su`). It lives outside the web folder and is readable by the php-fpm user only. Never publish it or `routes.db`.
- The panel is meant for the local network. Do not open its port to the internet.

## CLI

```
php-cli app.php apply     apply the routes from the database
php-cli app.php event     queue an "event" task (what the hooks do)
php-cli app.php sync      sync the policies with Keenetic
php-cli app.php hooks     install the ndm hooks
php-cli app.php checks    system checks in the console
php-cli app.php passwd P  change the panel password
```

## Translations

Interface strings are written in English; a translation is `lang.<code>.json` next to `index.html`: the key is the English text, `{0}`, `{1}` are the values put in. A new language can be added to an update archive and shows up in the list by itself. See `lang.ru.json`.

## Releases

A tag `vX.Y.Z` builds the release: the version must match `APP_VERSION` in `app.php` and `index.html`, and `CHANGELOG.md` must have a `## X.Y.Z` section; the release text is taken from `CHANGELOG.md` and `CHANGELOG.ru.md`.

## License

[MIT](LICENSE). Third-party material and its licenses: [NOTICE.md](NOTICE.md).
