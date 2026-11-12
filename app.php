<?php
const APP_VERSION = '5.40.1';
const COOKIE_NAME = 'krdns_auth';
const COOKIE_TTL = 604800;

if (PHP_SAPI !== 'cli') {
    ini_set('display_errors', '0');
    error_reporting(E_ALL);
}

$caught = [];
set_error_handler(function ($no, $msg, $file, $line) {
    if (!(error_reporting() & $no)) return false;
    $GLOBALS['caught'][] = sprintf('%s in %s:%d', $msg, basename($file), $line);
    return false;
});

// RCI and other HTTP reads must not hang a request for a minute
ini_set('default_socket_timeout', '15');

// ============================================ CONFIG ============================================
$db_file = __DIR__ . '/routes.db';
$rci_host = 'http://127.0.0.1:79';
$our_table_start = 400;
$passwd = '';
$auth_user = 'admin';
$auth_pass_hash = '';
$php_cli = '/opt/bin/php-cli';
$bird_config_file = null;
$bird_init_script = null;

function findConfig() {
    foreach ([getenv('DNSR_CONFIG'), '/opt/etc/dns-router/config.php', __DIR__ . '/config.php'] as $f) {
        if ($f && is_file($f)) return $f;
    }
    return null;
}

$configFile = findConfig();
if ($configFile !== null) include $configFile;

function hasPasswordHash() {
    global $auth_pass_hash;
    return preg_match('/^\$2[aby]\$/', (string)$auth_pass_hash) === 1;
}

// noconfig -> nodb -> login -> ok
function appState() {
    global $db_file;
    if (!hasPasswordHash()) return 'noconfig';
    if (!file_exists($db_file)) return 'nodb';
    return checkAuthCookie() === null ? 'login' : 'ok';
}

// ============================================ AUTH ============================================
// Signed cookie instead of PHP sessions (ext-session is often missing on Entware).
// The secret derives from the password hash, so changing the password invalidates all cookies.
function authSecret() {
    global $auth_pass_hash;
    return hash('sha256', 'krdns_auth_v1|' . $auth_pass_hash);
}

