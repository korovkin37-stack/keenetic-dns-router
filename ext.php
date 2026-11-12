<?php
defined("APP_VERSION") || exit;
// Optional tabs: routing tables, Test Route, DNS info, clients, interfaces, dashboard, bird4.
// Loaded by app.php only when one of these actions is requested.

function toNumber($v) {
    return is_numeric($v) ? $v + 0 : 0;
}

function lastNumericLine($output) {
    $lines = preg_split('/\r?\n/', trim((string)$output));
    for ($i = count($lines) - 1; $i >= 0; $i--) {
        $line = trim($lines[$i]);
        if (preg_match('/^\d+$/', $line)) {
            return (int)$line;
        }
    }
    return 0;
}

function tableRouteStats($ref) {
    $safeRef = escapeshellarg((string)$ref);
    $base = "/opt/sbin/ip route show table $safeRef 2>/dev/null";

    // wc -l - общее число строк. ОДНО число - PHP никогда не видит саму
    // таблицу маршрутов целиком, сколько бы там ни было записей.
    $total = lastNumericLine(execPipelineAsRoot("$base | wc -l"));

    return ['total' => $total];
}

function doGetRoutingTablesList(SQLite3 $db) {
    $ownTables = [];
    $res = $db->query("SELECT id, name, our_table FROM policies WHERE name != 'DELETED'");
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $ownTables[(int)$row['our_table']] = ['id' => (int)$row['id'], 'name' => $row['name'], 'kind' => 'targets'];
        $ownTables[listTable($row['our_table'])] = ['id' => (int)$row['id'], 'name' => $row['name'], 'kind' => 'lists'];
    }

    $rulesRaw = execReadOnly(['/opt/sbin/ip', 'rule', 'show']);
    $rulesByTable = [];
    foreach (preg_split('/\r?\n/', trim($rulesRaw)) as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (preg_match('/^(\d+):\s*(.+?)\s+lookup\s+(\S+)/', $line, $m)) {
            $rulesByTable[$m[3]][] = ['pref' => (int)$m[1], 'selector' => trim($m[2])];
        }
    }

    $refs = array_keys($rulesByTable);
    foreach (array_keys($ownTables) as $id) { $refs[] = (string)$id; }
    foreach (['main', 'default', 'local'] as $t) { $refs[] = $t; }
    $refs = array_values(array_unique($refs));

    $tables = [];
    foreach ($refs as $ref) {
        $numericId = preg_match('/^\d+$/', $ref) === 1 ? (int)$ref : null;

        $tables[] = [
            'ref'        => $ref, // как передавать в `ip route show table <ref>`
            'id'         => $numericId,
            'managed_by' => $numericId !== null ? ($ownTables[$numericId] ?? null) : null,
            'rules'      => $rulesByTable[$ref] ?? [],
        ];
    }

    usort($tables, function ($a, $b) {
        if ($a['id'] !== null && $b['id'] !== null) return $a['id'] <=> $b['id'];
        if ($a['id'] !== null) return -1;
        if ($b['id'] !== null) return 1;
        return strcmp($a['ref'], $b['ref']);
    });

    return $tables;
}

function doGetTableRouteCount($ref) {
    return tableRouteStats($ref)['total'];
}

function doGetTableRoutesPage($ref, $offset, $limit, $filter) {
    $safeRef = escapeshellarg((string)$ref);
    $base = "/opt/sbin/ip route show table $safeRef 2>/dev/null";

    $filter = trim((string)$filter);
    if ($filter !== '') {
        // -F: искать как обычную строку, не regex (иначе точки в IP/CIDR
        // трактовались бы как "любой символ") -i: без учёта регистра.
        $base .= ' | grep -F -i ' . escapeshellarg($filter);
    }

    $offset = max(0, (int)$offset);
    $limit = max(1, min(500, (int)$limit)); // защитный потолок на случай кривого запроса с фронта
    $start = $offset + 1;
    $end = $offset + $limit + 1;

    $pageRaw = execPipelineAsRoot("$base | sed -n '{$start},{$end}p'");

    $rawLines = preg_split('/\r?\n/', (string)$pageRaw);

    $lines = [];
    foreach ($rawLines as $line) {
        $line = rtrim($line, "\r");
        if ($line === '') continue;
        $lines[] = $line;
    }

    $hasMore = count($lines) > $limit;
    if ($hasMore) {
        array_pop($lines); // это была та самая "лишняя" +1 строка, не часть страницы
    }

    return ['lines' => $lines, 'has_more' => $hasMore];
}

function doTestRoute($ip, $mark = '') {
    $argv = ['/opt/sbin/ip', 'route', 'get', $ip];
    if ($mark !== '') {
        $argv[] = 'mark';
        $argv[] = $mark;
    }

    $raw = execAsRoot($argv);
    $lines = preg_split('/\r?\n/', trim((string)$raw));

    $rawText = preg_replace('/\s+/', ' ', trim(implode(' ', $lines)));

    return ['raw' => $rawText, 'parsed' => parseRouteGetOutput($rawText)];
}

function parseRouteGetOutput($rawText) {
    $firstLine = '';
    foreach (preg_split('/\r?\n/', trim($rawText)) as $line) {
        $line = trim($line);
        if ($line !== '') { $firstLine = $line; break; }
    }
    if ($firstLine === '') return null;

    if (preg_match('/^(RTNETLINK|Error|ip:)/i', $firstLine)) {
        return null;
    }

    $tokens = preg_split('/\s+/', $firstLine);
    $result = ['destination' => array_shift($tokens), 'gateway' => null, 'dev' => null, 'table' => null, 'src' => null, 'mark' => null];

    $known = ['via' => 'gateway', 'dev' => 'dev', 'table' => 'table', 'src' => 'src', 'mark' => 'mark'];
    for ($i = 0; $i < count($tokens); $i++) {
        if (isset($known[$tokens[$i]]) && isset($tokens[$i + 1])) {
            $result[$known[$tokens[$i]]] = $tokens[$i + 1];
            $i++;
        }
    }

    return $result;
}

function doTestRouteMulti($target, $mark = '') {
    $target = trim($target);
    if ($target === '') {
        return ['type' => 'error', 'error' => 'Enter a destination IP, CIDR or domain'];
    }

    if (isValidIPv4Cidr($target)) {
        $res = doTestRoute($target, $mark);
        $res['ip'] = $target;
        return ['type' => 'ip', 'target' => $target, 'results' => [$res]];
    }

    if (!isValidDomain($target)) {
        return ['type' => 'error', 'error' => 'Not a valid IP, CIDR or domain'];
    }

    $mode = 'first';
    $servers = withDb(function ($db) use ($target, &$mode) {
        $mode = getSetting($db, 'dns_mode') === 'all' ? 'all' : 'first';
        $own = dnsServerList(getSetting($db, 'dns_servers'));
        $st = $db->prepare("SELECT dns_skip FROM domains WHERE domain = :d AND dns_skip != '' LIMIT 1");
        $st->bindValue(':d', $target, SQLITE3_TEXT);
        $row = $st->execute()->fetchArray(SQLITE3_ASSOC);
        return implode(' ', $row ? array_diff($own, dnsServerList($row['dns_skip'])) : $own);
    });
    $found = resolveMany([0 => [$target, dnsServerList($servers)]], $mode)[0];
    $ips = $found['ips'];
    if (!$ips) {
        return ['type' => 'error', 'error' => "Could not resolve $target"];
    }

    $by = [];
    foreach ($found['map'] as $list) $by = array_merge($by, $list);

    $results = [];
    foreach ($ips as $ip) {
        $res = doTestRoute($ip, $mark);
        $res['ip'] = $ip;
        $res['by'] = $found['map'][$ip] ?? [];
        $results[] = $res;
    }

    if (empty($results)) {
        return ['type' => 'error', 'error' => "Resolved $target but got no usable IPs"];
    }

    return ['type' => 'domain', 'target' => $target, 'resolver' => implode(', ', array_unique($by)), 'results' => $results];
}

function doGetDnsConfig() {
    $result = ['isp_servers' => [], 'proxies' => []];
    $rciBase = rciHost();
    if ($rciBase === null) {
        return ['error' => '$rci_host is not set in config.php', 'isp_servers' => [], 'proxies' => []];
    }

    $nsRaw = @file_get_contents($rciBase . '/rci/show/ip/name-server');
    if ($nsRaw !== false) {
        $data = json_decode($nsRaw, true);
        if (is_array($data) && !empty($data['server']) && is_array($data['server'])) {
            foreach ($data['server'] as $s) {
                if (!empty($s['address'])) {
                    $result['isp_servers'][] = $s['address'];
                }
            }
            $result['isp_servers'] = array_values(array_unique($result['isp_servers']));
        }
    }

    $proxyRaw = @file_get_contents($rciBase . '/rci/show/dns-proxy');
    if ($proxyRaw !== false) {
        $data = json_decode($proxyRaw, true);
        if (is_array($data) && !empty($data['proxy-status']) && is_array($data['proxy-status'])) {
            foreach ($data['proxy-status'] as $p) {
                $name = (string)($p['proxy-name'] ?? '?');
                $servers = [];

                if (!empty($p['proxy-tls']['server-tls']) && is_array($p['proxy-tls']['server-tls'])) {
                    foreach ($p['proxy-tls']['server-tls'] as $s) {
                        if (!empty($s['address'])) {
                            $servers[] = [
                                'type'    => 'DoT',
                                'address' => $s['address'],
                                'host'    => $s['sni'] ?? '',
                            ];
                        }
                    }
                }

                $httpsList = $p['proxy-https']['server-https'] ?? ($p['proxy-https'] ?? null);
                if (is_array($httpsList)) {
                    foreach ($httpsList as $s) {
                        if (is_array($s) && !empty($s['address'])) {
                            $servers[] = [
                                'type'    => 'DoH',
                                'address' => $s['address'],
                                'host'    => $s['host'] ?? ($s['sni'] ?? ''),
                            ];
                        }
                    }
                }

                if (!empty($servers)) {
                    $result['proxies'][] = ['name' => $name, 'servers' => $servers];
                }
            }
        }
    }

    return $result;
}

function doGetClients() {
    $rciBase = rciHost();
    if ($rciBase === null) {
        return ['error' => '$rci_host is not set in config.php', 'clients' => []];
    }
    $raw = @file_get_contents($rciBase . '/rci/show/ip/hotspot');
    if ($raw === false) {
        return ['error' => 'Could not reach Keenetic RCI', 'clients' => []];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['error' => 'Invalid RCI response', 'clients' => []];
    }

    $hosts = null;
    if (isset($data[0]) && is_array($data[0])) {
        $hosts = $data;
    } else {
        foreach ($data as $v) {
            if (is_array($v) && isset($v[0]) && is_array($v[0])) {
                $hosts = $v;
                break;
            }
        }
    }
    if ($hosts === null) {
        return ['error' => 'Unexpected RCI response shape', 'clients' => []];
    }

    // Repeaters of the mesh: id (cid) and mac -> display name
    $members = [];
    $memberRaw = @file_get_contents($rciBase . '/rci/show/mws/member');
    $memberList = $memberRaw === false ? null : json_decode($memberRaw, true);
    if (is_array($memberList)) {
        foreach ($memberList as $m) {
            if (!is_array($m)) continue;
            $label = '';
            foreach (['name', 'description', 'known-host', 'hostname', 'model'] as $key) {
                if (!empty($m[$key]) && is_string($m[$key])) { $label = $m[$key]; break; }
            }
            if ($label === '') continue;
            foreach (['cid', 'mac'] as $key) {
                if (!empty($m[$key])) $members[strtolower($m[$key])] = $label;
            }
        }
    }

    $clients = [];
    foreach ($hosts as $h) {
        if (!is_array($h)) continue;

        // Clients behind a repeater have no ssid, their Wi-Fi data sits in "mws"
        $mws = is_array($h['mws'] ?? null) ? $h['mws'] : [];
        $isWifi = isset($h['ssid']) || isset($mws['rssi']) || isset($mws['txrate']) || isset($mws['mode']);
        $online = ($h['link'] ?? '') === 'up' || !empty($h['active']);
        $via = '';
        foreach (['ap', 'cid'] as $key) {
            $ref = strtolower((string)($mws[$key] ?? ''));
            if ($ref !== '' && isset($members[$ref])) { $via = $members[$ref]; break; }
        }

        $clients[] = [
            'mac'        => (string)($h['mac'] ?? ''),
            'ip'         => (string)($h['ip'] ?? ''),
            'name'       => (string)($h['name'] ?: ($h['hostname'] ?? '')),
            'policy'     => (string)($h['policy'] ?? ''),
            'registered' => (bool)($h['registered'] ?? false),
            'active'     => (bool)($h['active'] ?? false),
            'link'       => (string)($h['link'] ?? ''),
            'online'     => $online,
            'via'        => $via,
            'interface'  => (string)($h['interface']['name'] ?? ''),
            'uptime'     => (int)($h['uptime'] ?? 0),
            'rxbytes'    => toNumber($h['rxbytes'] ?? 0),
            'txbytes'    => toNumber($h['txbytes'] ?? 0),
            'is_wifi'    => $isWifi,
            'speed'      => $isWifi ? ($h['txrate'] ?? $mws['txrate'] ?? null) : ($h['speed'] ?? null),
            'ssid'       => (string)($h['ssid'] ?? ''),
        ];
    }

    return ['clients' => $clients];
}

function doGetClientConnections($clientIp) {
    if (!isValidIPv4($clientIp)) {
        return ['error' => 'Invalid IP address', 'connections' => []];
    }

    $needle = escapeshellarg("src=$clientIp ");
    $base = "cat /proc/net/nf_conntrack 2>/dev/null | grep -F $needle";

    $total = lastNumericLine(execPipelineAsRoot("$base | wc -l"));

    $limit = 300;
    $raw = execPipelineAsRoot("$base | head -n $limit");
    $lines = preg_split('/\r?\n/', trim((string)$raw));

    $connections = [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') continue;

        if (!preg_match('/^\S+\s+\d+\s+(\S+)/', $line, $mProto)) continue;
        if (!preg_match('/src=(\S+)/', $line, $mSrc)) continue;
        if ($mSrc[1] !== $clientIp) continue; // защита от совпадения по обратному направлению
        if (!preg_match('/dst=(\S+)/', $line, $mDst)) continue;

        preg_match('/dport=(\d+)/', $line, $mDport);
        preg_match('/packets=(\d+)/', $line, $mPackets);
        preg_match('/bytes=(\d+)/', $line, $mBytes);
        // "mark=" без учёта соседнего "nmark=" - у него тоже есть
        // подстрока "mark=", (?<!n) исключает именно это совпадение.
        preg_match('/(?<!n)mark=(\d+)/', $line, $mMark);

        $connections[] = [
            'proto'   => $mProto[1],
            'dst'     => $mDst[1],
            'dport'   => isset($mDport[1]) ? (int)$mDport[1] : null,
            'packets' => isset($mPackets[1]) ? (int)$mPackets[1] : null,
            'bytes'   => isset($mBytes[1]) ? (int)$mBytes[1] : null,
            'mark'    => isset($mMark[1]) ? (int)$mMark[1] : 0,
        ];
    }

    $grouped = [];
    foreach ($connections as $c) {
        $key = $c['proto'] . '|' . $c['dst'] . '|' . $c['dport'] . '|' . $c['mark'];
        if (!isset($grouped[$key])) {
            $grouped[$key] = $c;
            $grouped[$key]['count'] = 1;
        } else {
            $grouped[$key]['packets'] = ($grouped[$key]['packets'] ?? 0) + ($c['packets'] ?? 0);
            $grouped[$key]['bytes'] = ($grouped[$key]['bytes'] ?? 0) + ($c['bytes'] ?? 0);
            $grouped[$key]['count']++;
        }
    }
    $connections = array_values($grouped);
    usort($connections, function ($a, $b) {
        return ($b['bytes'] ?? 0) <=> ($a['bytes'] ?? 0);
    });

    $db = getDb();
    $policiesByMark = [];
    if ($db) {
        $res = $db->query("SELECT name, mark_hex, our_table FROM policies WHERE name != 'DELETED'");
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $policiesByMark[strtolower($row['mark_hex'])] = $row;
        }
    }

    foreach ($connections as &$c) {
        $c['managed'] = $db ? findManagedTargetForIp($db, $c['dst']) : null;
        $c['table_confirmed'] = false; // подтвердится ниже живым ip route get, если попадёт в лимит

        if ($c['mark'] > 0) {
            $markHex = '0x' . dechex($c['mark']);
            if (isset($policiesByMark[$markHex])) {
                $c['policy'] = $policiesByMark[$markHex]['name'];
                $c['table'] = $policiesByMark[$markHex]['our_table'];
            } else {
                // Метка есть, но нашей политике не принадлежит - могла
                // быть выставлена самим Keenetic для чего-то своего.
                $c['policy'] = null;
                $c['table'] = null;
            }
        } else {
            $c['policy'] = null;
            $c['table'] = 'main'; // без метки - обычная маршрутизация
        }
    }
    unset($c);

    $routeCache = [];
    $routeLookupLimit = 15;
    $lookupsDone = 0;
    foreach ($connections as &$c) {
        if ($lookupsDone >= $routeLookupLimit) break;

        $markHex = $c['mark'] > 0 ? ('0x' . dechex($c['mark'])) : '';
        $cacheKey = $c['dst'] . '|' . $markHex;
        if (!isset($routeCache[$cacheKey])) {
            $res = doTestRoute($c['dst'], $markHex);
            $routeCache[$cacheKey] = $res['parsed'] ?? null;
            $lookupsDone++;
        }
        $parsed = $routeCache[$cacheKey];
        $c['gateway'] = $parsed['gateway'] ?? null;
        $c['interface'] = $parsed['dev'] ?? null;

        $c['table'] = !empty($parsed['table']) ? $parsed['table'] : 'main';
        $c['table_confirmed'] = true;
    }
    unset($c);
    foreach ($connections as &$c) {
        if (!array_key_exists('gateway', $c)) {
            $c['gateway'] = null;
            $c['interface'] = null;
            $c['table_confirmed'] = false;
        }
    }
    unset($c);

    return [
        'connections' => $connections,
        'total'       => $total,
        'truncated'   => $total > count($lines),
        'route_lookups_capped' => $lookupsDone >= $routeLookupLimit,
    ];
}

function findManagedTargetForIp($db, $ip) {
    static $targets = null;
    if ($targets === null) {
        $targets = [];
        $res = $db->query("SELECT d.domain, d.current_ip, p.name AS policy_name
                            FROM domains d JOIN policies p ON d.policy_id = p.id
                            WHERE d.enabled = 1 AND p.name != 'DELETED'");
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $ips = json_decode($row['current_ip'] ?? '', true);
            $targets[] = [
                'domain'      => $row['domain'],
                'ips'         => is_array($ips) ? $ips : [],
                'policy_name' => $row['policy_name'],
            ];
        }
    }

    $ipLong = ip2long($ip);
    foreach ($targets as $t) {
        foreach ($t['ips'] as $entry) {
            if ($entry === $ip) {
                return ['target' => $t['domain'], 'policy' => $t['policy_name']];
            }
            if ($ipLong !== false && strpos($entry, '/') !== false) {
                $parts = explode('/', $entry, 2);
                $netLong = ip2long($parts[0]);
                $bits = (int)($parts[1] ?? 32);
                if ($netLong !== false && $bits >= 0 && $bits <= 32) {
                    $mask = $bits === 0 ? 0 : (~0 << (32 - $bits));
                    if (($ipLong & $mask) === ($netLong & $mask)) {
                        return ['target' => $t['domain'], 'policy' => $t['policy_name']];
                    }
                }
            }
        }
    }
    return null;
}

function doResolveHostnames($ips) {
    $result = [];
    if (!is_array($ips)) {
        return ['hostnames' => $result];
    }

    $limit = 20;
    $count = 0;
    foreach ($ips as $ip) {
        if ($count >= $limit) break;
        if (!is_string($ip) || !isValidIPv4($ip)) continue;

        $host = @gethostbyaddr($ip);
        $result[$ip] = ($host !== false && $host !== $ip) ? $host : null;
        $count++;
    }

    return ['hostnames' => $result];
}

function doGetPolicyTrafficSummary() {
    $clientsResult = doGetClients();
    if (!isset($clientsResult['clients']) || !is_array($clientsResult['clients'])) {
        return ['summary' => [], 'error' => $clientsResult['error'] ?? null];
    }

    $summary = [];
    foreach ($clientsResult['clients'] as $c) {
        $policy = $c['policy'] ?: '';
        if ($policy === '') continue; // клиент без политики - нечего суммировать в разрезе политик
        if (!isset($summary[$policy])) {
            $summary[$policy] = ['rxbytes' => 0, 'txbytes' => 0, 'clients' => 0];
        }
        $summary[$policy]['rxbytes'] += toNumber($c['rxbytes'] ?? 0);
        $summary[$policy]['txbytes'] += toNumber($c['txbytes'] ?? 0);
        $summary[$policy]['clients']++;
    }

    return ['summary' => $summary];
}

function doGetPolicyRoutesSummary() {
    $policyUrl = rciPolicyUrl();
    if ($policyUrl === null) {
        return ['error' => '$rci_host is not set in config.php', 'policies' => []];
    }

    $raw = @file_get_contents($policyUrl);
    if ($raw === false) {
        return ['error' => 'Could not reach Keenetic RCI', 'policies' => []];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['error' => 'Invalid RCI response', 'policies' => []];
    }

    $result = [];
    foreach ($data as $policyName => $p) {
        if (!is_array($p)) continue;

        $routes = [];
        if (isset($p['route4']['route']) && is_array($p['route4']['route'])) {
            foreach ($p['route4']['route'] as $r) {
                if (!is_array($r)) continue;
                $routes[] = [
                    'destination' => (string)($r['destination'] ?? ''),
                    'gateway'     => (string)($r['gateway'] ?? ''),
                    'interface'   => (string)($r['interface'] ?? ''),
                    'metric'      => isset($r['metric']) ? (int)$r['metric'] : null,
                    'floating'    => (bool)($r['floating'] ?? false),
                    'static'      => (bool)($r['static'] ?? false),
                ];
            }
        }

        $result[$policyName] = ['routes' => $routes];
    }

    return ['policies' => $result];
}

function doGetInterfaces() {
    $rciBase = rciHost();
    if ($rciBase === null) {
        return ['error' => '$rci_host is not set in config.php', 'interfaces' => []];
    }

    $raw = @file_get_contents($rciBase . '/rci/show/interface');
    if ($raw === false) {
        return ['error' => 'Could not reach Keenetic RCI', 'interfaces' => []];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['error' => 'Invalid RCI response', 'interfaces' => []];
    }

    $interfaces = [];
    foreach ($data as $id => $iface) {
        if (!is_array($iface)) continue;

        $realId = (string)($iface['id'] ?? $id);
        $type = (string)($iface['type'] ?? '');
        $name = (string)($iface['interface-name'] ?? $id);
        $system = (string)($iface['system-name'] ?? '');
        if ($system === '' && preg_match('/^Wireguard(\\d+)$/', $realId, $m)) $system = 'nwg' . $m[1];

        if ($type === 'Port' && strpos($realId, '/') !== false) {
            $parent = substr($realId, 0, strrpos($realId, '/'));
            $name = "$parent · Port $name";
        }

        $entry = [
            'id'          => $realId,
            'system'      => $system,
            'name'        => $name,
            'type'        => $type,
            'description' => (string)($iface['description'] ?? ''),
            'link'        => (string)($iface['link'] ?? ''),
            'state'       => (string)($iface['state'] ?? ''),
            'connected'   => ($iface['connected'] ?? '') === 'yes',
            'address'     => (string)($iface['address'] ?? ''),
            'mask'        => (string)($iface['mask'] ?? ''),
            'uptime'      => isset($iface['uptime']) ? (int)$iface['uptime'] : null,
            'mac'         => (string)($iface['mac'] ?? ''),
        ];

        // Wi-Fi радио (WifiMaster) - канал/ширина/температура.
        if (isset($iface['channel'])) {
            $entry['channel'] = (int)$iface['channel'];
            $entry['bandwidth'] = (string)($iface['bandwidth'] ?? '');
            $entry['temperature'] = isset($iface['temperature']) ? (int)$iface['temperature'] : null;
        }

        // Точка доступа - SSID/шифрование.
        if (isset($iface['ssid'])) {
            $entry['ssid'] = (string)$iface['ssid'];
            $entry['encryption'] = (string)($iface['encryption'] ?? '');
        }

        // WAN-приоритет и признак "сейчас основной шлюз" - самое полезное
        // поле для multi-WAN обзора, отдельно от простого link up/down.
        if (isset($iface['defaultgw'])) {
            $entry['defaultgw'] = (bool)$iface['defaultgw'];
        }
        if (isset($iface['priority'])) {
            $entry['priority'] = (int)$iface['priority'];
        }

        if (isset($iface['speed'])) {
            $entry['speed'] = (string)$iface['speed'];
            $entry['duplex'] = (string)($iface['duplex'] ?? '');
            $entry['auto_negotiation'] = ($iface['auto-negotiation'] ?? '') === 'on';
        }

        // Состав бриджа (Home/Guest network и т.п.) - какие физические
        // интерфейсы туда объединены.
        if (isset($iface['bridge']['interface']) && is_array($iface['bridge']['interface'])) {
            $members = [];
            foreach ($iface['bridge']['interface'] as $m) {
                if (is_array($m) && !empty($m['interface'])) {
                    $members[] = (string)$m['interface'];
                }
            }
            $entry['bridge_members'] = $members;
        }

        if (!empty($iface['tunnel-remote-destination']) && $iface['tunnel-remote-destination'] !== '0.0.0.0') {
            $entry['remote'] = (string)$iface['tunnel-remote-destination'];
        }

        if (isset($iface['ipsec-enabled'])) {
            $entry['ipsec_enabled'] = (bool)$iface['ipsec-enabled'];
            $entry['ipsec_ikev2_enabled'] = (bool)($iface['ipsec-ikev2-enabled'] ?? false);
            $entry['ipsec_encryption_level'] = (string)($iface['ipsec-encryption-level'] ?? '');
        }

        if (isset($iface['wireguard']['peer']) && is_array($iface['wireguard']['peer'])) {
            $peers = [];
            foreach ($iface['wireguard']['peer'] as $p) {
                if (!is_array($p)) continue;
                $handshake = isset($p['last-handshake']) ? (int)$p['last-handshake'] : null;
                $peers[] = [
                    'description'    => (string)($p['description'] ?? ''),
                    'online'         => (bool)($p['online'] ?? false),
                    'remote'         => (string)($p['remote-endpoint-address'] ?? ''),
                    'rxbytes'        => toNumber($p['rxbytes'] ?? 0),
                    'txbytes'        => toNumber($p['txbytes'] ?? 0),
                    'last_handshake' => ($handshake !== null && $handshake < 2147483647) ? $handshake : null,
                ];
            }
            $entry['wireguard_peers'] = $peers;
            $entry['wireguard_public_key'] = (string)($iface['wireguard']['public-key'] ?? '');
        }

        $interfaces[] = $entry;
    }

    return ['interfaces' => $interfaces, 'kernel' => kernelInterfaces()];
}

function doGetInterfaceStat($name) {
    $rciBase = rciHost();
    if ($rciBase === null) {
        return ['error' => '$rci_host is not set in config.php'];
    }

    $url = $rciBase . '/rci/show/interface/stat?name=' . urlencode($name);
    $raw = @file_get_contents($url);
    if ($raw === false) {
        return ['error' => 'Could not reach Keenetic RCI'];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['error' => 'Invalid RCI response'];
    }

    return [
        'rxbytes'   => toNumber($data['rxbytes'] ?? 0),
        'txbytes'   => toNumber($data['txbytes'] ?? 0),
        'rxpackets' => toNumber($data['rxpackets'] ?? 0),
        'txpackets' => toNumber($data['txpackets'] ?? 0),
        'rxerrors'  => toNumber($data['rxerrors'] ?? 0),
        'txerrors'  => toNumber($data['txerrors'] ?? 0),
        'rxdropped' => toNumber($data['rxdropped'] ?? 0),
        'txdropped' => toNumber($data['txdropped'] ?? 0),
        'rxspeed'   => toNumber($data['rxspeed'] ?? 0),
        'txspeed'   => toNumber($data['txspeed'] ?? 0),
    ];
}

