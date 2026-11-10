# Changelog

**English** · [Русский](CHANGELOG.ru.md)

## 5.38.1
- Multi-line tooltips (the DPI check among them) and multi-line notes in the check results are translated now.
- The release notes in the panel follow the interface language.
- English README; release descriptions are built from the changelog.

## 5.38.0
- Updates from GitHub: Settings → Panel update shows the new release and what changed, downloads the archive and installs it with the same checks and rollback; the version badge lights up when a new release is out.

## 5.37.0
- DPI check: delete saved runs one by one or all at once.

## 5.36
- White SNI: a "best names" summary that opens to show where each name passed and where it did not; the cut test is always on together with White SNI.

## 5.35
- QUIC in the domain check: an own Initial packet in PHP, verdicts OK / CLOSED / TIMEOUT, checks through the tunnel (sockets module).
- The check tables fill while the run goes; one order of the tests everywhere.
- System checks: PHP modules are checked with `extension_loaded()`, the install buttons update the PHP core together with the module.

## 5.34
- Test Route: a real curl request through the interface of the route, any SNI, a pick from the white names, details per row.

## 5.31–5.33
- Editable DPI check lists, own SNI for the hostings test, White SNI as a table by AS.
- Certificates in the domain check: what the server really gives, "foreign name" told apart from "untrusted".
- DNS: the route of each query, answer codes (NXDOMAIN, NODATA, SERVFAIL).

## 5.29–5.30
- DPI check (after dpi-detector) and the Diagnostics tab.

## 5.28
- Clients: registration and policy through RCI.

## 5.24–5.27
- Task dispatcher with a queue and a pause, edits without blocking, compact Settings and Service tabs, sorting and a policy filter for clients, the BGP rule restored after the routes are applied.