function cookieOpts($expires) {
    return ['expires' => $expires, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict'];
}

function issueAuthCookie($user) {
    $payload = base64_encode(json_encode(['user' => $user, 'exp' => time() + COOKIE_TTL]));
    setcookie(COOKIE_NAME, $payload . '.' . hash_hmac('sha256', $payload, authSecret()), cookieOpts(time() + COOKIE_TTL));
}

function checkAuthCookie() {
    global $auth_user;
    $parts = explode('.', $_COOKIE[COOKIE_NAME] ?? '', 2);
    if (count($parts) !== 2) return null;
    [$payload, $sig] = $parts;
    if (!hash_equals(hash_hmac('sha256', $payload, authSecret()), $sig)) return null;
    $data = json_decode(base64_decode($payload, true) ?: '', true);
    if (!is_array($data) || ($data['exp'] ?? 0) < time() || ($data['user'] ?? null) !== $auth_user) return null;
    return $data['user'];
}

function doLogin($in) {
    global $auth_user, $auth_pass_hash;
    // 5 wrong passwords from one address lock it out for 5 minutes
    $file = sys_get_temp_dir() . '/dns-router-login.json';
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    $fails = json_decode((string)@file_get_contents($file), true) ?: [];
    $fails = array_filter($fails, fn($f) => $f['until'] > time() || $f['last'] > time() - 300);
    if (($fails[$ip]['until'] ?? 0) > time()) {
        fail('Too many wrong passwords: try again in a few minutes', 429);
    }
    $user = trim((string)($in['username'] ?? ''));
    if (hash_equals($auth_user, $user) && password_verify((string)($in['password'] ?? ''), $auth_pass_hash)) {
        unset($fails[$ip]);
        @file_put_contents($file, json_encode($fails), LOCK_EX);
        issueAuthCookie($user);
        return ['success' => true];
    }
    $count = ($fails[$ip]['count'] ?? 0) + 1;
    $fails[$ip] = ['count' => $count >= 5 ? 0 : $count, 'last' => time(), 'until' => $count >= 5 ? time() + 300 : 0];
    @file_put_contents($file, json_encode($fails), LOCK_EX);
    usleep(500000);
    return ['success' => false, 'error' => 'Invalid username or password'];
}

function doLogout() {
    setcookie(COOKIE_NAME, '', cookieOpts(time() - 3600));
    return ['success' => true];
}

// ============================================ DB ============================================
function getDb() {
    global $db_file;
    static $migrated = false;
    if (!file_exists($db_file)) {
        return null;
    }
    $db = new SQLite3($db_file);
    $db->busyTimeout(20000);
    $db->exec("PRAGMA foreign_keys = ON;");
    if (!$migrated) {
        $have = [];
        $res = $db->query('PRAGMA table_info(domains)');
        while ($col = $res->fetchArray(SQLITE3_ASSOC)) $have[$col['name']] = true;
        if ($have) {
            // ip_sources: which DNS server returned each IP; dns_skip: servers not used for this target
            foreach (['ip_sources', 'dns_skip'] as $name) {
                if (!isset($have[$name])) $db->exec("ALTER TABLE domains ADD COLUMN $name TEXT DEFAULT ''");
            }
        }
        $db->exec("CREATE TABLE IF NOT EXISTS lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site TEXT NOT NULL,
            grp TEXT DEFAULT '',
            policy_id INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            interface TEXT DEFAULT '',
            gateway TEXT DEFAULT '',
            excl TEXT DEFAULT '',
            items TEXT DEFAULT '',
            domains TEXT DEFAULT '',
            n_items INTEGER DEFAULT 0,
            n_domains INTEGER DEFAULT 0,
            last_sync TEXT,
            status TEXT DEFAULT '',
            diff TEXT DEFAULT '',
            UNIQUE (site, policy_id)
        )");
        $listCols = [];
        $res = $db->query('PRAGMA table_info(lists)');
        while ($col = $res->fetchArray(SQLITE3_ASSOC)) $listCols[$col['name']] = true;
        if (!isset($listCols['mode'])) $db->exec("ALTER TABLE lists ADD COLUMN mode TEXT DEFAULT 'networks'");
        if (!isset($listCols['dropped'])) $db->exec("ALTER TABLE lists ADD COLUMN dropped TEXT DEFAULT ''");
        if (!isset($listCols['resolved'])) $db->exec("ALTER TABLE lists ADD COLUMN resolved TEXT DEFAULT ''");
        if (!isset($listCols['source'])) $db->exec("ALTER TABLE lists ADD COLUMN source TEXT DEFAULT ''");
        if (!isset($listCols['stats'])) $db->exec("ALTER TABLE lists ADD COLUMN stats TEXT DEFAULT ''");
        // DPI runs live in the database: a folder next to it would be served by nginx when the database sits in the web folder
        $db->exec('CREATE TABLE IF NOT EXISTS dpi_runs (id TEXT PRIMARY KEY, started INTEGER NOT NULL, summary TEXT, data TEXT)');
        $oldDir = dirname($db_file) . '/dpi';
        foreach (glob($oldDir . '/run-*.json') ?: [] as $file) {
            $run = json_decode((string)file_get_contents($file), true);
            if ($run) {
                $st = $db->prepare('INSERT OR IGNORE INTO dpi_runs (id, started, summary, data) VALUES (:id, :started, :summary, :data)');
                $st->bindValue(':id', (string)$run['id']);
                $st->bindValue(':started', (int)$run['started']);
                $st->bindValue(':summary', json_encode($run['summary']));
                $st->bindValue(':data', json_encode($run, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                $st->execute();
            }
            @unlink($file);
        }
        if (is_dir($oldDir)) @rmdir($oldDir);
        $migrated = true;
    }
    return $db;
}

function rows($db, $sql) {
    $out = [];
    $res = $db->query($sql);
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) $out[] = $row;
    return $out;
}

function withDb(callable $fn) {
    $db = getDb() ?: fail('Database not found', 500);
    try {
        return $fn($db);
    } finally {
        $db->close();
    }
}

// ============================================ ROOT EXEC ============================================
// Every argv element is escaped separately: nothing user-supplied is ever concatenated into a command.
function isRoot() {
    static $root;
    return $root ??= preg_match('/^Uid:\s*0\s+0\s+0\s+0/m', (string)@file_get_contents('/proc/self/status')) === 1;
}

function suExec($shell, $password = null) {
    global $passwd;
    if (isRoot()) {
        $out = shell_exec($shell . ' 2>&1');
    } else {
        // The password goes to su through stdin: it never shows up in the process list
        $proc = proc_open(['/opt/bin/su', '-c', $shell], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes);
        if (!is_resource($proc)) return '';
        fwrite($pipes[0], ($password ?? $passwd) . "\n");
        fclose($pipes[0]);
        $out = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        proc_close($proc);
    }
    // su prints its "Password:" prompt into the merged stream
    return preg_replace('/^Password:[ \t]*\r?\n?/', '', (string)$out);
}

function execAsRoot(array $argv) {
    return suExec(implode(' ', array_map('escapeshellarg', $argv)));
}

// For ready pipelines ("a | b"). su gets a stripped PATH, so set one explicitly,
// and wrap in sh -c because some busybox su builds do not interpret "|" on their own.
function execPipelineAsRoot($pipeline, $password = null) {
    $path = 'PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; export PATH; ';
    return suExec('/bin/sh -c ' . escapeshellarg($path . $pipeline), $password);
}

// Reading rules/routes needs no root.
function execReadOnly(array $argv) {
    return (string)shell_exec(implode(' ', array_map('escapeshellarg', $argv)) . ' 2>&1');
}

function writeFileAsRoot($path, $content, $backup = false, $owner = null) {
    $tmp = tempnam(sys_get_temp_dir(), 'krdns_');
    if ($tmp === false || file_put_contents($tmp, $content) === false) return false;
    $perms = @fileperms($path);
    if ($backup && file_exists($path)) {
        execPipelineAsRoot('cp ' . escapeshellarg($path) . ' ' . escapeshellarg($path . '.bak'));
    }
    execPipelineAsRoot('cp ' . escapeshellarg($tmp) . ' ' . escapeshellarg($path));
    if ($owner !== null) {
        execPipelineAsRoot('chown ' . (int)$owner . ' ' . escapeshellarg($path));
    }
    if ($perms !== false) {
        execPipelineAsRoot('chmod ' . substr(sprintf('%o', $perms), -4) . ' ' . escapeshellarg($path));
    }
    @unlink($tmp);
    return true;
}

function ipRuleDel($mark, $table, $pref) {
    // the pref is ours: a foreign rule with the same fwmark but another pref is never matched
    return execAsRoot(['/opt/sbin/ip', 'rule', 'del', 'fwmark', $mark, 'table', (string)$table, 'pref', (string)$pref]);
}
function ipRouteFlush($table) {
    return execAsRoot(['/opt/sbin/ip', 'route', 'flush', 'table', (string)$table]);
}

// Applies many routes with one root call: "ip -force -batch" keeps going past duplicates.
function ipRouteBatch(array $lines) {
    $tmp = tempnam(sys_get_temp_dir(), 'krroutes_');
    if ($tmp === false || file_put_contents($tmp, implode("\n", $lines) . "\n") === false) return false;
    chmod($tmp, 0644);
    $out = execAsRoot(['/opt/sbin/ip', '-force', '-batch', $tmp]);
    unlink($tmp);
    return $out;
}

// Rule order: targets, lists and BGP each get a pref (lower is looked at first).
function routePrefs(SQLite3 $db) {
    return [
        'targets' => (int)getSetting($db, 'pref_targets') ?: 4,
        'lists'   => (int)getSetting($db, 'pref_lists') ?: 6,
        'bgp'     => (int)getSetting($db, 'pref_bgp') ?: 5,
    ];
}

// The table of a policy's lists sits 100 above the table of its targets: 400 -> 500.
function listTable($ourTable) {
    return (int)$ourTable + 100;
}

// One writer at a time: web requests and ndm hooks both rebuild the same tables.
// A hook that finds the lock busy leaves a marker and the running writer repeats once.
function locked(callable $fn, $nowait = false) {
    $file = sys_get_temp_dir() . '/dns-router.lock';
    $h = fopen($file, 'c');
    @chmod($file, 0666);
    if (!flock($h, $nowait ? LOCK_EX | LOCK_NB : LOCK_EX)) {
        if ($nowait) {
            @touch($file . '.pending');
            @chmod($file . '.pending', 0666);
        }
        fclose($h);
        return null;
    }
    $res = $fn();
    for ($i = 0; $i < 3 && is_file($file . '.pending'); $i++) {
        @unlink($file . '.pending');
        $res = $fn();
    }
    flock($h, LOCK_UN);
    fclose($h);
    return $res;
}

// ============================================ VALIDATION ============================================
// No filter_var: ext-filter is missing on minimal Entware PHP builds.
function isValidDomain($domain) {
    return is_string($domain)
        && strlen($domain) > 0 && strlen($domain) <= 253
        && preg_match('/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/', $domain) === 1;
}

function isValidInterface($iface) {
    if ($iface === '' || $iface === null) return true; // поле необязательное
    return is_string($iface) && preg_match('/^[A-Za-z0-9_.-]{1,32}$/', $iface) === 1;
}

function isValidIPv4($ip) {
    if (!is_string($ip)) return false;
    if (!preg_match('/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/', $ip, $m)) return false;
    for ($i = 1; $i <= 4; $i++) {
        if ((int)$m[$i] > 255) return false;
        if (strlen($m[$i]) > 1 && $m[$i][0] === '0') return false; // "01" и т.п. отклоняем как неоднозначные
    }
    return true;
}

function isValidGateway($gw) {
    if ($gw === '' || $gw === null) return true; // поле необязательное
    return isValidIPv4($gw);
}

function isValidIPv4Cidr($v) {
    if (!is_string($v)) return false;
    if (strpos($v, '/') === false) {
        return isValidIPv4($v);
    }
    [$ip, $prefix] = array_pad(explode('/', $v, 2), 2, null);
    if (!isValidIPv4($ip)) return false;
    return preg_match('/^([0-9]|[12][0-9]|3[0-2])$/', (string)$prefix) === 1;
}

// A target never covers the whole Internet: 0.0.0.0/0 would become a default route in the policy table
function isValidTarget($v) {
    return isValidDomain($v) || (isValidIPv4Cidr($v) && !str_ends_with($v, '/0'));
}

function isValidRouteTarget($v) {
    return isValidIPv4Cidr($v) && !str_ends_with($v, '/0');
}

// true/1/"1"/"true"/"yes"/"on" => 1, anything else => 0 (filter_var is not there without ext-filter)
function toFlag($v) {
    return in_array(strtolower(trim((string)$v)), ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
}

// ============================================ RCI ============================================
function rciHost() {
    global $rci_host;
    return !empty($rci_host) ? rtrim($rci_host, '/') : null;
}

function rciPolicyUrl() {
    $host = rciHost();
    return $host === null ? null : $host . '/rci/show/ip/policy';
}

// ============================================ TARGETS ============================================
function getNextFreeTable(SQLite3 $db, $start) {
    static $used = null;
    if ($used === null) {
        $used = [];
        $res = $db->query('SELECT our_table FROM policies');
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $used[(int)$row['our_table']] = true;
        }
    }
    $table = (int)$start;
    while (isset($used[$table])) {
        $table++;
    }
    if ($table >= $start + 100) fail('At most 100 policies are supported');
    $used[$table] = true;
    return $table;
}

function dnsServerList($raw) {
    return preg_split('/[\s,;]+/', trim((string)$raw), -1, PREG_SPLIT_NO_EMPTY);
}

function parseNslookup($out) {
    $ips = [];
    $answers = false;
    foreach (preg_split('/\r?\n/', $out) as $line) {
        if (preg_match('/^Name:/i', $line)) $answers = true;
        if ($answers && preg_match('/^Address(?:\s+\d+)?:\s*(\d{1,3}(?:\.\d{1,3}){3})(?![\d:.])/i', $line, $m)) $ips[] = $m[1];
    }
    return array_values(array_unique($ips));
}

function nslookupCmd($host, $server) {
    return 'PATH=/opt/bin:/opt/sbin:/bin:/usr/bin:/sbin:/usr/sbin exec nslookup ' . escapeshellarg($host) . ' ' . escapeshellarg($server) . ' 2>&1';
}

function nslookupA($host, $server) {
    return parseNslookup((string)shell_exec(nslookupCmd($host, $server)));
}

// Runs many nslookup calls at once (at most $limit processes, each killed after $timeout seconds).
// $jobs: key => [host, server]. Returns key => list of IPv4.
function nslookupBatch(array $jobs, $limit = 8, $timeout = 5) {
    $result = [];
    $running = [];
    $queue = $jobs;
    while ($queue || $running) {
        while ($queue && count($running) < $limit) {
            $key = array_key_first($queue);
            [$host, $server] = $queue[$key];
            unset($queue[$key]);
            $proc = proc_open(nslookupCmd($host, $server), [1 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) {
                $result[$key] = [];
                continue;
            }
            stream_set_blocking($pipes[1], false);
            $running[$key] = ['proc' => $proc, 'pipe' => $pipes[1], 'out' => '', 'deadline' => microtime(true) + $timeout];
        }
        if (!$running) break;

        $read = array_column($running, 'pipe');
        $write = $except = null;
        @stream_select($read, $write, $except, 0, 200000);

        foreach ($running as $key => &$job) {
            $chunk = fread($job['pipe'], 8192);
            if ($chunk !== false && $chunk !== '') $job['out'] .= $chunk;
            $done = feof($job['pipe']);
            $late = microtime(true) > $job['deadline'];
            if (!$done && !$late) continue;
            if (!$done) proc_terminate($job['proc'], 9);
            fclose($job['pipe']);
            proc_close($job['proc']);
            $result[$key] = $late && !$done ? [] : parseNslookup($job['out']);
            unset($running[$key]);
        }
        unset($job);
    }
    return $result;
}

// Resolves many domains. $targets: id => [host, [servers]]. Returns id => ['ips' => [...], 'map' => ip => servers].
// Servers are asked in parallel; 'first' goes server by server and stops per domain at the first answer.
function resolveMany(array $targets, $mode) {
    $found = [];
    foreach ($targets as $id => $t) $found[$id] = ['ips' => [], 'map' => []];

    $viaNslookup = [];
    foreach ($targets as $id => $t) {
        if ($t[1] && hasNslookup()) {
            $viaNslookup[$id] = $t;
        } else {
            $records = @dns_get_record($t[0], DNS_A);
            foreach ($records ? array_column($records, 'ip') : [] as $ip) {
                $found[$id]['ips'][] = $ip;
                $found[$id]['map'][$ip] = ['system'];
            }
        }
    }

    $round = 0;
    while ($viaNslookup) {
        $jobs = [];
        foreach ($viaNslookup as $id => $t) {
            if ($mode === 'all') {
                foreach ($t[1] as $n => $server) $jobs["$id|$n"] = [$t[0], $server];
            } elseif (isset($t[1][$round])) {
                $jobs["$id|$round"] = [$t[0], $t[1][$round]];
            }
        }
        if (!$jobs) break;

        foreach (nslookupBatch($jobs) as $jobKey => $ips) {
            [$id, $n] = explode('|', $jobKey);
            $server = $viaNslookup[$id][1][$n];
            foreach ($ips as $ip) {
                if (!isset($found[$id]['map'][$ip])) $found[$id]['ips'][] = $ip;
                $found[$id]['map'][$ip][] = $server;
            }
        }

        if ($mode === 'all') break;
        foreach ($viaNslookup as $id => $t) {
            if ($found[$id]['ips']) unset($viaNslookup[$id]);
        }
        $round++;
    }
    return $found;
}

function hasNslookup() {
    return trim((string)shell_exec('PATH=/opt/bin:/opt/sbin:/bin:/usr/bin:/sbin:/usr/sbin command -v nslookup 2>/dev/null')) !== '';
}

// A records of a domain. 'first': the first DNS server of the list that answers; 'all': answers of
// every server are merged. Returns ips, map (ip => servers that returned it) and by (servers, '' = system resolver).
function resolveAInfo($host, $servers = '', $mode = 'first') {
    $list = dnsServerList($servers);
    if (!$list || !hasNslookup()) {
        $records = @dns_get_record($host, DNS_A);
        $ips = $records ? array_column($records, 'ip') : [];
        $map = [];
        foreach ($ips as $ip) $map[$ip] = ['system'];
        return ['ips' => $ips, 'map' => $map, 'by' => $ips ? ['system'] : []];
    }

    $map = [];
    $by = [];
    foreach ($list as $server) {
        $ips = nslookupA($host, $server);
        if (!$ips) continue;
        $by[] = $server;
        foreach ($ips as $ip) $map[$ip][] = $server;
        if ($mode !== 'all') break;
    }
    return ['ips' => array_keys($map), 'map' => $map, 'by' => $by];
}

function resolveA($host, $servers = '') {
    return resolveAInfo($host, $servers)['ips'];
}

function doUpdateIPs(SQLite3 $db, $onlyId = null) {
    $changed = 0;
    $errors = [];

    $sql = 'SELECT id, domain, current_ip, ip_sources, dns_skip FROM domains WHERE enabled = 1' . ($onlyId ? ' AND id IN (' . implode(',', array_map('intval', (array)$onlyId)) . ')' : '');
    $upd = $db->prepare("UPDATE domains SET previous_ip = current_ip, current_ip = :ip, ip_sources = :src, last_check = datetime('now') WHERE id = :id AND domain = :domain");
    $touch = $db->prepare("UPDATE domains SET ip_sources = :src, last_check = datetime('now') WHERE id = :id AND domain = :domain");

    $servers = dnsServerList(getSetting($db, 'dns_servers'));
    $mode = getSetting($db, 'dns_mode') === 'all' ? 'all' : 'first';
    $list = rows($db, $sql);

    $targets = [];
    foreach ($list as $row) {
        if (isValidIPv4Cidr($row['domain'])) continue;
        $targets[$row['id']] = [$row['domain'], array_values(array_diff($servers, dnsServerList($row['dns_skip'])))];
    }
    $resolved = resolveMany($targets, $mode);

    // One transaction for all the rows: hundreds of separate commits on a USB drive keep the database busy for the other requests.
    $db->exec('BEGIN');
    foreach ($list as $row) {
        $target = $row['domain'];
        $map = [];
        if (isValidIPv4Cidr($target)) {
            $ips = [$target];
        } else {
            $ips = $resolved[$row['id']]['ips'];
            $map = $resolved[$row['id']]['map'];
            if (!$ips) {
                $errors[] = "$target: cannot resolve";
                continue;
            }
        }

        $old = json_decode((string)$row['ip_sources'], true);
        $oldCur = is_array($old['cur'] ?? null) ? $old['cur'] : [];
        $cur = [];
        foreach ($ips as $ip) $cur[$ip] = $map[$ip] ?? [];

        $new = json_encode($ips);
        if ($new === $row['current_ip']) {
            $src = json_encode(['cur' => $cur, 'prev' => is_array($old['prev'] ?? null) ? $old['prev'] : []]);
            $touch->reset();
            $touch->bindValue(':src', $src, SQLITE3_TEXT);
            $touch->bindValue(':id', $row['id'], SQLITE3_INTEGER);
            $touch->bindValue(':domain', $target, SQLITE3_TEXT);
            $touch->execute();
            continue;
        }

        $prev = [];
        foreach ((array)json_decode((string)$row['current_ip'], true) as $ip) $prev[$ip] = $oldCur[$ip] ?? [];
        $upd->reset();
        $upd->bindValue(':ip', $new, SQLITE3_TEXT);
        $upd->bindValue(':src', json_encode(['cur' => $cur, 'prev' => $prev]), SQLITE3_TEXT);
        $upd->bindValue(':id', $row['id'], SQLITE3_INTEGER);
        $upd->bindValue(':domain', $target, SQLITE3_TEXT);
        if ($upd->execute()) {
            $changed++;
        } else {
            $errors[] = "$target: db update failed";
        }
    }

    $db->exec('COMMIT');

    return ['changed' => $changed, 'errors' => $errors];
}

function doSyncPolicies(SQLite3 $db) {
    global $our_table_start;

    $policyUrl = rciPolicyUrl();
    if ($policyUrl === null) {
        return ['success' => false, 'error' => '$rci_host is not set in config.php'];
    }

    $response = @file_get_contents($policyUrl);
    $keenetic_policies = json_decode($response, true);
    if (!is_array($keenetic_policies)) {
        return ['success' => false, 'error' => 'Invalid API response format'];
    }

    $db_policies = [];
    $result = $db->query("SELECT id, name, our_table, mark_hex FROM policies WHERE name != 'DELETED'");
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $db_policies[$row['name']] = $row;
    }
    // An empty answer is a hiccup of RCI far more often than the removal of every policy
    if (!$keenetic_policies && $db_policies) {
        return ['success' => false, 'error' => 'Keenetic returned no policies: nothing was changed'];
    }
    // Lists use the table 100 above the policy's own one: more than 100 policies would collide
    if (count($keenetic_policies) > 100) {
        return ['success' => false, 'error' => 'At most 100 policies are supported'];
    }

    $deleted_id = $db->querySingle("SELECT id FROM policies WHERE name = 'DELETED'");
    if (!$deleted_id) {
        $ins0 = $db->prepare("INSERT INTO policies (name, description, mark_hex, keenetic_table, our_table) VALUES ('DELETED', 'Orphaned domains', '0x000000', 0, 1999)");
        $ins0->execute();
        $deleted_id = $db->lastInsertRowID();
    }

    $upd = $db->prepare('UPDATE policies SET mark_hex = :mark, keenetic_table = :kt, description = :descr, updated_at = datetime(\'now\') WHERE name = :name');
    $ins = $db->prepare('INSERT INTO policies (name, description, mark_hex, keenetic_table, our_table) VALUES (:name, :descr, :mark, :kt, :table)');

    $added = 0;
    $updated = 0;

    foreach ($keenetic_policies as $name => $data) {
        if (!is_array($data)) continue;

        // the mark goes into ip rule and the bird hook: only plain hex is taken
        $mark = strtolower((string)($data['mark'] ?? ''));
        if (str_starts_with($mark, '0x')) $mark = substr($mark, 2);
        if (!preg_match('/^[0-9a-f]{1,8}$/', $mark)) continue;
        $mark = '0x' . $mark;
        $keenetic_table = (int)($data['table4'] ?? 0);
        $description = (string)($data['description'] ?? '');

        if (isset($db_policies[$name])) {
            $upd->reset();
            $upd->bindValue(':mark', $mark, SQLITE3_TEXT);
            $upd->bindValue(':kt', $keenetic_table, SQLITE3_INTEGER);
            $upd->bindValue(':descr', $description, SQLITE3_TEXT);
            $upd->bindValue(':name', $name, SQLITE3_TEXT);
            $upd->execute();
            $updated++;
            unset($db_policies[$name]);
        } else {
            $table = getNextFreeTable($db, $our_table_start);
            $ins->reset();
            $ins->bindValue(':name', $name, SQLITE3_TEXT);
            $ins->bindValue(':descr', $description, SQLITE3_TEXT);
            $ins->bindValue(':mark', $mark, SQLITE3_TEXT);
            $ins->bindValue(':kt', $keenetic_table, SQLITE3_INTEGER);
            $ins->bindValue(':table', $table, SQLITE3_INTEGER);
            $ins->execute();
            $added++;
        }
    }

    // Политики, пропавшие из ответа Keenetic: снимаем их правила/маршруты
    // и переносим их домены в служебную политику DELETED.
    $removed = 0;
    foreach ($db_policies as $name => $row) {
        $table = $row['our_table'];
        $mark = $row['mark_hex'];
        if ($table && $mark) {
            $prefs = routePrefs($db);
            foreach ([$prefs['targets'], $prefs['lists']] as $pref) {
                ipRuleDel($mark, $table, $pref);
                ipRuleDel($mark, listTable($table), $pref);
            }
            ipRouteFlush($table);
            ipRouteFlush(listTable($table));
        }

        $mv = $db->prepare("UPDATE domains SET policy_id = :did, updated_at = datetime('now') WHERE policy_id = :pid");
        $mv->bindValue(':did', $deleted_id, SQLITE3_INTEGER);
        $mv->bindValue(':pid', $row['id'], SQLITE3_INTEGER);
        $mv->execute();

        $del = $db->prepare('DELETE FROM policies WHERE id = :pid');
        $del->bindValue(':pid', $row['id'], SQLITE3_INTEGER);
        $del->execute();
        $removed++;
    }

    return ['success' => true, 'added' => $added, 'updated' => $updated, 'removed' => $removed];
}

// Brings every policy table to what the targets and lists want. Rules of Keenetic's own tables (keenetic_table) are never touched.
function doApplyRoutes(SQLite3 $db) {
    $policies = [];
    $result = $db->query("SELECT id, name, mark_hex, our_table FROM policies WHERE name != 'DELETED'");
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $policies[$row['id']] = $row;
    }
    if (empty($policies)) {
        return ['success' => false, 'error' => 'No active policies'];
    }

    $prefs = routePrefs($db);

    $domains = [];
    $result = $db->query('SELECT d.id, d.domain, d.policy_id, d.interface, d.gateway, d.current_ip FROM domains d WHERE d.enabled = 1 AND d.current_ip IS NOT NULL');
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $policy_id = $row['policy_id'];
        if (!isset($policies[$policy_id])) continue;

        $ips = json_decode($row['current_ip'], true);
        if (!is_array($ips) || empty($ips)) continue;

        $ips = array_values(array_filter($ips, 'isValidRouteTarget'));
        if (empty($ips)) continue;

        $interface = isValidInterface($row['interface']) ? $row['interface'] : '';
        $gateway   = isValidGateway($row['gateway']) ? $row['gateway'] : '';
        if ($interface === '' && $gateway === '') continue;

        $domains[] = [
            'domain'    => $row['domain'],
            'policy'    => $policies[$policy_id],
            'interface' => $interface,
            'gateway'   => $gateway,
            'ips'       => $ips,
        ];
    }

    $lists = [];
    $result = $db->query("SELECT policy_id, interface, gateway, items FROM lists WHERE enabled = 1 AND items != '' AND (interface != '' OR gateway != '')");
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        if (!isset($policies[$row['policy_id']])) continue;
        $lists[] = [
            'policy'    => $policies[$row['policy_id']],
            'is_list'   => true,
            'interface' => isValidInterface($row['interface']) ? $row['interface'] : '',
            'gateway'   => isValidGateway($row['gateway']) ? $row['gateway'] : '',
            'ips'       => explode("\n", $row['items']),
        ];
    }

    // What every table must hold: destination (as ip prints it) => the route command
    $want = [];
    $policy_seen = [];
    foreach (array_merge($lists, $domains) as $domain) {
        $policy = $domain['policy'];
        $table = !empty($domain['is_list']) ? listTable($policy['our_table']) : $policy['our_table'];
        $policy_seen[$policy['id']] = true;
        foreach ($domain['ips'] as $ip) {
            [$addr, $len] = array_pad(explode('/', trim($ip), 2), 2, '32');
            if (!isValidIPv4($addr)) continue;
            $len = (int)$len;
            $dest = $len === 32 ? $addr : long2ip(ip2long($addr) & (-1 << (32 - $len))) . '/' . $len;
            $line = 'route replace ' . $dest . ' table ' . $table;
            if ($domain['gateway'])   $line .= ' via ' . $domain['gateway'];
            if ($domain['interface']) $line .= ' dev ' . $domain['interface'];
            $want[$table][$dest] = $line;
        }
    }

    // The tables are never emptied: new routes are written over the old ones, then the routes nobody wants are removed.
    // Traffic of a target keeps its route the whole time.
    $replace = [];
    foreach ($want as $lines) {
        foreach ($lines as $line) $replace[] = $line;
    }
    $route_errors = 0;
    $route_error = '';
    if ($replace) {
        $out = (string)ipRouteBatch($replace);
        $route_errors = preg_match_all('/^Command failed/m', $out);
        if (preg_match('/^(?!Command failed).*\S.*$/m', $out, $m)) $route_error = trim($m[0]);
    }

    // Rules: a rule that is already right stays untouched (no del+add gap), stale prefs go, missing rules are added.
    // Rules of the previous prefs are removed as well, so changing a pref leaves nothing behind.
    $ours = array_unique(array_merge([$prefs['targets'], $prefs['lists']], array_map('intval', explode(' ', (string)getSetting($db, 'pref_applied')))));
    $rulesNow = [];
    foreach (explode("\n", execReadOnly(['/opt/sbin/ip', 'rule', 'show'])) as $row) {
        if (preg_match('/^(\d+):.*\bfwmark 0x([0-9a-f]+)\b.*\blookup (\d+)/i', $row, $m)) {
            $rulesNow[] = ['pref' => (int)$m[1], 'mark' => ltrim(strtolower($m[2]), '0'), 'table' => (int)$m[3]];
        }
    }
    $cleanup = [];
    foreach ($policies as $policy) {
        $mark = $policy['mark_hex'];
        $markBare = ltrim(strtolower(substr($mark, 2)), '0');
        $tables = [$policy['our_table'] => $prefs['targets'], listTable($policy['our_table']) => $prefs['lists']];
        foreach ($tables as $table => $pref) {
            $current = execReadOnly(['/opt/sbin/ip', 'route', 'show', 'table', (string)$table]);
            foreach (explode("\n", $current) as $row) {
                $parts = preg_split('/\s+/', trim($row));
                if (in_array($parts[0], ['unreachable', 'blackhole', 'prohibit', 'throw'], true)) array_shift($parts);
                $dest = $parts[0];
                // "default" is how ip prints 0.0.0.0/0: a target can never want it, so it always goes
                if ($dest !== 'default' && !preg_match('~^\d+\.\d+\.\d+\.\d+(/\d+)?$~', $dest)) continue;
                if (isset($want[$table][$dest])) continue;
                $cleanup[] = 'route del ' . $dest . ' table ' . $table;
            }
            $wanted = isset($want[$table]) ? $pref : 0;
            $present = false;
            foreach ($rulesNow as $rule) {
                if ($rule['mark'] !== $markBare || $rule['table'] !== (int)$table || !in_array($rule['pref'], $ours, true)) continue;
                if ($rule['pref'] === $wanted && !$present) $present = true;
                else $cleanup[] = "rule del fwmark $mark table $table pref {$rule['pref']}";
            }
            if ($wanted && !$present) $cleanup[] = "rule add fwmark $mark table $table pref $wanted";
        }
    }
    // Every line of the cleanup must work: a failed rule add means the routes are there but nothing sends traffic to them
    $rule_error = '';
    if ($cleanup) {
        $out = (string)ipRouteBatch($cleanup);
        $why = '';
        foreach (explode("\n", $out) as $row) {
            if (!preg_match('/^Command failed .*:(\d+)\s*$/', $row, $m)) {
                if (trim($row) !== '') $why = trim($row);
                continue;
            }
            $command = $cleanup[(int)$m[1] - 1] ?? '';
            if ($rule_error === '' || str_starts_with($command, 'rule add')) $rule_error = $command . ': ' . $why;
        }
    }
    setSetting($db, 'pref_applied', $prefs['targets'] . ' ' . $prefs['lists']);

    $total_routes = 0;
    foreach ($want as $lines) $total_routes += count($lines);
    return [
        'success'  => true,
        'routes'   => $total_routes,
        'domains'  => count($domains),
        'lists'    => count($lists),
        'route_errors' => $route_errors,
        'route_error'  => $route_error,
        'rule_error'   => $rule_error,
        'policies' => count($policy_seen),
    ];
}