function doGetClientDetail($mac) {
    $rciBase = rciHost();
    if ($rciBase === null) {
        return ['error' => '$rci_host is not set in config.php'];
    }
    if (!preg_match('/^[0-9a-fA-F:]{11,17}$/', $mac)) {
        return ['error' => 'Invalid MAC address'];
    }

    $url = $rciBase . '/rci/show/ip/hotspot/host?mac=' . urlencode($mac);
    $raw = @file_get_contents($url);
    if ($raw === false) {
        return ['error' => 'Could not reach Keenetic RCI'];
    }

    $data = json_decode($raw, true);
    // Ответ - массив с одним объектом (см. пример curl), но на всякий
    // случай допускаем и голый объект, если формат отличается по прошивке.
    $host = null;
    if (is_array($data)) {
        if (isset($data[0]) && is_array($data[0])) {
            $host = $data[0];
        } elseif (isset($data['mac'])) {
            $host = $data;
        }
    }
    if ($host === null) {
        return ['error' => 'No data for this MAC address'];
    }

    $result = [
        'raw'        => $host,
        'ip6'        => is_array($host['ip6'] ?? null) ? array_values($host['ip6']) : [],
        'access'     => (string)($host['access'] ?? ''),
        'schedule'   => (string)($host['schedule'] ?? ''),
        'first_seen' => isset($host['first-seen']) ? toNumber($host['first-seen']) : null,
        'last_seen'  => isset($host['last-seen']) ? toNumber($host['last-seen']) : null,
    ];

    if (isset($host['traffic-shape']) && is_array($host['traffic-shape'])) {
        $ts = $host['traffic-shape'];
        // rx/tx = 0 означает "без ограничения" - показывать нечего.
        if (!empty($ts['rx']) || !empty($ts['tx'])) {
            $result['traffic_shape'] = [
                'rx' => toNumber($ts['rx'] ?? 0),
                'tx' => toNumber($ts['tx'] ?? 0),
            ];
        }
    }

    if (isset($host['ssdp']) && is_array($host['ssdp'])) {
        $s = $host['ssdp'];
        $result['device'] = [
            'manufacturer' => (string)($s['manufacturer'] ?? ''),
            'model'        => (string)($s['model'] ?? ''),
            'model_desc'   => (string)($s['model-desc'] ?? ''),
            'model_numb'   => (string)($s['model-numb'] ?? ''),
            'serial'       => (string)($s['serial'] ?? ''),
        ];
    }

    $wifiInfo = null;
    if (isset($host['mws']) && is_array($host['mws'])) {
        $wifiInfo = $host['mws'];
    } elseif (isset($host['rssi']) || isset($host['txrate'])) {
        $wifiInfo = $host;
    }
    if ($wifiInfo !== null) {
        $result['wifi'] = [
            'ap'       => (string)($wifiInfo['ap'] ?? ''),
            'rssi'     => isset($wifiInfo['rssi']) ? toNumber($wifiInfo['rssi']) : null,
            'txrate'   => isset($wifiInfo['txrate']) ? toNumber($wifiInfo['txrate']) : null,
            'mode'     => (string)($wifiInfo['mode'] ?? ''),
            'security' => (string)($wifiInfo['security'] ?? ''),
            'ht'       => isset($wifiInfo['ht']) ? toNumber($wifiInfo['ht']) : null,
        ];
    }

    return $result;
}

function doGetDashboardData() {
    $uptime = null;
    $rciBase = rciHost();
    if ($rciBase !== null) {
        $raw = @file_get_contents($rciBase . '/rci/show/system/uptime');
        if ($raw !== false) {
            $data = json_decode($raw, true);
            if (is_numeric($data)) {
                $uptime = toNumber($data);
            } elseif (is_array($data) && isset($data['uptime'])) {
                $uptime = toNumber($data['uptime']);
            }
        }
    }

    $clientsResult = doGetClients();
    $clients = $clientsResult['clients'] ?? [];
    $onlineClients = 0;
    foreach ($clients as $c) {
        if (($c['link'] ?? '') === 'up' || !empty($c['active'])) $onlineClients++;
    }

    $interfacesResult = doGetInterfaces();
    $interfaces = $interfacesResult['interfaces'] ?? [];
    $interfacesUp = 0;
    foreach ($interfaces as $iface) {
        if (($iface['link'] ?? '') === 'up') $interfacesUp++;
    }

    $enabledTargets = 0;
    $totalPolicies = 0;
    $db = getDb();
    if ($db) {
        $enabledTargets = (int)$db->querySingle("SELECT COUNT(*) FROM domains WHERE enabled = 1");
        $totalPolicies = (int)$db->querySingle("SELECT COUNT(*) FROM policies WHERE name != 'DELETED'");
        $db->close();
    }

    return [
        'uptime'           => $uptime,
        'online_clients'   => $onlineClients,
        'total_clients'    => count($clients),
        'interfaces_up'    => $interfacesUp,
        'total_interfaces' => count($interfaces),
        'enabled_targets'  => $enabledTargets,
        'total_policies'   => $totalPolicies,
    ];
}

// ---- bird4 (BGP)
function birdRun($arg) {
    global $bird_init_script;
    $out = execPipelineAsRoot(escapeshellarg($bird_init_script) . " $arg 2>&1");
    return preg_replace('/\x1b\[[0-9;]*[a-zA-Z]/', '', trim($out));
}

function doGetBirdStatus() {
    global $bird_init_script;
    if (!$bird_init_script) return ['error' => '$bird_init_script is not set in config.php', 'running' => false, 'raw' => ''];
    $out = birdRun('status');
    return ['running' => stripos($out, 'alive') !== false, 'raw' => $out];
}

// BGP overview for the Tools tab. The numbers that need no bird client (table size, settings from bird4.conf)
// are always present; the session fields come from birdcl4/birdc4/birdc when one is installed.
function doGetBirdSession(SQLite3 $db) {
    global $bird_config_file;
    $conf = $bird_config_file ? execPipelineAsRoot('cat ' . escapeshellarg($bird_config_file)) : '';
    $conf = preg_replace('/#.*$/m', '', $conf);
    $pick = fn($re) => preg_match($re, $conf, $m) ? $m[1] : null;

    $settings = birdSettings($db);
    $table = $settings ? $settings['table'] : $pick('/\bkernel\s+table\s+(\d+)\s*;/');
    $config = [
        'hold' => $pick('/\bhold\s+time\s+(\d+)\s*;/'),
        'keepalive' => $pick('/\bkeepalive\s+time\s+(\d+)\s*;/'),
        'graceful' => $pick('/\bgraceful\s+restart\s+(on|aware|off)\s*;/'),
        'graceful_time' => $pick('/\bgraceful\s+restart\s+time\s+(\d+)\s*;/'),
        'local_as' => $pick('/\blocal\s+as\s+(\d+)\s*;/'),
    ];

    $pipe = 'BC=; for b in birdcl4 birdc4 birdc; do command -v $b >/dev/null 2>&1 && BC=$b && break; done; '
        . 'SOCK=; for s in /opt/var/run/bird*.ctl /var/run/bird*.ctl; do [ -S "$s" ] && SOCK=$s && break; done; '
        . 'echo "client=$BC"; echo "socket=$SOCK"; echo "---routes"; '
        . ($table ? 'ip route show table ' . (int)$table . ' 2>/dev/null | wc -l; ' : 'echo; ')
        . 'echo "---proto"; [ -n "$BC" ] && [ -n "$SOCK" ] && $BC -s "$SOCK" show protocols all 2>&1';
    $out = execPipelineAsRoot($pipe);
    [$head, $rest] = array_pad(explode("---routes\n", $out, 2), 2, '');
    [$routes, $proto] = array_pad(explode("---proto\n", $rest, 2), 2, '');
    preg_match('/^client=(.*)$/m', $head, $mc);
    preg_match('/^socket=(.*)$/m', $head, $ms);

    $sessions = [];
    $cur = null;
    foreach (explode("\n", $proto) as $line) {
        if (preg_match('/^(\S+)\s+BGP\s+\S+\s+(\S+)\s+(\S+)\s*(.*)$/', $line, $m)) {
            if ($cur) $sessions[] = $cur;
            $cur = ['name' => $m[1], 'state' => '', 'since' => $m[3], 'neighbor' => '', 'as' => '', 'hold' => null, 'keepalive' => null, 'caps' => '', 'imported' => null, 'error' => ''];
            continue;
        }
        if (!$cur) continue;
        if (preg_match('/^\s+BGP state:\s+(\S+)/', $line, $m)) $cur['state'] = $m[1];
        elseif (preg_match('/^\s+Neighbor address:\s+(\S+)/', $line, $m)) $cur['neighbor'] = $m[1];
        elseif (preg_match('/^\s+Neighbor AS:\s+(\d+)/', $line, $m)) $cur['as'] = $m[1];
        elseif (preg_match('/^\s+Hold timer:\s+\d+\/(\d+)/', $line, $m)) $cur['hold'] = (int)$m[1];
        elseif (preg_match('/^\s+Keepalive timer:\s+\d+\/(\d+)/', $line, $m)) $cur['keepalive'] = (int)$m[1];
        elseif (preg_match('/^\s+Neighbor caps:\s+(.*)$/', $line, $m)) $cur['caps'] = trim($m[1]);
        elseif (preg_match('/^\s+Routes:\s+(\d+) imported/', $line, $m)) $cur['imported'] = (int)$m[1];
        elseif (preg_match('/^\s+Last error:\s+(.*)$/', $line, $m)) $cur['error'] = trim($m[1]);
    }
    if ($cur) $sessions[] = $cur;

    return [
        'client' => trim($mc[1] ?? ''),
        'socket' => trim($ms[1] ?? ''),
        'table' => $table ? (int)$table : null,
        'routes' => $table ? (int)trim($routes) : null,
        'config' => $config,
        'sessions' => $sessions,
    ];
}

function doGetBirdConfig() {
    global $bird_config_file;
    if (!$bird_config_file) return ['error' => '$bird_config_file is not set in config.php', 'content' => null];
    $content = execPipelineAsRoot('cat ' . escapeshellarg($bird_config_file));
    if (stripos($content, 'No such file or directory') !== false) {
        return ['error' => 'Config file not found at ' . $bird_config_file, 'content' => null];
    }
    return ['content' => rtrim($content, "\n") . "\n", 'file' => $bird_config_file];
}

// Checks the text with "bird -p" (parse and exit) first and saves only what bird accepts, with a .bak backup.
// Never restarts bird: a restart stays an explicit button.
function doSaveBirdConfig($content) {
    global $bird_config_file;
    if (!$bird_config_file) return ['success' => false, 'error' => '$bird_config_file is not set in config.php'];
    if (!file_exists($bird_config_file)) return ['success' => false, 'error' => 'Config file not found at ' . $bird_config_file];

    $res = ['success' => true, 'checked' => false, 'check_output' => '', 'backup_file' => $bird_config_file . '.bak'];
    $bird = trim(execPipelineAsRoot('command -v bird || command -v bird4'));
    if ($bird !== '' && $bird[0] === '/') {
        $tmp = tempnam(sys_get_temp_dir(), 'krbird_');
        file_put_contents($tmp, $content);
        chmod($tmp, 0644);
        $out = execPipelineAsRoot(escapeshellarg($bird) . ' -p -c ' . escapeshellarg($tmp) . ' 2>&1; echo "rc=$?"');
        unlink($tmp);
        $ok = preg_match('/rc=0\s*$/', $out) === 1;
        $out = trim(str_replace($tmp, 'bird4.conf', preg_replace('/rc=\d+\s*$/', '', $out)));
        if (!$ok) return ['success' => false, 'error' => 'bird rejected the config, nothing was saved: ' . $out];
        $res['checked'] = true;
        $res['check_output'] = $out;
    } else {
        $res['warning'] = 'bird was not found: syntax check skipped';
    }
    if (!writeFileAsRoot($bird_config_file, $content, true)) return ['success' => false, 'error' => 'Failed to write a temporary file'];
    birdPeerRouteSync();
    return $res;
}

// The neighbor may have changed: re-run the hook so the host route follows it.
function birdPeerRouteSync() {
    $db = getDb();
    $s = $db ? birdSettings($db) : null;
    if (!$s || !$s['peer_route']) return;
    foreach (birdTunnels() as $t) {
        if ($t['system'] === $s['iface'] && $t['up']) birdRunHook($s['iface'], 'up');
    }
}

function doRestartBird() {
    global $bird_init_script;
    if (!$bird_init_script) return ['success' => false, 'error' => '$bird_init_script is not set in config.php'];
    return ['success' => true, 'raw' => birdRun('restart')];
}

// Interfaces the kernel has an IPv4 address on (eth3, nwg0, ppp0...): the names that routes use.
function kernelInterfaces() {
    $raw = (string)shell_exec('PATH=/opt/sbin:/opt/bin:/sbin:/usr/sbin:/bin:/usr/bin ip -o -4 addr show 2>/dev/null');
    $out = [];
    foreach (explode("\n", trim($raw)) as $line) {
        if (!preg_match('/^\d+:\s+(\S+)\s+inet\s+(\S+)/', $line, $m)) continue;
        $name = preg_replace('/@.*/', '', $m[1]);
        if ($name === 'lo') continue;
        $state = trim((string)@file_get_contents('/sys/class/net/' . $name . '/operstate'));
        $out[$name] = ['name' => $name, 'address' => $m[2], 'up' => $state !== 'down'];
    }
    return array_values($out);
}

// ---- bird routing hook (settings live in the DB, the hook file is generated by birdHook())
function birdTunnels() {
    $vpnTypes = ['Wireguard', 'OpenVPN', 'IPsec', 'L2TP', 'PPTP', 'SSTP', 'Gre', 'Ipip', 'Eoip'];
    $out = [];
    foreach ((array)rciGet('/rci/show/interface') as $id => $i) {
        if (!is_array($i) || !in_array((string)($i['type'] ?? ''), $vpnTypes, true)) continue;
        $realId = (string)($i['id'] ?? $id);
        $system = (string)($i['system-name'] ?? '');
        if ($system === '' && preg_match('/^Wireguard(\d+)$/', $realId, $m)) $system = 'nwg' . $m[1];
        if ($system === '') continue;
        $descr = (string)($i['description'] ?? '');
        $out[] = ['system' => $system, 'name' => $descr !== '' ? "$descr ($realId)" : $realId, 'up' => ($i['connected'] ?? '') === 'yes'];
    }
    return $out;
}

// The kernel table bird writes its routes into, read from "kernel table N;" in bird4.conf.
function birdDetectTable() {
    global $bird_config_file;
    if (!$bird_config_file) return null;
    $conf = execPipelineAsRoot('cat ' . escapeshellarg($bird_config_file));
    return preg_match('/\bkernel\s+table\s+(\d+)\s*;/', $conf, $m) ? (int)$m[1] : null;
}

function doGetDnsResolver(SQLite3 $db) {
    return ['servers' => (string)getSetting($db, 'dns_servers'), 'mode' => getSetting($db, 'dns_mode') === 'all' ? 'all' : 'first', 'nslookup' => hasNslookup()];
}

function doSaveDnsResolver(SQLite3 $db, $in) {
    $list = dnsServerList($in['servers'] ?? '');
    if (count($list) > 8) fail('At most 8 DNS servers');
    foreach ($list as $ip) {
        if (!isValidIPv4($ip)) fail("Not an IPv4 address: $ip");
    }
    setSetting($db, 'dns_servers', $list ? implode(' ', $list) : null);
    setSetting($db, 'dns_mode', ($in['mode'] ?? '') === 'all' ? 'all' : null);
    return ['success' => true, 'servers' => implode(' ', $list)];
}

function doGetPanelNet(SQLite3 $db) {
    return ['interface' => (string)getSetting($db, 'curl_interface')];
}

// The interface curl binds to when it downloads the lists; empty: the router's normal routing.
function doSavePanelNet(SQLite3 $db, $in) {
    $iface = trim((string)($in['interface'] ?? ''));
    if (!isValidInterface($iface)) fail('Invalid interface name');
    if ($iface !== '' && !is_dir('/sys/class/net/' . $iface)) fail('No such interface on the router');
    setSetting($db, 'curl_interface', $iface === '' ? null : $iface);
    return ['success' => true, 'interface' => $iface];
}

// The pause the dispatcher keeps before it starts a task that waited in the queue
function doSaveJobSettings(SQLite3 $db, $in) {
    $delay = (int)($in['delay'] ?? 0);
    if ($delay < 0 || $delay > 600) fail('The pause must be between 0 and 600 seconds');
    setSetting($db, 'job_delay', $delay ?: null);
    return ['success' => true, 'delay' => $delay];
}

function doTestDnsResolver($in) {
    $list = dnsServerList($in['servers'] ?? '');
    if (count($list) > 8) fail('At most 8 DNS servers');
    foreach ($list as $ip) {
        if (!isValidIPv4($ip)) fail("Not an IPv4 address: $ip");
    }
    $host = trim((string)($in['host'] ?? ''));
    if ($host === '') {
        foreach (withDb(fn($db) => rows($db, 'SELECT domain FROM domains WHERE enabled = 1')) as $row) {
            if (isValidDomain($row['domain'])) { $host = $row['domain']; break; }
        }
    }
    if ($host === '') $host = 'example.com';
    if (!isValidDomain($host)) fail('Not a valid domain');
    if (!$list) {
        return ['host' => $host, 'results' => [['server' => '', 'ips' => resolveA($host, ''), 'ms' => null]]];
    }
    if (!hasNslookup()) fail('nslookup not found');
    $results = [];
    foreach ($list as $server) {
        $t = microtime(true);
        $ips = nslookupA($host, $server);
        $results[] = ['server' => $server, 'ips' => $ips, 'ms' => (int)round((microtime(true) - $t) * 1000)];
    }
    return ['host' => $host, 'results' => $results];
}

function doGetBirdHook(SQLite3 $db) {
    global $bird_init_script;
    $settings = birdSettings($db);
    $hook = $settings ? birdHook() : null;
    return [
        'bird_installed' => (bool)$bird_init_script,
        'settings'       => $settings,
        'installed'      => $hook !== null && execPipelineAsRoot('cat ' . escapeshellarg(BIRD_HOOK_PATH)) === $hook,
        'tunnels'        => birdTunnels(),
        'policies'       => rows($db, "SELECT name, description, mark_hex, keenetic_table FROM policies WHERE name != 'DELETED' ORDER BY name"),
        'detected_table' => birdDetectTable(),
    ];
}

// The BGP rule and the host routes to the neighbors are outside our tables, and only the tunnel hook sets them.
// After the routes are written they are put back while the tunnel is up; nothing changes when they are in place. Returns whether it ran.
function birdReassert(SQLite3 $db) {
    global $bird_config_file;
    $s = birdSettings($db);
    if (!$s) return false;
    $up = false;
    foreach (birdTunnels() as $tunnel) {
        if ($tunnel['system'] === $s['iface'] && $tunnel['up']) $up = true;
    }
    if (!$up) return false;
    $stmt = $db->prepare('SELECT mark_hex FROM policies WHERE name = :n');
    $stmt->bindValue(':n', $s['policy'], SQLITE3_TEXT);
    $policy = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    if (!$policy || !preg_match('/^0x[0-9a-f]{1,8}$/i', $policy['mark_hex'])) return false;

    $rule = "fwmark {$policy['mark_hex']} table {$s['table']} pref " . routePrefs($db)['bgp'];
    $commands = '';
    if ($s['peer_route'] && $bird_config_file) {
        $commands = birdPeersShell() . 'for P in $PEERS; do /opt/sbin/ip route replace $P/32 dev ' . escapeshellarg($s['iface']) . "; done\n";
    }
    $commands .= "/opt/sbin/ip rule del $rule 2>/dev/null\n/opt/sbin/ip rule add $rule";
    execPipelineAsRoot($commands);
    return true;
}

function birdRunHook($iface, $state) {
    $env = $state === 'up' ? 'up=up connected=yes' : 'up=down connected=no';
    execPipelineAsRoot('test -f ' . escapeshellarg(BIRD_HOOK_PATH) . ' && system_name=' . escapeshellarg($iface) . " $env /bin/sh " . escapeshellarg(BIRD_HOOK_PATH));
}

function doSaveBirdHook(SQLite3 $db, $in) {
    global $bird_init_script;
    if (!$bird_init_script) fail('bird is not installed (opkg install bird1-ipv4)');

    if (empty($in['enabled'])) {
        $old = birdSettings($db);
        if ($old) birdRunHook($old['iface'], 'down');
        foreach (['bird_iface', 'bird_policy', 'bird_table', 'bird_peer_route'] as $k) setSetting($db, $k, null);
        return ['success' => true] + hooksInstall();
    }

    $iface = trim((string)($in['iface'] ?? ''));
    $policy = trim((string)($in['policy'] ?? ''));
    $table = (int)($in['table'] ?? 0);
    if (!preg_match('/^[A-Za-z0-9_.-]{1,15}$/', $iface)) fail('Choose the tunnel');
    $stmt = $db->prepare("SELECT 1 FROM policies WHERE name = :n AND name != 'DELETED'");
    $stmt->bindValue(':n', $policy, SQLITE3_TEXT);
    if (!$stmt->execute()->fetchArray()) fail('Choose the policy');
    if ($table < 1 || $table > 65535) fail('Table number must be between 1 and 65535');

    $peerRoute = !empty($in['peer_route']);
    $old = birdSettings($db);
    if ($old && ($old['iface'] !== $iface || $old['policy'] !== $policy || $old['table'] !== $table || $old['peer_route'] !== $peerRoute)) birdRunHook($old['iface'], 'down');
    setSetting($db, 'bird_iface', $iface);
    setSetting($db, 'bird_policy', $policy);
    setSetting($db, 'bird_table', $table);
    setSetting($db, 'bird_peer_route', $peerRoute ? '1' : '');

    $r = hooksInstall();
    if (!$r['success']) fail($r['error']);
    $applied = false;
    foreach (birdTunnels() as $t) {
        if ($t['system'] === $iface && $t['up']) {
            birdRunHook($iface, 'up');
            $applied = true;
        }
    }
    return ['success' => true, 'applied_now' => $applied];
}


const BIRD_LOG_FILE = '/opt/var/log/bird.log';

function hookId($in) {
    $id = (string)($in['id'] ?? '');
    if (!isset(HOOK_DEFS[$id])) fail('Unknown hook');
    return $id;
}

function doGetHooks(SQLite3 $db) {
    $out = [];
    foreach (hookDefaults() as $id => $default) {
        [$path, $label, $desc] = HOOK_DEFS[$id];
        $enabled = getSetting($db, "hook_off_$id") !== '1';
        $custom = (string)getSetting($db, "hook_custom_$id");
        $effective = $custom !== '' ? $custom : $default;
        $disk = execPipelineAsRoot('cat ' . escapeshellarg($path) . ' 2>/dev/null');
        $out[] = [
            'id' => $id, 'label' => $label, 'description' => $desc, 'path' => $path,
            'enabled' => $enabled, 'custom' => $custom !== '',
            'available' => $effective !== null,
            'installed' => $enabled && $effective !== null && $disk === $effective,
            'exists' => $disk !== '',
            'last_run' => (int)@filemtime(HOOK_RAN . $id),
        ];
    }
    return ['hooks' => $out];
}

function doGetHookContent(SQLite3 $db, $id) {
    $custom = (string)getSetting($db, "hook_custom_$id");
    $default = hookDefaults()[$id];
    $content = $custom !== '' ? $custom : $default;
    return ['content' => $content ?? "#!/bin/sh\n", 'path' => HOOK_DEFS[$id][0], 'custom' => $custom !== ''];
}

function doSetHookEnabled(SQLite3 $db, $id, $enabled) {
    setSetting($db, "hook_off_$id", $enabled ? null : '1');
    return hooksInstall();
}

function doSaveHookContent(SQLite3 $db, $id, $content) {
    $content = str_replace("\r\n", "\n", $content);
    if (strncmp($content, '#!', 2) !== 0) return ['success' => false, 'error' => 'A hook must start with a shebang line, e.g. #!/bin/sh'];
    if (strlen($content) > 20000) return ['success' => false, 'error' => 'Hook is too long'];
    if (substr($content, -1) !== "\n") $content .= "\n";
    $default = hookDefaults()[$id];
    setSetting($db, "hook_custom_$id", $content === $default ? null : $content);
    return hooksInstall();
}

function doResetHook(SQLite3 $db, $id) {
    setSetting($db, "hook_custom_$id", null);
    return hooksInstall();
}

function birdLogEnabled() {
    global $bird_config_file;
    if (!$bird_config_file) return false;
    $conf = execPipelineAsRoot('cat ' . escapeshellarg($bird_config_file));
    return preg_match('/^\s*log\s+"' . preg_quote(BIRD_LOG_FILE, '/') . '"\s+all\s*;/m', $conf) === 1;
}

function doGetBirdLog($lines) {
    $n = max(20, min(2000, (int)$lines));
    $has = trim(execPipelineAsRoot('test -f ' . escapeshellarg(BIRD_LOG_FILE) . ' && echo yes')) === 'yes';
    if ($has) {
        $text = execPipelineAsRoot('tail -n ' . $n . ' ' . escapeshellarg(BIRD_LOG_FILE) . ' 2>&1');
        $source = BIRD_LOG_FILE;
    } else {
        $text = execPipelineAsRoot('logread 2>/dev/null | grep -i bird | tail -n ' . $n);
        $source = 'syslog (logread)';
    }
    return ['source' => $source, 'content' => rtrim($text), 'file_log' => birdLogEnabled(), 'file_exists' => $has];
}

function doClearBirdLog() {
    execPipelineAsRoot(': > ' . escapeshellarg(BIRD_LOG_FILE));
    return ['success' => true];
}

// Adds "log <file> all;" to bird4.conf (after the existing log lines) and restarts bird.
function doEnableBirdLog() {
    global $bird_config_file;
    if (!$bird_config_file) return ['success' => false, 'error' => '$bird_config_file is not set in config.php'];
    $conf = doGetBirdConfig();
    if (!isset($conf['content'])) return ['success' => false, 'error' => $conf['error'] ?? 'Cannot read bird4.conf'];
    if (birdLogEnabled()) return ['success' => true, 'already' => true];
    $line = 'log "' . BIRD_LOG_FILE . '" all;';
    $text = $conf['content'];
    $new = preg_match('/^\s*log\s+stderr\s+all\s*;.*$/m', $text)
        ? preg_replace('/^(\s*log\s+stderr\s+all\s*;.*)$/m', "$1\n$line", $text, 1)
        : $line . "\n" . $text;
    execPipelineAsRoot('mkdir -p ' . escapeshellarg(dirname(BIRD_LOG_FILE)));
    $res = doSaveBirdConfig($new);
    if ($res['success']) birdRun('restart');
    return $res;
}

const UPDATE_FILES = ['app.php', 'ext.php', 'index.html', 'app.js', 'style.css'];
const UPDATE_BACKUP = '/opt/var/dns-router-backup';

// The five panel files plus language files lang.<code>.json
function updateAllowed($name) {
    return in_array($name, UPDATE_FILES, true) || preg_match('/^lang\.[a-z]{2,3}(-[A-Za-z]{2,4})?\.json$/', (string)$name) === 1;
}


function updateWebDir() { return __DIR__; }

