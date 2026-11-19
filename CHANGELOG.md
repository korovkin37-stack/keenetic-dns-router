# Changelog

**English** · [Русский](CHANGELOG.ru.md)

## 5.45.5
- One folder for every temporary file of the panel: task state and logs, locks, downloads and update stages. Before, downloads and update stages went to /opt/tmp while the task state and the writer's lock went to the system temp folder: a task started by a router event could write where the page does not look, and the two writers did not share the lock. Root opens /opt/tmp for the web user so both see the same folder; without it the system one is used.
- Old update stages are really cleaned up: they were created in one folder and looked for in another, so the leftovers of a failed update stayed on the drive.
- System checks: "Temporary files folder" shows which folder the panel uses and whether it can write to it.
- Downloads (lists and catalog, own lists by a link, GitHub): a failed connection is retried twice instead of failing the whole list, the connect gets 15 s instead of 10 and the transfer 120 s instead of 60, and a transfer that stalled is cut instead of hanging. IPv4 only, like the rest of the panel; proxy variables of the environment are ignored.
- A download that failed says why: the reason, the interface it went through and its state when it is down, the host and the text of curl. An interface that no longer exists on the router is reported before curl is even started. The stray "123" in the message is gone.
- app.php fetch <url> from the shell: checks the download path with the panel's own settings and prints the folder, the curl, the interface, the seconds, the bytes and the reason.

## 5.45.4
- Fix bugs.

## 5.45.3
- Fix bugs.

## 5.45.2
- Own lists: the example in the text field no longer suggests that `*.example.com` catches subdomains; the hint says it counts as example.com.
- The hint of "Downloads through the interface" lists everything that goes through it: iplist lists and catalog, own lists by a link, the GitHub update.
- DNS for domain lookups: "Send these servers through the interface" puts a route to every chosen server through a tunnel, like the route to the BGP neighbor, so the panel's lookups go through it. Local and private addresses are never routed away; the routes come back after the interface reconnects.

## 5.45.1
- Connectivity check in the interface window: the Keenetic ping-check of the interface (hosts, interval, failures in a row) with its live state. Two modes: "Only watch" (ignore-fail: the interface stays on, the panel reads the result; groundwork for the backup exit) and "Turn the interface off" (Keenetic turns it off itself). The panel keeps its own profile `dnsr-<interface>` and only shows profiles made in the Keenetic web interface.
- The connectivity check has all the modes of Keenetic: ICMP, TCP port, TLS on a TCP port, automatic (with the port for the TCP ones).
- "Connectivity checks" on the Interfaces tab: every profile with its interfaces and their state in one window.
- The "Connectivity checks" window shows a card per interface: state, method and hosts, failures in a row against the threshold, the share of passed checks, the mode and who made the profile; it refreshes every 10 s while open. Tunnels without a check are listed with a button to set one up.
- Own lists: "+ Own list" on the Lists tab takes a pasted text or a link to a file. Every line is recognized by itself: a domain, an IP or a network; comments, hosts files, adblock lines (`||example.com^`), v2fly (`domain:`, `full:`), `*.example.com` and links are understood. "Check" shows what was found and which lines were skipped and why. An own list then works like any other: one row, subnets merged, the guard against a list that lost half of its entries, domains resolved through your DNS on every update; a link is downloaded again each time.
- Every gateway field (targets, editing several targets, lists, own lists, the catalog, static routes, the bird wizard) offers the gateways already used by targets and lists, the most used first.
- A task started by the router says which events asked for it: "Router event: Wireguard0 came up, firewall rebuilt (mangle)" in the task list, and an "event: …" line at the top of its log. Events that come while the task waits in the queue are added to it. The ndm hooks now pass the interface and the table to the panel; they are rewritten by the update itself (a hook with your own text keeps it).
- Backup exit for targets and lists (an interface or a gateway). At every apply the panel checks the main exit: when Keenetic says it is not connected or its connectivity check fails, the routes go to the backup; when it works again, they come back. Only the changed routes are written. A gateway is matched to its interface by the subnet, so targets set by a gateway work too. A backup that is down as well is not used.
- The targets table shows a struck main exit → the backup while it is used, and a banner on top; the connectivity check cards say since when the backup is on and what moved where. The task log has "failover:" lines.
- Editing several targets can set or remove the backup exit; export and import keep it.
- The ndm interface hook also reports an interface going down; the panel starts a task only when that interface is the main exit of something with a backup.
- A policy is shown with its description everywhere: target details, every policy list (targets, lists, catalog, editing several targets, test route, clients, BGP, import), the clients table and connections, the table check, the DPI check. The description is no longer translated ("Custom VPN" stayed "Custom VPN" only in some places).
- The backup exit messages name the interfaces with their descriptions: "Wireguard2 (amnezia, nwg2) is not connected … on the backup exit GigabitEthernet1 (ISP, eth3)".