// Called after every change made from the UI so the result is live immediately.
// defer=1 skips it, for batches that apply once at the end.
function applyNow(SQLite3 $db, $in, $resolveId = null) {
    if (!empty($in['defer'])) return null;
    if ($resolveId) doUpdateIPs($db, $resolveId);
    return locked(fn() => doApplyRoutes($db));
}

function readTarget(array $in) {
    $t = [
        'domain'    => trim((string)($in['domain'] ?? '')),
        'policy_id' => (int)($in['policy_id'] ?? 0),
        'interface' => trim((string)($in['interface'] ?? '')),
        'gateway'   => trim((string)($in['gateway'] ?? '')),
        'enabled'   => isset($in['enabled']) ? toFlag($in['enabled']) : 1,
    ];
    if (str_ends_with($t['domain'], '/0')) fail('A target cannot be a /0 network: that is a default route for the whole policy');
    if (!isValidTarget($t['domain'])) fail('Invalid domain, IP or CIDR');
    if ($t['policy_id'] <= 0) fail('Valid policy is required');
    if (!isValidInterface($t['interface'])) fail('Invalid interface name');
    if (!isValidGateway($t['gateway'])) fail('Invalid gateway IP');
    if ($t['interface'] === '' && $t['gateway'] === '') fail('Set an interface or a gateway: a route needs an exit');
    return $t;
}