function fileVersion($path) {
    $text = is_file($path) ? (string)file_get_contents($path) : '';
    return preg_match("/const\\s+APP_VERSION\\s*=\\s*'([^']+)'/", $text, $m) ? $m[1] : null;
}

function updateStageDir($token) {
    if (!preg_match('/^[a-f0-9]{16}$/', (string)$token)) fail('Bad update token');
    return sys_get_temp_dir() . '/dnsr_update_' . $token;
}

function updateRemoveStage($dir) {
    if (strpos($dir, sys_get_temp_dir() . '/dnsr_update_') !== 0) return;
    foreach (glob($dir . '/*') ?: [] as $f) @unlink($f);
    @rmdir($dir);
}


// The web user's PATH has no tar/gzip, so the archive is read in PHP: zlib when present, otherwise gzip with an explicit PATH.
function updateGunzip($file) {
    $raw = (string)file_get_contents($file);
    if (function_exists('gzdecode')) {
        $out = @gzdecode($raw, 20 * 1024 * 1024);
        return $out === false ? null : $out;
    }
    $out = shell_exec('PATH=/opt/bin:/opt/sbin:/bin:/usr/bin:/sbin:/usr/sbin gzip -dc ' . escapeshellarg($file) . ' 2>/dev/null');
    return ($out === null || $out === '') ? null : $out;
}

// Plain ustar reader: regular files with the known names only.
function updateParseTar($data) {
    $files = [];
    $pos = 0;
    $len = strlen($data);
    while ($pos + 512 <= $len) {
        $h = substr($data, $pos, 512);
        if (trim($h, "\0") === '') break;
        $name = rtrim(substr($h, 0, 100), "\0");
        $prefix = rtrim(substr($h, 345, 155), "\0");
        if ($prefix !== '') $name = "$prefix/$name";
        $name = preg_replace('#^\./#', '', $name);
        $type = $h[156];
        $size = octdec(trim(substr($h, 124, 12), "\0 "));
        // pax extended headers (mtime and the like) carry no file: skip them, the name comes from the real header
        if ($type === 'x' || $type === 'g') {
            $pos += 512 + (int)(ceil($size / 512) * 512);
            continue;
        }
        if (($type !== '0' && $type !== "\0") || !updateAllowed($name)) {
            return ['error' => 'Unexpected item in the archive: ' . ($name === '' ? '(unnamed)' : $name) . '. Only these files are allowed: ' . implode(', ', UPDATE_FILES) . ', lang.<code>.json'];
        }
        if ($pos + 512 + $size > $len) return ['error' => 'The archive is cut short'];
        $files[$name] = substr($data, $pos + 512, $size);
        $pos += 512 + (int)(ceil($size / 512) * 512);
    }
    return $files ? ['files' => $files] : ['error' => 'The archive has no files'];
}

// Step 1: the archive comes in as base64; nothing is installed yet.
function doUploadUpdate($b64) {
    $raw = base64_decode((string)$b64, true);
    if ($raw === false) return ['success' => false, 'error' => 'The file is empty or damaged'];
    return updateStage($raw);
}

// Unpacks and checks an archive into a temporary folder; the answer lists the files and the token for applyUpdate
function updateStage($raw) {
    global $php_cli;
    if (strlen($raw) < 100) return ['success' => false, 'error' => 'The file is empty or damaged'];
    if (strlen($raw) > 5 * 1024 * 1024) return ['success' => false, 'error' => 'The archive is larger than 5 MB'];

    foreach (glob(sys_get_temp_dir() . '/dnsr_update_*') ?: [] as $old) {
        if (is_dir($old) && filemtime($old) < time() - 3600) updateRemoveStage($old);
    }
    $token = bin2hex(random_bytes(8));
    $dir = updateStageDir($token);
    if (!@mkdir($dir, 0700)) return ['success' => false, 'error' => 'Cannot create a temporary folder'];
    $tgz = $dir . '/upload.tgz';
    file_put_contents($tgz, $raw);

    $tar = updateGunzip($tgz);
    if ($tar === null) { updateRemoveStage($dir); return ['success' => false, 'error' => 'This is not a .tar.gz archive']; }
    $parsed = updateParseTar($tar);
    if (isset($parsed['error'])) { updateRemoveStage($dir); return ['success' => false, 'error' => $parsed['error']]; }
    $names = [];
    foreach ($parsed['files'] as $name => $data) {
        file_put_contents("$dir/$name", $data);
        $names[] = $name;
    }
    $files = [];
    foreach (array_unique($names) as $name) {
        $path = "$dir/$name";
        if (!is_file($path) || filesize($path) === 0) { updateRemoveStage($dir); return ['success' => false, 'error' => "Could not read $name from the archive"]; }
        if (substr($name, -5) === '.json') {
            $j = json_decode((string)file_get_contents($path), true);
            if (!is_array($j) || !isset($j['strings']) || !is_array($j['strings'])) { updateRemoveStage($dir); return ['success' => false, 'error' => "$name is not a valid language file (needs a \"strings\" object)"]; }
        }
        if (substr($name, -4) === '.php') {
            $lint = trim((string)shell_exec(escapeshellarg($php_cli) . ' -l ' . escapeshellarg($path) . ' 2>&1'));
            if (stripos($lint, 'No syntax errors') === false) { updateRemoveStage($dir); return ['success' => false, 'error' => "PHP syntax error in $name: $lint"]; }
        }
        $cur = updateWebDir() . "/$name";
        $files[] = ['name' => $name, 'size' => filesize($path), 'changed' => !is_file($cur) || md5_file($path) !== md5_file($cur)];
    }
    if (in_array('app.php', $names, true) && fileVersion("$dir/app.php") === null) {
        updateRemoveStage($dir);
        return ['success' => false, 'error' => 'app.php in the archive has no version: this does not look like the panel'];
    }
    return ['success' => true, 'token' => $token, 'files' => $files,
        'version_new' => in_array('app.php', $names, true) ? fileVersion("$dir/app.php") : null,
        'version_current' => APP_VERSION];
}

// ---- updates from the GitHub releases of the project

const GITHUB_REPO = 'korovkin37-stack/keenetic-dns-router';

// The newest release and what changed since the installed version (the CHANGELOG.md of that tag).
// The answer is kept for 6 hours, so opening the page does not ask GitHub every time.
function doCheckGithubUpdate($in) {
    $cacheFile = sys_get_temp_dir() . '/dns-router-github.json';
    $cache = json_decode((string)@file_get_contents($cacheFile), true);
    // the notes come from CHANGELOG.<lang>.md when the release has one, otherwise from the English CHANGELOG.md
    $lang = preg_match('/^[a-z]{2,3}$/', (string)($in['lang'] ?? '')) ? (string)$in['lang'] : 'en';
    if ($cache && empty($in['force']) && $cache['checked'] > time() - 6 * 3600 && $cache['current'] === APP_VERSION && $cache['lang'] === $lang) return $cache;

    $tmp = tempnam(sys_get_temp_dir(), 'krgh_');
    $error = listsDownload('https://api.github.com/repos/' . GITHUB_REPO . '/releases/latest', $tmp);
    $release = json_decode((string)file_get_contents($tmp), true);
    @unlink($tmp);
    if ($error !== '') return ['success' => false, 'error' => $error];
    if (!is_array($release) || empty($release['tag_name'])) return ['success' => false, 'error' => 'GitHub gave no release'];

    $tag = (string)$release['tag_name'];
    $latest = ltrim($tag, 'v');
    $asset = '';
    $digest = '';
    foreach ((array)($release['assets'] ?? []) as $a) {
        if (($a['name'] ?? '') !== 'dns-router.tar.gz') continue;
        $asset = (string)$a['browser_download_url'];
        // GitHub counts the sha256 of every asset itself
        if (preg_match('/^sha256:([0-9a-f]{64})$/', (string)($a['digest'] ?? ''), $m)) $digest = $m[1];
    }

    $notes = [];
    $newer = version_compare($latest, APP_VERSION, '>');
    if ($newer) {
        $tmp = tempnam(sys_get_temp_dir(), 'krgh_');
        $raw = 'https://raw.githubusercontent.com/' . GITHUB_REPO . '/' . rawurlencode($tag) . '/';
        $found = $lang !== 'en' && listsDownload($raw . 'CHANGELOG.' . $lang . '.md', $tmp) === '';
        if ($found || listsDownload($raw . 'CHANGELOG.md', $tmp) === '') {
            $parts = preg_split('/^## +(.+)$/m', (string)file_get_contents($tmp), -1, PREG_SPLIT_DELIM_CAPTURE);
            for ($i = 1; $i + 1 < count($parts) && count($notes) < 10; $i += 2) {
                // "5.36" or "5.31–5.33": the first version in the heading decides
                if (!preg_match('/\d+\.\d+(\.\d+)?/', $parts[$i], $m)) continue;
                if (version_compare($m[0], APP_VERSION, '<=')) continue;
                $notes[] = ['title' => trim($parts[$i]), 'text' => trim($parts[$i + 1])];
            }
        }
        @unlink($tmp);
    }

    $result = ['success' => true, 'current' => APP_VERSION, 'latest' => $latest, 'tag' => $tag, 'newer' => $newer,
        'published' => (string)($release['published_at'] ?? ''), 'url' => (string)($release['html_url'] ?? ''), 'asset' => $asset, 'digest' => $digest,
        'notes' => $notes, 'lang' => $lang, 'checked' => time()];
    file_put_contents($cacheFile, json_encode($result));
    @chmod($cacheFile, 0666);
    return $result;
}

// Downloads the archive of the newest release and checks it the same way as an uploaded one
function doGithubDownloadUpdate() {
    $check = doCheckGithubUpdate(['lang' => 'en', 'force' => 1]);
    if (!$check['success']) return $check;
    if (!$check['newer']) return ['success' => false, 'error' => 'The release on GitHub is not newer than this version'];
    if ($check['asset'] === '') return ['success' => false, 'error' => 'The release has no dns-router.tar.gz'];
    if ($check['digest'] === '') return ['success' => false, 'error' => 'GitHub gave no checksum for the archive'];
    $tmp = tempnam(sys_get_temp_dir(), 'krgh_');
    $error = listsDownload($check['asset'], $tmp);
    $raw = (string)file_get_contents($tmp);
    @unlink($tmp);
    if ($error !== '') return ['success' => false, 'error' => $error];
    if (!hash_equals($check['digest'], hash('sha256', $raw))) return ['success' => false, 'error' => 'The archive does not match the checksum from GitHub'];
    return updateStage($raw);
}

// Copies $src/<names> into the panel folder as root. Current files go to backup/new, which becomes backup/prev only if everything was copied.
function updateInstallFiles($src, array $names) {
    global $php_cli;
    $web = updateWebDir();
    $b = UPDATE_BACKUP;
    usort($names, fn($x, $y) => ($x === 'app.php') <=> ($y === 'app.php'));
    $cmd = 'set -e; mkdir -p ' . escapeshellarg($b) . '; rm -rf ' . escapeshellarg("$b/new") . '; mkdir -p ' . escapeshellarg("$b/new") . '; ';
    foreach ($names as $n) {
        $cmd .= 'if [ -f ' . escapeshellarg("$web/$n") . ' ]; then cp ' . escapeshellarg("$web/$n") . ' ' . escapeshellarg("$b/new/$n") . '; fi; ';
    }
    foreach ($names as $n) {
        $cmd .= 'cp ' . escapeshellarg("$src/$n") . ' ' . escapeshellarg("$web/$n.tmp") . ' && chmod 644 ' . escapeshellarg("$web/$n.tmp") . ' && mv ' . escapeshellarg("$web/$n.tmp") . ' ' . escapeshellarg("$web/$n") . '; ';
    }
    $cmd .= 'rm -rf ' . escapeshellarg("$b/prev") . '; mv ' . escapeshellarg("$b/new") . ' ' . escapeshellarg("$b/prev") . '; echo DNSR_OK';
    // other requests wait until the files and hooks are all of one version
    $maintenance = sys_get_temp_dir() . '/dns-router-maintenance';
    file_put_contents($maintenance, (string)time());
    $out = execPipelineAsRoot($cmd . ' 2>&1');
    if (strpos($out, 'DNSR_OK') === false) {
        @unlink($maintenance);
        return ['success' => false, 'error' => 'Could not write the files: ' . trim($out)];
    }
    // Hooks are generated by the new code: let it write them.
    execPipelineAsRoot(escapeshellarg($php_cli) . ' ' . escapeshellarg("$web/app.php") . ' hooks 2>&1');
    @unlink($maintenance);
    return ['success' => true, 'version' => fileVersion("$web/app.php")];
}

function doApplyUpdate($token) {
    $dir = updateStageDir($token);
    if (!is_dir($dir)) return ['success' => false, 'error' => 'The upload has expired, upload the file again'];
    $names = array_values(array_filter(array_map('basename', glob("$dir/*") ?: []), fn($n) => updateAllowed($n)));
    if (!$names) return ['success' => false, 'error' => 'Nothing to install'];
    $res = updateInstallFiles($dir, $names);
    updateRemoveStage($dir);
    return $res;
}

function doGetUpdateInfo() {
    $prev = UPDATE_BACKUP . '/prev';
    $has = trim(execPipelineAsRoot('ls ' . escapeshellarg($prev) . ' 2>/dev/null'));
    $files = $has === '' ? [] : array_values(array_filter(preg_split('/\s+/', $has), fn($n) => updateAllowed($n)));
    $ver = null;
    if (in_array('app.php', $files, true)) {
        $text = execPipelineAsRoot('cat ' . escapeshellarg("$prev/app.php"));
        $ver = preg_match("/const\\s+APP_VERSION\\s*=\\s*'([^']+)'/", $text, $m) ? $m[1] : null;
    }
    return ['version' => APP_VERSION, 'prev_files' => $files, 'prev_version' => $ver, 'backup_dir' => UPDATE_BACKUP];
}

function doRollbackUpdate() {
    $prev = UPDATE_BACKUP . '/prev';
    $out = trim(execPipelineAsRoot('ls ' . escapeshellarg($prev) . ' 2>/dev/null'));
    $names = array_values(array_filter(preg_split('/\s+/', $out), fn($n) => updateAllowed($n)));
    if (!$names) return ['success' => false, 'error' => 'There is no previous version to return to'];
    // The folder is root-owned: copy it into a stage the web user owns would be pointless, so install straight from it.
    return updateInstallFiles($prev, $names);
}

function tableRef($in) {
    $ref = trim((string)($in['ref'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9_]{1,32}$/', $ref)) fail('Invalid table reference');
    return $ref;
}

// ============================================ LISTS (iplist source) ============================================
const LISTS_DEFAULT_SOURCES = [
    ['name' => 'iplist', 'url' => 'https://iplist.opencck.org'],
    ['name' => 'russia', 'url' => 'https://russia.iplist.opencck.org'],
];

// The places lists are downloaded from: [['name' => ..., 'url' => ...], ...]; the first one is the default.
function listsSources(SQLite3 $db) {
    $saved = json_decode((string)getSetting($db, 'lists_sources'), true);
    if ($saved) return $saved;
    $sources = LISTS_DEFAULT_SOURCES;
    $old = getSetting($db, 'lists_source');
    if ($old) $sources[0]['url'] = $old;
    return $sources;
}

// Address of the source with this name; an unknown or empty name means the first source.
function listsSourceUrl(SQLite3 $db, $name) {
    $sources = listsSources($db);
    foreach ($sources as $source) {
        if ($source['name'] === $name) return $source['url'];
    }
    return $sources[0]['url'];
}

// Downloads $url into $file with curl. Returns '' on success, an error text otherwise.
function listsDownload($url, $file) {
    $curl = listsCurl();
    if ($curl === '') return 'curl is not installed: Service, System checks, "curl"';
    $iface = (string)getSetting(getDb(), 'curl_interface');
    $bind = $iface === '' ? '' : ' --interface ' . escapeshellarg($iface);
    // http(s) only, redirects only to https, at most 20 MB: /tmp on the router is RAM
    $limits = ' --proto =http,https --proto-redir =https --max-filesize 20M';
    exec(escapeshellarg($curl) . $bind . $limits . ' -fsSL --connect-timeout 10 -m 60 -o ' . escapeshellarg($file) . ' ' . escapeshellarg($url) . ' 2>&1', $out, $code);
    if ($code === 63) return 'Download failed: the file is larger than 20 MB';
    if ($code !== 0) return 'Download failed: ' . trim(implode(' ', $out));
    return '';
}

// One request to the source: format=text returns one value per line.
function listsDataUrl($sourceUrl, $site, $data) {
    return $sourceUrl . '/?format=text&data=' . $data . '&site=' . rawurlencode($site);
}

function listsFetchLines($sourceUrl, $site, $data, &$error) {
    $url = listsDataUrl($sourceUrl, $site, $data);
    $tmp = tempnam(sys_get_temp_dir(), 'krlist_');
    $error = listsDownload($url, $tmp);
    $lines = [];
    $fh = $error === '' ? fopen($tmp, 'r') : false;
    while ($fh && ($line = fgets($fh)) !== false) {
        $line = trim($line);
        if ($line !== '') $lines[] = $line;
    }
    if ($fh) fclose($fh);
    @unlink($tmp);
    return $lines;
}

// IPv4 as a float: PHP on the router may be 32-bit, where ip2long() goes negative.
function ipToFloat($ip) {
    return (float)sprintf('%u', ip2long($ip));
}

function floatToIp($n) {
    $parts = [];
    for ($i = 0; $i < 4; $i++) {
        $parts[] = (int)fmod(floor($n / pow(256, 3 - $i)), 256);
    }
    return implode('.', $parts);
}

// Drops nested blocks and merges neighbours into bigger ones: 1.1.1.0/25 + 1.1.1.128/25 = 1.1.1.0/24.
function aggregateIpv4(array $items) {
    $blocks = [];
    foreach ($items as $item) {
        [$ip, $len] = array_pad(explode('/', $item, 2), 2, '32');
        $size = pow(2, 32 - (int)$len);
        $blocks[] = [floor(ipToFloat($ip) / $size) * $size, $size];
    }
    usort($blocks, fn($a, $b) => $a[0] <=> $b[0] ?: $b[1] <=> $a[1]);

    $stack = [];
    $end = -1;
    foreach ($blocks as [$start, $size]) {
        if ($start < $end) continue;
        $end = $start + $size;
        while ($stack) {
            [$topStart, $topSize] = end($stack);
            if ($topSize != $size || $topStart + $size != $start || fmod($topStart, $size * 2) != 0) break;
            array_pop($stack);
            $start = $topStart;
            $size *= 2;
        }
        $stack[] = [$start, $size];
    }

    $out = [];
    foreach ($stack as [$start, $size]) {
        $len = 32 - (int)round(log($size, 2));
        $out[] = floatToIp($start) . ($len < 32 ? '/' . $len : '');
    }
    return $out;
}

// Entries that must never become routes: broad blocks, private and special ranges.
// Why an entry never goes into the table: '' = it is fine.
function listsEntryReject($item) {
    if (!isValidIPv4Cidr($item)) return 'invalid';
    [$ip, $len] = array_pad(explode('/', $item, 2), 2, '32');
    if ((int)$len < 8) return 'wide';
    if ((int)$ip >= 224) return 'special';
    // The entry is rejected when it overlaps a private or reserved range
    $net = ip2long($ip);
    foreach (['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24'] as $range) {
        [$rip, $rlen] = explode('/', $range);
        $mask = -1 << (32 - min((int)$len, (int)$rlen)) & 0xffffffff;
        if (($net & $mask) === (ip2long($rip) & $mask)) return 'private';
    }
    return '';
}

function listsEntryAllowed($item) {
    return listsEntryReject($item) === '';
}

// The block of $blocks ([start, end, text], sorted by start, not overlapping) that contains the entry.
function listsFindBlock(array $blocks, $item) {
    $ip = ipToFloat(explode('/', $item, 2)[0]);
    $low = 0;
    $high = count($blocks) - 1;
    while ($low <= $high) {
        $mid = intdiv($low + $high, 2);
        if ($blocks[$mid][1] <= $ip) {
            $low = $mid + 1;
        } elseif ($blocks[$mid][0] > $ip) {
            $high = $mid - 1;
        } else {
            return $blocks[$mid][2];
        }
    }
    return '';
}

// Entries that are the same as, or inside, one of the excluded blocks are dropped.
function listsApplyExclusions(array $items, $excl) {
    $blocks = [];
    foreach (preg_split('/\s+/', trim($excl)) as $e) {
        if ($e === '' || !isValidIPv4Cidr($e)) continue;
        [$ip, $len] = array_pad(explode('/', $e, 2), 2, '32');
        $size = pow(2, 32 - (int)$len);
        $start = floor(ipToFloat($ip) / $size) * $size;
        $blocks[] = [$start, $start + $size];
    }
    if (!$blocks) return $items;
    return array_values(array_filter($items, function ($item) use ($blocks) {
        $ip = ipToFloat(explode('/', $item, 2)[0]);
        foreach ($blocks as [$from, $to]) {
            if ($ip >= $from && $ip < $to) return false;
        }
        return true;
    }));
}

// More domains take minutes of DNS: the rest are skipped and the list says so
const LISTS_RESOLVE_LIMIT = 1000;

// Addresses of the source's domains, resolved through the DNS servers set in Settings.
// 'log' keeps, per domain, what came back and which server said it.
function listsResolveDomains(SQLite3 $db, array $domains, $listId = 0, $token = null) {
    $servers = dnsServerList((string)getSetting($db, 'dns_servers'));
    $mode = getSetting($db, 'dns_mode') === 'all' ? 'all' : 'first';
    $targets = [];
    foreach (array_slice($domains, 0, LISTS_RESOLVE_LIMIT) as $n => $domain) {
        $targets[$n] = [$domain, $servers];
    }
    $ips = [];
    $answered = 0;
    $log = [];
    foreach (array_chunk($targets, 40, true) as $chunk) {
        if (listsAborted($db, $listId, $token)) return ['aborted' => true];
        if ($listId) listsStage($listId, 'Resolving domains: ' . count($log) . '/' . count($targets));
        foreach (resolveMany($chunk, $mode) as $n => $found) {
            if ($found['ips']) $answered++;
            $log[] = [$targets[$n][0], $found['map']];
            foreach ($found['ips'] as $ip) $ips[] = $ip;
        }
    }
    return ['ips' => array_values(array_unique($ips)), 'answered' => $answered, 'asked' => count($targets), 'log' => $log, 'servers' => $servers, 'mode' => $mode];
}

// Updating a list takes minutes, so it runs in a separate process (app.php listsync) that the web server
// cannot cut off together with the request.
// Starts "app.php <arguments>" in the background; returns its pid, 0 when it could not be started.
function startBackground($arguments, $then = '') {
    global $php_cli;
    $base = escapeshellarg($php_cli) . ' ' . escapeshellarg(__DIR__ . '/app.php') . ' ';
    $cmd = $base . $arguments;
    // $then runs after the process ends however it ends (even killed), so a dead process cannot leave the queue standing
    if ($then !== '') $cmd = 'sh -c ' . escapeshellarg($cmd . '; ' . $base . $then);
    // the log belongs to whoever starts the process: a hook (root) and the panel (web user) cannot overwrite each other's file
    exec('(' . $cmd . ' >/tmp/dns-router-lists-' . getmyuid() . '.log 2>&1 & echo $!)', $out);
    return (int)($out[0] ?? 0);
}

// Progress of a running update lives in small files in the temp folder: the page polls it every 2 seconds
// and must not queue behind the database.
function jobRead($name) {
    $text = @file_get_contents(sys_get_temp_dir() . '/dns-router-' . $name . '.json');
    return $text === false ? null : json_decode($text, true);
}

function jobWrite($name, $data) {
    $file = sys_get_temp_dir() . '/dns-router-' . $name . '.json';
    if ($data === null) {
        if (!@unlink($file)) @file_put_contents($file, '');
        return;
    }
    file_put_contents($file, json_encode($data), LOCK_EX);
    @chmod($file, 0666);
}

// The stage of the running update; a stage nobody has touched for 10 minutes belongs to a dead process.
function listsCurrentStage() {
    $stage = jobRead('stage');
    if ($stage && $stage['at'] < time() - 600) return null;
    return $stage;
}

// What the running update is doing now, for the page to show. With a site name the step also goes into the log.
function listsStage($id, $text, $site = '') {
    jobWrite('stage', ['id' => (int)$id, 'text' => $text, 'at' => time()]);
    if ($site !== '') jobLog($site . ': ' . $text);
}

// The log of the last update: one line per event, shown by the page on demand.
function jobLog($text) {
    $file = sys_get_temp_dir() . '/dns-router-job.log';
    file_put_contents($file, date('H:i:s') . ' ' . $text . "\n", FILE_APPEND | LOCK_EX);
    @chmod($file, 0666);
}

function listsIsWorking($status) {
    if (strpos((string)$status, 'working:') !== 0) return false;
    return (int)substr($status, 8) > time() - 1800;
}

// A list that is being updated holds 'working:<time>' as its status. When the user cancels, the status is
// replaced, so a worker that still sees another value than the one it started with has to stop.
function listsAborted(SQLite3 $db, $listId, $token) {
    if ($token === null || !$listId) return false;
    return $db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$listId) !== $token;
}

function doCancelLists(SQLite3 $db, $in) {
    $id = (int)($in['id'] ?? 0);
    $where = $id ? ' AND id = ' . $id : '';
    $db->exec("UPDATE lists SET status = 'cancelled' WHERE status LIKE 'working:%'" . $where);
    return ['success' => true, 'cancelled' => $db->changes()];
}

function listsMarkWorking(SQLite3 $db, array $ids) {
    foreach ($ids as $id) {
        $status = $db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$id);
        if (listsIsWorking($status)) fail('This list is being updated right now');
    }
    $db->exec('BEGIN');
    foreach ($ids as $id) {
        $db->exec("UPDATE lists SET status = 'working:" . time() . "' WHERE id = " . (int)$id);
    }
    $db->exec('COMMIT');
}

// Marks the lists as waiting for the task manager; the ones already marked keep their place
function listsQueue(SQLite3 $db, array $ids) {
    $db->exec('BEGIN');
    foreach ($ids as $id) {
        if (!listsIsWorking($db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$id))) {
            $db->exec("UPDATE lists SET status = 'working:" . time() . "' WHERE id = " . (int)$id);
        }
    }
    $db->exec('COMMIT');
}

// Syncs the lists one by one, writing the outcome of each into the log. Returns how many failed and how many were held back.
function listsSyncMany(SQLite3 $db, array $ids, $force, $progress = false) {
    $failed = 0;
    $held = 0;
    foreach ($ids as $position => $id) {
        if ($progress) jobSet(['done' => $position]);
        $row = $db->querySingle('SELECT site, status FROM lists WHERE id = ' . (int)$id, true);
        if (!$row) continue;
        $site = $row['site'];
        if (!listsIsWorking($row['status'])) {
            jobLog($site . ': skipped, it was cancelled');
            continue;
        }
        // The marker of the list is renewed when its turn comes: a long update must not make it look abandoned
        $db->exec("UPDATE lists SET status = 'working:" . time() . "' WHERE id = " . (int)$id);
        try {
            $result = doSyncList($db, $id, $force);
        } catch (Throwable $e) {
            $failed++;
            listsSetStatus($db, $id, 'Sync crashed: ' . $e->getMessage(), gmdate('Y-m-d H:i:s'));
            jobLog($site . ': crashed: ' . $e->getMessage());
            continue;
        }
        if (!empty($result['cancelled'])) {
            jobLog($site . ': cancelled');
        } elseif (!$result['success']) {
            $failed++;
            jobLog($site . ': failed: ' . $result['error']);
        } elseif (!empty($result['held'])) {
            $held++;
            jobLog($site . ': held back: ' . $result['status']);
        } else {
            jobLog($site . ': done, ' . $result['items'] . ' networks (+' . $result['added'] . ' -' . $result['removed'] . ')');
        }
    }
    return ['failed' => $failed, 'held' => $held];
}