## 5.42.1
- Editing several targets is one window: policy, interface and gateway together, each can be kept as is.

## 5.42.0
- Several targets at once: tick targets in the table (a tick in a policy header takes all its shown targets, Shift+click takes a range, the tick in the table header takes everything shown). A bar at the bottom changes the exit (interface and gateway, each can be kept, set or emptied), moves to another policy, switches on and off or deletes. One transaction and one task for the routes; targets that would be left without an exit or already exist in the new policy are skipped and named.
- The search on Targets also finds the interface and the gateway.

## 5.41.4
- Fixed tasks started from the panel hanging forever with an empty log: the background process wrote its output into a file named after the owner of app.php, so once a hook (root) had created that file the web user could not open it, and the shell did not start the task at all. The file is now named after the user that starts the process.
- Background processes are started with `setsid`: a restart of php-fpm no longer takes them down.

## 5.41.3
- A running task can be killed at any step, also while the routes are written (with a confirmation): the process and what it runs (su, ip, curl) are killed as root.
- A task whose process never came up no longer hangs as "running" forever: the shell around it is watched from the first second, and a task without a process for a minute is closed.
- The task log starts with the pid of the process and shows the steps of applying (reading the tables, how many routes to write and to fix).

## 5.41.2
- The "Tasks" button spins while a task runs or waits in the queue; its tooltip says how many.

## 5.41.1
- The table check is easier to find: a "Tables and database" card at the top of Diagnostics, and a counter on the "Apply routes" button when applying would change something.

## 5.41.0
- Tables and database: a new "Routes" item in the status panel compares the routing tables of the router with the targets and lists in the database and shows the result (in sync / number of differences). A click opens the details per policy and table: routes missing in the router, routes pointing to another interface or gateway, routes and ip rules the database does not have. It only reads; "Apply routes" in the same window fixes everything. The check runs at start, after every task and on request.
- The check and the apply share one plan, so what the check shows is exactly what applying will do.

## 5.40.2
- Applying compares the tables with what they must hold and writes only the difference: missing routes and routes with another gateway or interface. When nothing changed, nothing is written and no root call is made, so hooks firing often cost nothing and the router does not stutter. The task log shows how many routes were added, changed, removed and left untouched.

## 5.40.1
Fixes after review of 5.40.0.
- ip rules that are already right stay untouched; a rule that the router refused to add is reported in the task and in the list window instead of a silent "routes applied".
- A target cannot be a /0 network; a default route left in a policy table is removed on the next apply.
- `enabled` in targets and imports no longer needs the PHP filter extension, which minimal Entware builds lack.

## 5.40.0
The second round of the audit.
- Routes are applied without a gap: new routes are written over the old ones, then the stale ones are removed; the tables are never emptied, so traffic of a target keeps its route the whole time. Two root calls instead of dozens.
- bird4.conf is checked with `bird -p` before saving; a config bird rejects is not written. Turning on the bird log no longer mistakes "No syntax errors" for an error.
- DPI runs are kept in the database instead of the `dpi/` folder (old runs move over by themselves).
- Downloads (lists, GitHub): at most 20 MB, http(s) only, redirects only to https; a list source cannot point to the router itself.
- Policy marks from Keenetic are taken only as plain hex before they reach `ip rule` and the bird hook.
- At most 100 policies (the lists table sits 100 above the policy's own one).
- Import of targets is one transaction: all or nothing, and much faster.
- Editing, deleting and refreshing a target that no longer exists says so; `enabled` is read as a boolean.
- A list with more than 1000 domains says that the rest were not resolved; lists are read line by line.
- At most 8 DNS servers in the DNS test, at most two tests at a time; route test curl runs one by one.
- While the panel files are being replaced other requests wait (503) instead of meeting old and new code side by side.
- Windows: Tab stays inside the window, the page under it does not scroll, focus returns after closing; the close cross is a button.
- Detail windows ignore late answers to an earlier request.

## 5.39.0
Security hardening after an audit.
- No inline click handlers in the panel any more; a Content-Security-Policy forbids foreign scripts.
- The password for `su` goes through stdin and no longer shows in the process list.
- Actions that change something are accepted only as a JSON POST (protection against cross-site requests).
- 5 wrong passwords from one address lock the sign-in for 5 minutes.
- Update from GitHub: the archive is checked against the sha256 that GitHub gives, an older or the same version is refused.
- RCI requests time out after 15 s; an empty list of policies from Keenetic no longer wipes the policies in the panel.
- Lists skip 100.64/10, 172.16/12, 198.18/15 and the documentation networks too.
- A static route wider than /8 (0.0.0.0/0 included) asks for confirmation.
- Faster tables of targets and policies; sorting by the current IP is numeric; the DNS limit message says 8.
- nginx (fresh install): `nosniff` and `X-Frame-Options` headers, the `dpi/` folder is closed. On an existing install add `dpi/.*` to the `location` that hides `config.php`.

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