function bindTarget($stmt, array $t) {
    $stmt->bindValue(':domain', $t['domain'], SQLITE3_TEXT);
    $stmt->bindValue(':pid', $t['policy_id'], SQLITE3_INTEGER);
    $stmt->bindValue(':iface', $t['interface'] !== '' ? $t['interface'] : null, SQLITE3_TEXT);
    $stmt->bindValue(':gw', $t['gateway'] !== '' ? $t['gateway'] : null, SQLITE3_TEXT);
    $stmt->bindValue(':enabled', $t['enabled'], SQLITE3_INTEGER);
}

function targetExists($db, $domain, $policyId, $exceptId = 0) {
    $st = $db->prepare('SELECT id FROM domains WHERE domain = :domain AND policy_id = :pid AND id != :id');
    $st->bindValue(':domain', $domain, SQLITE3_TEXT);
    $st->bindValue(':pid', $policyId, SQLITE3_INTEGER);
    $st->bindValue(':id', $exceptId, SQLITE3_INTEGER);
    return (bool)$st->execute()->fetchArray();
}

// The routes follow a change through the task manager. defer=1 leaves it to the caller (several changes, one task).
function queueTargets(SQLite3 $db, array $in, array $ids) {
    if (!empty($in['defer'])) return [];
    extHandlers();
    return doStartJob($db, ['kind' => 'sync', 'targets' => $ids]);
}

function addDomain($in) {
    $t = readTarget($in);
    return withDb(function ($db) use ($t, $in) {
        if (!$db->querySingle('SELECT id FROM policies WHERE id = ' . $t['policy_id'])) fail('Policy not found');
        if (targetExists($db, $t['domain'], $t['policy_id'])) fail('Domain already exists for this policy');

        $st = $db->prepare("INSERT INTO domains (domain, policy_id, interface, gateway, enabled, created_at, updated_at)
                            VALUES (:domain, :pid, :iface, :gw, :enabled, datetime('now'), datetime('now'))");
        bindTarget($st, $t);
        $st->execute() or fail('Failed to add domain', 500);
        $id = $db->lastInsertRowID();
        return ['success' => true, 'id' => $id] + queueTargets($db, $in, [$id]);
    });
}

function updateDomain($in) {
    $id = (int)($in['id'] ?? 0);
    if ($id <= 0) fail('Valid ID is required');
    $t = readTarget($in);
    return withDb(function ($db) use ($id, $t, $in) {
        if (!$db->querySingle('SELECT id FROM policies WHERE id = ' . $t['policy_id'])) fail('Policy not found');
        if (targetExists($db, $t['domain'], $t['policy_id'], $id)) fail('Domain already exists for this policy');

        $st = $db->prepare("UPDATE domains SET domain = :domain, policy_id = :pid, interface = :iface, gateway = :gw,
                            enabled = :enabled, updated_at = datetime('now') WHERE id = :id");
        bindTarget($st, $t);
        $st->bindValue(':id', $id, SQLITE3_INTEGER);
        $st->execute() or fail('Failed to update domain', 500);
        if (!$db->changes()) fail('Target not found', 404);
        return ['success' => true] + queueTargets($db, $in, [$id]);
    });
}

function deleteDomain($in) {
    $id = (int)($in['id'] ?? 0);
    if ($id <= 0) fail('Valid ID is required');
    return withDb(function ($db) use ($id, $in) {
        $st = $db->prepare('DELETE FROM domains WHERE id = :id');
        $st->bindValue(':id', $id, SQLITE3_INTEGER);
        $st->execute() or fail('Failed to delete domain', 500);
        if (!$db->changes()) fail('Target not found', 404);
        return ['success' => true] + queueTargets($db, $in, []);
    });
}

function saveTargetDns($in) {
    $id = (int)($in['id'] ?? 0);
    if ($id <= 0) fail('Valid ID is required');
    $skip = dnsServerList($in['skip'] ?? '');
    foreach ($skip as $ip) {
        if (!isValidIPv4($ip)) fail("Not an IPv4 address: $ip");
    }
    return withDb(function ($db) use ($id, $skip) {
        $st = $db->prepare('UPDATE domains SET dns_skip = :skip WHERE id = :id');
        $st->bindValue(':skip', implode(' ', array_unique($skip)), SQLITE3_TEXT);
        $st->bindValue(':id', $id, SQLITE3_INTEGER);
        $st->execute() or fail('Failed to save', 500);
        if (!$db->changes()) fail('Target not found', 404);
        return ['success' => true];
    });
}

// Resolve one target again with its current DNS settings and apply the routes.
function refreshTarget($in) {
    $id = (int)($in['id'] ?? 0);
    if ($id <= 0) fail('Valid ID is required');
    return withDb(function ($db) use ($id) {
        if (!$db->querySingle('SELECT id FROM domains WHERE id = ' . $id)) fail('Target not found', 404);
        return queueTargets($db, [], [$id]);
    });
}

function doExportConfig(SQLite3 $db) {
    $policies = [];
    $res = $db->query("SELECT name, description, mark_hex, keenetic_table, our_table FROM policies WHERE name != 'DELETED' ORDER BY name");
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $policies[] = $row;
    }

    $domains = [];
    $res = $db->query("
        SELECT d.domain, p.name as policy_name, d.interface, d.gateway, d.enabled
        FROM domains d
        JOIN policies p ON d.policy_id = p.id
        WHERE p.name != 'DELETED'
        ORDER BY p.name, d.domain
    ");
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $domains[] = [
            'domain'    => $row['domain'],
            'policy'    => $row['policy_name'],
            'interface' => $row['interface'] !== '' ? $row['interface'] : null,
            'gateway'   => $row['gateway'] !== '' ? $row['gateway'] : null,
            'enabled'   => (int)$row['enabled'],
        ];
    }

    return [
        'version'     => 1,
        'exported_at' => date('c'),
        'policies'    => $policies, // справочно, на импорте не используется
        'domains'     => $domains,
    ];
}

function doImportConfig(SQLite3 $db, $data) {
    if (!is_array($data) || !isset($data['domains']) || !is_array($data['domains'])) {
        return ['success' => false, 'error' => 'Invalid import file format: no "domains" array'];
    }

    $policies = [];
    $res = $db->query("SELECT id, name FROM policies WHERE name != 'DELETED'");
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $policies[$row['name']] = $row['id'];
    }

    $findStmt = $db->prepare('SELECT id FROM domains WHERE domain = :domain AND policy_id = :pid');
    $insStmt = $db->prepare("INSERT INTO domains (domain, policy_id, interface, gateway, enabled, created_at, updated_at) VALUES (:domain, :pid, :iface, :gw, :enabled, datetime('now'), datetime('now'))");
    $updStmt = $db->prepare("UPDATE domains SET interface = :iface, gateway = :gw, enabled = :enabled, updated_at = datetime('now') WHERE id = :id");

    // map: policy name in the file => policy name here ('' = skip). Without it names must match.
    $map = isset($data['map']) && is_array($data['map']) ? $data['map'] : null;
    $prune = !isset($data['prune']) || (bool)$data['prune'];
    $scopePolicyIds = [];

    // all or nothing: a file that breaks half way leaves the targets as they were (and one fsync instead of thousands)
    $db->exec('BEGIN');
    $imported = 0;
    $updated = 0;
    $skipped = [];
    $seenByPolicy = []; // policy_id => [target, target, ...] встреченные в файле

    foreach ($data['domains'] as $entry) {
        if (!is_array($entry)) continue;

        $target = trim((string)($entry['domain'] ?? ''));
        $policyName = (string)($entry['policy'] ?? '');
        if ($map !== null) {
            if (!array_key_exists($policyName, $map)) continue;
            $policyName = (string)$map[$policyName];
            if ($policyName === '') continue;
        }
        $interface = isset($entry['interface']) ? trim((string)$entry['interface']) : '';
        $gateway = isset($entry['gateway']) ? trim((string)$entry['gateway']) : '';
        $enabled = isset($entry['enabled']) ? toFlag($entry['enabled']) : 1;

        if (!isValidTarget($target) || !isset($policies[$policyName])
            || !isValidInterface($interface) || !isValidGateway($gateway)) {
            $skipped[] = $target !== '' ? $target : '(empty)';
            continue;
        }

        $pid = $policies[$policyName];
        $seenByPolicy[$pid][] = $target;
        $scopePolicyIds[$pid] = true; // на случай файлов без списка policies (совместимость со старым форматом экспорта)

        $findStmt->reset();
        $findStmt->bindValue(':domain', $target, SQLITE3_TEXT);
        $findStmt->bindValue(':pid', $pid, SQLITE3_INTEGER);
        $existing = $findStmt->execute()->fetchArray(SQLITE3_ASSOC);

        if ($existing) {
            $updStmt->reset();
            $updStmt->bindValue(':iface', $interface !== '' ? $interface : null, SQLITE3_TEXT);
            $updStmt->bindValue(':gw', $gateway !== '' ? $gateway : null, SQLITE3_TEXT);
            $updStmt->bindValue(':enabled', $enabled, SQLITE3_INTEGER);
            $updStmt->bindValue(':id', $existing['id'], SQLITE3_INTEGER);
            $updStmt->execute();
            $updated++;
        } else {
            $insStmt->reset();
            $insStmt->bindValue(':domain', $target, SQLITE3_TEXT);
            $insStmt->bindValue(':pid', $pid, SQLITE3_INTEGER);
            $insStmt->bindValue(':iface', $interface !== '' ? $interface : null, SQLITE3_TEXT);
            $insStmt->bindValue(':gw', $gateway !== '' ? $gateway : null, SQLITE3_TEXT);
            $insStmt->bindValue(':enabled', $enabled, SQLITE3_INTEGER);
            $insStmt->execute();
            $imported++;
        }
    }

    $removed = 0;
    $delStmt = $db->prepare('DELETE FROM domains WHERE id = :id');
    foreach ($prune ? array_keys($scopePolicyIds) : [] as $pid) {
        $targetsSet = array_flip($seenByPolicy[$pid] ?? []);
        $existingStmt = $db->prepare('SELECT id, domain FROM domains WHERE policy_id = :pid');
        $existingStmt->bindValue(':pid', $pid, SQLITE3_INTEGER);
        $existingRes = $existingStmt->execute();
        while ($row = $existingRes->fetchArray(SQLITE3_ASSOC)) {
            if (!isset($targetsSet[$row['domain']])) {
                $delStmt->reset();
                $delStmt->bindValue(':id', $row['id'], SQLITE3_INTEGER);
                $delStmt->execute();
                $removed++;
            }
        }
    }

    $db->exec('COMMIT');
    return ['success' => true, 'imported' => $imported, 'updated' => $updated, 'removed' => $removed, 'skipped' => $skipped];
}