function listsSetStatus(SQLite3 $db, $id, $status, $now) {
    $stmt = $db->prepare('UPDATE lists SET status = :s, last_sync = :t WHERE id = :id');
    $stmt->bindValue(':s', $status, SQLITE3_TEXT);
    $stmt->bindValue(':t', $now, SQLITE3_TEXT);
    $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
    $stmt->execute();
}

// Downloads the site's data, builds the new list, compares it with the stored one and saves it.
// 'networks' mode takes the source's CIDRs and addresses as they are; 'resolve' mode resolves the source's domains; 'both' does both and merges the results.
// A result that lost more than half of the entries is held back unless $force is set.
function doSyncList(SQLite3 $db, $id, $force = false) {
    ini_set('memory_limit', '192M');
    $list = $db->querySingle('SELECT * FROM lists WHERE id = ' . (int)$id, true);
    if (!$list) fail('List not found', 404);

    $token = listsIsWorking($list['status']) ? $list['status'] : null;
    $sourceUrl = listsSourceUrl($db, $list['source']);
    $err = '';
    $cidrs = [];
    $addresses = [];
    listsStage($id, 'Downloading the domains', $list['site']);
    $domains = listsFetchLines($sourceUrl, $list['site'], 'domains', $domainsError);
    if ($list['mode'] === 'resolve') {
        $err = $domainsError;
        if ($err === '' && !$domains) $err = 'The source has no domains for this site';
    } elseif ($list['mode'] === 'both') {
        listsStage($id, 'Downloading the networks', $list['site']);
        $cidrs = listsFetchLines($sourceUrl, $list['site'], 'cidr4', $cidrError);
        listsStage($id, 'Downloading the addresses', $list['site']);
        $addresses = listsFetchLines($sourceUrl, $list['site'], 'ip4', $addressError);
        $err = $cidrError ?: ($addressError ?: $domainsError);
        if ($err === '' && !$cidrs && !$addresses && !$domains) $err = 'The source returned no data for this site';
    } else {
        listsStage($id, 'Downloading the networks', $list['site']);
        $cidrs = listsFetchLines($sourceUrl, $list['site'], 'cidr4', $cidrError);
        listsStage($id, 'Downloading the addresses', $list['site']);
        $addresses = listsFetchLines($sourceUrl, $list['site'], 'ip4', $addressError);
        $err = $cidrError ?: $addressError;
        if ($err === '' && !$cidrs && !$addresses) $err = 'The source returned no data for this site';
    }

    $now = gmdate('Y-m-d H:i:s');
    if (listsAborted($db, $id, $token)) return ['success' => false, 'error' => 'cancelled', 'cancelled' => true];
    if ($err !== '') {
        listsSetStatus($db, $id, $err, $now);
        return ['success' => false, 'error' => $err];
    }

    $resolvedLog = '';
    $stats = ['mode' => $list['mode'], 'cidrs' => count($cidrs), 'addresses' => count($addresses), 'domains' => count($domains), 'asked' => 0, 'answered' => 0];
    if ($list['mode'] !== 'networks') {
        listsStage($id, 'Resolving domains: 0/' . count($domains), $list['site']);
        $resolved = listsResolveDomains($db, $domains, $id, $token);
        if (!empty($resolved['aborted'])) return ['success' => false, 'error' => 'cancelled', 'cancelled' => true];
        $raw = array_merge($cidrs, $addresses, $resolved['ips']);
        $stats['resolved_ips'] = count($resolved['ips']);
        $stats['asked'] = $resolved['asked'];
        $stats['answered'] = $resolved['answered'];
        $stats['dns'] = $resolved['servers'];
        $stats['dns_mode'] = $resolved['mode'];
        $resolvedLog = json_encode($resolved['log']);
        if (!$raw) {
            $err = 'No domain of this site could be resolved: check the DNS servers in Settings';
            listsSetStatus($db, $id, $err, $now);
            return ['success' => false, 'error' => $err];
        }
    } else {
        $raw = array_merge($cidrs, $addresses);
    }

    listsStage($id, 'Building the list: ' . count($raw), $list['site']);
    $unique = array_values(array_unique($raw));
    unset($raw);
    $allowed = [];
    $dropped = ['rejected' => [], 'excluded' => [], 'merged' => []];
    foreach ($unique as $entry) {
        $why = listsEntryReject($entry);
        if ($why === '') $allowed[] = $entry; else $dropped['rejected'][] = [$entry, $why];
    }
    $kept = listsApplyExclusions($allowed, $list['excl']);
    foreach (array_diff($allowed, $kept) as $entry) $dropped['excluded'][] = [$entry, ''];
    $new = aggregateIpv4($kept);
    $blocks = [];
    foreach ($new as $block) {
        [$ip, $len] = array_pad(explode('/', $block, 2), 2, '32');
        $size = pow(2, 32 - (int)$len);
        $blocks[] = [ipToFloat($ip), ipToFloat($ip) + $size, $block];
    }
    $inTable = array_flip($new);
    foreach ($kept as $entry) {
        if (isset($inTable[$entry])) continue;
        if (count($dropped['merged']) >= 3000) break;
        $dropped['merged'][] = [$entry, listsFindBlock($blocks, $entry)];
    }
    $stats['entries'] = count($unique);
    $stats['rejected'] = count($unique) - count($allowed);
    $stats['excluded'] = count($allowed) - count($kept);
    $stats['merged'] = count($kept) - count($new);
    $stats['final'] = count($new);

    $old = $list['items'] === '' ? [] : explode("\n", $list['items']);
    $added = array_values(array_diff($new, $old));
    $removed = array_values(array_diff($old, $new));

    if (listsAborted($db, $id, $token)) return ['success' => false, 'error' => 'cancelled', 'cancelled' => true];
    $status = 'ok';
    if (!$force && $old && count($removed) * 2 > count($old)) {
        $status = 'held: ' . count($removed) . ' of ' . count($old) . ' entries disappeared';
        listsSetStatus($db, $id, $status, $now);
        return ['success' => true, 'held' => true, 'status' => $status];
    }

    $diff = json_encode([
        'added' => count($added), 'removed' => count($removed),
        'added_sample' => array_slice($added, 0, 20), 'removed_sample' => array_slice($removed, 0, 20),
    ]);
    $stmt = $db->prepare('UPDATE lists SET items = :items, domains = :domains, n_items = :ni, n_domains = :nd, last_sync = :t, status = :s, diff = :diff, stats = :stats, dropped = :dropped, resolved = :resolved WHERE id = :id');
    $stmt->bindValue(':items', implode("\n", $new), SQLITE3_TEXT);
    $stmt->bindValue(':domains', implode("\n", $domains), SQLITE3_TEXT);
    $stmt->bindValue(':ni', count($new), SQLITE3_INTEGER);
    $stmt->bindValue(':nd', count($domains), SQLITE3_INTEGER);
    $stmt->bindValue(':t', $now, SQLITE3_TEXT);
    $stmt->bindValue(':s', $status, SQLITE3_TEXT);
    $stmt->bindValue(':diff', $diff, SQLITE3_TEXT);
    $stmt->bindValue(':stats', json_encode($stats), SQLITE3_TEXT);
    $stmt->bindValue(':dropped', json_encode($dropped), SQLITE3_TEXT);
    $stmt->bindValue(':resolved', $resolvedLog, SQLITE3_TEXT);
    $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
    $stmt->execute();
    return ['success' => true, 'items' => count($new), 'domains' => count($domains), 'added' => count($added), 'removed' => count($removed), 'stats' => $stats];
}

// What the last finished task did, in the form the lists page reports it
function listsLastJob() {
    $job = jobRead('job');
    if (!$job || $job['state'] !== 'done') return null;
    return ['applied' => ['routes' => $job['routes'], 'route_errors' => $job['route_errors'], 'route_error' => $job['route_error'], 'rule_error' => $job['rule_error'] ?? ''], 'failed' => $job['failed'] ?? 0, 'held' => $job['held'] ?? 0];
}

function doGetLists(SQLite3 $db) {
    $lists = rows($db, "SELECT l.id, l.site, l.grp, l.policy_id, l.enabled, l.interface, l.gateway, l.n_items, l.n_domains, l.last_sync, l.status, l.diff, l.mode, l.stats, l.source,
        COALESCE(p.name, '') AS policy_name, COALESCE(p.description, '') AS policy_description, COALESCE(p.mark_hex, '') AS mark_hex, COALESCE(p.our_table, 0) AS our_table
        FROM lists l LEFT JOIN policies p ON p.id = l.policy_id ORDER BY l.site");
    $routes = 0;
    foreach ($lists as $l) {
        if ($l['enabled']) $routes += $l['n_items'];
    }
    return ['lists' => $lists, 'routes' => $routes, 'sources' => listsSources($db), 'downloader' => listsCurl() !== '', 'job' => listsLastJob(), 'stage' => listsCurrentStage()];
}

function doGetListDetail(SQLite3 $db, $id) {
    $list = $db->querySingle('SELECT id, site, grp, policy_id, enabled, interface, gateway, excl, n_items, n_domains, last_sync, status, diff, mode, stats, dropped, resolved, domains, items, source FROM lists WHERE id = ' . (int)$id, true);
    if (!$list) fail('List not found', 404);
    $sourceUrl = listsSourceUrl($db, $list['source']);
    $list['stage'] = listsCurrentStage();
    $list['urls'] = [];
    foreach (['cidr4', 'ip4', 'domains'] as $data) $list['urls'][$data] = listsDataUrl($sourceUrl, $list['site'], $data);
    $items = $list['items'] === '' ? [] : explode("\n", $list['items']);
    $list['items_all'] = array_slice($items, 0, 5000);
    $domainNames = $list['domains'] === '' ? [] : explode("\n", $list['domains']);
    $list['domains_all'] = array_slice($domainNames, 0, 3000);
    unset($list['items'], $list['domains']);
    $list['job'] = listsLastJob();
    return $list;
}

// The catalog is the source's full JSON: only "name" and "group" of every site are cut out of it, chunk by chunk.
function doGetListsCatalog(SQLite3 $db, $refresh, $sourceName = '') {
    $cacheKey = 'lists_catalog_' . preg_replace('/\W/', '_', $sourceName);
    $cached = getSetting($db, $cacheKey);
    if ($cached && !$refresh) return ['sites' => json_decode($cached, true), 'cached' => true];

    $tmp = tempnam(sys_get_temp_dir(), 'krcat_');
    $error = listsDownload(listsSourceUrl($db, $sourceName) . '/?format=json', $tmp);
    if ($error !== '') {
        @unlink($tmp);
        fail($error, 502);
    }
    $sites = [];
    $fh = fopen($tmp, 'rb');
    $tail = '';
    while (!feof($fh)) {
        $chunk = $tail . fread($fh, 1048576);
        if (preg_match_all('/"name":"([^"]+)","group":"([^"]*)"/', $chunk, $m, PREG_SET_ORDER)) {
            foreach ($m as $hit) $sites[$hit[1]] = $hit[2];
        }
        $tail = substr($chunk, -300);
    }
    fclose($fh);
    unlink($tmp);
    if (!$sites) fail('The source returned no catalog', 502);

    $out = [];
    foreach ($sites as $name => $group) $out[] = ['site' => $name, 'group' => $group];
    usort($out, fn($a, $b) => strcmp($a['site'], $b['site']));
    setSetting($db, $cacheKey, json_encode($out));
    return ['sites' => $out, 'cached' => false];
}

function readList(SQLite3 $db, array $in, $id = 0) {
    $policyId = (int)($in['policy_id'] ?? 0);
    if (!$db->querySingle('SELECT id FROM policies WHERE id = ' . $policyId)) fail('Valid policy is required');
    $interface = trim((string)($in['interface'] ?? ''));
    $gateway = trim((string)($in['gateway'] ?? ''));
    if (!isValidInterface($interface)) fail('Invalid interface name');
    if (!isValidGateway($gateway)) fail('Invalid gateway IP');
    if ($interface === '' && $gateway === '') fail('Set an interface or a gateway: a route needs an exit');
    $excl = trim((string)($in['excl'] ?? ''));
    foreach (preg_split('/\s+/', $excl) as $e) {
        if ($e !== '' && !isValidIPv4Cidr($e)) fail("Not an IPv4 address or CIDR: $e");
    }
    $mode = in_array($in['mode'] ?? '', ['resolve', 'both'], true) ? $in['mode'] : 'networks';
    return ['policy_id' => $policyId, 'interface' => $interface, 'gateway' => $gateway, 'excl' => $excl, 'mode' => $mode, 'enabled' => isset($in['enabled']) ? (int)(bool)$in['enabled'] : 1];
}

function doAddList(SQLite3 $db, $in) {
    $site = trim((string)($in['site'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9._-]{1,100}$/', $site)) fail('Invalid site name');
    $l = readList($db, $in);
    $sourceName = (string)($in['source'] ?? '');
    $stmt = $db->prepare('INSERT INTO lists (site, grp, policy_id, enabled, interface, gateway, excl, mode, source) VALUES (:site, :grp, :pid, 1, :if, :gw, :excl, :mode, :source)');
    $stmt->bindValue(':source', $sourceName, SQLITE3_TEXT);
    $stmt->bindValue(':site', $site, SQLITE3_TEXT);
    $stmt->bindValue(':grp', (string)($in['group'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':pid', $l['policy_id'], SQLITE3_INTEGER);
    $stmt->bindValue(':if', $l['interface'], SQLITE3_TEXT);
    $stmt->bindValue(':gw', $l['gateway'], SQLITE3_TEXT);
    $stmt->bindValue(':excl', $l['excl'], SQLITE3_TEXT);
    $stmt->bindValue(':mode', $l['mode'], SQLITE3_TEXT);
    if (!@$stmt->execute()) fail('This site is already in a list for that policy');
    $id = $db->lastInsertRowID();
    listsQueue($db, [$id]);
    doStartJob($db, ['kind' => 'sync', 'lists' => [$id], 'force' => 1]);
    return ['success' => true, 'id' => $id, 'working' => true];
}

function doSaveList(SQLite3 $db, $in) {
    $id = (int)($in['id'] ?? 0);
    if (!$db->querySingle('SELECT id FROM lists WHERE id = ' . $id)) fail('List not found', 404);
    $l = readList($db, $in);
    $stmt = $db->prepare('UPDATE lists SET policy_id = :pid, enabled = :en, interface = :if, gateway = :gw, excl = :excl, mode = :mode WHERE id = :id');
    $stmt->bindValue(':pid', $l['policy_id'], SQLITE3_INTEGER);
    $stmt->bindValue(':en', $l['enabled'], SQLITE3_INTEGER);
    $stmt->bindValue(':if', $l['interface'], SQLITE3_TEXT);
    $stmt->bindValue(':gw', $l['gateway'], SQLITE3_TEXT);
    $stmt->bindValue(':excl', $l['excl'], SQLITE3_TEXT);
    $stmt->bindValue(':mode', $l['mode'], SQLITE3_TEXT);
    $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
    $stmt->execute();
    listsQueue($db, [$id]);
    doStartJob($db, ['kind' => 'sync', 'lists' => [$id], 'force' => 1]);
    return ['success' => true, 'working' => true];
}

function doDeleteList(SQLite3 $db, $in) {
    $db->exec('DELETE FROM lists WHERE id = ' . (int)($in['id'] ?? 0));
    doStartJob($db, ['kind' => 'sync']);
    return ['success' => true, 'queued' => true];
}

// One list, or all enabled ones; the routes are applied once at the end.
function doSyncLists(SQLite3 $db, $in) {
    $id = (int)($in['id'] ?? 0);
    $ids = $id ? [$id] : array_column(rows($db, 'SELECT id FROM lists WHERE enabled = 1'), 'id');
    if (!$ids) return ['success' => true, 'working' => false, 'count' => 0];
    listsQueue($db, $ids);
    doStartJob($db, ['kind' => 'sync', 'lists' => $ids, 'force' => !empty($in['force']) ? 1 : 0]);
    return ['success' => true, 'working' => true, 'count' => count($ids)];
}

// A job is a chain of steps (targets, lists, apply) that runs in a separate process: "app.php job <kind> <list ids>".
// Its progress is kept in files (see jobRead) and the process is alive while /proc/<pid> exists.
const JOB_STEPS = [
    'all'     => ['targets', 'lists', 'apply'],
    'targets' => ['targets', 'apply'],
    'lists'   => ['lists', 'apply'],
    'apply'   => ['apply'],
    'event'   => ['targets', 'lists', 'apply'],
    'sync'    => ['targets', 'lists', 'apply'],
];

function jobSet(array $fields) {
    jobWrite('job', array_merge(jobRead('job'), $fields));
}

const JOB_HISTORY_MAX = 20;
const JOB_QUEUE_MAX = 6;

function jobLock() {
    $file = sys_get_temp_dir() . '/dns-router-jobq.lock';
    $handle = fopen($file, 'c');
    @chmod($file, 0666);
    flock($handle, LOCK_EX);
    return $handle;
}

function jobAlive($job) {
    if (!$job || $job['state'] !== 'running') return false;
    $pid = (int)(jobRead('jobpid')['pid'] ?? 0);
    return $pid === 0 || is_dir('/proc/' . $pid);
}

// Finished jobs are kept (newest first) with the tail of their log: the task manager shows them
function jobArchive($job) {
    if (empty($job['id'])) return;
    $file = sys_get_temp_dir() . '/dns-router-jobhist.json';
    $handle = fopen($file, 'c+');
    @chmod($file, 0666);
    flock($handle, LOCK_EX);
    $history = json_decode((string)stream_get_contents($handle), true) ?: [];
    foreach ($history as $item) {
        if ($item['id'] === $job['id']) {
            fclose($handle);
            return;
        }
    }
    $lines = @file(sys_get_temp_dir() . '/dns-router-job.log', FILE_IGNORE_NEW_LINES) ?: [];
    $keep = ['id', 'kind', 'source', 'state', 'started', 'finished', 'steps', 'step', 'total', 'done', 'failed', 'held', 'targets_changed', 'target_errors', 'routes', 'route_errors', 'route_error', 'rule_error', 'error'];
    $entry = array_intersect_key($job, array_flip($keep));
    $entry['finished'] = $job['finished'] ?? time();
    if ($entry['state'] === 'done') $entry['done'] = $entry['total'];
    $entry['log'] = implode("\n", array_slice($lines, -150));
    array_unshift($history, $entry);
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode(array_slice($history, 0, JOB_HISTORY_MAX)));
    fclose($handle);
}

// Reads files only; the database is opened only to clean up after a process that died.
function jobReadChecked() {
    $job = jobRead('job');
    if (!$job) return null;
    $pid = (int)(jobRead('jobpid')['pid'] ?? 0);
    if ($job['state'] === 'running' && $pid > 0 && !is_dir('/proc/' . $pid)) {
        jobSet(['state' => 'error', 'error' => 'The update process stopped unexpectedly', 'finished' => time()]);
        jobLog('the update process stopped unexpectedly');
        $db = getDb();
        foreach ($job['ids'] as $id) {
            if (listsIsWorking($db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$id))) {
                listsSetStatus($db, $id, 'cancelled', gmdate('Y-m-d H:i:s'));
            }
        }
        jobWrite('stage', null);
        jobFinished();
        $job = jobRead('job');
    }
    return $job;
}

// A job has ended: keep its record and start the next one from the queue
function jobFinished() {
    $job = jobRead('job');
    if ($job && $job['state'] === 'running') return;
    if ($job) jobArchive($job);
    jobStartNext();
}

function jobStartNext() {
    $lock = jobLock();
    if (jobAlive(jobRead('job'))) {
        fclose($lock);
        return;
    }
    $db = getDb();
    $queue = jobRead('jobq') ?: [];
    $ids = null;
    $next = null;
    while ($db && $queue) {
        $next = array_shift($queue);
        jobWrite('jobq', $queue);
        $ids = jobPrepare($db, $next['kind'], $next['source'], $next + ['delay' => (int)getSetting($db, 'job_delay')]);
        if ($ids !== null) break;
    }
    fclose($lock);
    if ($ids === null) return;
    try {
        jobSpawn($db, $next['kind'], $ids);
    } catch (ApiError $e) {
        jobArchive(jobRead('job'));
    }
}

// The steps a job will really do. A router event refreshes only what is due: the targets at most every 5 minutes,
// the lists at most once an hour, and the routes are written after either of them; when nothing is due there is no job.
function jobStepsFor(SQLite3 $db, $kind, array $params = []) {
    if ($kind === 'sync') {
        $steps = [];
        if ($params['targets']) $steps[] = 'targets';
        if ($params['lists']) $steps[] = 'lists';
        $steps[] = 'apply';
        return $steps;
    }
    if ($kind !== 'event') return JOB_STEPS[$kind];
    $steps = [];
    $targetsDue = $db->querySingle("SELECT COUNT(*) FROM domains WHERE enabled = 1") > 0
        && !$db->querySingle("SELECT COUNT(*) FROM domains WHERE enabled = 1 AND last_check > datetime('now', '-5 minutes')");
    $listsDue = $db->querySingle("SELECT COUNT(*) FROM lists WHERE enabled = 1 AND (last_sync IS NULL OR last_sync = '' OR last_sync < datetime('now', '-1 hour'))") > 0;
    if ($targetsDue) $steps[] = 'targets';
    if ($listsDue) $steps[] = 'lists';
    $steps[] = 'apply';
    return $steps;
}

// Under the lock: writes the record of the new job. The process is started after the lock is released (it would inherit the lock).
function jobPrepare(SQLite3 $db, $kind, $source, array $params = []) {
    if ($kind === 'sync') {
        // the lists cancelled while they waited drop out
        $params['lists'] = array_values(array_filter($params['lists'], fn($id) => listsIsWorking($db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$id))));
    }
    $steps = jobStepsFor($db, $kind, $params);
    if (!$steps) return null;
    $previous = jobRead('job');
    if ($previous && $previous['state'] !== 'running') jobArchive($previous);
    $ids = [];
    $sites = [];
    if ($kind === 'sync') {
        foreach ($params['lists'] as $id) {
            $ids[] = (int)$id;
            $sites[$id] = (string)$db->querySingle('SELECT site FROM lists WHERE id = ' . (int)$id);
        }
    } elseif (in_array('lists', $steps, true)) {
        foreach (rows($db, 'SELECT id, site, status FROM lists WHERE enabled = 1') as $l) {
            if (listsIsWorking($l['status'])) continue;
            $ids[] = (int)$l['id'];
            $sites[$l['id']] = $l['site'];
        }
    }
    if ($kind !== 'sync') listsMarkWorking($db, $ids);
    $logFile = sys_get_temp_dir() . '/dns-router-job.log';
    if (!@unlink($logFile)) @file_put_contents($logFile, '');
    jobWrite('stage', null);
    jobWrite('jobpid', ['pid' => 0]);
    jobWrite('job', ['id' => dechex(time()) . bin2hex(random_bytes(2)), 'source' => $source, 'state' => 'running', 'kind' => $kind, 'done' => 0, 'steps' => $steps, 'step' => $steps[0], 'started' => time(), 'ids' => $ids, 'sites' => $sites, 'total' => count($ids), 'targets' => $params['targets'] ?? [], 'force' => $params['force'] ?? 0, 'delay' => $params['delay'] ?? 0]);
    return $ids;
}

function jobSpawn(SQLite3 $db, $kind, array $ids) {
    $pid = startBackground('job ' . $kind . ' ' . implode(',', $ids), 'next ' . jobRead('job')['id']);
    if ($pid === 0) {
        jobSet(['state' => 'error', 'error' => 'Could not start the update process: check that php-cli is installed', 'finished' => time()]);
        foreach ($ids as $id) listsSetStatus($db, $id, 'Could not start the update process', gmdate('Y-m-d H:i:s'));
        fail('Could not start the update process: check that php-cli is installed', 500);
    }
}

// Starts the job, or puts it into the queue when another one is running
function doStartJob(SQLite3 $db, $in, $source = 'panel') {
    $kind = (string)($in['kind'] ?? '');
    if (!isset(JOB_STEPS[$kind])) fail('Unknown update');
    $params = [
        'targets' => array_values(array_unique(array_map('intval', (array)($in['targets'] ?? [])))),
        'lists'   => array_values(array_unique(array_map('intval', (array)($in['lists'] ?? [])))),
        'force'   => !empty($in['force']) ? 1 : 0,
    ];
    jobReadChecked();
    $lock = jobLock();
    $job = jobRead('job');
    if (jobAlive($job)) {
        $queue = jobRead('jobq') ?: [];
        // edits made while a task runs join the one waiting edit task
        if ($kind === 'sync') {
            foreach ($queue as $n => $item) {
                if ($item['kind'] !== 'sync') continue;
                $queue[$n]['targets'] = array_values(array_unique(array_merge($item['targets'], $params['targets'])));
                $queue[$n]['lists'] = array_values(array_unique(array_merge($item['lists'], $params['lists'])));
                $queue[$n]['force'] = max($item['force'], $params['force']);
                jobWrite('jobq', $queue);
                fclose($lock);
                return ['success' => true, 'queued' => true, 'merged' => true];
            }
        }
        $covered = $job['kind'] === $kind && !in_array($kind, ['event', 'sync'], true);
        foreach ($queue as $item) {
            if ($item['kind'] === $kind) $covered = true;
        }
        if ($covered) {
            fclose($lock);
            return ['success' => true, 'already' => true];
        }
        if (count($queue) >= JOB_QUEUE_MAX) {
            fclose($lock);
            fail('The queue is full');
        }
        $queue[] = ['qid' => bin2hex(random_bytes(3)), 'kind' => $kind, 'source' => $source, 'added' => time()] + $params;
        jobWrite('jobq', $queue);
        fclose($lock);
        return ['success' => true, 'queued' => true, 'position' => count($queue)];
    }
    $ids = jobPrepare($db, $kind, $source, $params);
    fclose($lock);
    if ($ids === null) return ['success' => true, 'skipped' => true];
    jobSpawn($db, $kind, $ids);
    return ['success' => true];
}

// Reads files only, so it answers even while the database is busy with the job.
function doGetJob() {
    $job = jobReadChecked();
    $queue = jobRead('jobq') ?: [];
    if ($queue && !jobAlive($job)) {
        jobFinished();
        $job = jobRead('job');
        $queue = jobRead('jobq') ?: [];
    }
    if (!$job) return ['job' => null, 'queue' => $queue];
    $stage = listsCurrentStage();
    $job['stage'] = $stage ? $stage['text'] : '';
    $job['site'] = $stage && $stage['id'] ? $job['sites'][$stage['id']] : '';
    if ($job['step'] === 'apply' || $job['state'] === 'done') $job['done'] = $job['total'];
    $log = @file_get_contents(sys_get_temp_dir() . '/dns-router-job.log');
    $job['log'] = $log === false ? '' : $log;
    return ['job' => $job, 'queue' => $queue];
}

function jobHistory() {
    return json_decode((string)@file_get_contents(sys_get_temp_dir() . '/dns-router-jobhist.json'), true) ?: [];
}

function doGetJobHistory() {
    $history = jobHistory();
    foreach ($history as &$item) unset($item['log']);
    return ['history' => $history];
}

function doGetJobLog($id) {
    foreach (jobHistory() as $item) {
        if ($item['id'] === $id) return ['log' => $item['log']];
    }
    return ['log' => ''];
}

function doClearJobHistory() {
    @file_put_contents(sys_get_temp_dir() . '/dns-router-jobhist.json', '[]');
    return ['success' => true];
}

// With a queue id: takes that waiting job out of the queue. Without: stops the running one.
function doCancelJob(SQLite3 $db, $in = []) {
    $qid = (string)($in['qid'] ?? '');
    if ($qid !== '') {
        $lock = jobLock();
        foreach (jobRead('jobq') ?: [] as $item) {
            if ($item['qid'] !== $qid) continue;
            foreach ($item['lists'] ?? [] as $listId) doCancelLists($db, ['id' => $listId]);
        }
        $queue = array_values(array_filter(jobRead('jobq') ?: [], fn($item) => $item['qid'] !== $qid));
        jobWrite('jobq', $queue);
        fclose($lock);
        return ['success' => true];
    }
    $job = jobReadChecked();
    if (!$job || $job['state'] !== 'running') return ['success' => true];
    if ($job['step'] === 'apply') fail('The routes are being written right now: it cannot be stopped halfway');
    $pid = (int)(jobRead('jobpid')['pid'] ?? 0);
    if ($pid > 0) exec('kill ' . $pid . ' 2>&1');
    jobSet(['state' => 'cancelled', 'finished' => time()]);
    jobLog('cancelled by the user');
    doCancelLists($db, []);
    jobWrite('stage', null);
    jobFinished();
    return ['success' => true];
}

// "app.php next <job id>" runs after the job process has ended: a job that died without a trace is closed here, then the queue goes on
function jobAfterExit($db, $id) {
    $job = jobRead('job');
    if ($job && $job['id'] === $id && $job['state'] === 'running') {
        jobSet(['state' => 'error', 'error' => 'The update process was killed', 'finished' => time()]);
        jobLog('crashed: the update process was killed');
        foreach ($job['ids'] as $listId) {
            if (listsIsWorking($db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$listId))) {
                listsSetStatus($db, $listId, 'Update crashed: the process was killed', gmdate('Y-m-d H:i:s'));
            }
        }
        jobWrite('stage', null);
    }
    jobFinished();
}

// The body of "app.php job <kind> <ids>".
function jobRun(SQLite3 $db, $kind, array $ids) {
    ini_set('memory_limit', '192M');
    $myId = (string)(jobRead('job')['id'] ?? '');
    jobWrite('jobpid', ['pid' => getmypid()]);
    register_shutdown_function(function () use ($db, $ids, $myId) {
        // the queue may already have started the next job: only this process's own job can be marked as crashed
        $job = jobRead('job');
        if (!$job || $job['id'] !== $myId || $job['state'] !== 'running') return;
        $error = error_get_last();
        $fatal = $error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true);
        $message = $fatal ? $error['message'] : 'The update process stopped unexpectedly';
        jobSet(['state' => 'error', 'error' => $message, 'finished' => time()]);
        jobLog('crashed: ' . $message);
        foreach ($ids as $id) {
            if (listsIsWorking($db->querySingle('SELECT status FROM lists WHERE id = ' . (int)$id))) {
                listsSetStatus($db, $id, 'Update crashed: ' . $message, gmdate('Y-m-d H:i:s'));
            }
        }
        jobWrite('stage', null);
        jobFinished();
    });
    $steps = jobRead('job')['steps'];
    jobLog('started: ' . implode(', ', $steps));
    $delay = jobRead('job')['delay'];
    if ($delay > 0) {
        jobSet(['step' => 'pause']);
        jobLog('pause before the task: ' . $delay . ' s');
        sleep($delay);
    }

    if (in_array('targets', $steps, true)) {
        jobSet(['step' => 'targets']);
        listsStage(0, 'Resolving the targets');
        $check = doUpdateIPs($db, jobRead('job')['targets'] ?: null);
        jobLog('targets: ' . $check['changed'] . ' changed, ' . count($check['errors']) . ' not resolved');
        foreach (array_slice($check['errors'], 0, 30) as $line) jobLog('  ' . $line);
        jobSet(['targets_changed' => $check['changed'], 'target_errors' => count($check['errors'])]);
    }

    if (in_array('lists', $steps, true)) {
        jobSet(['step' => 'lists']);
        $sync = listsSyncMany($db, $ids, !empty(jobRead('job')['force']), true);
        jobSet(['failed' => $sync['failed'], 'held' => $sync['held']]);
    }

    jobSet(['step' => 'apply']);
    listsStage(0, 'Applying the routes');
    $applied = applyNow($db, []);
    jobWrite('stage', null);
    if (!$applied['success']) {
        jobLog('apply failed: ' . $applied['error']);
        jobSet(['state' => 'error', 'error' => $applied['error'], 'finished' => time()]);
        jobFinished();
        return;
    }
    if (birdReassert($db)) jobLog('bgp: the rule and the neighbor routes are in place');
    jobLog('routes: ' . $applied['routes'] . ' written' . ($applied['route_errors'] ? ', ' . $applied['route_errors'] . ' rejected: ' . $applied['route_error'] : ''));
    if ($applied['rule_error'] !== '') jobLog('rules: FAILED ' . $applied['rule_error']);
    jobSet(['state' => 'done', 'finished' => time(), 'routes' => $applied['routes'], 'route_errors' => $applied['route_errors'], 'route_error' => $applied['route_error'], 'rule_error' => $applied['rule_error']]);
    jobLog('finished');
    jobFinished();
}

function doSaveListsSources(SQLite3 $db, $in) {
    $given = $in['sources'] ?? [];
    $sources = [];
    $names = [];
    foreach ($given as $item) {
        $name = trim((string)($item['name'] ?? ''));
        $url = rtrim(trim((string)($item['url'] ?? '')), '/');
        if ($name === '' && $url === '') continue;
        if (!preg_match('/^[A-Za-z0-9._ -]{1,30}$/', $name)) fail('Invalid source name');
        if (!preg_match('~^https?://([A-Za-z0-9._-]+)(:\d+)?(/[A-Za-z0-9._/-]*)?$~', $url, $m)) fail('Invalid source address');
        // the router itself is not a source: that would be a way into RCI and the panel
        if (preg_match('/^(localhost|127\.|0\.)/i', $m[1])) fail('A source cannot be the router itself');
        if (isset($names[$name])) fail('Source names must be different');
        $names[$name] = true;
        $sources[] = ['name' => $name, 'url' => $url];
    }
    if (!$sources) fail('At least one source is needed');
    setSetting($db, 'lists_sources', json_encode($sources));
    $db->exec("DELETE FROM settings WHERE k LIKE 'lists_catalog%'");
    return ['success' => true, 'sources' => listsSources($db)];
}

// Saves the three prefs. When the BGP pref changes, the hook is rewritten and re-run, so the rule moves at once.
function doSaveRoutePrefs(SQLite3 $db, $in) {
    $new = ['targets' => (int)($in['targets'] ?? 0), 'lists' => (int)($in['lists'] ?? 0), 'bgp' => (int)($in['bgp'] ?? 0)];
    foreach ($new as $pref) {
        if ($pref < 1 || $pref > 99) fail('Pref must be a number from 1 to 99');
    }
    if (count(array_unique($new)) < 3) fail('Targets, lists and BGP need different prefs');

    $old = routePrefs($db);
    $bird = birdSettings($db);
    $bgpMoved = $bird && $old['bgp'] !== $new['bgp'];
    if ($bgpMoved) birdRunHook($bird['iface'], 'down');

    setSetting($db, 'pref_targets', $new['targets'] === 4 ? null : $new['targets']);
    setSetting($db, 'pref_lists', $new['lists'] === 6 ? null : $new['lists']);
    setSetting($db, 'pref_bgp', $new['bgp'] === 5 ? null : $new['bgp']);

    if ($bgpMoved) {
        hooksInstall();
        foreach (birdTunnels() as $t) {
            if ($t['system'] === $bird['iface'] && $t['up']) birdRunHook($bird['iface'], 'up');
        }
    }
    return ['success' => true, 'applied' => applyNow($db, $in)] + routePrefs($db);
}

// ---- Keenetic's own configuration through RCI: interface state and static routes (the "ip route" of the web interface)
function rciInterfaceId($v) {
    $v = trim((string)$v);
    return preg_match('~^[A-Za-z0-9_./-]{1,64}$~', $v) ? $v : null;
}

// Messages of every {"status":"error"} in an RCI reply, whatever the nesting
function rciErrors($node) {
    $out = [];
    if (!is_array($node)) return $out;
    if (($node['status'] ?? null) === 'error') $out[] = (string)($node['message'] ?? $node['code'] ?? 'error');
    foreach ($node as $child) {
        if (is_array($child)) $out = array_merge($out, rciErrors($child));
    }
    return $out;
}

// Sends the commands in one request followed by a configuration save. With dry_run nothing is sent.
function rciApply(array $commands, $in) {
    global $rci_host;
    $commands[] = ['system' => ['configuration' => ['save' => new stdClass()]]];
    if (!empty($in['dry_run'])) return ['success' => true, 'dry_run' => true, 'sent' => $commands];
    $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => json_encode($commands), 'timeout' => 30, 'ignore_errors' => true]]);
    $raw = @file_get_contents(rtrim($rci_host, '/') . '/rci/', false, $ctx);
    if ($raw === false) return ['success' => false, 'error' => 'Could not reach Keenetic RCI', 'sent' => $commands];
    $errors = rciErrors(json_decode($raw, true));
    if ($errors) return ['success' => false, 'error' => implode('; ', array_unique($errors)), 'sent' => $commands, 'reply' => $raw];
    return ['success' => true, 'sent' => $commands, 'reply' => $raw];
}

function rciInterfaceFind($id) {
    foreach ((array)rciGet('/rci/show/interface') as $key => $i) {
        if (is_array($i) && (string)($i['id'] ?? $key) === $id) return $i;
    }
    return null;
}

function doSetInterfaceState($in) {
    $id = rciInterfaceId($in['id'] ?? '');
    if ($id === null) fail('Invalid interface name');
    $iface = rciInterfaceFind($id);
    if ($iface === null) fail('Interface not found', 404);
    $up = !empty($in['up']);
    $critical = !empty($iface['defaultgw']) || ($iface['type'] ?? '') === 'Bridge';
    if (!$up && $critical && empty($in['force'])) fail('This interface carries the router or the internet: confirm to turn it off');
    $r = rciApply([['interface' => [$id => ['up' => $up ? true : ['no' => true]]]]], $in);
    if (!$r['success'] || !empty($r['dry_run'])) return $r;
    $now = rciInterfaceFind($id);
    $r['state'] = (string)($now['state'] ?? '');
    return $r;
}

// Characters, not bytes; the router's php has no mbstring
function textLength($s) {
    return count(preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) ?: []);
}

function doSetInterfaceDescription($in) {
    $id = rciInterfaceId($in['id'] ?? '');
    if ($id === null) fail('Invalid interface name');
    $text = trim(preg_replace('/[\x00-\x1f]/', ' ', (string)($in['description'] ?? '')));
    if (textLength($text) > 64) fail('At most 64 characters');
    $change = $text === '' ? ['no' => true] : $text;
    return rciApply([['interface' => [$id => ['description' => $change]]]], $in);
}

function clientMac($in) {
    $mac = strtolower(trim((string)($in['mac'] ?? '')));
    if (!preg_match('/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/', $mac)) fail('Invalid MAC address');
    return $mac;
}

// Policy "" puts the client back on the default policy
function doSetClientPolicy($in) {
    $mac = clientMac($in);
    $policy = trim((string)($in['policy'] ?? ''));
    if ($policy !== '' && !preg_match('/^[A-Za-z0-9_.-]{1,32}$/', $policy)) fail('Invalid policy name');
    $host = ['mac' => $mac, 'permit' => true, 'policy' => $policy === '' ? ['no' => true] : $policy];
    return rciApply([['ip' => ['hotspot' => ['host' => $host]]]], $in);
}

function doRegisterClient($in) {
    $mac = clientMac($in);
    $name = trim(preg_replace('/[\x00-\x1f]/', ' ', (string)($in['name'] ?? '')));
    if ($name === '' || textLength($name) > 63) fail('The name must be 1-63 characters');
    return rciApply([['known' => ['host' => ['name' => $name, 'mac' => $mac]]]], $in);
}

function doUnregisterClient($in) {
    $mac = clientMac($in);
    return rciApply([['known' => ['host' => ['mac' => $mac, 'no' => true]]]], $in);
}

function staticMaskToPrefix($mask) {
    $long = ip2long((string)$mask);
    if ($long === false) return 32;
    return substr_count(decbin($long & 0xFFFFFFFF), '1');
}

function staticPrefixToMask($prefix) {
    return $prefix === 0 ? '0.0.0.0' : long2ip((0xFFFFFFFF << (32 - $prefix)) & 0xFFFFFFFF);
}

// "10.0.0.5", "10.0.0.0/8" -> the fields RCI wants: host, or network and mask
function staticDestination($text) {
    $text = trim((string)$text);
    if (!isValidIPv4Cidr($text)) fail("Not an IPv4 address or CIDR: $text");
    [$ip, $prefix] = array_pad(explode('/', $text, 2), 2, '32');
    $prefix = (int)$prefix;
    if ($prefix === 32) return ['host' => $ip];
    $mask = staticPrefixToMask($prefix);
    return ['network' => long2ip(ip2long($ip) & ip2long($mask)), 'mask' => $mask];
}

function doGetStaticRoutes() {
    $config = rciGet('/rci/ip/route');
    if ($config === null) return ['success' => false, 'error' => 'Could not read the static routes from Keenetic RCI', 'routes' => []];
    $live = [];
    foreach ((array)rciGet('/rci/show/ip/route') as $r) {
        if (is_array($r) && isset($r['destination'])) $live[(string)$r['destination']] = true;
    }
    $routes = [];
    foreach ($config as $r) {
        if (!is_array($r)) continue;
        if (!empty($r['host'])) $dest = $r['host'] . '/32';
        elseif (!empty($r['network'])) $dest = $r['network'] . '/' . staticMaskToPrefix($r['mask'] ?? '255.255.255.255');
        else continue;
        $routes[] = [
            'dest' => $dest, 'gateway' => (string)($r['gateway'] ?? ''), 'interface' => (string)($r['interface'] ?? ''),
            'auto' => !empty($r['auto']), 'reject' => !empty($r['reject']), 'comment' => (string)($r['comment'] ?? ''),
            'active' => isset($live[$dest]),
        ];
    }
    return ['success' => true, 'routes' => $routes];
}

function doAddStaticRoutes($in) {
    $dests = array_values(array_filter(array_map('trim', (array)($in['routes'] ?? []))));
    if (!$dests) fail('Enter at least one address or network');
    if (count($dests) > 500) fail('At most 500 routes at once');
    $gateway = trim((string)($in['gateway'] ?? ''));
    $interface = trim((string)($in['interface'] ?? ''));
    if ($gateway !== '' && !isValidIPv4($gateway)) fail('Invalid gateway IP');
    if ($interface !== '' && rciInterfaceId($interface) === null) fail('Invalid interface name');
    if ($gateway === '' && $interface === '') fail('Set an interface or a gateway: a route needs an exit');
    $comment = trim(preg_replace('/[\x00-\x1f]/', ' ', (string)($in['comment'] ?? '')));
    if (textLength($comment) > 60) fail('At most 60 characters');
    $commands = [];
    foreach ($dests as $dest) {
        if (preg_match('~/[0-7]$~', $dest) && empty($in['wide'])) fail("$dest covers a large part of the Internet: confirm it");
        $route = staticDestination($dest);
        if ($gateway !== '') $route['gateway'] = $gateway;
        if ($interface !== '') $route['interface'] = $interface;
        if (!empty($in['auto'])) $route['auto'] = true;
        if ($comment !== '') $route['comment'] = $comment;
        $commands[] = ['ip' => ['route' => $route]];
    }
    return rciApply($commands, $in);
}

function doDeleteStaticRoutes($in) {
    $dests = array_values(array_filter(array_map('trim', (array)($in['routes'] ?? []))));
    if (!$dests) fail('Nothing to delete');
    if (count($dests) > 500) fail('At most 500 routes at once');
    $commands = [];
    foreach ($dests as $dest) {
        $commands[] = ['ip' => ['route' => ['no' => true] + staticDestination($dest)]];
    }
    return rciApply($commands, $in);
}

// ---- DPI check: what the provider blocks and whether the tunnel gets through.
// The test runs as root in its own process ("app.php dpi"): curl needs root to bind to an interface.
// Progress lives in the temp folder, finished runs in the data folder next to the database.

const DPI_DOMAINS = [
    'www.instagram.com', 'www.facebook.com', 'x.com', 'www.linkedin.com', 'discord.com', 'gateway.discord.gg',
    'media.discordapp.net', 'www.youtube.com', 'soundcloud.com', 'meduza.io', 'www.dw.com', 'www.svoboda.org',
    'holod.media', 'www.euronews.com', 'www.torproject.org', 'protonvpn.com', 'amnezia.org', 'nnmclub.to',
    'standby-rezka.tv', 'hub.docker.com', 'www.intel.com', 'www.canva.com', 'www.coursera.org', 'aws.amazon.com',
    'www.apkmirror.com', 'www.currenttime.tv', 'www.messenger.com', 'www.themoscowtimes.com', 'www.linuxserver.io',
    'danbooru.donmai.us', 'browserleaks.com', 'www.cdn77.com', 'shikimori.io', 'kinopub.online', 'vk.ru', 'www.google.com',
];

const DPI_DNS_DOMAINS = ['rutor.info', 'flibusta.is', 'rezka.ag', 'shikimori.one', 'clubtone.do.am'];
const DPI_DNS_CONTROL = ['vk.ru', 'gosuslugi.ru'];

// id, asn, provider, ip, port, sni (lists from github.com/Runnin4ik/dpi-detector, MIT)
const DPI_TCP_TARGETS = [
    ['HE-01', '24940', 'Hetzner', '91.98.156.82', 443, ''], ['HE-02', '24940', 'Hetzner', '46.62.154.37', 443, ''],
    ['HE-02H', '24940', 'Hetzner', '185.189.229.124', 80, ''], ['HE-03', '213230', 'Hetzner Cloud 2', '5.161.249.234', 443, ''],
    ['HE-04', '213230', 'Hetzner Cloud 2', '178.156.225.186', 443, ''], ['HE-05', '212317', 'Hetzner Cloud 3', '5.78.155.139', 443, ''],
    ['HE-06', '212317', 'Hetzner Cloud 3', '5.78.82.109', 443, ''], ['HE-07', '215859', 'Hetzner Cloud 4', '5.223.56.99', 443, ''],
    ['HE-08', '215859', 'Hetzner Cloud 4', '5.223.68.131', 443, ''],
    ['CF-01', '13335', 'Cloudflare', '172.67.70.222', 443, ''], ['CF-02', '13335', 'Cloudflare', '172.67.181.54', 443, ''],
    ['CF-03', '13335', 'Cloudflare', '104.18.63.125', 443, ''], ['CF-04', '13335', 'Cloudflare', '104.19.153.39', 443, ''],
    ['CF-05', '13335', 'Cloudflare', '104.18.46.6', 443, ''], ['CF-06', '13335', 'Cloudflare', '104.16.59.56', 443, ''],
    ['CDN-02', '60068', 'CDN77', '195.181.167.155', 443, ''], ['CDN-03', '60068', 'CDN77', '169.150.239.5', 443, ''],
    ['CDN-04', '60068', 'CDN77', '84.17.50.100', 80, ''], ['CDN-05', '212238', 'CDN77 2', '136.0.114.217', 443, ''],
    ['CDN-06', '212238', 'CDN77 2', '194.32.146.68', 443, ''], ['CDN-07', '212238', 'CDN77 2', '85.237.223.203', 443, ''],
    ['AK-01', '20940', 'Akamai', '23.222.76.4', 443, ''], ['AK-02', '20940', 'Akamai', '23.46.144.6', 443, ''],
    ['AK-03', '20940', 'Akamai', '72.246.41.5', 80, ''], ['AK-04', '20940', 'Akamai', '95.101.229.18', 443, ''],
    ['AK-05', '16625', 'Akamai 2', '23.1.64.4', 443, ''], ['AK-06', '16625', 'Akamai 2', '184.31.208.5', 443, ''],
    ['AK-07', '12222', 'Akamai 3', '23.62.225.111', 443, ''], ['AK-08', '12222', 'Akamai 3', '88.221.209.114', 443, ''],
    ['AK-09', '33905', 'Akamai 4', '23.40.100.221', 443, ''], ['AK-10', '33905', 'Akamai 4', '23.7.244.221', 443, ''],
    ['AK-11', '63949', 'Akamai Cloud', '172.236.2.30', 443, ''], ['AK-12', '63949', 'Akamai Cloud', '212.71.233.10', 443, ''],
    ['AWS-02', '16509', 'AWS', '3.165.188.250', 443, ''], ['AWS-03', '16509', 'AWS', '168.100.27.4', 443, ''],
    ['AWS-04', '14618', 'AWS 2', '54.196.100.238', 443, ''], ['AWS-05', '14618', 'AWS 2', '148.5.72.176', 443, ''],
    ['AWS-06', '8987', 'AWS 3', '52.119.209.76', 443, ''], ['AWS-07', '8987', 'AWS 3', '170.85.83.22', 443, ''],
    ['CNT-01', '51167', 'Contabo', '173.249.28.198', 443, ''], ['CNT-02', '51167', 'Contabo', '207.180.221.131', 443, ''],
    ['CNT-03', '51167', 'Contabo', '185.211.6.51', 443, ''], ['CNT-04', '51167', 'Contabo', '5.189.159.58', 443, ''],
    ['CNT-05', '141995', 'Contabo 2', '80.65.208.137', 443, ''], ['CNT-06', '141995', 'Contabo 2', '147.93.153.44', 443, ''],
    ['CNT-07', '141995', 'Contabo 2', '94.136.190.9', 443, ''],
    ['FST-01', '54113', 'Fastly', '151.101.66.245', 443, 'www.jetblue.com'], ['FST-02', '54113', 'Fastly', '151.101.194.114', 443, 'ssl.p.jwpcdn.com'],
    ['FST-03', '54113', 'Fastly GitHub', '185.199.108.133', 443, 'release-assets.githubusercontent.com'],
    ['FST-04', '54113', 'Fastly GitHub', '185.199.109.133', 443, 'release-assets.githubusercontent.com'],
    ['FST-05', '54113', 'Fastly GitHub', '185.199.110.133', 443, 'release-assets.githubusercontent.com'],
    ['FST-06', '54113', 'Fastly GitHub', '185.199.111.133', 443, 'release-assets.githubusercontent.com'],
    ['FST-07', '54113', 'Fastly Gog', '151.101.1.55', 443, 'gog.com'],
    ['GC-01', '396982', 'Google Cloud', '147.189.239.240', 443, ''], ['GC-02', '396982', 'Google Cloud', '35.227.66.60', 443, ''],
    ['GCR-01', '199524', 'Gcore', '62.112.221.146', 443, ''], ['GCR-02', '199524', 'Gcore', '92.223.13.10', 443, ''],
    ['GCR-03', '199524', 'Gcore', '185.145.113.133', 443, ''], ['GCR-04', '199524', 'Gcore', '82.117.228.93', 443, ''],
    ['GCR-05', '202422', 'Gcore 2', '5.8.34.27', 443, ''], ['GCR-06', '202422', 'Gcore 2', '185.101.139.107', 443, ''],
    ['OR-01', '31898', 'Oracle Cloud', '153.72.114.110', 443, ''], ['OR-02', '31898', 'Oracle Cloud', '67.222.57.149', 443, ''],
    ['OR-03', '31898', 'Oracle Cloud', '132.145.253.77', 443, ''], ['OR-04', '31898', 'Oracle Cloud', '138.2.147.83', 443, ''],
    ['OR-05', '54253', 'Oracle', '158.180.162.112', 80, ''], ['OR-06', '54253', 'Oracle', '158.178.160.240', 443, ''],
    ['OR-07', '54253', 'Oracle', '217.142.192.157', 443, ''], ['OR-08', '6142', 'Oracle 3', '139.87.80.96', 443, ''],
    ['OR-09', '6142', 'Oracle 3', '139.87.117.158', 443, ''], ['OR-10', '14544', 'Oracle 4', '207.127.85.89', 443, ''],
    ['OR-11', '20054', 'Oracle 5', '155.248.28.213', 443, ''],
    ['OVH-01', '16276', 'OVH', '5.196.63.68', 443, ''], ['OVH-02', '16276', 'OVH', '141.95.228.164', 443, ''],
    ['OVH-03', '16276', 'OVH', '51.75.18.27', 443, ''], ['OVH-04', '16276', 'OVH', '40.160.45.210', 443, ''],
    ['OVH-05', '16276', 'OVH', '188.165.20.24', 443, ''], ['OVH-06', '16276', 'OVH', '147.135.214.172', 80, ''],
    ['SW-01', '12876', 'Scaleway', '62.4.10.75', 443, ''], ['SW-02', '12876', 'Scaleway', '51.158.153.203', 443, ''],
    ['SW-03', '12876', 'Scaleway', '212.83.152.108', 443, ''], ['SW-04', '12876', 'Scaleway', '163.172.223.99', 80, ''],
    ['SW-05', '29447', 'Scaleway 2', '81.56.227.171', 443, ''], ['SW-06', '29447', 'Scaleway 2', '83.158.240.200', 443, ''],
    ['SW-07', '29447', 'Scaleway 2', '81.56.5.136', 443, ''], ['SW-08', '29447', 'Scaleway 2', '81.56.32.219', 443, ''],
    ['DO-01', '14061', 'DigitalOcean', '157.230.91.62', 443, ''], ['DO-02', '14061', 'DigitalOcean', '138.68.63.162', 443, ''],
    ['DO-03', '14061', 'DigitalOcean', '165.245.210.202', 443, ''], ['DO-04', '14061', 'DigitalOcean', '147.182.168.41', 443, ''],
    ['DO-05', '14061', 'DigitalOcean', '45.55.107.70', 443, ''], ['DO-06', '46652', 'DigitalOcean 2', '141.0.173.188', 443, ''],
    ['DO-07', '46652', 'DigitalOcean 2', '69.55.57.11', 443, ''],
    ['VLT-01', '20473', 'Vultr', '209.250.243.50', 443, ''], ['VLT-02', '20473', 'Vultr', '64.176.188.124', 443, ''],
    ['VLT-03', '20473', 'Vultr', '108.61.167.59', 443, ''], ['VLT-04', '20473', 'Vultr', '173.199.115.182', 443, ''],
    ['MBC-01', '8849', 'Melbicom', '109.122.201.147', 443, ''], ['MBC-03', '56630', 'Melbicom 2', '185.6.14.1', 443, ''],
    ['FT-01', '53667', 'FranTech', '107.189.29.143', 443, ''], ['FT-02', '53667', 'FranTech', '198.251.88.98', 443, ''],
    ['CV-01', '62240', 'Clouvider', '185.42.222.195', 443, ''], ['CV-02', '62240', 'Clouvider', '80.73.109.187', 443, ''],
    ['ME-01', '9009', 'M247', '146.70.158.22', 443, ''], ['IM-01', '20860', 'IOMART', '162.33.28.242', 443, ''],
    ['IM-02', '21130', 'IOMART 2', '185.224.199.82', 443, ''], ['ZL-01', '21859', 'Zenlayer', '193.118.45.137', 443, ''],
    ['CN-01', '51765', 'CreaNova', '185.112.82.170', 443, ''], ['SCA-01', '58061', 'Scalaxy', '5.61.55.146', 443, ''],
    ['FRX-01', '48040', 'Fornex', '199.68.199.16', 443, ''],
];