// ============================================ SYSTEM CHECKS / NDM HOOKS ============================================
const BIRD_HOOK_PATH = '/opt/etc/ndm/ifstatechanged.d/60-dns-router-bird.sh';
const BIRD_NETFILTER_HOOK = '/opt/etc/ndm/netfilter.d/50-dns-router.sh';
const BIRD_IFSTATE_HOOK = '/opt/etc/ndm/ifstatechanged.d/50-dns-router.sh';

function getSetting(SQLite3 $db, $key) {
    $db->exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)');
    $stmt = $db->prepare('SELECT v FROM settings WHERE k = :k');
    $stmt->bindValue(':k', $key, SQLITE3_TEXT);
    $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    return $row ? $row['v'] : null;
}

function setSetting(SQLite3 $db, $key, $value) {
    $db->exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)');
    if ($value === null) {
        $stmt = $db->prepare('DELETE FROM settings WHERE k = :k');
    } else {
        $stmt = $db->prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (:k, :v)');
        $stmt->bindValue(':v', (string)$value, SQLITE3_TEXT);
    }
    $stmt->bindValue(':k', $key, SQLITE3_TEXT);
    $stmt->execute();
}

// Chosen in the panel: tunnel (kernel name), policy (its mark) and the table bird fills.
function birdSettings(SQLite3 $db) {
    $iface = getSetting($db, 'bird_iface');
    $policy = getSetting($db, 'bird_policy');
    $table = (int)getSetting($db, 'bird_table');
    return ($iface && $policy && $table) ? ['iface' => $iface, 'policy' => $policy, 'table' => $table, 'peer_route' => getSetting($db, 'bird_peer_route') === '1'] : null;
}

// Shell line that lists the active neighbors of bird4.conf in $PEERS
function birdPeersShell() {
    global $bird_config_file;
    return "PEERS=\$(sed -n 's/^[[:space:]]*neighbor[[:space:]][[:space:]]*\\([0-9.]*\\)[[:space:]].*/\\1/p' " . escapeshellarg($bird_config_file) . ")\n";
}

// While the tunnel is up: bird runs and marked traffic that our tables did not match falls through to the BGP table (its pref is set in Settings).
function birdHook() {
    global $bird_init_script;
    $db = getDb();
    if (!$db || !$bird_init_script) return null;
    $s = birdSettings($db);
    if (!$s) return null;
    $stmt = $db->prepare('SELECT mark_hex FROM policies WHERE name = :n');
    $stmt->bindValue(':n', $s['policy'], SQLITE3_TEXT);
    $p = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    if (!$p) return null;

    if (!preg_match('/^0x[0-9a-f]{1,8}$/i', $p['mark_hex'])) return null;
    $rule = "fwmark {$p['mark_hex']} table {$s['table']} pref " . routePrefs($db)['bgp'];
    $init = escapeshellarg($bird_init_script);
    // The BGP session is opened by the router itself, so it uses the main table: a host route there sends it into the tunnel.
    global $bird_config_file;
    $peerUp = $peerDown = '';
    $peerGet = '';
    if ($s['peer_route'] && $bird_config_file) {
        $dev = escapeshellarg($s['iface']);
        $peerGet = birdPeersShell();
        $peerUp = "for P in \$PEERS; do /opt/sbin/ip route replace \$P/32 dev $dev; done\n";
        $peerDown = "for P in \$PEERS; do /opt/sbin/ip route del \$P/32 dev $dev 2>/dev/null; done\n";
    }
    return "#!/bin/sh\n[ \"\$system_name\" = " . escapeshellarg($s['iface']) . " ] || exit 0\ntouch " . HOOK_RAN . "bird\n$peerGet"
        . "if [ \"\$up\" = up ] && [ \"\$connected\" = yes ]; then\n$peerUp$init start\n/opt/sbin/ip rule del $rule 2>/dev/null\n/opt/sbin/ip rule add $rule\n"
        . "elif [ \"\$up\" = down ] && [ \"\$connected\" = no ]; then\n$init stop\n/opt/sbin/ip rule del $rule 2>/dev/null\n$peerDown"
        . "fi\n";
}

// Every generated hook touches this file (plus its id) when it acts; the panel shows the time
const HOOK_RAN = '/tmp/dns-router-hook-';

const HOOK_DEFS = [
    'netfilter' => [BIRD_NETFILTER_HOOK, 'Firewall rebuilt', 'ndm rebuilt the firewall: ask the task manager for a refresh. It writes the routes, refreshes the domains (at most every 5 minutes) and the lists (at most once an hour) and puts the BGP rule and the neighbor routes back.'],
    'ifstate'   => [BIRD_IFSTATE_HOOK, 'Interface up', 'An interface came up and is connected: ask the task manager for a refresh. It writes the routes, refreshes the domains (at most every 5 minutes) and the lists (at most once an hour) and puts the BGP rule and the neighbor routes back.'],
    'bird'      => [BIRD_HOOK_PATH, 'BGP tunnel', 'Generated from "BGP routing hook": starts/stops bird and the BGP rule with the tunnel.'],
];

function hookDefaults() {
    global $php_cli;
    $run = $php_cli . ' ' . __FILE__;
    return [
        'netfilter' => "#!/bin/sh\n[ \"\$type\" = ip6tables ] && exit 0\n[ \"\$table\" = mangle ] || exit 0\ntouch " . HOOK_RAN . "netfilter\n"
            . "$run event >/dev/null 2>&1 &\n",
        'ifstate' => "#!/bin/sh\n[ \"\$up\" = up ] && [ \"\$connected\" = yes ] || exit 0\ntouch " . HOOK_RAN . "ifstate\n"
            . "$run event >/dev/null 2>&1 &\n",
        'bird' => birdHook(),
    ];
}

// Per hook: switched off in the panel (hook_off_<id>) or replaced by the user's own text (hook_custom_<id>).
function hookFiles() {
    $db = getDb();
    $out = [];
    foreach (hookDefaults() as $id => $default) {
        if ($db && getSetting($db, "hook_off_$id") === '1') continue;
        $custom = $db ? getSetting($db, "hook_custom_$id") : null;
        $content = ($custom !== null && $custom !== '') ? $custom : $default;
        if ($content !== null) $out[HOOK_DEFS[$id][0]] = $content;
    }
    if ($db) $db->close();
    return $out;
}

function hooksStatus() {
    $out = [];
    foreach (hookFiles() as $path => $content) {
        $current = execPipelineAsRoot('cat ' . escapeshellarg($path) . ' 2>/dev/null');
        $out[] = ['path' => $path, 'installed' => $current === $content];
    }
    return $out;
}

function hooksInstall() {
    $results = [];
    $files = hookFiles();
    foreach (HOOK_DEFS as $def) {
        if (!isset($files[$def[0]])) execPipelineAsRoot('rm -f ' . escapeshellarg($def[0]));
    }
    foreach ($files as $path => $content) {
        execPipelineAsRoot('mkdir -p ' . escapeshellarg(dirname($path)));
        $ok = writeFileAsRoot($path, $content);
        execPipelineAsRoot('chmod 755 ' . escapeshellarg($path));
        $results[] = ['path' => $path, 'installed' => $ok && execPipelineAsRoot('cat ' . escapeshellarg($path)) === $content];
    }
    $success = !in_array(false, array_column($results, 'installed'), true);
    return ['success' => $success, 'hooks' => $results] + ($success ? [] : ['error' => 'Could not write hook files - is the OPKG component enabled on the router?']);
}

function testSu($password = null) {
    $out = trim(execPipelineAsRoot('cat /proc/self/status | grep Uid', $password));
    return ['success' => preg_match('/^Uid:\s*0\s+0\s+0\s+0\s*$/', $out) === 1, 'output' => $out];
}

function rciGet($path, $host = null) {
    global $rci_host;
    $raw = @file_get_contents(rtrim($host ?? $rci_host, '/') . $path);
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? $data : null;
}

// Finds an installed bird init script and config in the usual Entware places.
function detectBird($password = null) {
    $init = trim(strtok(execPipelineAsRoot('ls /opt/etc/init.d/ 2>/dev/null | grep -i bird', $password), "\n"));
    $conf = trim(strtok(execPipelineAsRoot('ls /opt/etc/bird*.conf 2>/dev/null', $password), "\n"));
    return [
        'init' => $init !== '' ? '/opt/etc/init.d/' . $init : null,
        'conf' => strpos($conf, '/opt/etc/') === 0 ? $conf : null,
    ];
}

// Each item: id, label, ok (true/false/null = cannot check yet), level (required|optional),
// detail, fix (shell commands to copy), action (button the UI can offer).
function systemChecks() {
    global $php_cli, $configFile;
    $items = [];
    $add = function ($id, $label, $ok, $level, $detail = '', $fix = [], $action = null) use (&$items) {
        $items[] = compact('id', 'label', 'ok', 'level', 'detail', 'fix', 'action');
    };

    $pv = 'php' . PHP_MAJOR_VERSION;
    $ini = php_ini_loaded_file() ?: 'your php.ini';
    $restart = 'ls /opt/etc/init.d/ | grep -i php   # then: /opt/etc/init.d/<that script> restart';

    $add('sqlite', 'PHP SQLite3', class_exists('SQLite3'), 'required',
        'Stores targets and policies.', ["opkg update && opkg install {$pv}-mod-sqlite3", $restart]);

    $disabled = array_map('trim', explode(',', (string)ini_get('disable_functions')));
    $shell = function_exists('shell_exec') && !in_array('shell_exec', $disabled, true);
    $add('shell', 'PHP shell_exec', $shell, 'required',
        'Needed to run ip route/rule as root.', ["Remove shell_exec from disable_functions in $ini", $restart]);
    if (!$shell) return $items;

    if ($configFile === null) {
        $add('su', 'Root access (su)', null, 'required', 'Checked when you enter the router password on the next step.');
        return $items;
    }

    $su = testSu();
    $add('su', 'Root access (su)', $su['success'], 'required',
        $su['success'] ? '' : 'The password in config.php is not the router admin password: ' . $su['output'],
        $su['success'] ? [] : ['Set $passwd in ' . $configFile . ' to the admin password of the Keenetic web UI']);
    if (!$su['success']) return $items;

    $cli = stripos(execPipelineAsRoot(escapeshellarg($php_cli) . ' -v'), 'PHP') !== false;
    $add('php_cli', 'php-cli', $cli, 'required', 'Runs the ndm hooks.', ["opkg install {$pv}-cli"]);

    $ip = trim(execPipelineAsRoot('readlink -f /opt/sbin/ip'));
    $add('ip_full', 'ip-full', $ip !== '' && stripos($ip, 'busybox') === false, 'optional',
        'The busybox ip cannot do "route get ... mark", used by Test Route and Clients.', ['opkg install ip-full']);

    $add('curl', 'curl (downloads for Lists)', listsCurl() !== '', 'optional',
        'Downloads the lists of IPs and domains from the source over HTTPS.', ['opkg update && opkg install curl ca-bundle'], 'installCurl');

    $openssl = phpCliModule('openssl');
    $add('openssl', 'PHP OpenSSL (DoT and QUIC in the DPI check)', $openssl['ok'], 'optional',
        $openssl['error'] !== '' ? 'The module is installed but does not load: the PHP core and the module are of different versions. ' . $openssl['error'] : 'The DoT and QUIC columns of the DPI check need it.',
        ["opkg update && opkg upgrade {$pv} {$pv}-cli {$pv}-fpm && opkg install --force-reinstall {$pv}-mod-openssl"], 'installOpenssl');
    $sockets = phpCliModule('sockets');
    $add('sockets', 'PHP sockets (QUIC through the tunnel)', $sockets['ok'], 'optional',
        $sockets['error'] !== '' ? 'The module is installed but does not load: the PHP core and the module are of different versions. ' . $sockets['error'] : 'Without it QUIC is checked only through the main route.',
        ["opkg update && opkg upgrade {$pv} {$pv}-cli {$pv}-fpm && opkg install --force-reinstall {$pv}-mod-sockets"], 'installSockets');

    $add('rci', 'Keenetic RCI', rciGet('/rci/show/ip/policy') !== null, 'required',
        'Policy list. Check $rci_host in config.php; the port is shown in the Keenetic web UI under Diagnostics.');

    $ndm = trim(execPipelineAsRoot('test -d /opt/etc/ndm && echo yes'));
    $hooks = $ndm === 'yes' ? hooksStatus() : [];
    $hooksOk = $ndm === 'yes' && !in_array(false, array_column($hooks, 'installed'), true);
    $add('hooks', 'ndm hooks (automatic re-apply)', $hooksOk, 'required',
        $ndm === 'yes' ? 'Re-applies routes when the firewall is rebuilt or an interface changes.'
                       : '/opt/etc/ndm is missing: enable the "OPKG packages" component in the Keenetic web UI (System settings -> Component options).',
        [], $ndm === 'yes' ? 'installHooks' : null);

    global $bird_init_script, $bird_config_file;
    $bird = detectBird();
    if ($bird_init_script) {
        $out = preg_replace('/\x1b\[[0-9;]*[a-zA-Z]/', '', trim(execPipelineAsRoot(escapeshellarg($bird_init_script) . ' status 2>&1')));
        $running = stripos($out, 'alive') !== false;
        $add('bird', 'bird4 (BGP)', $running, 'optional', $out, $running ? [] : [$bird_init_script . ' start']);
    } elseif ($bird['init']) {
        $add('bird', 'bird4 (BGP)', false, 'optional', 'Installed but not enabled in the panel.', [
            "\$bird_init_script = '{$bird['init']}';" . ($bird['conf'] ? "\n\$bird_config_file = '{$bird['conf']}';" : ''),
        ]);
    } else {
        $add('bird', 'bird4 (BGP)', false, 'optional', 'Not installed. Only needed for BGP geo-routing.', ['opkg install bird1-ipv4']);
    }
    if ($bird_init_script) {
        $hook = birdHook();
        $hookOk = $hook !== null && execPipelineAsRoot('cat ' . escapeshellarg(BIRD_HOOK_PATH)) === $hook;
        $add('bird_hook', 'BGP routing hook', $hookOk, 'optional',
            $hookOk ? 'bird starts with the tunnel; marked traffic falls through to the BGP table.' : 'Not set up: Tools, section BGP, "BGP routing hook".');
    }

    return $items;
}

// Path of curl for the list downloads, '' when it is not installed.
function listsCurl() {
    if (is_executable('/opt/bin/curl')) return '/opt/bin/curl';
    return trim((string)shell_exec('command -v curl'));
}

// The DPI check runs in php-cli, so that is where a module has to load. A module of another version than
// the PHP core stays in php -m's warning only, so ask PHP itself and keep the warning as the reason.
function phpCliModule($name) {
    global $php_cli;
    $out = execReadOnly([$php_cli, '-r', 'echo extension_loaded("' . $name . '") ? "yes" : "no";']);
    $error = preg_match('/Unable to load dynamic library \'' . $name . '[^\n]*/', $out, $m) ? $m[0] : '';
    return ['ok' => substr(trim($out), -3) === 'yes', 'error' => $error];
}

// Updates the PHP core together with the module: a fresh module on an old core does not load
function phpModuleInstall($name) {
    if (!in_array($name, ['openssl', 'sockets'], true)) fail('Unknown module');
    $pv = 'php' . PHP_MAJOR_VERSION;
    $out = execPipelineAsRoot("opkg update >/dev/null 2>&1; opkg upgrade $pv $pv-cli $pv-fpm 2>&1; opkg install --force-reinstall $pv-mod-$name 2>&1");
    $module = phpCliModule($name);
    if (!$module['ok']) return ['success' => false, 'error' => 'opkg could not install the module: ' . trim(substr($module['error'] ?: $out, -400))];
    // php-fpm keeps the old core until it restarts; it restarts a moment after this answer has gone
    execPipelineAsRoot('(sleep 2; for s in /opt/etc/init.d/*php*fpm*; do "$s" restart; done) >/dev/null 2>&1 &');
    return ['success' => true];
}

function curlInstall() {
    $out = execPipelineAsRoot('opkg update >/dev/null 2>&1; opkg install curl ca-bundle 2>&1');
    if (listsCurl() === '') return ['success' => false, 'error' => 'opkg could not install curl: ' . trim(substr($out, -400))];
    return ['success' => true];
}

// ============================================ SETUP WIZARD ============================================
function webUid() {
    preg_match('/^Uid:\s*(\d+)/m', (string)@file_get_contents('/proc/self/status'), $m);
    return isset($m[1]) ? (int)$m[1] : null;
}