// Russian names that a filter tends to let through; tried as SNI on the hostings that cut the connection
const DPI_WHITE_SNI = [
    'ya.ru', 'yandex.ru', 'vk.com', 'vk.ru', 'gosuslugi.ru', 'mail.ru', 'ok.ru', 'dzen.ru', 'avito.ru', 'ozon.ru',
    'wildberries.ru', 'sberbank.ru', 'online.sberbank.ru', 'vtb.ru', 'alfabank.ru', 'tbank.ru', 'rzd.ru', '2gis.ru',
    'kinopoisk.ru', 'rutube.ru', 'mos.ru', 'nalog.gov.ru', 'mts.ru', 'beeline.ru', 'megafon.ru', 'rt.ru',
    'yastatic.net', 'userapi.com', 'vk-cdn.net', 'mycdn.me', 'dns-shop.ru', 'market.yandex.ru', 'music.yandex.ru',
    'disk.yandex.ru', 'cloud.mail.ru', 'pochta.ru', 'hh.ru', 'kp.ru', 'ria.ru', 'tass.ru',
];

const DPI_TG_DCS = [['DC1', '149.154.175.53'], ['DC2', '149.154.167.51'], ['DC3', '149.154.175.100'], ['DC4', '149.154.167.91'], ['DC5', '91.108.56.130']];

const DPI_TESTS = ['dns', 'domains', 'tcp', 'sni', 'tg'];
const DPI_TCP_PAD = 4000;
const DPI_TCP_STEPS = 10;
const DPI_CUT_MIN = 12 * 1024;
const DPI_CUT_MAX = 36 * 1024;
const DPI_KEEP_RUNS = 5;
const DPI_SNI_GROUPS = 10;

// ---- QUIC: the first packet of an HTTP/3 connection (RFC 9000/9001), built and read here, without curl.
// The Initial packets are encrypted with keys anybody can derive from the connection id, so the answer of the server can be read too.

const QUIC_SALT = '38762cf7f55934b34d179ae6a4c80cadccbb7f0a';

function quicVarint($n) {
    if ($n < 64) return chr($n);
    if ($n < 16384) return pack('n', 0x4000 | $n);
    return pack('N', 0x80000000 | $n);
}

function quicReadVarint($data, &$pos) {
    $first = ord($data[$pos] ?? "\0");
    $length = 1 << ($first >> 6);
    $value = $first & 0x3f;
    for ($i = 1; $i < $length; $i++) $value = ($value << 8) | ord($data[$pos + $i] ?? "\0");
    $pos += $length;
    return $value;
}

function quicExpandLabel($secret, $label, $length) {
    $label = 'tls13 ' . $label;
    $info = pack('n', $length) . chr(strlen($label)) . $label . "\0";
    return substr(hash_hmac('sha256', $info . "\x01", $secret, true), 0, $length);
}

// $side: 'client in' or 'server in'
function quicKeys($dcid, $side) {
    $initial = hash_hmac('sha256', $dcid, hex2bin(QUIC_SALT), true);
    $secret = quicExpandLabel($initial, $side, 32);
    return ['key' => quicExpandLabel($secret, 'quic key', 16), 'iv' => quicExpandLabel($secret, 'quic iv', 12), 'hp' => quicExpandLabel($secret, 'quic hp', 16)];
}

function quicMask($hp, $sample) {
    return openssl_encrypt($sample, 'aes-128-ecb', $hp, OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING);
}

function quicExtension($type, $data) {
    return pack('n', $type) . pack('n', strlen($data)) . $data;
}

// A TLS 1.3 ClientHello the way a browser asks for HTTP/3; $host '' sends no SNI
function quicClientHello($host, $scid) {
    $params = '';
    foreach ([0x01 => 30000, 0x03 => 1472, 0x04 => 1048576, 0x05 => 262144, 0x06 => 262144, 0x07 => 262144, 0x08 => 100, 0x09 => 100] as $id => $value) {
        $encoded = quicVarint($value);
        $params .= quicVarint($id) . quicVarint(strlen($encoded)) . $encoded;
    }
    $params .= quicVarint(0x0f) . quicVarint(strlen($scid)) . $scid;

    $extensions = '';
    if ($host !== '') {
        $name = "\0" . pack('n', strlen($host)) . $host;
        $extensions .= quicExtension(0x0000, pack('n', strlen($name)) . $name);
    }
    $extensions .= quicExtension(0x000a, pack('n', 4) . "\x00\x1d\x00\x17");
    $algorithms = "\x04\x03\x08\x04\x04\x01\x05\x03\x08\x05\x05\x01\x08\x06\x06\x01";
    $extensions .= quicExtension(0x000d, pack('n', strlen($algorithms)) . $algorithms);
    $extensions .= quicExtension(0x0010, pack('n', 3) . "\x02h3");
    $extensions .= quicExtension(0x002b, "\x02\x03\x04");
    $extensions .= quicExtension(0x002d, "\x01\x01");
    $share = "\x00\x1d" . pack('n', 32) . random_bytes(32);
    $extensions .= quicExtension(0x0033, pack('n', strlen($share)) . $share);
    $extensions .= quicExtension(0x0039, $params);

    $body = "\x03\x03" . random_bytes(32) . "\x00" . pack('n', 6) . "\x13\x01\x13\x02\x13\x03" . "\x01\x00" . pack('n', strlen($extensions)) . $extensions;
    return "\x01" . substr(pack('N', strlen($body)), 1) . $body;
}

// The client Initial packet, padded to the 1200 bytes a server demands
function quicInitialPacket($dcid, $scid, $host) {
    $keys = quicKeys($dcid, 'client in');
    $hello = quicClientHello($host, $scid);
    $payload = "\x06" . quicVarint(0) . quicVarint(strlen($hello)) . $hello;
    $head = "\xc3" . "\x00\x00\x00\x01" . chr(strlen($dcid)) . $dcid . chr(strlen($scid)) . $scid . "\x00";
    $payload = str_pad($payload, 1200 - strlen($head) - 2 - 4 - 16, "\0");
    $header = $head . pack('n', 0x4000 | (4 + strlen($payload) + 16)) . "\x00\x00\x00\x00";
    $pnOffset = strlen($header) - 4;
    $sealed = openssl_encrypt($payload, 'aes-128-gcm', $keys['key'], OPENSSL_RAW_DATA, $keys['iv'], $tag, $header, 16) . $tag;
    $mask = quicMask($keys['hp'], substr($sealed, 0, 16));
    $header[0] = chr(ord($header[0]) ^ (ord($mask[0]) & 0x0f));
    for ($i = 0; $i < 4; $i++) $header[$pnOffset + $i] = chr(ord($header[$pnOffset + $i]) ^ ord($mask[1 + $i]));
    return $header . $sealed;
}

// What the server answered: ['class', 'code', 'note'], or null when the datagram says nothing yet
function quicReadAnswer($data, $dcid) {
    $keys = quicKeys($dcid, 'server in');
    $pos = 0;
    $answered = false;
    while ($pos < strlen($data) && (ord($data[$pos]) & 0x80)) {
        $first = ord($data[$pos]);
        if (substr($data, $pos + 1, 4) === "\0\0\0\0") return ['class' => 'ok', 'code' => 'OK', 'note' => 'The server answered with the versions it supports'];
        $type = ($first >> 4) & 3;
        $p = $pos + 5;
        $p += 1 + ord($data[$p]);
        $p += 1 + ord($data[$p]);
        if ($type === 3) return ['class' => 'ok', 'code' => 'OK', 'note' => 'The server asked to retry with a token (Retry)'];
        if ($type === 0) $p += quicReadVarint($data, $p);
        $length = quicReadVarint($data, $p);
        $end = $p + $length;
        if ($type !== 0) {
            $pos = $end;
            $answered = true;
            continue;
        }
        $mask = quicMask($keys['hp'], substr($data, $p + 4, 16));
        $first ^= ord($mask[0]) & 0x0f;
        $pnLength = ($first & 3) + 1;
        $pn = 0;
        $pnBytes = '';
        for ($i = 0; $i < $pnLength; $i++) {
            $byte = ord($data[$p + $i]) ^ ord($mask[1 + $i]);
            $pnBytes .= chr($byte);
            $pn = ($pn << 8) | $byte;
        }
        $header = chr($first) . substr($data, $pos + 1, $p - $pos - 1) . $pnBytes;
        $nonce = $keys['iv'] ^ str_pad(pack('N', $pn), 12, "\0", STR_PAD_LEFT);
        $sealed = substr($data, $p + $pnLength, $end - $p - $pnLength);
        $plain = openssl_decrypt(substr($sealed, 0, -16), 'aes-128-gcm', $keys['key'], OPENSSL_RAW_DATA, $nonce, substr($sealed, -16), $header);
        if ($plain === false) return ['class' => 'rst', 'code' => 'ERR', 'note' => 'The answer could not be decrypted'];
        $frame = quicReadFrames($plain);
        if ($frame) return $frame;
        $answered = true;
        $pos = $end;
    }
    return $answered ? ['class' => 'ok', 'code' => 'OK', 'note' => 'The server answered'] : null;
}

function quicReadFrames($plain) {
    $i = 0;
    while ($i < strlen($plain)) {
        $type = quicReadVarint($plain, $i);
        if ($type === 0x00 || $type === 0x01) continue;
        if ($type === 0x02 || $type === 0x03) {
            quicReadVarint($plain, $i);
            quicReadVarint($plain, $i);
            $ranges = quicReadVarint($plain, $i);
            quicReadVarint($plain, $i);
            for ($r = 0; $r < $ranges * 2 + ($type === 0x03 ? 3 : 0); $r++) quicReadVarint($plain, $i);
            continue;
        }
        if ($type === 0x06) {
            quicReadVarint($plain, $i);
            $length = quicReadVarint($plain, $i);
            $data = substr($plain, $i, $length);
            $i += $length;
            if (($data[0] ?? '') === "\x02") return ['class' => 'ok', 'code' => 'OK', 'note' => 'The server began the handshake (ServerHello)'];
            continue;
        }
        if ($type === 0x1c || $type === 0x1d) {
            $code = quicReadVarint($plain, $i);
            if ($type === 0x1c) quicReadVarint($plain, $i);
            $length = quicReadVarint($plain, $i);
            $reason = substr($plain, $i, $length);
            $what = $code >= 0x100 && $code < 0x200 ? 'TLS alert ' . ($code - 0x100) : 'error 0x' . dechex($code);
            return ['class' => 'na', 'code' => 'CLOSED', 'note' => 'The server closed the connection: ' . $what . ($reason !== '' ? ' (' . $reason . ')' : '') . '; UDP got through'];
        }
        break;
    }
    return null;
}

// Many QUIC probes side by side: each job [ip, host, iface]. One resend after a second, the answer waits 3 s.
// Without the sockets module an interface cannot be chosen, so such jobs are not sent.
function quicProbeMany(array $jobs) {
    $results = [];
    $open = [];
    $sockets = function_exists('socket_create');
    foreach ($jobs as $key => [$ip, $host, $iface]) {
        if (!extension_loaded('openssl')) {
            $results[$key] = ['class' => 'na', 'code' => 'N/A', 'note' => 'The PHP OpenSSL module is not installed: Service, System checks'];
            continue;
        }
        if ($iface !== '' && !$sockets) {
            $results[$key] = ['class' => 'na', 'code' => 'N/A', 'note' => 'QUIC through an interface needs the PHP sockets module'];
            continue;
        }
        $dcid = random_bytes(8);
        $packet = quicInitialPacket($dcid, random_bytes(8), isValidIPv4($host) ? '' : $host);
        if ($sockets) {
            $sock = socket_create(AF_INET, SOCK_DGRAM, SOL_UDP);
            if ($iface !== '' && !@socket_set_option($sock, SOL_SOCKET, SO_BINDTODEVICE, $iface)) {
                $results[$key] = ['class' => 'na', 'code' => 'N/A', 'note' => 'Could not bind to ' . $iface];
                continue;
            }
            socket_set_nonblock($sock);
            socket_connect($sock, $ip, 443);
        } else {
            $sock = stream_socket_client('udp://' . $ip . ':443');
            stream_set_blocking($sock, false);
        }
        $open[$key] = ['sock' => $sock, 'dcid' => $dcid, 'packet' => $packet, 'start' => microtime(true), 'resent' => false];
        $sockets ? @socket_write($sock, $packet) : @fwrite($sock, $packet);
    }
    while ($open) {
        $read = array_column($open, 'sock');
        $write = null;
        $except = null;
        $sockets ? @socket_select($read, $write, $except, 0, 200000) : @stream_select($read, $write, $except, 0, 200000);
        $now = microtime(true);
        foreach ($open as $key => &$job) {
            $data = $sockets ? @socket_read($job['sock'], 2048) : @fread($job['sock'], 2048);
            $answer = $data ? quicReadAnswer($data, $job['dcid']) : null;
            if (!$answer && $now - $job['start'] > 3) $answer = ['class' => 'to', 'code' => 'TIMEOUT', 'note' => 'No answer over UDP 443'];
            if (!$answer && !$job['resent'] && $now - $job['start'] > 1) {
                $sockets ? @socket_write($job['sock'], $job['packet']) : @fwrite($job['sock'], $job['packet']);
                $job['resent'] = true;
            }
            if (!$answer) continue;
            $answer['ms'] = (int)round(($now - $job['start']) * 1000);
            $results[$key] = $answer;
            $sockets ? socket_close($job['sock']) : fclose($job['sock']);
            unset($open[$key]);
        }
        unset($job);
    }
    return $results;
}

// ---- Test Route: one real request through the interface the route test found, with any SNI

// Runs curl as root (binding to an interface needs it) and splits the merged output into the -w JSON and the -v lines
function testRouteCurlRun(array $args) {
    $out = execPipelineAsRoot(implode(' ', array_map('escapeshellarg', array_merge([listsCurl()], $args))) . ' 2>&1');
    $json = null;
    $log = [];
    foreach (preg_split('/\r?\n/', $out) as $line) {
        if ($line !== '' && $line[0] === '{' && strpos($line, '"exitcode"') !== false) {
            $json = json_decode($line, true);
            continue;
        }
        if (preg_match('/^[{}] \[/', $line) || trim($line) === '') continue;
        $log[] = $line;
    }
    $stderr = implode("\n", $log);
    preg_match_all('/^\*\s+(subject|issuer|start date|expire date):\s*(.+)$/m', $stderr, $m, PREG_SET_ORDER);
    $cert = [];
    foreach ($m as [, $field, $value]) $cert[$field] ??= trim($value);
    $connected = preg_match('/^\* (Connected to|Established connection)/mi', $stderr) === 1 || (float)($json['time_connect'] ?? 0) > 0;
    return ['json' => $json, 'log' => $log, 'cert' => $cert, 'connected' => $connected];
}

function doTestRouteCurl($in) {
    if (listsCurl() === '') fail('curl is not installed: Service, System checks, "curl"');
    $ip = trim((string)($in['ip'] ?? ''));
    $dev = trim((string)($in['dev'] ?? ''));
    $target = strtolower(trim((string)($in['target'] ?? '')));
    $sni = strtolower(trim((string)($in['sni'] ?? '')));
    $scheme = ($in['scheme'] ?? 'https') === 'http' ? 'http' : 'https';
    $path = trim((string)($in['path'] ?? '/'));
    $tls = (string)($in['tls'] ?? '');
    if (!isValidIPv4($ip)) fail('Invalid IP');
    if (!isValidInterface($dev)) fail('Invalid interface name');
    if ($sni !== '' && !isValidDomain($sni)) fail('The SNI is not a domain: ' . $sni);
    if ($path === '') $path = '/';
    if (!preg_match('#^/[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*$#', $path)) fail('Invalid path');

    // the name goes into SNI and Host; without a name the request goes to the bare IP and sends no SNI
    $host = $sni !== '' ? $sni : (isValidDomain($target) ? $target : $ip);
    $port = $scheme === 'https' ? 443 : 80;
    $args = dpiCurlOptions($dev, 8);
    if ($tls === '1.2') array_push($args, '--tlsv1.2', '--tls-max', '1.2');
    if ($tls === '1.3') $args[] = '--tlsv1.3';
    $tail = ['-o', '/dev/null', '--resolve', "$host:$port:$ip", "$scheme://$host$path"];
    $r = testRouteCurlRun(array_merge($args, $tail));
    if (!$r['json']) return ['success' => false, 'error' => trim(implode(' ', array_slice($r['log'], -3)))];
    $t = $r['json'];
    $result = dpiClassify($t + ['connected' => $r['connected']], $host, $scheme === 'https');

    $cert = null;
    if ($scheme === 'https') {
        $source = $r;
        // a refused certificate is not printed: ask again without the check to see what the server gives
        if ($result['code'] === 'CERT') $source = testRouteCurlRun(array_merge($args, ['-k'], $tail));
        $cert = dpiCertInfo(['transfers' => [$source['json'] ?? []], 'cert' => $source['cert']]);
        if ($cert && $result['code'] === 'CERT' && dpiNameMismatch($result['note']) && dpiCertSameSite($cert, $host)) {
            $result = ['class' => 'na', 'code' => 'NAME', 'note' => 'The certificate of the site itself, but the name ' . $host . ' is not in it: not a block'];
        }
        // with somebody else's name in SNI the server can only give its own certificate: the handshake itself got through
        if ($result['code'] === 'CERT' && dpiNameMismatch($result['note']) && $sni !== '' && $sni !== $target) {
            $result = ['class' => 'ok', 'code' => 'TLS OK', 'note' => 'The TLS handshake with SNI ' . $sni . ' got through; the server gave its own certificate, as expected with a foreign name'];
        }
    }
    $headers = array_values(array_filter(array_map(fn($l) => trim(substr($l, 2)), preg_grep('/^< /', $r['log'])), 'strlen'));
    $tlsLine = '';
    foreach ($r['log'] as $line) {
        if (preg_match('/^\* SSL connection using (.+)$/', $line, $m)) $tlsLine = $m[1];
    }
    return [
        'success' => true, 'result' => $result, 'host' => $host, 'sni' => $scheme === 'https' && $host !== $ip ? $host : '',
        'url' => "$scheme://$host$path", 'ip' => $ip, 'dev' => $dev,
        'http' => (int)($t['http_code'] ?? 0), 'http_version' => (string)($t['http_version'] ?? ''), 'tls' => $tlsLine,
        'times' => ['connect' => (float)($t['time_connect'] ?? 0), 'tls' => (float)($t['time_appconnect'] ?? 0), 'first_byte' => (float)($t['time_starttransfer'] ?? 0), 'total' => (float)($t['time_total'] ?? 0)],
        'size' => (int)($t['size_download'] ?? 0), 'redirect' => (string)($t['redirect_url'] ?? ''),
        'cert' => $cert, 'headers' => array_slice($headers, 0, 30), 'log' => array_slice($r['log'], 0, 80),
    ];
}

// ---- the lists the check uses: the built-in ones above, or the user's own edit kept in settings

const DPI_LISTS = ['domains', 'dns', 'dns_control', 'tcp', 'sni', 'tg'];

function dpiDefaultText($name) {
    if ($name === 'domains') return implode("\n", DPI_DOMAINS);
    if ($name === 'dns') return implode("\n", DPI_DNS_DOMAINS);
    if ($name === 'dns_control') return implode("\n", DPI_DNS_CONTROL);
    if ($name === 'sni') return implode("\n", DPI_WHITE_SNI);
    $lines = [];
    if ($name === 'tcp') {
        foreach (DPI_TCP_TARGETS as [$id, $asn, $provider, $ip, $port, $sni]) {
            $lines[] = $id . ' ' . $ip . ($port === 443 ? '' : ':' . $port) . ' AS' . $asn . ($sni !== '' ? ' sni=' . $sni : '') . ' ' . $provider;
        }
    }
    if ($name === 'tg') {
        foreach (DPI_TG_DCS as [$dc, $ip]) $lines[] = $ip . ' ' . $dc;
    }
    return implode("\n", $lines);
}

// Lines without comments (#) and blanks, with their line numbers for the error messages
function dpiLines($text) {
    $out = [];
    foreach (preg_split('/\r?\n/', (string)$text) as $n => $line) {
        $line = trim(preg_replace('/#.*$/', '', $line));
        if ($line !== '') $out[$n + 1] = $line;
    }
    return $out;
}