function setupConfig($in) {
    $passwd = (string)($in['passwd'] ?? '');
    $rci = rtrim(trim((string)($in['rci_host'] ?? '')), '/');
    $start = (int)($in['our_table_start'] ?? 0);
    $user = trim((string)($in['auth_user'] ?? ''));
    $password = (string)($in['auth_password'] ?? '');

    if ($passwd === '') fail('Router admin password is required');
    if (!preg_match('~^https?://[\w.-]+(:\d+)?$~', $rci)) fail('RCI host must look like http://127.0.0.1:79');
    if ($start < 100 || $start > 60000) fail('Routing table start must be between 100 and 60000');
    if (!preg_match('/^[A-Za-z0-9_.-]{1,32}$/', $user)) fail('Login: letters, digits, . _ - (up to 32)');
    if (strlen($password) < 4) fail('Password must be at least 4 characters');

    if (!testSu($passwd)['success']) fail('su rejected this password - use the admin password of the Keenetic web UI');
    $GLOBALS['passwd'] = $passwd; // config is not loaded yet; every su call below needs it
    if (rciGet('/rci/show/ip/policy', $rci) === null) fail("Cannot read policies from $rci - check the RCI port");

    $target = __DIR__ . '/config.php';
    $vars = [
        'db_file'         => dirname($target) . '/routes.db',
        'rci_host'        => $rci,
        'our_table_start' => $start,
        'passwd'          => $passwd,
        'auth_user'       => $user,
        'auth_pass_hash'  => password_hash($password, PASSWORD_BCRYPT),
    ];
    $bird = detectBird($passwd);
    if ($bird['init']) $vars['bird_init_script'] = $bird['init'];
    if ($bird['conf']) $vars['bird_config_file'] = $bird['conf'];
    $content = configText($vars);

    // The file holds the root password: readable only by the php-fpm user
    $uid = webUid();
    if (!writeFileAsRoot($target, $content, false, $uid)) fail('Could not write config.php', 500);
    execPipelineAsRoot('chmod ' . ($uid !== null ? '600' : '644') . ' ' . escapeshellarg($target));
    if (trim(execPipelineAsRoot('test -s ' . escapeshellarg($target) . ' && echo yes')) !== 'yes') fail("config.php was not written to $target", 500);
    if (!is_file($target)) fail("config.php was written to $target but PHP cannot see it - check open_basedir", 500);
    return ['success' => true];
}

function doCreateDatabase() {
    global $db_file, $our_table_start;

    $log = [];

    if (file_exists($db_file)) {
        return ['success' => false, 'error' => 'Database already exists', 'log' => $log];
    }

    $db_dir = dirname($db_file);
    if (!is_dir($db_dir)) {
        @mkdir($db_dir, 0755, true);
        $log[] = "Directory created: $db_dir";
    }

    $db = new SQLite3($db_file);
    $db->exec("PRAGMA foreign_keys = ON;");

    $db->exec("
        CREATE TABLE policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            mark_hex TEXT NOT NULL,
            keenetic_table INTEGER,
            our_table INTEGER UNIQUE NOT NULL,
            active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ");
    $log[] = "Table 'policies' created";

    $db->exec("
        CREATE TABLE domains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL,
            policy_id INTEGER NOT NULL,
            interface TEXT DEFAULT '',
            gateway TEXT DEFAULT '',
            current_ip TEXT DEFAULT '',
            previous_ip TEXT DEFAULT '',
            last_check DATETIME,
            enabled BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE,
            UNIQUE(domain, policy_id)
        )
    ");
    $log[] = "Table 'domains' created";

    $db->exec("CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT)");
    $db->exec("CREATE INDEX idx_domains_policy ON domains(policy_id)");
    $db->exec("CREATE INDEX idx_domains_enabled ON domains(enabled)");
    $db->exec("CREATE INDEX idx_policies_active ON policies(active)");

    $policyUrl = rciPolicyUrl();
    if ($policyUrl === null) {
        $db->close();
        return ['success' => false, 'error' => '$rci_host is not set in config.php', 'log' => $log];
    }
    $response = @file_get_contents($policyUrl);
    if ($response === false) {
        $db->close();
        return ['success' => false, 'error' => "Cannot get data from $policyUrl", 'log' => $log];
    }

    $data = json_decode($response, true);
    if (!is_array($data)) {
        $db->close();
        return ['success' => false, 'error' => 'Invalid API response format', 'log' => $log];
    }
    if (count($data) > 100) {
        $db->close();
        return ['success' => false, 'error' => 'At most 100 policies are supported', 'log' => $log];
    }

    $stmt = $db->prepare('INSERT INTO policies (name, description, mark_hex, keenetic_table, our_table)
                           VALUES (:name, :descr, :mark, :kt, :table)');

    $index = 0;
    $imported = 0;
    foreach ($data as $policy_name => $policy_data) {
        if (!is_array($policy_data)) continue;

        $description = (string)($policy_data['description'] ?? '');
        $mark = strtolower((string)($policy_data['mark'] ?? ''));
        if (str_starts_with($mark, '0x')) $mark = substr($mark, 2);
        if (!preg_match('/^[0-9a-f]{1,8}$/', $mark)) {
            $log[] = "  ! $policy_name: no valid mark, skipped";
            continue;
        }
        $keenetic_table = (int)($policy_data['table4'] ?? 0);
        $mark_hex = '0x' . $mark;
        $our_table = $our_table_start + $index;

        $stmt->reset();
        $stmt->bindValue(':name', $policy_name, SQLITE3_TEXT);
        $stmt->bindValue(':descr', $description, SQLITE3_TEXT);
        $stmt->bindValue(':mark', $mark_hex, SQLITE3_TEXT);
        $stmt->bindValue(':kt', $keenetic_table, SQLITE3_INTEGER);
        $stmt->bindValue(':table', $our_table, SQLITE3_INTEGER);

        if ($stmt->execute()) {
            $log[] = "  + $policy_name: $description [mark=$mark_hex, our_table=$our_table]";
            $imported++;
        } else {
            $log[] = "  ERROR adding $policy_name";
        }

        $index++;
    }

    $db->close();
    @chmod($db_file, 0660);
    $log[] = "Permissions set to 0660";

    return ['success' => true, 'log' => $log, 'policies_imported' => $imported];
}

// ============================================ ACTIONS ============================================
class ApiError extends Exception {
    public $status;
    public function __construct($msg, $status = 400) {
        parent::__construct($msg);
        $this->status = $status;
    }
}

function fail($msg, $status = 400) {
    throw new ApiError($msg, $status);
}

function respond($data) {
    if (!empty($GLOBALS['caught']) && is_array($data) && !array_is_list($data)) {
        $data['php_warnings'] = $GLOBALS['caught'];
    }
    echo json_encode($data);
}

// Language files lang.<code>.json next to app.php: {"_name": "Русский", "strings": {...}}. English is built in.
function availableLangs() {
    $out = [['code' => 'en', 'name' => 'English']];
    foreach (glob(__DIR__ . '/lang.*.json') ?: [] as $f) {
        if (!preg_match('/^lang\.([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/', basename($f), $m) || $m[1] === 'en') continue;
        $j = json_decode((string)file_get_contents($f), true);
        $out[] = ['code' => $m[1], 'name' => is_array($j) && !empty($j['_name']) ? (string)$j['_name'] : $m[1]];
    }
    return $out;
}

function coreHandlers() {
    return [
        'state'        => fn() => ['state' => appState(), 'version' => APP_VERSION, 'langs' => availableLangs()],
        'login'        => 'doLogin',
        'logout'       => 'doLogout',
        'setupCheck'   => fn() => ['checks' => systemChecks()],
        'setupConfig'  => 'setupConfig',
        'setupDb'      => function () {
            $res = doCreateDatabase();
            if ($res['success']) $res['hooks'] = hooksInstall();
            return $res;
        },

        'getDomains'   => fn() => withDb(fn($db) => rows($db, '
            SELECT d.id, d.domain, d.policy_id, p.name AS policy_name, p.description, d.interface, d.gateway,
                   d.current_ip, d.previous_ip, d.ip_sources, d.dns_skip, d.last_check, d.enabled, d.created_at, d.updated_at
            FROM domains d LEFT JOIN policies p ON d.policy_id = p.id ORDER BY d.domain')),
        'getPolicies'  => fn() => withDb(fn($db) => rows($db, "
            SELECT id, name, description, mark_hex, keenetic_table, our_table, created_at, updated_at
            FROM policies ORDER BY CASE WHEN name = 'DELETED' THEN 999 ELSE 0 END, name")),
        'addDomain'    => 'addDomain',
        'updateDomain' => 'updateDomain',
        'deleteDomain' => 'deleteDomain',
        'saveTargetDns' => 'saveTargetDns',
        'refreshTarget' => 'refreshTarget',
        'syncPolicies' => fn() => withDb(fn($db) => locked(fn() => doSyncPolicies($db))),
        'applyRoutes'  => fn() => withDb(fn($db) => queueTargets($db, [], [])),
        'exportConfig' => function () {
            $data = withDb('doExportConfig');
            header('Content-Disposition: attachment; filename="keenetic-dns-router-export.json"');
            echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            exit;
        },
        'importConfig' => fn($in) => withDb(function ($db) use ($in) {
            $res = doImportConfig($db, $in);
            if (!$res['success']) fail($res['error']);
            $res['applied'] = applyNow($db, $in);
            return $res;
        }),

        'getSystemChecks' => fn() => ['checks' => systemChecks()],
        'installHooks'    => 'hooksInstall',
        'installCurl'     => 'curlInstall',
        'installOpenssl'  => fn() => phpModuleInstall('openssl'),
        'installSockets'  => fn() => phpModuleInstall('sockets'),
        'getRoutePrefs'   => fn() => withDb(fn($db) => routePrefs($db) + ['bird_table' => (int)getSetting($db, 'bird_table') ?: null]),
    ];
}

// Optional tabs (clients, interfaces, bird, routing tables, ...) live in ext.php and load only when asked for.
function extHandlers() {
    static $handlers;
    return $handlers ??= require __DIR__ . '/ext.php';
}

// Actions that change data or the routes: refused while a task of the task manager (updating targets and routes) is running.
const UPDATE_BLOCKS = [
    'syncPolicies', 'importConfig', 'installHooks', 'installCurl', 'installOpenssl', 'installSockets', 'saveBirdConfig', 'restartBird', 'setHookEnabled', 'saveHook', 'resetHook',
    'clearBirdLog', 'enableBirdLog', 'uploadUpdate', 'applyUpdate', 'rollbackUpdate', 'githubUpdate', 'saveDnsResolver', 'savePanelNet',
    'saveListsSources', 'saveRoutePrefs', 'saveBirdHook',
];

function jobIsRunning() {
    $prefix = sys_get_temp_dir() . '/dns-router-';
    $job = json_decode((string)@file_get_contents($prefix . 'job.json'), true);
    if (!$job || $job['state'] !== 'running') return false;
    $pid = (int)(json_decode((string)@file_get_contents($prefix . 'jobpid.json'), true)['pid'] ?? 0);
    return $pid === 0 || is_dir('/proc/' . $pid);
}

function handleRequest() {
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    register_shutdown_function(function () {
        $err = error_get_last();
        if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
            http_response_code(500);
            echo json_encode(['error' => 'Fatal PHP error: ' . $err['message'], 'file' => basename($err['file']), 'line' => $err['line']]);
        }
    });

    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');

    $body = json_decode((string)file_get_contents('php://input'), true);
    $in = $_GET + (is_array($body) ? $body : []);
    $action = (string)($in['action'] ?? '');

    // Anything that changes the router comes only as a JSON POST: a foreign page can send neither without a CORS preflight
    $readOnly = str_starts_with($action, 'get') || in_array($action, ['state', 'setupCheck', 'checkGithubUpdate', 'exportConfig', 'testRoute'], true);
    if (!$readOnly) {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            http_response_code(405);
            respond(['error' => 'This action needs POST']);
            return;
        }
        if (stripos((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') !== 0) {
            http_response_code(415);
            respond(['error' => 'This action needs a JSON body']);
            return;
        }
    }
    $state = appState();

    try {
        if (in_array($action, ['setupCheck', 'setupConfig', 'setupDb'], true)) {
            $expected = $action === 'setupDb' ? 'nodb' : 'noconfig';
            if ($state !== $expected && !($action === 'setupCheck' && $state === 'nodb')) fail("Setup is at step '$state', this action needs '$expected'", 403);
        } elseif ($action === 'login' && $state !== 'login') {
            fail('Not ready for login', 403);
        } elseif (!in_array($action, ['state', 'login', 'logout'], true) && $state !== 'ok') {
            http_response_code(401);
            respond(['error' => 'Unauthorized', 'state' => $state]);
            return;
        }

        // While the panel files are being replaced old and new code would answer side by side
        $maintenance = sys_get_temp_dir() . '/dns-router-maintenance';
        if ($action !== 'state' && is_file($maintenance) && filemtime($maintenance) > time() - 120) fail('The panel is being updated: try again in a minute', 503);
        if (in_array($action, UPDATE_BLOCKS, true) && jobIsRunning()) fail('An update is running: wait for it to finish', 409);

        // Tests hold a php-fpm worker for seconds: at most two at a time, so the panel keeps answering
        if (in_array($action, ['testRoute', 'testRouteCurl', 'testDnsResolver'], true)) {
            $testLock = null;
            foreach ([1, 2] as $slot) {
                $h = fopen(sys_get_temp_dir() . '/dns-router-test' . $slot . '.lock', 'c');
                if (flock($h, LOCK_EX | LOCK_NB)) {
                    $testLock = $h;
                    break;
                }
                fclose($h);
            }
            if (!$testLock) fail('Another test is running: wait for it to finish', 429);
        }

        $handler = coreHandlers()[$action] ?? extHandlers()[$action] ?? null;
        if ($handler === null) fail('Unknown action');
        respond($handler($in));
    } catch (ApiError $e) {
        http_response_code($e->status);
        respond(['error' => $e->getMessage()]);
    }
}

// ============================================ CLI ============================================
// php-cli app.php <apply|update|sync|passwd|hooks|checks|install>
// Idempotent setup for install.sh, runs as root. Without a config it creates one from the environment;
// with a config it keeps it and only repairs what is missing (bird settings, database, hooks).
function cliInstall() {
    global $db_file, $rci_host, $our_table_start, $passwd, $configFile;
    $webUser = getenv('DNSR_WEB_USER') ?: 'nobody';

    if (!isRoot()) exit("install must run as root\n");
    if (trim((string)shell_exec('id -u ' . escapeshellarg($webUser) . ' 2>/dev/null')) === '') exit("User $webUser does not exist\n");

    if ($configFile === null) {
        $routerPass = (string)getenv('DNSR_ROUTER_PASS');
        $panelPass = (string)getenv('DNSR_PANEL_PASS');
        $rci = rtrim(getenv('DNSR_RCI') ?: 'http://127.0.0.1:79', '/');
        $dir = rtrim(getenv('DNSR_CONF_DIR') ?: '/opt/etc/dns-router', '/');
        if ($routerPass === '' || strlen($panelPass) < 4) exit("DNSR_ROUTER_PASS and DNSR_PANEL_PASS (4+ chars) are required\n");
        if (rciGet('/rci/show/ip/policy', $rci) === null) exit("Cannot read policies from $rci - is the RCI port right?\n");

        @mkdir($dir, 0750, true);
        chown($dir, $webUser);
        chmod($dir, 0750);

        $configFile = "$dir/config.php";
        $vars = [
            'db_file'         => "$dir/routes.db",
            'rci_host'        => $rci,
            'our_table_start' => 400,
            'passwd'          => $routerPass,
            'auth_user'       => getenv('DNSR_PANEL_USER') ?: 'admin',
            'auth_pass_hash'  => password_hash($panelPass, PASSWORD_BCRYPT),
        ];
        $bird = detectBird();
        if ($bird['init']) $vars['bird_init_script'] = $bird['init'];
        if ($bird['conf']) $vars['bird_config_file'] = $bird['conf'];
        file_put_contents($configFile, configText($vars));
        chown($configFile, $webUser);
        chmod($configFile, 0600);
        foreach ($vars as $k => $v) $GLOBALS[$k] = $v;
        echo "Config created: $configFile\n";
    } else {
        echo "Config kept: $configFile\n";
        if (!hasPasswordHash()) {
            // config.php of panel 4.x: no panel login yet
            $panelPass = (string)getenv('DNSR_PANEL_PASS');
            if (strlen($panelPass) < 4) exit("config.php has no panel password: set DNSR_PANEL_PASS (4+ chars)\n");
            $user = getenv('DNSR_PANEL_USER') ?: 'admin';
            $hash = password_hash($panelPass, PASSWORD_BCRYPT);
            $c = preg_replace('/\?>\s*$/', '', (string)file_get_contents($configFile));
            file_put_contents($configFile, rtrim($c) . "\n\$auth_user = " . var_export($user, true) . ";\n\$auth_pass_hash = " . var_export($hash, true) . ";\n");
            $GLOBALS['auth_user'] = $user;
            $GLOBALS['auth_pass_hash'] = $hash;
            echo "Panel login added to the config\n";
        }
        if (empty($GLOBALS['bird_init_script'])) {
            $bird = detectBird();
            if ($bird['init']) {
                $add = "\$bird_init_script = " . var_export($bird['init'], true) . ";\n"
                    . ($bird['conf'] ? "\$bird_config_file = " . var_export($bird['conf'], true) . ";\n" : '');
                file_put_contents($configFile, $add, FILE_APPEND);
                $GLOBALS['bird_init_script'] = $bird['init'];
                echo "bird found, added to the config\n";
            }
        }
    }

    if (file_exists($db_file)) {
        echo "Database kept: $db_file\n";
    } else {
        if (rciGet('/rci/show/ip/policy') === null) exit("Cannot read policies from $rci_host - is the RCI port right?\n");
        $r = doCreateDatabase();
        echo implode("\n", $r['log']) . "\n";
        if (!$r['success']) exit("Database: {$r['error']}\n");
    }

    // Whatever an earlier (possibly failed) run left behind: the web user must own the folder, config and database.
    $confDir = dirname($configFile);
    @chown($confDir, $webUser);
    @chmod($confDir, 0750);
    @chown($configFile, $webUser);
    @chmod($configFile, 0600);
    foreach ([$db_file, $db_file . '-journal', $db_file . '-wal', $db_file . '-shm'] as $f) {
        if (file_exists($f)) { @chown($f, $webUser); @chmod($f, 0660); }
    }

    $h = hooksInstall();
    foreach ($h['hooks'] as $x) echo ($x['installed'] ? 'ok   ' : 'FAIL ') . $x['path'] . "\n";
    if (!$h['success']) exit("{$h['error']}\n");
}

// Run as root: the config's owner is the web user, so the folder and database get the same owner (an earlier root-run step may have left them with root).
function fixDataOwnership() {
    global $configFile, $db_file;
    if (!isRoot() || !$configFile || !is_file($configFile)) return;
    $uid = fileowner($configFile);
    if (!$uid) return;
    foreach ([dirname($configFile), $db_file, $db_file . '-journal', $db_file . '-wal', $db_file . '-shm'] as $f) {
        if ($f && file_exists($f)) @chown($f, $uid);
    }
    if ($db_file && file_exists($db_file)) @chmod($db_file, 0660);
}

function configText(array $vars) {
    $content = "<?php\n";
    foreach ($vars as $k => $v) $content .= "\$$k = " . var_export($v, true) . ";\n";
    return $content . "// \$php_cli = '/opt/bin/php-cli';\n";
}

function runCli(array $argv) {
    $cmd = $argv[1] ?? '';
    $db = in_array($cmd, ['apply', 'update', 'event', 'sync', 'next'], true) ? (getDb() ?: exit("Database not found - finish the setup wizard first\n")) : null;

    switch ($cmd) {
        case 'apply':
            $r = locked(fn() => doApplyRoutes($db), true);
            echo $r === null ? "Busy, queued\n" : ($r['success'] ? "{$r['routes']} routes applied\n" : "{$r['error']}\n");
            break;
        case 'event':
        case 'update':
            extHandlers();
            // The hook only queues a task; the dispatcher decides what is due and applies the routes
            try {
                $started = doStartJob($db, ['kind' => 'event'], 'hook');
                echo !empty($started['queued']) ? "Task queued\n" : (!empty($started['already']) ? "Task is already waiting\n" : "Task started\n");
            } catch (ApiError $e) {
                echo $e->getMessage() . "\n";
            }
            break;
        case 'job':
            $db = getDb() ?: exit("Database not found\n");
            extHandlers();
            jobRun($db, $argv[2] ?? '', array_filter(array_map('intval', explode(',', $argv[3] ?? ''))));
            break;
        case 'dpi':
            extHandlers();
            dpiRun(getDb());
            break;
        case 'next':
            extHandlers();
            jobAfterExit($db, $argv[2] ?? '');
            break;
        case 'sync':
            $r = locked(fn() => doSyncPolicies($db));
            echo $r['success'] ? "Policies synced\n" : "{$r['error']}\n";
            break;
        case 'passwd':
            $file = findConfig();
            if (!isset($argv[2]) || $file === null) exit("Usage: app.php passwd <new password>\n");
            $hash = var_export(password_hash($argv[2], PASSWORD_BCRYPT), true);
            $src = file_get_contents($file);
            file_put_contents($file, preg_replace_callback('/\$auth_pass_hash\s*=\s*[^;]*;/', fn() => "\$auth_pass_hash = $hash;", $src, 1));
            echo "Password changed\n";
            break;
        case 'install':
            cliInstall();
            break;
        case 'hooks':
            fixDataOwnership();
            $r = hooksInstall();
            foreach ($r['hooks'] as $h) echo ($h['installed'] ? 'ok   ' : 'FAIL ') . $h['path'] . "\n";
            break;
        case 'checks':
            foreach (systemChecks() as $c) echo ($c['ok'] === null ? '[ ? ] ' : ($c['ok'] ? '[ok] ' : '[!!] ')) . $c['label'] . ($c['ok'] === false ? " - {$c['detail']}\n      " . implode("\n      ", $c['fix']) : '') . "\n";
            break;
        default:
            echo "Usage: app.php <apply|update|event|sync|listsync|job|passwd|hooks|checks|install>\n";
    }
}

PHP_SAPI === 'cli' ? runCli($argv) : handleRequest();