function dpiParseList($name, $text) {
    $labels = ['domains' => 'Domains', 'dns' => 'DNS names', 'dns_control' => 'DNS control names', 'tcp' => 'Hostings', 'sni' => 'White SNI', 'tg' => 'Telegram'];
    $out = [];
    foreach (dpiLines($text) as $n => $line) {
        $where = $labels[$name] . ', line ' . $n . ': ';
        if (in_array($name, ['domains', 'dns', 'dns_control', 'sni'], true)) {
            $line = strtolower($line);
            if (!preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/', $line)) fail($where . 'not a domain: ' . $line);
            $out[] = $line;
            continue;
        }
        $words = preg_split('/\s+/', $line);
        if ($name === 'tg') {
            if (!isValidIPv4($words[0])) fail($where . 'not an IPv4 address: ' . $words[0]);
            $out[] = [count($words) > 1 ? implode(' ', array_slice($words, 1)) : $words[0], $words[0]];
            continue;
        }
        // hostings: [id] ip[:port] [AS123] [sni=host] [provider name]
        $id = preg_match('/^[0-9.]+(:\d+)?$/', $words[0]) ? '#' . (count($out) + 1) : array_shift($words);
        [$ip, $port] = array_pad(explode(':', (string)array_shift($words), 2), 2, '443');
        if (!isValidIPv4($ip)) fail($where . 'not an IPv4 address: ' . $ip);
        if (!preg_match('/^\d+$/', $port) || (int)$port < 1 || (int)$port > 65535) fail($where . 'bad port: ' . $port);
        $asn = '';
        $sni = '';
        $provider = [];
        foreach ($words as $word) {
            if (preg_match('/^AS(\d+)$/i', $word, $m)) $asn = $m[1];
            elseif (strpos($word, 'sni=') === 0) $sni = strtolower(substr($word, 4));
            else $provider[] = $word;
        }
        if ($sni !== '' && !preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/', $sni)) fail($where . 'not a domain: ' . $sni);
        $out[] = [$id, $asn, $provider ? implode(' ', $provider) : $ip, $ip, (int)$port, $sni];
    }
    return $name === 'tcp' || $name === 'tg' ? $out : array_values(array_unique($out));
}

function dpiListText(SQLite3 $db, $name) {
    return getSetting($db, 'dpi_list_' . $name) ?? dpiDefaultText($name);
}

function dpiLists(SQLite3 $db) {
    $lists = [];
    foreach (DPI_LISTS as $name) $lists[$name] = dpiParseList($name, dpiListText($db, $name));
    $lists['tcp_sni'] = dpiTcpSni($db);
    return $lists;
}

// The SNI of the hostings test for the addresses without their own; '' means no SNI
function dpiTcpSni(SQLite3 $db) {
    return getSetting($db, 'dpi_tcp_sni') ?? 'example.com';
}

function doGetDpiLists(SQLite3 $db) {
    $out = ['lists' => [], 'defaults' => []];
    foreach (DPI_LISTS as $name) {
        $out['lists'][$name] = dpiListText($db, $name);
        $out['defaults'][$name] = dpiDefaultText($name);
    }
    $out['tcp_sni'] = dpiTcpSni($db);
    return $out;
}

// Checks every list first, then saves; a list equal to the built-in one is not kept
function doSaveDpiLists(SQLite3 $db, $in) {
    $given = (array)($in['lists'] ?? []);
    foreach (DPI_LISTS as $name) dpiParseList($name, $given[$name] ?? '');
    $sni = strtolower(trim((string)($in['tcp_sni'] ?? 'example.com')));
    if ($sni !== '' && !preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/', $sni)) fail('Hostings: the SNI is not a domain: ' . $sni);
    setSetting($db, 'dpi_tcp_sni', $sni === 'example.com' ? null : $sni);
    foreach (DPI_LISTS as $name) {
        $text = trim(str_replace("\r", '', (string)($given[$name] ?? '')));
        setSetting($db, 'dpi_list_' . $name, $text === dpiDefaultText($name) ? null : $text);
    }
    return ['success' => true];
}

// The running test: params, progress and the pid of the root process
function dpiState() {
    $state = jobRead('dpi');
    if (!$state || $state['state'] !== 'running') return $state;
    $dead = $state['pid'] > 0 ? !is_dir('/proc/' . $state['pid']) : $state['started'] < time() - 30;
    if ($dead) {
        $state['state'] = 'error';
        $state['error'] = 'The check process stopped unexpectedly';
        jobWrite('dpi', $state);
    }
    return $state;
}

function dpiProgress(array $changes) {
    $state = jobRead('dpi');
    jobWrite('dpi', array_merge($state, $changes));
}

function dpiCancelled() {
    return (jobRead('dpi')['state'] ?? '') !== 'running';
}

function dpiRuns() {
    return withDb(fn($db) => array_map(
        fn($row) => ['id' => $row['id'], 'started' => (int)$row['started'], 'summary' => json_decode($row['summary'], true)],
        rows($db, 'SELECT id, started, summary FROM dpi_runs ORDER BY id DESC')));
}

function dpiReadRun($id) {
    if (!preg_match('/^[0-9]{10}$/', (string)$id)) return null;
    $data = withDb(function ($db) use ($id) {
        $st = $db->prepare('SELECT data FROM dpi_runs WHERE id = :id');
        $st->bindValue(':id', $id);
        return $st->execute()->fetchArray(SQLITE3_NUM)[0] ?? null;
    });
    return $data === null ? null : json_decode($data, true);
}

function dpiSaveRun(array $run) {
    withDb(function ($db) use ($run) {
        $st = $db->prepare('INSERT OR REPLACE INTO dpi_runs (id, started, summary, data) VALUES (:id, :started, :summary, :data)');
        $st->bindValue(':id', (string)$run['id']);
        $st->bindValue(':started', (int)$run['started']);
        $st->bindValue(':summary', json_encode($run['summary']));
        $st->bindValue(':data', json_encode($run, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        $st->execute();
    });
}

// One run by its id, or every run when there is no id; the run in progress stays
function doDeleteDpiRuns($in) {
    $state = dpiState();
    $running = $state && $state['state'] === 'running' ? (string)$state['id'] : '';
    $id = (string)($in['id'] ?? '');
    if ($id !== '' && !preg_match('/^[0-9]{10}$/', $id)) fail('Invalid run');
    return withDb(function ($db) use ($id, $running) {
        $st = $db->prepare($id !== '' ? 'DELETE FROM dpi_runs WHERE id = :id AND id != :running' : 'DELETE FROM dpi_runs WHERE id != :running');
        if ($id !== '') $st->bindValue(':id', $id);
        $st->bindValue(':running', $running);
        $st->execute();
        return ['success' => true, 'deleted' => $db->changes()];
    });
}

function doGetDpi(SQLite3 $db, $in) {
    $state = dpiState();
    $runs = dpiRuns();
    $id = (string)($in['id'] ?? '');
    if ($id === '' && $runs) $id = $runs[0]['id'];
    $run = $id === '' ? null : dpiReadRun($id);
    if ($run) $run['targets'] = dpiTargetMap($db, $run['domains']);
    return ['state' => $state, 'runs' => $runs, 'run' => $run, 'openssl' => extension_loaded('openssl'), 'curl' => listsCurl() !== '', 'my_targets' => count(dpiMyTargets($db)), 'base_count' => count(dpiParseList('domains', dpiListText($db, 'domains')))];
}

// Hostnames of the enabled targets: IPs and networks are not domains to check
function dpiMyTargets(SQLite3 $db) {
    $out = [];
    foreach (rows($db, 'SELECT DISTINCT domain FROM domains WHERE enabled = 1 ORDER BY domain') as $row) {
        $name = strtolower($row['domain']);
        if (preg_match('/^[0-9.\/]+$/', $name)) continue;
        if (!preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/', $name)) continue;
        $out[] = $name;
    }
    return $out;
}

// For each checked domain: what already routes it, a target or a list (by name, by the list's domains or by its networks)
function dpiTargetMap(SQLite3 $db, array $rows) {
    $targets = rows($db, 'SELECT d.domain, p.name FROM domains d JOIN policies p ON p.id = d.policy_id WHERE d.enabled = 1');
    $lists = rows($db, 'SELECT l.site, l.domains, l.items, p.name FROM lists l JOIN policies p ON p.id = l.policy_id WHERE l.enabled = 1');
    $map = [];
    foreach ($rows as $row) {
        $domain = $row['domain'];
        $map[$domain] = null;
        foreach ($targets as $t) {
            if (dpiNameCovers(strtolower($t['domain']), $domain)) {
                $map[$domain] = ['policy' => $t['name'], 'via' => 'target', 'what' => $t['domain']];
                break;
            }
        }
        if ($map[$domain]) continue;
        $ip = $row['ip'] === '' ? null : ipToFloat($row['ip']);
        foreach ($lists as $l) {
            $names = array_merge([$l['site']], $l['domains'] === '' ? [] : explode("\n", $l['domains']));
            $covered = false;
            foreach ($names as $name) {
                if (dpiNameCovers(strtolower(trim($name)), $domain)) $covered = true;
            }
            if (!$covered && $ip !== null) {
                foreach (explode("\n", $l['items']) as $item) {
                    [$net, $len] = array_pad(explode('/', trim($item), 2), 2, '32');
                    if (!isValidIPv4($net)) continue;
                    $size = pow(2, 32 - (int)$len);
                    $start = ipToFloat($net) - fmod(ipToFloat($net), $size);
                    if ($ip >= $start && $ip < $start + $size) {
                        $covered = true;
                        break;
                    }
                }
            }
            if ($covered) {
                $map[$domain] = ['policy' => $l['name'], 'via' => 'list', 'what' => $l['site']];
                break;
            }
        }
    }
    return $map;
}

// "example.com" covers example.com, www.example.com and any other subdomain
function dpiNameCovers($name, $domain) {
    if ($name === '') return false;
    $bare = preg_replace('/^www\./', '', $domain);
    return $name === $domain || $name === $bare || substr($domain, -strlen($name) - 1) === '.' . $name;
}

function doStartDpi(SQLite3 $db, $in) {
    global $php_cli;
    $state = dpiState();
    if ($state && $state['state'] === 'running') fail('The check is already running');
    if (listsCurl() === '') fail('curl is not installed: Service, System checks, "curl"');

    $tests = (array)($in['tests'] ?? []);
    // white SNI are looked for on the hostings the cut test found, so that test always runs with it
    if (in_array('sni', $tests, true)) $tests[] = 'tcp';
    $tests = array_values(array_intersect(DPI_TESTS, $tests));
    if (!$tests) fail('Choose at least one check');
    $mode = (string)($in['mode'] ?? 'isp');
    if (!in_array($mode, ['isp', 'tun', 'both'], true)) fail('Unknown mode');
    $isp = trim((string)($in['isp'] ?? ''));
    $tun = trim((string)($in['tun'] ?? ''));
    if (!isValidInterface($isp) || !isValidInterface($tun)) fail('Invalid interface name');
    if ($mode !== 'isp' && $tun === '') fail('Choose the tunnel interface');

    $source = (string)($in['source'] ?? 'builtin');
    if ($source === 'mine') {
        $domains = dpiMyTargets($db);
    } elseif ($source === 'custom') {
        $domains = [];
        foreach (preg_split('/[\s,]+/', strtolower((string)($in['custom'] ?? ''))) as $name) {
            $name = preg_replace('~^https?://~', '', $name);
            $name = explode('/', $name)[0];
            if ($name === '') continue;
            if (!preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/', $name)) fail("Not a domain: $name");
            $domains[] = $name;
        }
    } else {
        $source = 'builtin';
        $domains = dpiParseList('domains', dpiListText($db, 'domains'));
    }
    $domains = array_values(array_unique($domains));
    if (in_array('domains', $tests, true) && !$domains) fail('No domains to check');
    $lists = dpiLists($db);
    if (in_array('dns', $tests, true) && !$lists['dns'] && !$lists['dns_control']) fail('The DNS list is empty');
    if (in_array('tcp', $tests, true) && !$lists['tcp']) fail('The list of hostings is empty');
    if (in_array('sni', $tests, true) && !$lists['sni']) fail('The list of white SNI is empty');
    if (in_array('tg', $tests, true) && !$lists['tg']) fail('The Telegram list is empty');
    if (count($domains) > 200) fail('At most 200 domains');

    $ifaces = [];
    if ($mode !== 'tun') $ifaces['isp'] = $isp;
    if ($mode !== 'isp') $ifaces['tun'] = $tun;

    jobWrite('dpi', [
        'state' => 'running', 'pid' => 0, 'id' => (string)time(), 'started' => time(),
        'tests' => $tests, 'ifaces' => $ifaces, 'source' => $source, 'domains' => $domains, 'lists' => $lists,
        'step' => $tests[0], 'done' => 0, 'total' => 0, 'stage' => 'Starting',
    ]);
    $cmd = escapeshellarg($php_cli) . ' ' . escapeshellarg(__DIR__ . '/app.php') . ' dpi';
    $pid = (int)trim(execPipelineAsRoot($cmd . ' >/tmp/dns-router-dpi.log 2>&1 & echo $!'));
    if ($pid === 0) {
        dpiProgress(['state' => 'error', 'error' => 'Could not start the check process: check that php-cli is installed']);
        fail('Could not start the check process: check that php-cli is installed', 500);
    }
    return ['success' => true];
}

function doStopDpi() {
    $state = dpiState();
    if (!$state || $state['state'] !== 'running') return ['success' => true];
    dpiProgress(['state' => 'cancelled', 'finished' => time()]);
    return ['success' => true];
}

// ---- running: curl processes side by side

// Runs the curl commands, at most $parallel at once. Each result: exit code, the -w output (one JSON per transfer), stderr.
function dpiCurlMany(array $commands, $parallel, callable $onDone = null) {
    $results = [];
    $running = [];
    $next = 0;
    $keys = array_keys($commands);
    while ($next < count($keys) || $running) {
        while ($next < count($keys) && count($running) < $parallel) {
            $key = $keys[$next++];
            $proc = proc_open($commands[$key], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            stream_set_blocking($pipes[1], false);
            stream_set_blocking($pipes[2], false);
            $running[$key] = ['proc' => $proc, 'out' => $pipes[1], 'err' => $pipes[2], 'stdout' => '', 'stderr' => ''];
        }
        usleep(50000);
        foreach ($running as $key => &$r) {
            $r['stdout'] .= stream_get_contents($r['out']);
            $r['stderr'] .= stream_get_contents($r['err']);
            $status = proc_get_status($r['proc']);
            if ($status['running']) continue;
            $r['stdout'] .= stream_get_contents($r['out']);
            $r['stderr'] .= stream_get_contents($r['err']);
            fclose($r['out']);
            fclose($r['err']);
            proc_close($r['proc']);
            $transfers = [];
            foreach (explode("\n", trim($r['stdout'])) as $line) {
                $one = json_decode($line, true);
                if ($one) $transfers[] = $one;
            }
            // TCP got through: curl -v says so ("Connected to", "Established connection" in newer curl),
            // or its timing has it; on a timeout during TLS the timings stay at zero
            $connected = preg_match('/^\* (Connected to|Established connection)/mi', $r['stderr']) === 1;
            foreach ($transfers as $t) {
                if ((float)($t['time_connect'] ?? 0) > 0) $connected = true;
            }
            $errors = preg_grep('/^curl: \(/', explode("\n", $r['stderr']));
            preg_match_all('/^\*\s+(subject|issuer|start date|expire date):\s*(.+)$/m', $r['stderr'], $m, PREG_SET_ORDER);
            $cert = [];
            foreach ($m as [, $field, $value]) $cert[$field] ??= trim($value);
            $h3 = preg_match('/^< alt-svc:.*\bh3\b/mi', $r['stderr']) === 1;
            $results[$key] = ['code' => $status['exitcode'], 'transfers' => $transfers, 'connected' => $connected, 'cert' => $cert, 'h3' => $h3, 'stderr' => trim(implode(' ', $errors))];
            unset($running[$key]);
            if ($onDone) $onDone();
        }
        unset($r);
    }
    return $results;
}

// The common start of every curl call; $iface '' leaves the router's own routing
function dpiCurl($iface, $timeout) {
    return array_merge([listsCurl()], dpiCurlOptions($iface, $timeout));
}

function dpiCurlOptions($iface, $timeout) {
    $options = ['-sSv', '--noproxy', '*', '--connect-timeout', '8', '-m', (string)$timeout, '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', '-w', '%{json}\n'];
    if ($iface !== '') array_push($options, '--interface', $iface);
    return $options;
}

// --rate (curl 7.84+) keeps 50 ms between the starts of the requests
function dpiCurlHasRate() {
    static $has = null;
    return $has ??= strpos((string)shell_exec(escapeshellarg(listsCurl()) . ' --help all 2>/dev/null'), '--rate') !== false;
}

// One HTTP or TLS attempt reduced to a short code for the table.
// class: ok, rst (reset), to (no answer), mitm (foreign certificate or provider page), na (not a verdict)
function dpiClassify(array $t, $domain, $tls) {
    $code = (int)($t['exitcode'] ?? 0);
    $msg = (string)($t['errormsg'] ?? '');
    $http = (int)($t['http_code'] ?? 0);
    $connected = !empty($t['connected']);
    $handshake = (float)($t['time_appconnect'] ?? 0) > 0;
    $ms = (int)round(((float)($t['time_total'] ?? 0)) * 1000);
    if ($code === 0) {
        $redirect = (string)($t['redirect_url'] ?? '');
        $host = strtolower((string)parse_url($redirect, PHP_URL_HOST));
        if ($host !== '' && preg_match('/(^|\.)(rt\.ru|rkn\.gov\.ru|eais\.rkn\.gov\.ru)$|block|zapret|warning|blackhole|restrict/', $host)) {
            return ['class' => 'mitm', 'code' => 'STUB', 'note' => 'Redirect to ' . $host];
        }
        $note = $http . ', ' . $ms . ' ms' . ($redirect !== '' ? ' → ' . $redirect : '');
        return ['class' => 'ok', 'code' => $tls ? 'OK' : (string)$http, 'note' => $note];
    }
    if ($code === 60 || $code === 51) {
        $what = preg_match('/does not match|no alternative certificate subject name/i', $msg) ? 'Certificate is not for ' . $domain : 'Untrusted certificate';
        return ['class' => 'mitm', 'code' => 'CERT', 'note' => $what . ': ' . $msg];
    }
    if (stripos($msg, 'reset') !== false) {
        return ['class' => 'rst', 'code' => 'RST', 'note' => ($handshake || !$tls ? 'Reset after the request' : 'Reset during the TLS handshake') . ', ' . $ms . ' ms'];
    }
    if ($code === 28) {
        if (!$connected) return ['class' => 'to', 'code' => 'TIMEOUT', 'note' => 'No TCP connection'];
        if ($tls && !$handshake) return ['class' => 'to', 'code' => 'TIMEOUT', 'note' => 'The TLS handshake did not finish: packets are dropped'];
        return ['class' => 'to', 'code' => 'TIMEOUT', 'note' => 'Connected, but no answer came'];
    }
    if ($code === 35 && preg_match('/protocol version|unsupported protocol|no protocols available|wrong version/i', $msg)) {
        return ['class' => 'na', 'code' => 'N/A', 'note' => 'The site does not offer this TLS version'];
    }
    if ($code === 35) return ['class' => 'rst', 'code' => 'TLS', 'note' => 'TLS error: ' . $msg];
    if ($code === 52) return ['class' => 'rst', 'code' => 'EMPTY', 'note' => 'The connection closed without an answer'];
    if ($code === 7) return ['class' => 'to', 'code' => 'CONN', 'note' => $msg];
    if ($code === 6) return ['class' => 'na', 'code' => 'DNS', 'note' => $msg];
    return ['class' => 'rst', 'code' => 'ERR ' . $code, 'note' => $msg];
}

// ---- DNS: own UDP and DoT queries, DoH through curl

function dnsQueryPacket($name, $id) {
    $packet = pack('nnnnnn', $id, 0x0100, 1, 0, 0, 0);
    foreach (explode('.', $name) as $label) $packet .= chr(strlen($label)) . $label;
    return $packet . "\0" . pack('nn', 1, 1);
}

// The A records of an answer; null when the answer is broken
// The A records of an answer, or the name of its error code (NXDOMAIN: "no such name"); 'ERR' when the answer is broken
function dnsAnswerIps($data) {
    if (strlen($data) < 12) return 'ERR';
    $head = unpack('nid/nflags/nqd/nan', substr($data, 0, 8));
    $rcode = $head['flags'] & 0xF;
    if ($rcode !== 0) return DNS_RCODES[$rcode] ?? 'RCODE ' . $rcode;
    $pos = 12;
    for ($i = 0; $i < $head['qd']; $i++) $pos = dnsSkipName($data, $pos) + 4;
    $ips = [];
    for ($i = 0; $i < $head['an'] && $pos < strlen($data); $i++) {
        $pos = dnsSkipName($data, $pos);
        $rr = unpack('ntype/nclass/Nttl/nlen', substr($data, $pos, 10));
        $pos += 10;
        if ($rr['type'] === 1 && $rr['len'] === 4) $ips[] = inet_ntop(substr($data, $pos, 4));
        $pos += $rr['len'];
    }
    return $ips;
}

const DNS_RCODES = [1 => 'FORMERR', 2 => 'SERVFAIL', 3 => 'NXDOMAIN', 4 => 'NOTIMP', 5 => 'REFUSED'];

function dnsSkipName($data, $pos) {
    while ($pos < strlen($data)) {
        $len = ord($data[$pos]);
        if ($len === 0) return $pos + 1;
        if ($len >= 0xC0) return $pos + 2;
        $pos += $len + 1;
    }
    return $pos;
}

// Answer of one server over UDP: list of IPs, or a string with the error
function dpiDnsUdp($server, $name) {
    $sock = @stream_socket_client('udp://' . $server . ':53', $errno, $error, 3);
    if (!$sock) return 'ERR';
    stream_set_timeout($sock, 3);
    fwrite($sock, dnsQueryPacket($name, random_int(1, 65535)));
    $data = fread($sock, 1500);
    fclose($sock);
    if ($data === '' || $data === false) return 'TIMEOUT';
    return dnsAnswerIps($data);
}

function dpiDnsDot($server, $peer, $name) {
    if (!extension_loaded('openssl')) return 'N/A';
    $ctx = stream_context_create(['ssl' => ['peer_name' => $peer, 'verify_peer' => true]]);
    $sock = @stream_socket_client('tls://' . $server . ':853', $errno, $error, 5, STREAM_CLIENT_CONNECT, $ctx);
    if (!$sock) return stripos($error, 'reset') !== false ? 'RST' : 'TIMEOUT';
    stream_set_timeout($sock, 5);
    $packet = dnsQueryPacket($name, random_int(1, 65535));
    fwrite($sock, pack('n', strlen($packet)) . $packet);
    $len = fread($sock, 2);
    $data = strlen($len) === 2 ? fread($sock, unpack('n', $len)[1]) : '';
    fclose($sock);
    if ($data === '' || $data === false) return 'TIMEOUT';
    return dnsAnswerIps($data);
}

// Cloudflare's JSON DoH for many names at once: list of IPs, or the error code
function dpiDnsDohMany(array $names, $iface) {
    $commands = [];
    $files = [];
    foreach ($names as $name) {
        $files[$name] = tempnam(sys_get_temp_dir(), 'krdoh_');
        $cmd = dpiCurl($iface, 8);
        array_push($cmd, '-H', 'accept: application/dns-json', '-o', $files[$name], 'https://cloudflare-dns.com/dns-query?type=A&name=' . rawurlencode($name));
        $commands[$name] = $cmd;
    }
    $out = [];
    foreach (dpiCurlMany($commands, 8) as $name => $r) {
        $body = json_decode((string)file_get_contents($files[$name]), true);
        @unlink($files[$name]);
        if ($r['code'] !== 0 || !is_array($body)) {
            $out[$name] = stripos($r['stderr'], 'reset') !== false ? 'RST' : ($r['code'] === 28 ? 'TIMEOUT' : 'ERR');
            continue;
        }
        $status = (int)($body['Status'] ?? 0);
        if ($status !== 0) {
            $out[$name] = DNS_RCODES[$status] ?? 'RCODE ' . $status;
            continue;
        }
        $ips = [];
        foreach ((array)($body['Answer'] ?? []) as $answer) {
            if ((int)($answer['type'] ?? 0) === 1) $ips[] = (string)$answer['data'];
        }
        $out[$name] = $ips;
    }
    return $out;
}

function dpiIspDns() {
    foreach ((array)(rciGet('/rci/show/ip/name-server')['server'] ?? []) as $s) {
        $ip = (string)($s['address'] ?? '');
        if (isValidIPv4($ip) && strpos($ip, '127.') !== 0 && (int)($s['port'] ?? 53) === 53) return $ip;
    }
    return '';
}

function dpiBogusIp($ip) {
    return $ip === '0.0.0.0' || preg_match('/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/', $ip) === 1;
}

// ---- the checks

// ISP resolver, Google over UDP, Cloudflare DoH and Quad9 DoT for the usual blocked names; the router's own route
function dpiTestDns(array $lists) {
    $names = array_values(array_unique(array_merge($lists['dns'], $lists['dns_control'])));
    $isp = dpiIspDns();
    dpiProgress(['stage' => 'DoH', 'done' => 0, 'total' => count($names)]);
    $doh = dpiDnsDohMany($names, '');
    $answers = [];
    foreach ($names as $n => $name) {
        dpiProgress(['stage' => $name, 'done' => $n]);
        $answers[$name] = [
            'isp'    => $isp === '' ? 'N/A' : dpiDnsUdp($isp, $name),
            'google' => dpiDnsUdp('8.8.8.8', $name),
            'doh'    => $doh[$name],
            'dot'    => dpiDnsDot('9.9.9.9', 'dns.quad9.net', $name),
        ];
    }
    // an address the provider gives to several different blocked names is its stub
    $seen = [];
    foreach ($answers as $name => $a) {
        foreach (['isp', 'google'] as $key) {
            if (!is_array($a[$key])) continue;
            foreach ($a[$key] as $ip) $seen[$ip][$name] = true;
        }
    }
    $rows = [];
    foreach ($answers as $name => $a) {
        $truth = is_array($a['doh']) && $a['doh'] ? $a['doh'] : (is_array($a['dot']) ? $a['dot'] : []);
        $cells = [];
        $spoofed = [];
        foreach ($a as $key => $value) {
            $checked = in_array($key, ['isp', 'google'], true) && $truth;
            if (is_array($value)) {
                $fake = $checked && !array_intersect($value, $truth);
                if ($fake && $value) {
                    $fake = false;
                    foreach ($value as $ip) {
                        if (dpiBogusIp($ip) || count($seen[$ip]) > 1) $fake = true;
                    }
                }
                $shown = $value ? $value[0] . (count($value) > 1 ? ' +' . (count($value) - 1) : '') : 'NODATA';
                $note = $value ? 'Answer: ' . implode(', ', $value) : 'The name exists, but has no IPv4 address';
                if ($fake) $note .= "\n" . 'DoH gives: ' . implode(', ', $truth);
                $cells[$key] = ['class' => $fake ? 'mitm' : 'ok', 'code' => $shown, 'note' => $note];
            } elseif ($value === 'NXDOMAIN') {
                $fake = $checked;
                $cells[$key] = ['class' => $fake ? 'mitm' : 'na', 'code' => 'NXDOMAIN', 'note' => 'NXDOMAIN: the server says there is no such name' . ($fake ? "\n" . 'DoH gives: ' . implode(', ', $truth) : '')];
            } else {
                $fake = false;
                $notes = ['TIMEOUT' => 'No answer: the query is lost or dropped on the way', 'RST' => 'The connection was reset', 'ERR' => 'The answer could not be read'];
                if ($value === 'N/A') $notes['N/A'] = $key === 'dot' ? 'The PHP OpenSSL module is not installed: Service, System checks' : 'The provider DNS is unknown';
                $cells[$key] = ['class' => $value === 'N/A' ? 'na' : ($value === 'TIMEOUT' ? 'to' : 'rst'), 'code' => $value, 'note' => $notes[$value] ?? 'The server answered with an error: ' . $value];
            }
            if ($fake) $spoofed[] = $key;
        }
        $text = [];
        if (in_array('google', $spoofed, true)) $text[] = 'UDP 53 is intercepted';
        elseif (in_array('isp', $spoofed, true)) $text[] = 'The provider spoofs the answer';
        if (!in_array('google', $spoofed, true) && !is_array($a['google']) && $truth) $text[] = '8.8.8.8 does not answer';
        if (!is_array($a['doh'])) $text[] = 'DoH is blocked';
        if (!is_array($a['dot']) && $a['dot'] !== 'N/A') $text[] = 'DoT is closed';
        $level = $spoofed ? 'block' : ($text ? 'partial' : 'ok');
        $rows[] = ['domain' => $name, 'control' => in_array($name, $lists['dns_control'], true), 'cells' => $cells, 'level' => $level, 'verdict' => $text ? implode('; ', $text) : 'Matches'];
    }
    $doh = gethostbyname('cloudflare-dns.com');
    $routes = [
        'isp'    => $isp === '' ? '' : dpiRouteDev($isp),
        'google' => dpiRouteDev('8.8.8.8'),
        'doh'    => isValidIPv4($doh) ? dpiRouteDev($doh) : '',
        'dot'    => dpiRouteDev('9.9.9.9'),
    ];
    return ['isp_server' => $isp, 'routes' => $routes, 'rows' => $rows];
}

// The interface the router's own packets to $ip leave through
function dpiRouteDev($ip) {
    return preg_match('/\bdev\s+(\S+)/', execReadOnly(['ip', 'route', 'get', $ip]), $m) ? $m[1] : '';
}


// HTTP, TLS 1.2 and TLS 1.3 to the real address of each domain, through every chosen interface
function dpiTestDomains(array $domains, array $ifaces, callable $partial) {
    dpiProgress(['stage' => 'Resolving', 'done' => 0, 'total' => count($domains)]);
    $doh = dpiDnsDohMany($domains, '');
    $isp = dpiIspDns();
    $rows = [];
    foreach ($domains as $domain) {
        $ips = is_array($doh[$domain]) ? $doh[$domain] : [];
        if (!$ips) {
            $udp = dpiDnsUdp('8.8.8.8', $domain);
            $ips = is_array($udp) ? $udp : [];
        }
        $dnsNote = '';
        if ($isp !== '' && $ips) {
            $own = dpiDnsUdp($isp, $domain);
            if ($own === 'NXDOMAIN') $dnsNote = 'NXDOMAIN';
            if (is_array($own) && !array_intersect($own, $ips) && (!$own || dpiBogusIp($own[0]))) $dnsNote = $own ? $own[0] : 'NODATA';
        }
        $rows[$domain] = ['domain' => $domain, 'ip' => $ips[0] ?? '', 'dns' => $dnsNote, 'h3' => false, 'cells' => [], 'level' => 'pending', 'verdict' => 'Checking…'];
    }
    // a row gets its verdict as soon as all its HTTP/TLS answers are in; the page shows the rows while they fill
    $settle = function () use (&$rows, $ifaces) {
        foreach ($rows as $domain => $row) {
            $complete = true;
            foreach ($ifaces as $key => $iface) {
                if (count(array_intersect_key($row['cells'][$key] ?? [], ['http' => 1, 'tls12' => 1, 'tls13' => 1])) < 3) $complete = false;
            }
            if ($row['ip'] !== '' && !$complete) continue;
            [$level, $text] = dpiDomainVerdict($row, array_keys($ifaces));
            $rows[$domain]['level'] = $level;
            $rows[$domain]['verdict'] = $text;
        }
        return array_values($rows);
    };
    $partial($settle());

    $kinds = ['http' => [80, 'http', []], 'tls12' => [443, 'https', ['--tlsv1.2', '--tls-max', '1.2']], 'tls13' => [443, 'https', ['--tlsv1.3']]];
    $commands = [];
    foreach ($rows as $domain => $row) {
        if ($row['ip'] === '') continue;
        foreach ($ifaces as $key => $iface) {
            foreach ($kinds as $kind => [$port, $scheme, $extra]) {
                $cmd = array_merge(dpiCurl($iface, 10), $extra, ['-I', '-o', '/dev/null', '--resolve', "$domain:$port:{$row['ip']}", "$scheme://$domain/"]);
                $commands["$domain|$key|$kind"] = $cmd;
            }
        }
    }
    $done = 0;
    dpiProgress(['stage' => 'HTTP / TLS', 'done' => 0, 'total' => count($commands)]);
    foreach (array_chunk($commands, 24, true) as $chunk) {
        if (dpiCancelled()) break;
        $results = dpiCurlMany($chunk, 8, function () use (&$done) {
            $done++;
            if ($done % 4 === 0) dpiProgress(['done' => $done]);
        });
        foreach ($results as $k => $r) {
            [$domain, $key, $kind] = explode('|', $k);
            $t = ($r['transfers'][0] ?? ['exitcode' => $r['code'], 'errormsg' => $r['stderr']]) + ['connected' => $r['connected']];
            $rows[$domain]['cells'][$key][$kind] = dpiClassify($t, $domain, $kind !== 'http');
            if ($r['h3']) $rows[$domain]['h3'] = true;
        }
        $partial($settle());
    }
    dpiCertDetails($rows, $ifaces, $kinds);
    dpiQuicCells($rows, $ifaces, fn() => $partial($settle()));
    return $settle();
}

// For every CERT cell: the same request again without the check, to see the certificate the server really gives.
// A certificate of the site itself that only misses this exact name (*.googlevideo.com for googlevideo.com) is not a block.
function dpiCertDetails(array &$rows, array $ifaces, array $kinds) {
    $commands = [];
    foreach ($rows as $domain => $row) {
        foreach ($row['cells'] as $key => $cells) {
            foreach ($cells as $kind => $cell) {
                if ($cell['code'] !== 'CERT') continue;
                [$port, $scheme, $extra] = $kinds[$kind];
                $commands["$domain|$key|$kind"] = array_merge(dpiCurl($ifaces[$key], 10), $extra, ['-k', '-I', '-o', '/dev/null', '--resolve', "$domain:$port:{$row['ip']}", "$scheme://$domain/"]);
            }
        }
    }
    if (!$commands) return;
    dpiProgress(['stage' => 'Certificates']);
    foreach (dpiCurlMany($commands, 8) as $k => $r) {
        [$domain, $key, $kind] = explode('|', $k);
        $info = dpiCertInfo($r);
        if (!$info) continue;
        $cell = &$rows[$domain]['cells'][$key][$kind];
        $cell['cert'] = $info;
        $lines = [];
        if ($info['subject'] !== '') $lines[] = 'Certificate: ' . $info['subject'];
        if ($info['issuer'] !== '') $lines[] = 'Issued by: ' . $info['issuer'];
        if ($info['names']) $lines[] = 'Names: ' . implode(', ', array_slice($info['names'], 0, 8)) . (count($info['names']) > 8 ? ' +' . (count($info['names']) - 8) : '');
        if ($info['until'] !== '') $lines[] = 'Valid until: ' . $info['until'];
        if (dpiNameMismatch($cell['note']) && dpiCertSameSite($info, $domain)) {
            $cell['class'] = 'na';
            $cell['code'] = 'NAME';
            $cell['note'] = 'The certificate of the site itself, but the name ' . $domain . ' is not in it: not a block';
        }
        $cell['note'] .= "\n" . implode("\n", $lines);
        unset($cell);
    }
}

// Subject, issuer, names and dates of the server's own certificate: from %{certs} (curl 7.88+) or from the -v lines
function dpiCertInfo(array $r) {
    $certs = (string)($r['transfers'][0]['certs'] ?? '');
    $info = ['subject' => '', 'issuer' => '', 'names' => [], 'until' => ''];
    if ($certs !== '') {
        $first = explode('-----END CERTIFICATE-----', $certs)[0];
        if (preg_match('/^Subject:\s*(.+)$/m', $first, $m)) $info['subject'] = trim($m[1]);
        if (preg_match('/^Issuer:\s*(.+)$/m', $first, $m)) $info['issuer'] = trim($m[1]);
        if (preg_match('/^Expire date:\s*(.+)$/m', $first, $m)) $info['until'] = trim($m[1]);
        if (preg_match('/^X509v3 Subject Alternative Name:\s*(.+)$/m', $first, $m)) {
            preg_match_all('/DNS:([^,\s]+)/', $m[1], $names);
            $info['names'] = $names[1];
        }
    } else {
        $info['subject'] = $r['cert']['subject'] ?? '';
        $info['issuer'] = $r['cert']['issuer'] ?? '';
        $info['until'] = $r['cert']['expire date'] ?? '';
    }
    if ($info['subject'] === '' && $info['issuer'] === '') return null;
    return $info;
}

// Only a wrong name; a broken chain (self-signed, unknown issuer) is a different story even with the right name
function dpiNameMismatch($text) {
    return preg_match('/does not match|no alternative certificate subject name/i', $text) === 1;
}

function dpiCertSameSite(array $info, $domain) {
    $names = $info['names'];
    if (preg_match('/CN\s*=\s*([^,\/]+)/', $info['subject'], $m)) $names[] = trim($m[1]);
    $bare = preg_replace('/^www\./', '', $domain);
    foreach ($names as $name) {
        $base = strtolower(preg_replace('/^\*\./', '', $name));
        if ($base === $domain || $base === $bare || substr($base, -strlen($bare) - 1) === '.' . $bare || substr($domain, -strlen($base) - 1) === '.' . $base) return true;
    }
    return false;
}

// QUIC to every domain through every interface. Silence means a block only when the site has QUIC at all:
// it offers HTTP/3 in alt-svc, or it answered QUIC through another route. Otherwise silence says nothing ("—").
function dpiQuicCells(array &$rows, array $ifaces, callable $after) {
    $jobs = [];
    foreach ($rows as $domain => $row) {
        if ($row['ip'] === '') continue;
        foreach ($ifaces as $key => $iface) $jobs["$domain|$key"] = [$row['ip'], $domain, $iface];
    }
    if (!$jobs || dpiCancelled()) return;
    dpiProgress(['stage' => 'QUIC', 'done' => 0, 'total' => count($jobs)]);
    $done = 0;
    $quiet = ['class' => 'na', 'code' => '—', 'note' => 'No answer over UDP 443 through any route: the site probably has no HTTP/3'];
    foreach (array_chunk($jobs, 16, true) as $chunk) {
        foreach (quicProbeMany($chunk) as $k => $cell) {
            [$domain, $key] = explode('|', $k);
            if ($cell['class'] === 'ok' && isset($cell['ms'])) $cell['note'] .= ', ' . $cell['ms'] . ' ms';
            $rows[$domain]['quic'][$key] = $cell;
            $rows[$domain]['cells'][$key]['quic'] = $cell['code'] === 'TIMEOUT' ? $quiet : $cell;
        }
        $done += count($chunk);
        dpiProgress(['done' => $done]);
        $after();
    }
    foreach ($rows as $domain => $row) {
        if (empty($row['quic'])) continue;
        $answeredBy = [];
        foreach ($row['quic'] as $key => $cell) {
            if ($cell['code'] !== 'TIMEOUT' && $cell['code'] !== 'N/A') $answeredBy[] = $key;
        }
        foreach ($row['quic'] as $key => $cell) {
            if ($cell['code'] !== 'TIMEOUT') continue;
            if ($row['h3']) $note = 'The site offers HTTP/3, but nothing came back over UDP 443: QUIC is dropped';
            elseif ($answeredBy) $note = 'QUIC answers through ' . implode(', ', array_map(fn($k) => $ifaces[$k] !== '' ? $ifaces[$k] : 'the main route', $answeredBy)) . ', but not here: QUIC is dropped';
            else continue;
            $rows[$domain]['cells'][$key]['quic'] = ['class' => 'to', 'code' => 'TIMEOUT', 'note' => $note];
        }
        unset($rows[$domain]['quic']);
    }
}

function dpiDomainVerdict(array $row, array $keys) {
    if ($row['ip'] === '') return ['down', 'The name does not resolve'];
    $bad = [];
    foreach ($keys as $key) {
        $bad[$key] = [];
        foreach ((array)($row['cells'][$key] ?? []) as $kind => $cell) {
            if ($kind !== 'quic' && in_array($cell['class'], ['rst', 'to', 'mitm'], true)) $bad[$key][$kind] = $cell['class'];
        }
    }
    $quicDropped = ($row['cells'][$keys[0]]['quic']['class'] ?? '') === 'to';
    $first = $keys[0];
    $tlsBad = array_intersect_key($bad[$first], ['tls12' => 1, 'tls13' => 1]);
    $tunnelOk = isset($bad['tun']) && !array_intersect_key($bad['tun'], ['tls12' => 1, 'tls13' => 1]);
    $dns = $row['dns'] !== '' ? 'DNS + ' : '';

    if (!$bad[$first] && $quicDropped) return ['partial', $dns . 'Only QUIC is blocked'];
    if (!$bad[$first]) return $row['dns'] !== '' ? ['partial', 'Only DNS is spoofed'] : ['ok', 'Available'];
    if (in_array('mitm', $bad[$first], true)) $verdict = ['stub', $dns . 'Provider stub'];
    elseif (count($tlsBad) === 2 && !in_array('to', $tlsBad, true)) $verdict = ['block', $dns . 'Blocked by SNI'];
    elseif (count($tlsBad) === 2 && !in_array('rst', $tlsBad, true)) $verdict = ['block', $dns . 'Dropped or throttled'];
    elseif (count($tlsBad) === 2) $verdict = ['block', $dns . 'Blocked'];
    elseif (isset($tlsBad['tls13'])) $verdict = ['partial', $dns . 'Partly (TLS 1.3)'];
    elseif (isset($tlsBad['tls12'])) $verdict = ['partial', $dns . 'Partly (TLS 1.2)'];
    else $verdict = ['partial', $dns . 'Only HTTP is blocked'];

    if ($first === 'isp' && isset($bad['tun']) && !$tunnelOk && count($tlsBad) === 2) return ['down', 'Unreachable everywhere'];
    return $verdict;
}

function dpiTcpUrl($host, $port) {
    $scheme = $port === 80 ? 'http' : 'https';
    return in_array($port, [80, 443], true) ? "$scheme://$host/" : "$scheme://$host:$port/";
}

// One plain request before the test: its time gives the read timeout of the test, 3 x that time, from 1.5 to 12 s
function dpiTcpProbe($iface, $ip, $port, $host) {
    return array_merge(dpiCurl($iface, 12), ['-k', '--resolve', "$host:$port:$ip", '-o', '/dev/null', dpiTcpUrl($host, $port)]);
}

function dpiTcpTimeout(array $probe) {
    $time = (float)($probe['transfers'][0]['time_total'] ?? 12);
    return round(min(max($time * 3, 1.5), 12), 1);
}

// A keep-alive connection with requests padded to ~4 KB each: the filter freezes it after 16-20 KB.
// Every request is its own --next part, so the first two wait 12 s and the rest only $timeout; curl keeps the connection between the parts.
function dpiTcpCommand($iface, $ip, $port, $host, $pad, $timeout) {
    $cmd = [listsCurl(), '--fail-early'];
    if (dpiCurlHasRate()) array_push($cmd, '--rate', '20/s');
    for ($i = 0; $i < DPI_TCP_STEPS; $i++) {
        if ($i > 0) $cmd[] = '--next';
        $cmd = array_merge($cmd, dpiCurlOptions($iface, $i < 2 ? 12 : $timeout), ['-k', '--resolve', "$host:$port:$ip", '-H', 'X-Pad: ' . $pad, '-o', '/dev/null', dpiTcpUrl($host, $port)]);
    }
    return $cmd;
}

// How far the bytes went on one connection before it stopped
function dpiTcpResult(array $r) {
    $conn = 0;
    $max = 0;
    $passed = 0;
    foreach ($r['transfers'] as $n => $t) {
        if ((int)($t['num_connects'] ?? 0) > 0) $conn = 0;
        $sent = (int)($t['size_request'] ?? 0) + (int)($t['size_header'] ?? 0) + (int)($t['size_download'] ?? 0);
        if ((int)($t['exitcode'] ?? 0) !== 0) {
            $at = $conn + $sent;
            $kb = round($at / 1024, 1);
            $how = stripos((string)$t['errormsg'], 'reset') !== false ? 'reset' : 'frozen';
            if ($n === 0 && !$r['connected']) return ['verdict' => 'down', 'kb' => 0, 'note' => (string)$t['errormsg']];
            if ($at >= DPI_CUT_MIN && $at <= DPI_CUT_MAX) return ['verdict' => 'cut', 'kb' => $kb, 'note' => "Connection $how after $kb KB"];
            return ['verdict' => 'fail', 'kb' => $kb, 'note' => "Connection $how after $kb KB: " . $t['errormsg']];
        }
        $conn += $sent;
        $max = max($max, $conn);
        $passed++;
    }
    if (!$r['transfers']) return ['verdict' => 'down', 'kb' => 0, 'note' => $r['stderr']];
    return ['verdict' => 'ok', 'kb' => round($max / 1024, 1), 'note' => "$passed requests passed"];
}

function dpiPad() {
    $letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    $pad = '';
    for ($i = 0; $i < DPI_TCP_PAD; $i++) $pad .= $letters[random_int(0, 61)];
    return $pad;
}

// $defaultSni goes to the targets without their own sni; '' sends no SNI at all (the request goes to the bare IP)
function dpiTestTcp(array $ifaces, array $targets, $defaultSni, callable $partial) {
    $pad = dpiPad();
    $list = $targets;
    $targets = [];
    foreach ($list as $n => [$id, $asn, $provider, $ip, $port, $sni]) {
        foreach ($ifaces as $key => $iface) {
            $targets["$n|$key"] = [$iface, $ip, $port, $sni !== '' ? $sni : ($defaultSni !== '' ? $defaultSni : $ip)];
        }
    }
    $done = 0;
    $tick = function () use (&$done) {
        $done++;
        if ($done % 5 === 0) dpiProgress(['done' => $done]);
    };
    dpiProgress(['stage' => 'Hostings', 'done' => 0, 'total' => count($targets) * 2]);

    $probes = [];
    foreach (array_chunk($targets, 20, true) as $chunk) {
        if (dpiCancelled()) break;
        $commands = [];
        foreach ($chunk as $k => [$iface, $ip, $port, $host]) $commands[$k] = dpiTcpProbe($iface, $ip, $port, $host);
        $probes += dpiCurlMany($commands, 10, $tick);
    }

    // a hosting that did not answer the plain request is not tested further
    $results = [];
    $build = function () use ($list, $ifaces, &$results) {
        $rows = [];
        foreach ($list as $n => [$id, $asn, $provider, $ip, $port, $sni]) {
            $row = ['id' => $id, 'asn' => $asn, 'provider' => $provider, 'ip' => $ip, 'port' => $port, 'res' => []];
            foreach ($ifaces as $key => $iface) {
                if (isset($results["$n|$key"])) $row['res'][$key] = $results["$n|$key"];
            }
            $rows[] = $row;
        }
        return $rows;
    };
    $timeouts = [];
    $commands = [];
    foreach ($probes as $k => $probe) {
        if ($probe['code'] !== 0) {
            $results[$k] = dpiTcpResult($probe);
            $done++;
            continue;
        }
        [$iface, $ip, $port, $host] = $targets[$k];
        $timeouts[$k] = dpiTcpTimeout($probe);
        $commands[$k] = dpiTcpCommand($iface, $ip, $port, $host, $pad, $timeouts[$k]);
    }
    $partial($build());
    foreach (array_chunk($commands, 20, true) as $chunk) {
        if (dpiCancelled()) break;
        foreach (dpiCurlMany($chunk, 10, $tick) as $k => $r) {
            $results[$k] = dpiTcpResult($r) + ['timeout' => $timeouts[$k]];
        }
        $partial($build());
    }

    return $build();
}

// For the hostings that cut the connection: which Russian names in SNI get through
function dpiTestSni(array $tcp, array $ifaces, array $names, callable $partial) {
    $key = array_key_first($ifaces);
    $groups = [];
    foreach ($tcp as $row) {
        $group = $row['asn'] !== '' ? $row['asn'] : $row['provider'];
        if ($row['port'] !== 443 || ($row['res'][$key]['verdict'] ?? '') !== 'cut' || isset($groups[$group])) continue;
        $groups[$group] = ['asn' => $row['asn'], 'provider' => $row['provider'], 'ip' => $row['ip'], 'timeout' => $row['res'][$key]['timeout'], 'base' => $row['res'][$key], 'results' => []];
    }
    $groups = array_slice($groups, 0, DPI_SNI_GROUPS, true);
    foreach ($groups as &$group) {
        $group['names'] = $names;
        $group['active'] = false;
    }
    unset($group);
    $partial(array_values($groups));
    $pad = dpiPad();
    $done = 0;
    dpiProgress(['stage' => 'SNI', 'done' => 0, 'total' => count($groups) * count($names)]);
    // every name on every hosting: what does not pass matters as much as what does
    foreach ($groups as &$group) {
        dpiProgress(['stage' => $group['provider']]);
        $group['active'] = true;
        foreach (array_chunk($names, 8) as $batch) {
            if (dpiCancelled()) break 2;
            $commands = [];
            foreach ($batch as $sni) $commands[$sni] = dpiTcpCommand($ifaces[$key], $group['ip'], 443, $sni, $pad, $group['timeout']);
            foreach (dpiCurlMany($commands, 8) as $sni => $r) {
                $result = dpiTcpResult($r);
                $group['results'][] = ['sni' => (string)$sni, 'verdict' => $result['verdict'], 'kb' => $result['kb'], 'note' => $result['note']];
            }
            $done += count($batch);
            dpiProgress(['done' => $done]);
            $partial(array_values($groups));
        }
        $group['active'] = false;
    }
    unset($group);
    return array_values($groups);
}

// Telegram: TCP to the data centers and 5 MB of a file from telegram.org
function dpiTestTelegram(array $ifaces, array $dcs) {
    $commands = [];
    foreach ($ifaces as $key => $iface) {
        foreach ($dcs as [$name, $ip]) {
            $commands["$name|$key"] = array_merge(dpiCurl($iface, 6), ['-o', '/dev/null', "http://$ip:443/"]);
        }
        $commands["file|$key"] = array_merge(dpiCurl($iface, 25), ['-o', '/dev/null', '-r', '0-4999999', 'https://telegram.org/img/Telegram200million.png']);
    }
    dpiProgress(['stage' => 'Telegram', 'done' => 0, 'total' => count($commands)]);
    $results = dpiCurlMany($commands, 6);
    $rows = [];
    foreach ($dcs as [$name, $ip]) {
        $row = ['name' => $name, 'ip' => $ip, 'res' => []];
        foreach ($ifaces as $key => $iface) {
            $t = $results["$name|$key"]['transfers'][0] ?? [];
            $ms = (int)round((float)($t['time_connect'] ?? 0) * 1000);
            $row['res'][$key] = $results["$name|$key"]['connected']
                ? ['class' => 'ok', 'code' => $ms > 0 ? $ms . ' ms' : 'OK', 'note' => 'TCP connection made']
                : ['class' => 'to', 'code' => 'TIMEOUT', 'note' => (string)($t['errormsg'] ?? $results["$name|$key"]['stderr'])];
        }
        $rows[] = $row;
    }
    $file = [];
    foreach ($ifaces as $key => $iface) {
        $t = $results["file|$key"]['transfers'][0] ?? [];
        $size = (int)($t['size_download'] ?? 0);
        $speed = (int)($t['speed_download'] ?? 0);
        $file[$key] = $size >= 5000000
            ? ['class' => 'ok', 'code' => round($speed / 1048576, 1) . ' MB/s', 'note' => '5 MB in ' . round((float)$t['time_total'], 1) . ' s']
            : ['class' => $size > 0 ? 'to' : 'rst', 'code' => round($size / 1024) . ' KB', 'note' => 'Stopped: ' . ($t['errormsg'] ?? '')];
    }
    return ['dcs' => $rows, 'file' => $file];
}

function dpiSummary(array $run) {
    $s = ['blocked' => 0, 'fixed' => 0, 'down' => 0, 'dns' => 0, 'cut' => 0];
    foreach ($run['domains'] as $row) {
        if (in_array($row['level'], ['ok', 'pending'], true) || $row['verdict'] === 'Only QUIC is blocked') continue;
        if ($row['level'] === 'down') {
            $s['down']++;
            continue;
        }
        $s['blocked']++;
        $tun = $row['cells']['tun'] ?? null;
        if ($tun && !array_filter($tun, fn($c, $kind) => $kind !== 'quic' && in_array($c['class'], ['rst', 'to', 'mitm'], true), ARRAY_FILTER_USE_BOTH)) $s['fixed']++;
    }
    foreach ($run['dns']['rows'] ?? [] as $row) {
        if ($row['level'] === 'block') $s['dns']++;
    }
    $first = array_key_first($run['ifaces']);
    foreach ($run['tcp'] as $row) {
        if (($row['res'][$first]['verdict'] ?? '') === 'cut') $s['cut']++;
    }
    return $s;
}

// The body of "app.php dpi" (root)
function dpiRun(SQLite3 $db) {
    ini_set('memory_limit', '64M');
    set_time_limit(0);
    $state = jobRead('dpi');
    if (!$state || $state['state'] !== 'running') return;
    dpiProgress(['pid' => getmypid()]);
    $id = $state['id'];
    register_shutdown_function(function () use ($id) {
        $now = jobRead('dpi');
        if (!$now || $now['id'] !== $id || $now['state'] !== 'running') return;
        $error = error_get_last();
        dpiProgress(['state' => 'error', 'error' => $error ? $error['message'] : 'The check process stopped unexpectedly', 'finished' => time()]);
    });

    $ifaces = $state['ifaces'];
    $run = ['id' => $id, 'started' => $state['started'], 'finished' => 0, 'ifaces' => $ifaces, 'tests' => $state['tests'], 'source' => $state['source'],
            'dns' => null, 'domains' => [], 'tcp' => [], 'tcp_sni' => $state['lists']['tcp_sni'] ?? 'example.com', 'sni' => null, 'tg' => null, 'summary' => []];
    $lists = $state['lists'];

    // the run is on disk from the start with every row waiting, so the page lists what will be checked at once
    if (in_array('domains', $run['tests'], true)) {
        foreach ($state['domains'] as $domain) {
            $run['domains'][] = ['domain' => $domain, 'ip' => '', 'dns' => '', 'h3' => false, 'cells' => [], 'level' => 'pending', 'verdict' => 'Waiting'];
        }
    }
    if (in_array('tcp', $run['tests'], true)) {
        foreach ($lists['tcp'] as [$tid, $asn, $provider, $ip, $port]) {
            $run['tcp'][] = ['id' => $tid, 'asn' => $asn, 'provider' => $provider, 'ip' => $ip, 'port' => $port, 'res' => []];
        }
    }
    $run['summary'] = dpiSummary($run);
    dpiSaveRun($run);
    $last = 0;
    $partial = function ($key, $value) use (&$run, &$last) {
        $run[$key] = $value;
        if (microtime(true) - $last < 2) return;
        $last = microtime(true);
        $run['summary'] = dpiSummary($run);
        dpiSaveRun($run);
    };

    foreach ($state['tests'] as $test) {
        if (dpiCancelled()) break;
        dpiProgress(['step' => $test, 'stage' => '', 'done' => 0, 'total' => 0]);
        $last = 0;
        if ($test === 'dns') $run['dns'] = dpiTestDns($lists);
        if ($test === 'domains') $run['domains'] = dpiTestDomains($state['domains'], $ifaces, fn($rows) => $partial('domains', $rows));
        if ($test === 'tcp') $run['tcp'] = dpiTestTcp($ifaces, $lists['tcp'], $lists['tcp_sni'], fn($rows) => $partial('tcp', $rows));
        if ($test === 'sni') {
            $run['sni'] = dpiTestSni($run['tcp'], $ifaces, $lists['sni'], fn($groups) => $partial('sni', $groups));
        }
        if ($test === 'tg') $run['tg'] = dpiTestTelegram($ifaces, $lists['tg']);
        $run['summary'] = dpiSummary($run);
        dpiSaveRun($run);
    }
    $run['finished'] = time();
    $run['summary'] = dpiSummary($run);
    dpiSaveRun($run);
    withDb(fn($db) => $db->exec('DELETE FROM dpi_runs WHERE id NOT IN (SELECT id FROM dpi_runs ORDER BY id DESC LIMIT ' . DPI_KEEP_RUNS . ')'));
    if (!dpiCancelled()) dpiProgress(['state' => 'done', 'finished' => time(), 'stage' => '']);
}

return [
    'getRoutingTables'    => fn() => ['tables' => withDb('doGetRoutingTablesList')],
    'getTableRoutes'      => fn($in) => ['ref' => tableRef($in), 'routes' => doGetTableRouteCount(tableRef($in))],
    'getTableRoutesPage'  => function ($in) {
        $filter = trim((string)($in['q'] ?? ''));
        if (strlen($filter) > 200) fail('Filter too long');
        return doGetTableRoutesPage(tableRef($in), $in['offset'] ?? 0, $in['limit'] ?? 100, $filter);
    },
    'testRoute'           => function ($in) {
        $target = trim((string)($in['target'] ?? ''));
        $mark = trim((string)($in['mark'] ?? ''));
        if ($target === '') fail('Enter a destination IP, CIDR or domain');
        if ($mark !== '' && !preg_match('/^0x[0-9a-fA-F]+$/', $mark)) fail('Invalid mark');
        return doTestRouteMulti($target, $mark);
    },
    'testRouteCurl'       => 'doTestRouteCurl',
    'getDnsInfo'          => 'doGetDnsConfig',
    'getClients'          => 'doGetClients',
    'setClientPolicy'     => 'doSetClientPolicy',
    'registerClient'      => 'doRegisterClient',
    'unregisterClient'    => 'doUnregisterClient',
    'getClientConnections' => fn($in) => doGetClientConnections(trim((string)($in['ip'] ?? ''))),
    'resolveHostnames'    => fn($in) => doResolveHostnames(is_array($in['ips'] ?? null) ? $in['ips'] : []),
    'getPolicyTrafficSummary' => 'doGetPolicyTrafficSummary',
    'getPolicyRoutes'     => 'doGetPolicyRoutesSummary',
    'getInterfaces'       => 'doGetInterfaces',
    'setInterfaceState'   => 'doSetInterfaceState',
    'setInterfaceDescription' => 'doSetInterfaceDescription',
    'getStaticRoutes'     => 'doGetStaticRoutes',
    'addStaticRoutes'     => 'doAddStaticRoutes',
    'deleteStaticRoutes'  => 'doDeleteStaticRoutes',
    'getInterfaceStat'    => fn($in) => doGetInterfaceStat(trim((string)($in['name'] ?? ''))),
    'getClientDetail'     => fn($in) => doGetClientDetail(trim((string)($in['mac'] ?? ''))),
    'getDashboard'        => 'doGetDashboardData',
    'getBirdStatus'       => 'doGetBirdStatus',
    'getBirdSession'      => fn() => withDb('doGetBirdSession'),
    'getBirdConfig'       => 'doGetBirdConfig',
    'saveBirdConfig'      => fn($in) => doSaveBirdConfig((string)($in['content'] ?? '')),
    'restartBird'         => 'doRestartBird',
    'getHooks'            => fn() => withDb('doGetHooks'),
    'getHookContent'      => fn($in) => withDb(fn($db) => doGetHookContent($db, hookId($in))),
    'setHookEnabled'      => fn($in) => withDb(fn($db) => doSetHookEnabled($db, hookId($in), !empty($in['enabled']))),
    'saveHook'            => fn($in) => withDb(fn($db) => doSaveHookContent($db, hookId($in), (string)($in['content'] ?? ''))),
    'resetHook'           => fn($in) => withDb(fn($db) => doResetHook($db, hookId($in))),
    'getBirdLog'          => fn($in) => doGetBirdLog($in['lines'] ?? 300),
    'clearBirdLog'        => 'doClearBirdLog',
    'enableBirdLog'       => 'doEnableBirdLog',
    'uploadUpdate'        => fn($in) => doUploadUpdate($in['data'] ?? ''),
    'applyUpdate'         => fn($in) => doApplyUpdate($in['token'] ?? ''),
    'getUpdateInfo'       => 'doGetUpdateInfo',
    'rollbackUpdate'      => 'doRollbackUpdate',
    'checkGithubUpdate'   => fn($in) => doCheckGithubUpdate($in),
    'githubUpdate'        => fn() => doGithubDownloadUpdate(),
    'getDnsResolver'      => fn() => withDb('doGetDnsResolver'),
    'saveDnsResolver'     => fn($in) => withDb(fn($db) => doSaveDnsResolver($db, $in)),
    'getJobSettings'      => fn() => withDb(fn($db) => ['delay' => (int)getSetting($db, 'job_delay')]),
    'saveJobSettings'     => fn($in) => withDb(fn($db) => doSaveJobSettings($db, $in)),
    'getPanelNet'         => fn() => withDb('doGetPanelNet'),
    'savePanelNet'        => fn($in) => withDb(fn($db) => doSavePanelNet($db, $in)),
    'testDnsResolver'     => fn($in) => doTestDnsResolver($in),
    'getLists'            => fn() => withDb('doGetLists'),
    'getListDetail'       => fn($in) => withDb(fn($db) => doGetListDetail($db, $in['id'] ?? 0)),
    'getListsCatalog'     => fn($in) => withDb(fn($db) => doGetListsCatalog($db, !empty($in['refresh']), (string)($in['source'] ?? ''))),
    'addList'             => fn($in) => withDb(fn($db) => doAddList($db, $in)),
    'saveList'            => fn($in) => withDb(fn($db) => doSaveList($db, $in)),
    'deleteList'          => fn($in) => withDb(fn($db) => doDeleteList($db, $in)),
    'cancelLists'         => fn($in) => withDb(fn($db) => doCancelLists($db, $in)),
    'syncLists'           => fn($in) => withDb(fn($db) => doSyncLists($db, $in)),
    'startJob'            => fn($in) => withDb(fn($db) => doStartJob($db, $in)),
    'getJob'              => fn() => doGetJob(),
    'getJobHistory'       => fn() => doGetJobHistory(),
    'getJobLog'           => fn($in) => doGetJobLog((string)($in['id'] ?? '')),
    'clearJobHistory'     => fn() => doClearJobHistory(),
    'cancelJob'           => fn($in) => withDb(fn($db) => doCancelJob($db, $in)),
    'saveListsSources'    => fn($in) => withDb(fn($db) => doSaveListsSources($db, $in)),
    'saveRoutePrefs'      => fn($in) => withDb(fn($db) => doSaveRoutePrefs($db, $in)),
    'getBirdHook'         => fn() => withDb('doGetBirdHook'),
    'saveBirdHook'        => fn($in) => withDb(fn($db) => doSaveBirdHook($db, $in)),
    'getDpi'              => fn($in) => withDb(fn($db) => doGetDpi($db, $in)),
    'startDpi'            => fn($in) => withDb(fn($db) => doStartDpi($db, $in)),
    'stopDpi'             => fn() => doStopDpi(),
    'deleteDpiRuns'       => fn($in) => doDeleteDpiRuns($in),
    'getDpiLists'         => fn() => withDb('doGetDpiLists'),
    'saveDpiLists'        => fn($in) => withDb(fn($db) => doSaveDpiLists($db, $in)),
];
