// app.js - клиентская логика

const API = '/app.php';
const JS_VERSION = '5.40.0'; // must match APP_VERSION: a mismatch means the browser holds stale files


// ============================================ I18N ============================================
// English text is the key. A language is a file lang.<code>.json: {"_name": "Русский", "strings": {"English": "Перевод"}}.
// Keys may contain {0}, {1}...: they match any text in that place and are put into the translation.
// The DOM is translated as it appears (text, placeholder, title, aria-label), so the rest of the code writes plain English.
const I18N = { lang: 'en', langs: [], dict: new Map(), patterns: [], observer: null, queued: false, skip: new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']) };
const I18N_ATTRS = ['placeholder', 'title', 'aria-label', 'data-label', 'data-tip'];

function i18nLocale() { return I18N.lang === 'en' ? undefined : I18N.lang; }

function i18nDate(d) {
    return d.toLocaleString(i18nLocale(), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function i18nNorm(s) { return s.replace(/\s+/g, ' ').trim(); }

function i18nEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function i18nSetDict(strings) {
    I18N.dict = new Map();
    I18N.patterns = [];
    for (const [key, v] of Object.entries(strings || {})) {
        // lookups normalize whitespace, so a key written with line breaks (a multi-line tooltip) is stored the same way
        const k = i18nNorm(key);
        if (!v || k === v) continue;
        if (/\{\d+\}/.test(k)) {
            const idx = [];
            // {0} glued to a unit letter ("{0}m ago") can only be a number: otherwise "Algorithm" would match "{0}m"
            const re = new RegExp('^' + i18nEscape(k).replace(/\\\{(\d+)\\\}/g, (m, n, off, s) => { idx.push(+n); return /^[A-Za-z]/.test(s.slice(off + m.length)) ? '(\\d+)' : '(.+?)'; }) + '$');
            I18N.patterns.push({ re, idx, to: v, len: k.length });
            I18N.dict.set(k, v); // t('{0}m', n) looks the key up as written
        } else {
            I18N.dict.set(k, v);
        }
    }
    I18N.patterns.sort((a, b) => b.len - a.len);
    // Fragments: strings the code builds from pieces ('Updated to ' + v + ', reloading…') never match a whole key, so longer keys are also replaced inside text.
    const frag = [...I18N.dict.keys()].filter(k => !/\{\d+\}/.test(k) && (k.length >= 6 || k.includes(' '))).sort((a, b) => b.length - a.length);
    I18N.frag = frag.length ? new RegExp(frag.map(k => (/^[A-Za-z0-9]/.test(k) ? '(?<![A-Za-z0-9])' : '') + i18nEscape(k) + (/[A-Za-z0-9]$/.test(k) ? '(?![A-Za-z0-9])' : '')).join('|'), 'g') : null;
    I18N.cache = new Map();
}

// Translates one string; whitespace around it is kept.
function i18nTr(str) {
    if (I18N.lang === 'en' || !str) return str;
    const lead = str.match(/^\s*/)[0];
    const trail = str.match(/\s*$/)[0];
    const core = i18nNorm(str);
    if (!core) return str;
    let out = I18N.dict.get(core);
    if (out === undefined) {
        for (const p of I18N.patterns) {
            const m = p.re.exec(core);
            if (!m) continue;
            out = p.to.replace(/\{(\d+)\}/g, (x, n) => {
                const g = m[p.idx.indexOf(+n) + 1];
                return g === undefined ? x : i18nTr(g);
            });
            break;
        }
    }
    if (out === undefined && I18N.frag) {
        if (I18N.cache.has(core)) out = I18N.cache.get(core);
        else {
            const r = core.replace(I18N.frag, m => I18N.dict.get(m));
            out = r === core ? undefined : r;
            if (I18N.cache.size > 5000) I18N.cache.clear();
            I18N.cache.set(core, out);
        }
    }
    return out === undefined ? str : lead + out + trail;
}

// For code that needs a string right away (confirm, prompt) and for formatting: t('Hello {0}', name)
// A note from the server made of several lines: each line is its own key
function tLines(text) {
    return String(text || '').split('\n').map(line => t(line)).join('\n');
}

function t(str, ...args) {
    return i18nTr(str).replace(/\{(\d+)\}/g, (x, n) => (args[+n] === undefined ? x : args[+n]));
}

function i18nSkipped(node) {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
        if (I18N.skip.has(el.tagName) || (el.dataset && el.dataset.notr !== undefined)) return true;
    }
    return false;
}

function i18nText(node) {
    if (node.__tr !== undefined && node.data === node.__tr) {
        if (I18N.lang === node.__lang) return;
    } else {
        node.__en = node.data;
    }
    const out = i18nTr(node.__en);
    node.__lang = I18N.lang;
    node.__tr = out;
    if (node.data !== out) node.data = out;
}

function i18nAttrs(el) {
    for (const a of I18N_ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const cur = el.getAttribute(a);
        const st = el.__i18n || (el.__i18n = {});
        const rec = st[a];
        if (rec && rec.tr === cur) {
            if (rec.lang === I18N.lang) continue;
        } else {
            st[a] = { en: cur };
        }
        const out = i18nTr(st[a].en);
        st[a].tr = out;
        st[a].lang = I18N.lang;
        if (cur !== out) el.setAttribute(a, out);
    }
}

function i18nApply(root) {
    if (!root || (I18N.lang === 'en' && !I18N.touched)) return;
    if (root.nodeType === 3) {
        if (!i18nSkipped(root)) i18nText(root);
        return;
    }
    if (root.nodeType !== 1) return;
    if (root.tagName === 'TEXTAREA') i18nAttrs(root);
    if (i18nSkipped(root)) return;
    i18nAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) { if (!i18nSkipped(n)) i18nText(n); }
        else if (!i18nSkipped(n) || n.tagName === 'TEXTAREA') i18nAttrs(n);
    }
}

function i18nWatch() {
    if (I18N.observer) return;
    I18N.observer = new MutationObserver((muts) => {
        for (const m of muts) {
            if (m.type === 'childList') m.addedNodes.forEach(n => i18nApply(n));
            else if (m.type === 'characterData') i18nApply(m.target);
            else if (m.type === 'attributes') i18nAttrs(m.target);
        }
    });
    I18N.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: I18N_ATTRS });
}

async function i18nLoad(code) {
    if (code !== 'en') {
        const r = await fetch('/lang.' + encodeURIComponent(code) + '.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('language file not found');
        i18nSetDict((await r.json()).strings);
    } else {
        i18nSetDict({});
    }
    I18N.lang = code;
    I18N.touched = true;
    document.documentElement.lang = code;
    i18nApply(document.body);
    i18nApply(document.querySelector('title'));
    i18nWatch();
    i18nFillSelectors();
}

function i18nFillSelectors() {
    document.querySelectorAll('.lang-select').forEach(sel => {
        sel.innerHTML = I18N.langs.map(l => `<option value="${escapeHtml(l.code)}"${l.code === I18N.lang ? ' selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
        sel.hidden = I18N.langs.length < 2;
        sel.dataset.notr = '';
    });
}

async function i18nInit(langs) {
    I18N.langs = Array.isArray(langs) ? langs : [];
    let want = null;
    try { want = localStorage.getItem('lang'); } catch (e) { /* storage may be blocked */ }
    if (!want) want = (navigator.language || 'en').slice(0, 2).toLowerCase();
    if (!I18N.langs.some(l => l.code === want)) want = 'en';
    try { await i18nLoad(want); } catch (e) { await i18nLoad('en'); }
    document.querySelectorAll('.lang-select').forEach(sel => sel.addEventListener('change', async () => {
        try { localStorage.setItem('lang', sel.value); } catch (e) { /* ignore */ }
        try { await i18nLoad(sel.value); } catch (e) { showToast('Language file not found', 'error'); }
    }));
}
// ============================================ I18N ============================================

// 401 means the session expired: back to the login form.
// Feedback for every request to the server: the button that was pressed shows a spinner and the bar at the top
// of the page runs while a request is in flight. Reads (GET) show the bar only when they take long.
let lastClicked = null;
let netShown = 0;
document.addEventListener('click', (e) => {
    lastClicked = e.target.closest('button');
    setTimeout(() => { lastClicked = null; }, 0);
}, true);

function netBegin(isAction) {
    const token = { done: false, shown: false, timer: null };
    const show = () => {
        if (token.done) return;
        token.shown = true;
        netShown++;
        document.getElementById('netBar').classList.add('on');
    };
    if (isAction) show();
    else token.timer = setTimeout(show, 800);
    return token;
}

function netEnd(token) {
    token.done = true;
    clearTimeout(token.timer);
    if (!token.shown) return;
    netShown--;
    if (netShown === 0) document.getElementById('netBar').classList.remove('on');
}

async function apiFetch(url, options) {
    const isAction = !!(options && options.method && options.method !== 'GET');
    const button = lastClicked;
    if (button) {
        button.dataset.busy = String(Number(button.dataset.busy || 0) + 1);
        button.classList.add('is-busy');
    }
    const token = netBegin(isAction);
    try {
        const response = await fetch(url, options);
        if (response.status === 401) {
            enterState('login');
            throw new Error('Session expired');
        }
        return response;
    } finally {
        netEnd(token);
        if (button) {
            const left = Number(button.dataset.busy) - 1;
            button.dataset.busy = String(left);
            if (left <= 0) button.classList.remove('is-busy');
        }
    }
}

// Состояние приложения
let state = {
    domains: [],
    policies: [],
    deleted: [],
    currentTab: 'domains',
    sort: (function(){ try { return JSON.parse(localStorage.getItem('domSort')) || {key:'',dir:1}; } catch(e) { return {key:'',dir:1}; } })(),
    collapsedPolicies: new Set() // id политик, свёрнутых в списке целей
};

// Экранирование пользовательских данных перед вставкой в innerHTML.
// domain/interface/gateway/policy.description приходят из БД, куда их
// можно было записать через публичный (без-auth на уровне API) POST -
// без экранирования это готовый stored XSS.
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============================================ ВИЗУАЛЬНЫЕ ХЕЛПЕРЫ ============================================

// Оттенок-идентификатор политики (не путать со статусными LED-цветами).
// Диапазон 190-330° (сине-фиолетово-пурпурный), сознательно не пересекается
// с зоной зелёный/жёлтый/красный, зарезервированной под статус домена.
function policyHue(id) {
    const n = Number(id) || 0;
    return 190 + ((n * 47) % 140);
}

// LED-статус домена - тот же визуальный язык, что и физические
// индикаторы на корпусе роутера.
//   Disabled     - домен выключен
//   Not resolved - нет успешного резолва DNS
//   Active       - есть текущий IP (обычный день: Check & apply уже
//                  прогнал и резолв, и применение маршрутов одним шагом)
function domainStatus(domain) {
    if (!domain.enabled) return { cls: 'led-grey', label: 'Disabled' };
    if (!domain.current_ip || !isJSONString(domain.current_ip) || JSON.parse(domain.current_ip).length === 0) {
        return { cls: 'led-red', label: 'Not resolved' };
    }
    return { cls: 'led-green', label: 'Active' };
}

function ipChips(raw) {
    if (!isJSONString(raw)) return '<span class="muted">—</span>';
    const ips = JSON.parse(raw);
    if (!ips.length) return '<span class="muted">—</span>';
    return '<div class="chip-row">' + ips.map(ip => `<span class="chip">${escapeHtml(ip)}</span>`).join('') + '</div>';
}

// SQLite datetime('now') отдаёт UTC без таймзоны ("YYYY-MM-DD HH:MM:SS") -
// добавляем 'T' и 'Z', чтобы Date() не интерпретировал это как локальное время.
function toLocalDate(sqliteUtcStr) {
    if (!sqliteUtcStr) return null;
    return new Date(sqliteUtcStr.replace(' ', 'T') + 'Z');
}

function timeAgo(sqliteUtcStr) {
    const d = toLocalDate(sqliteUtcStr);
    if (!d) return '—';
    const diffMs = Date.now() - d.getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
}

function renderStatusStrip() {
    const strip = document.getElementById('statusStrip');
    if (!strip) return;

    let green = 0, red = 0, grey = 0;
    let lastCheck = null;
    state.domains.forEach(d => {
        const s = domainStatus(d);
        if (s.cls === 'led-green') green++;
        else if (s.cls === 'led-red') red++;
        else grey++;
        if (d.last_check && (!lastCheck || d.last_check > lastCheck)) lastCheck = d.last_check;
    });

    strip.innerHTML = `
        <div class="stat-card"><span class="stat-label"><span class="led led-green"></span>Resolved</span><span class="stat-value">${green}</span></div>
        <div class="stat-card"><span class="stat-label"><span class="led led-red"></span>Could not resolve</span><span class="stat-value">${red}</span></div>
        <div class="stat-card"><span class="stat-label"><span class="led led-grey"></span>Disabled</span><span class="stat-value">${grey}</span></div>
        <div class="stat-card"><span class="stat-label"><span class="led led-blue"></span>Last sync</span><span class="stat-value">${timeAgo(lastCheck)}</span></div>
    `;
}

// ============================================ ПОДТВЕРЖДЕНИЕ (замена confirm()) ============================================
// Системный confirm() блокирует поток и выглядит инородно на тёмной
// панели - свой диалог в тех же токенах, что форма добавления домена.
// Esc closes the topmost window. Dialogs built on the fly (confirm, import) handle Esc themselves.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal')].filter(m => m.style.display === 'block');
    if (!open.length || open.some(m => !m.id)) return;
    const top = open[open.length - 1];
    const close = top.querySelector('.close');
    if (close) close.click(); else top.style.display = 'none';
});

// Windows: the page under an open window does not scroll, Tab stays inside the top window,
// and focus goes back where it was when the window closes
const modalStack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function modalIsOpen(m) {
    return m.isConnected && m.style.display !== '' && m.style.display !== 'none';
}
function modalFocusable(m) {
    return [...m.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
}
function modalSync() {
    for (let i = modalStack.length - 1; i >= 0; i--) {
        const entry = modalStack[i];
        if (modalIsOpen(entry.modal)) continue;
        modalStack.splice(i, 1);
        const lost = document.activeElement === document.body || entry.modal.contains(document.activeElement);
        if (entry.back && entry.back.isConnected && lost) entry.back.focus();
    }
    document.querySelectorAll('.modal').forEach(m => {
        if (!modalIsOpen(m) || modalStack.some(entry => entry.modal === m)) return;
        modalStack.push({ modal: m, back: document.activeElement });
        // the opener may have put the focus into a field itself
        if (m.contains(document.activeElement)) return;
        // on a phone a focused text field would pop the keyboard up: the close button takes the focus there
        const fields = modalFocusable(m);
        const touch = matchMedia('(pointer: coarse)').matches;
        const first = (!touch && fields.find(el => el.matches('input, select, textarea'))) || fields.find(el => el.classList.contains('close')) || fields[0];
        if (first) first.focus({ preventScroll: true });
    });
    document.body.classList.toggle('modal-open', modalStack.length > 0);
}
new MutationObserver(modalSync).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !modalStack.length) return;
    const top = modalStack[modalStack.length - 1].modal;
    const fields = modalFocusable(top);
    if (!fields.length) { e.preventDefault(); return; }
    const first = fields[0];
    const last = fields[fields.length - 1];
    if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function showConfirm(message, confirmLabel = 'Confirm') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.style.display = 'block';

        const content = document.createElement('div');
        content.className = 'modal-content confirm-content';

        const msg = document.createElement('p');
        msg.className = 'confirm-msg';
        msg.textContent = message;

        const actions = document.createElement('div');
        actions.className = 'form-actions';

        const yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.className = 'btn btn-danger';
        yesBtn.textContent = confirmLabel;

        const noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'btn';
        noBtn.textContent = 'Cancel';

        const cleanup = (result) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') cleanup(false);
            if (e.key === 'Enter') cleanup(true);
        };

        yesBtn.addEventListener('click', () => cleanup(true));
        noBtn.addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
        document.addEventListener('keydown', onKey);

        actions.appendChild(yesBtn);
        actions.appendChild(noBtn);
        content.appendChild(msg);
        content.appendChild(actions);
        overlay.appendChild(content);
        document.body.appendChild(overlay);
        noBtn.focus();
    });
}

// ============================================ ОВЕРЛЕЙ ЗАГРУЗКИ ============================================
// Блокирует всю страницу на время Sync/Check&apply/Apply/Save/Delete/
// Import - чтобы не успеть натыкать что-то ещё поверх незавершённой
// операции (Check & apply особенно долгий - DNS-резолв каждой цели).
// Счётчик нужен, чтобы вложенный hideLoading() не убрал оверлей раньше времени.
let loadingCount = 0;
const LOADING_MESSAGES = [
    'Working on it…',
    'Talking to the router…',
    "Don't close the tab, almost there…",
];

function showLoading(message) {
    loadingCount++;
    const overlay = document.getElementById('loadingOverlay');
    const text = document.getElementById('loadingText');
    if (!overlay || !text) return;
    text.textContent = message || LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
    overlay.classList.add('active');
}

function hideLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.classList.remove('active');
    }
}

// ============================================ ТОСТЫ ============================================
// Ненавязчивые уведомления о результате операций (sync/check/apply),
// вместо alert() - видно что реально произошло, не блокируя интерфейс.
function toastContainer() {
    let el = document.getElementById('toastContainer');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toastContainer';
        el.className = 'toast-container';
        document.body.appendChild(el);
    }
    return el;
}

function showToast(message, type = 'info', ttl = 5000) {
    const container = toastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    // LED-точка того же цвета, что и статусы доменов - один визуальный
    // язык на всё приложение, и заодно самый быстрый способ отличить
    // тип уведомления боковым зрением, не читая текст.
    const ledMap = { success: 'led-green', warning: 'led-amber', error: 'led-red', info: 'led-blue' };
    const dot = document.createElement('span');
    dot.className = `led toast-dot ${ledMap[type] || 'led-blue'}`;

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message; // textContent - без риска инъекции, переносы строк рендерит white-space: pre-line

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';

    const remove = () => {
        toast.classList.add('toast-leaving');
        setTimeout(() => toast.remove(), 200);
    };
    close.addEventListener('click', remove);

    toast.appendChild(dot);
    toast.appendChild(msg);
    toast.appendChild(close);
    container.appendChild(toast);

    if (ttl) setTimeout(remove, ttl);
    return toast;
}

// ============================================ ИНИЦИАЛИЗАЦИЯ ============================================
// Every modal gets the same structure: head (title + close), scrolling body and, when the
// content ends with a .form-actions or .bw-footer block, a fixed foot.
function normalizeModals() {
    document.querySelectorAll('.modal-content').forEach(mc => {
        if (mc.querySelector(':scope > .modal-head')) return;
        const close = mc.querySelector(':scope > .close');
        const h2 = mc.querySelector(':scope > h2');
        if (!close && !h2) return;
        const head = document.createElement('div');
        head.className = 'modal-head';
        if (h2) head.appendChild(h2);
        if (close) head.appendChild(close);
        const body = document.createElement('div');
        body.className = 'modal-body';
        while (mc.firstChild) body.appendChild(mc.firstChild);
        mc.append(head, body);
        const foot = body.querySelector(':scope > .form-actions, :scope > .bw-footer, :scope > .bl-footer');
        if (foot) {
            foot.classList.add('modal-foot');
            mc.appendChild(foot);
        }
    });
}

function initApp() {
    normalizeModals();
    const nav = document.getElementById('mainNav');
    const moreBtn = document.getElementById('navMoreBtn');
    const setMore = (open) => {
        if (open) {
            document.getElementById('headerActions').classList.remove('open');
            document.getElementById('headerBurgerBtn').setAttribute('aria-expanded', 'false');
        }
        nav.classList.toggle('more-open', open);
        moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); setMore(!nav.classList.contains('more-open')); });
    document.addEventListener('click', (e) => {
        if (nav.classList.contains('more-open') && !nav.contains(e.target)) setMore(false);
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setMore(false);                
            state.currentTab = btn.dataset.tab;
            if (location.hash !== '#' + state.currentTab) history.replaceState(null, '', '#' + state.currentTab);
            document.getElementById('pageTitle').textContent = btn.querySelector('.tab-label').textContent;
            moreBtn.classList.toggle('active', !!btn.closest('.nav-more-menu'));
            setMore(false);
            // Update tab buttons
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === state.currentTab);
            });            
            // Update tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.toggle('active', content.id === state.currentTab + 'Tab');
            });
            // Таблицы маршрутизации - live-срез ядра, а не часть обычного
            // state; перечитываем при каждом открытии вкладки, а не только
            // один раз при старте страницы.
            if (state.currentTab === 'lists') {
                loadLists();
            }
            if (state.currentTab === 'tables') {
                loadRoutingTables();
                loadStaticRoutes();
            }
            if (state.currentTab === 'update') {
                loadUpdateInfo();
                loadDnsResolver();
                loadPanelNet();
                loadJobDelay();
            }
            if (state.currentTab === 'tools') {
                loadDependencyStatus();
                loadBirdStatus();
                loadHooks();
                loadBirdHook();
            }
            if (state.currentTab === 'diag') {
                loadDpi();
            }
            // Клиенты - тоже live-данные с роутера (RCI), перечитываем
            // при каждом открытии вкладки.
            if (state.currentTab === 'clients') {
                loadClients();
            }
            // Трафик по политикам - тоже live-снимок (те же данные RCI,
            // что и Clients), перечитываем при каждом открытии вкладки.
            if (state.currentTab === 'policies') {
                loadPolicyTrafficSummary();
                loadPolicyRoutesSummary();
            }
            // Интерфейсы - тоже live-снимок RCI, перечитываем при каждом
            // открытии вкладки.
            if (state.currentTab === 'interfaces') {
                loadInterfaces();
            }
        });
    });
    
    // Header buttons
    document.getElementById('refreshPolicies').addEventListener('click', syncPolicies);
    // Бургер-меню (мобильная шапка) - открыть/закрыть, закрыть по клику
    // мимо, закрыть после выбора любого действия внутри.
    const headerBurgerBtn = document.getElementById('headerBurgerBtn');
    const headerActions = document.getElementById('headerActions');
    headerBurgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!headerActions.classList.contains('open')) setMore(false);
        const isOpen = headerActions.classList.toggle('open');
        headerBurgerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    headerActions.addEventListener('click', (e) => {
        if (e.target.closest('button, a')) {
            headerActions.classList.remove('open');
            headerBurgerBtn.setAttribute('aria-expanded', 'false');
        }
    });
    document.addEventListener('click', (e) => {
        if (headerActions.classList.contains('open') && !headerActions.contains(e.target) && e.target !== headerBurgerBtn) {
            headerActions.classList.remove('open');
            headerBurgerBtn.setAttribute('aria-expanded', 'false');
        }
    });
    document.getElementById('refreshTablesBtn').addEventListener('click', loadRoutingTables);
    document.getElementById('dashboardRefreshBtn').addEventListener('click', loadDashboard);

    // Окно просмотра содержимого таблицы
    document.getElementById('tableViewClose').addEventListener('click', closeTableView);
    document.getElementById('tableViewModal').addEventListener('click', (e) => {
        if (e.target.id === 'tableViewModal') closeTableView();
    });
    document.getElementById('tableViewFilter').addEventListener('input', (e) => {
        clearTimeout(tableViewFilterTimer);
        const value = e.target.value;
        tableViewFilterTimer = setTimeout(() => {
            tableViewState.filter = value;
            loadTableViewPage(true);
        }, 350); // дебаунс - не дёргаем роутер на каждое нажатие клавиши
    });
    document.getElementById('tableViewList').addEventListener('scroll', (e) => {
        const el = e.target;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
            loadTableViewPage(false);
        }
    });

    // Test Route
    document.getElementById('testRouteBtn').addEventListener('click', openTestRouteModal);
    document.getElementById('testRouteCancel').addEventListener('click', closeModal);
    document.getElementById('testRouteRun').addEventListener('click', runTestRoute);
    document.getElementById('testRouteIp').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runTestRoute();
    });

    document.getElementById('refreshBirdBtn').addEventListener('click', loadBirdStatus);
    document.getElementById('restartBirdBtn').addEventListener('click', restartBird);
    document.getElementById('editBirdConfigBtn').addEventListener('click', openBirdConfigEditor);
    document.getElementById('birdConfBtn').addEventListener('click', (e) => {
        const menu = document.getElementById('birdConfMenu');
        menu.hidden = !menu.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.getElementById('birdConfMenu').addEventListener('click', () => { document.getElementById('birdConfMenu').hidden = true; });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#birdConfBtn')) document.getElementById('birdConfMenu').hidden = true;
    });
    initHooksAndLog();
    initUpdate();
    // once on start, from the 6-hour cache of the server: the version badge shows when a new release is out
    setTimeout(() => checkGithubUpdate(false), 3000);
    initBirdWizard();
    ['birdTunnel', 'birdTable', 'birdPolicy', 'birdPeerRoute'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('input', renderBirdPreview);
        el.addEventListener('change', renderBirdPreview);
    });
    document.getElementById('saveBirdHookBtn').addEventListener('click', () => saveBirdHook(true));
    document.getElementById('disableBirdHookBtn').addEventListener('click', () => saveBirdHook(false));
    document.getElementById('fileEditorClose').addEventListener('click', closeFileEditor);
    document.getElementById('fileEditorCancel').addEventListener('click', closeFileEditor);
    document.getElementById('policyRoutesClose').addEventListener('click', () => {
        document.getElementById('policyRoutesModal').style.display = 'none';
    });
    document.getElementById('policyRoutesModal').addEventListener('click', (e) => {
        if (e.target.id === 'policyRoutesModal') document.getElementById('policyRoutesModal').style.display = 'none';
    });
    document.getElementById('interfaceDetailClose').addEventListener('click', () => {
        document.getElementById('interfaceDetailModal').style.display = 'none';
        stopInterfaceStatAutoRefresh();
    });
    document.getElementById('interfaceDetailModal').addEventListener('click', (e) => {
        if (e.target.id === 'interfaceDetailModal') {
            document.getElementById('interfaceDetailModal').style.display = 'none';
            stopInterfaceStatAutoRefresh();
        }
    });
    document.getElementById('interfaceStatRefreshBtn').addEventListener('click', fetchInterfaceStat);
    document.getElementById('interfaceStatAutoRefresh').addEventListener('change', (e) => {
        if (e.target.checked) startInterfaceStatAutoRefresh(); else stopInterfaceStatAutoRefresh();
    });
    document.getElementById('interfaceStatAutoRefreshInterval').addEventListener('change', () => {
        if (document.getElementById('interfaceStatAutoRefresh').checked) startInterfaceStatAutoRefresh();
    });
    const closeClientDetail = () => {
        document.getElementById('clientDetailModal').style.display = 'none';
        stopAutoRefresh();
    };
    document.getElementById('clientDetailClose').addEventListener('click', closeClientDetail);
    document.getElementById('clientDetailModal').addEventListener('click', (e) => {
        if (e.target.id === 'clientDetailModal') closeClientDetail();
    });
    document.getElementById('targetClose').addEventListener('click', closeModal);
    document.querySelectorAll('#targetTabs button').forEach(b => b.addEventListener('click', () => switchTargetPane(b.dataset.pane)));
    document.getElementById('targetRefreshBtn').addEventListener('click', refreshTargetDetail);
    document.getElementById('fileEditorModal').addEventListener('click', (e) => {
        if (e.target.id === 'fileEditorModal') closeFileEditor();
    });
    document.getElementById('fileEditorSaveBtn').addEventListener('click', saveFileEditorContent);
    document.getElementById('fileEditorWrapToggle').addEventListener('change', (e) => {
        const textarea = document.getElementById('fileEditorTextarea');
        textarea.classList.toggle('wrap-lines', e.target.checked);
        textarea.setAttribute('wrap', e.target.checked ? 'soft' : 'off');
    });
    document.getElementById('logoutBtn').addEventListener('click', async (e) => {
        e.preventDefault();
        await postJson({ action: 'logout' });
        location.reload();
    });

    // Clients
    document.getElementById('refreshClientsBtn').addEventListener('click', loadClients);
    document.getElementById('refreshInterfacesBtn').addEventListener('click', loadInterfaces);
    document.getElementById('searchInterfaces').addEventListener('input', (e) => renderInterfaces(e.target.value));
    document.getElementById('interfacesFilter').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        interfaceFilter = b.dataset.f;
        try { localStorage.setItem('ifaceFilter', interfaceFilter); } catch (err) { /* ignore */ }
        renderInterfaces(document.getElementById('searchInterfaces').value);
    });
    document.getElementById('searchClients').addEventListener('input', (e) => renderClients(e.target.value));
    document.getElementById('clientsPolicy').addEventListener('change', (e) => {
        clientPolicy = e.target.value;
        renderClients(document.getElementById('searchClients').value);
    });
    document.querySelectorAll('#clientsTable [data-sort]').forEach(th => {
        th.addEventListener('click', () => setClientSort(th.dataset.sort));
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setClientSort(th.dataset.sort); } });
    });
    document.querySelectorAll('#clientsFilter button').forEach(b => b.addEventListener('click', () => {
        clientFilter = b.dataset.f;
        renderClients(document.getElementById('searchClients').value);
    }));
    document.getElementById('connFilterIp').addEventListener('input', () => renderConnections());
    document.getElementById('connProtoFilter').addEventListener('change', () => renderConnections());
    document.getElementById('connRefreshBtn').addEventListener('click', fetchConnections);
    document.getElementById('connAutoRefresh').addEventListener('change', (e) => {
        if (e.target.checked) startAutoRefresh(); else stopAutoRefresh();
    });
    document.getElementById('connAutoRefreshInterval').addEventListener('change', () => {
        if (document.getElementById('connAutoRefresh').checked) startAutoRefresh();
    });
    
    // Domain actions
    document.querySelectorAll('#domainsTable th[data-sort]').forEach(th => {
        th.addEventListener('click', () => setDomainSort(th.dataset.sort));
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDomainSort(th.dataset.sort); } });
    });
    document.getElementById('addDomainBtn').addEventListener('click', () => openDomainModal());
    document.getElementById('exportBtn').addEventListener('click', exportConfig);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', handleImportFile);
    document.getElementById('searchDomains').addEventListener('input', (e)=>{
        renderDomains(e.target.value);
    });
    
    //Policies actions
    document.getElementById('searchPolicies').addEventListener('input', (e)=>{
        renderPolicies(e.target.value);
    });
    
    // Modal
    document.getElementById('cancelModal').addEventListener('click', closeModal);
    document.getElementById('domainForm').addEventListener('submit', saveDomain);
    
    // Close modal on outside click
    window.addEventListener('click', (event) => {
        if (event.target.id === 'targetModal') {
            closeModal();
        }
    });
    // Apply routes
    resumeJob();
    loadData();
    loadDashboard(); // строка метрик в шапке - не привязана к вкладке, грузится один раз при старте
}
// ============================================ ИНИЦИАЛИЗАЦИЯ ============================================
// ============================================ ЗАГРУЗКА ДАННЫХ ============================================
async function loadData() {
    try {
        const domainsData = await (await apiFetch(API+"?action=getDomains")).json();
        if (!Array.isArray(domainsData)) {
            // API вернул {"error": "..."} (например "Database not found.
            // Run create_db.php first") вместо массива - без этой проверки
            // domainsData.filter() ниже просто кидает исключение, которое
            // тихо ловилось в catch и оставляло "Loading..." висеть вечно.
            throw new Error(domainsData.error || 'Failed to load targets');
        }
        state.domains = domainsData;

        const policiesData = await (await apiFetch(API+"?action=getPolicies")).json();
        if (!Array.isArray(policiesData)) {
            throw new Error(policiesData.error || 'Failed to load policies');
        }
        state.policies = policiesData;

        state.deleted = state.domains.filter(domain => {
            return domain.policy_name === 'DELETED'
        });        
        renderDomains();
        renderPolicies();
        renderStatusStrip();
        updateNavCounts();
    } catch (error) {
        console.log('Failed to load data: ' + error.message);
        showToast('Failed to load data: ' + error.message, 'error', 9000);
        const msg = escapeHtml(error.message);
        document.getElementById('domainsList').innerHTML = `<tr><td colspan="7" class="loading">${msg}</td></tr>`;
        document.getElementById('policiesList').innerHTML = `<tr><td colspan="10" class="loading">${msg}</td></tr>`;
    }
}
// ============================================ ЗАГРУЗКА ДАННЫХ ============================================
// ============================================ РЕНДЕРИНГ ТАБЛИЦ ============================================
function sortValue(d, key) {
    switch (key) {
        case 'target': return d.domain;
        case 'interface': return d.interface;
        case 'gateway': return d.gateway;
        case 'current_ip': return ipSortValue(d.current_ip);
        case 'last_check': { const t = toLocalDate(d.last_check); return t ? t.getTime() : null; }
        case 'status': return { 'Active': 0, 'Not resolved': 1, 'Disabled': 2 }[domainStatus(d).label];
    }
    return null;
}

// Sorts by the value of one column: empty values go last in both directions, equal ones keep the order of the name
function sortList(list, { key, dir }, valueOf, nameOf) {
    if (!key) return list;
    return list.slice().sort((a, b) => {
        const x = valueOf(a, key), y = valueOf(b, key);
        const ex = x === null || x === '' || x === undefined, ey = y === null || y === '' || y === undefined;
        const byName = () => String(nameOf(a)).localeCompare(String(nameOf(b)), undefined, { numeric: true, sensitivity: 'base' });
        if (ex || ey) return ex === ey ? byName() : (ex ? 1 : -1);
        const c = (typeof x === 'number' && typeof y === 'number')
            ? x - y
            : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
        return c ? c * dir : byName();
    });
}

function sortDomains(list) {
    return sortList(list, state.sort, sortValue, d => d.domain);
}

function setDomainSort(key) {
    const s = state.sort;
    if (s.key !== key) { s.key = key; s.dir = 1; }
    else if (s.dir === 1) s.dir = -1;
    else { s.key = ''; s.dir = 1; }
    try { localStorage.setItem('domSort', JSON.stringify(s)); } catch (e) {}
    renderDomains(document.getElementById('searchDomains').value);
}

function updateSortHeaders() {
    document.querySelectorAll('#domainsTable th[data-sort]').forEach(th => {
        const on = th.dataset.sort === state.sort.key;
        th.classList.toggle('sorted', on);
        th.dataset.dir = on ? (state.sort.dir === 1 ? 'asc' : 'desc') : '';
        th.setAttribute('aria-sort', on ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
}

// "1.2.3.4" sorts by its number; several addresses (JSON list) by the first; a target without an address goes last
function ipSortValue(value) {
    let first = String(value || '');
    if (first.startsWith('[')) {
        try { first = JSON.parse(first)[0] || ''; } catch (e) { first = ''; }
    }
    const m = first.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
}

function renderDomains(filterText = '') {
    let tbody = document.getElementById('domainsList');
    let domains = state.domains;
    let policies = state.policies;
    if (filterText) {
        let search = filterText.toLowerCase();
        domains = domains.filter(domain => 
            domain.domain.toLowerCase().includes(search) ||
            (domain.policy_name && domain.policy_name.toLowerCase().includes(search)) ||
            (domain.current_ip && domain.current_ip.includes(search))
        );
    }    
    if (domains.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading">No domains found</td></tr>';
        return;
    }
    updateSortHeaders();
    let html = '';
    const isSearching = !!filterText; // во время поиска игнорируем "свёрнуто" - иначе результат может просто не показаться
    policies.forEach(policie => {
        const policie_domains = sortDomains(domains.filter(domain => domain.policy_name == policie.name));
        const hue = policyHue(policie.id);
        const isCollapsed = !isSearching && state.collapsedPolicies.has(policie.id);

        let groupHtml = `<tr class="policy-group" style="--policy-hue:${hue}">
            <td colspan="7">
                <div class="policy-group-row">
                    <div class="policy-group-left">
                        <button class="policy-toggle" data-click="togglePolicy" data-id="${policie.id}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '▸' : '▾'}</button><span class="policy-dot"></span><span class="policy-name" data-click="togglePolicy" data-id="${policie.id}" data-notr>${escapeHtml(policie.name)}</span>${policie.description ? `<span class="policy-desc" data-notr>${escapeHtml(policie.description)}</span>` : ''}
                    </div>
                    <div class="policy-meta">
                        <span class="meta-mark">mark <code>${escapeHtml(policie.mark_hex)}</code></span>
                        <span class="meta-table">table ${escapeHtml(policie.our_table)}</span>
                        <span class="meta-count">${policie_domains.length} target(s)</span>
                    </div>
                </div>
            </td>
        </tr>`;
        html += groupHtml;

        if (isCollapsed) return;

        if (policie_domains.length !== 0) {
            policie_domains.forEach(domain => {
                const status = domainStatus(domain);
                const lastCheckDate = toLocalDate(domain.last_check);
                const rowHtml = `<tr class="domain-row">
                    <td class="cell-domain" data-label="Target" data-col="target"><button type="button" class="target-link" data-click="openTarget" data-id="${domain.id}" title="Target details" data-notr>${escapeHtml(domain.domain)}</button></td>
                    <td class="cell-mono" data-label="Interface" data-col="interface">${escapeHtml(domain.interface) || '<span class="muted">—</span>'}</td>
                    <td class="cell-mono" data-label="Gateway" data-col="gateway">${escapeHtml(domain.gateway) || '<span class="muted">—</span>'}</td>
                    <td data-label="Current IP" data-col="current-ip">${ipChips(domain.current_ip)}</td>
                    <td class="cell-mono" data-label="Last check" data-col="last-check">${lastCheckDate ? `<span title="${escapeHtml(i18nDate(lastCheckDate))}">${timeAgo(domain.last_check)}</span>` : '<span class="muted">—</span>'}</td>
                    <td data-label="Status" data-col="status"><span class="status-pill"><span class="led ${status.cls}" title="${status.label}"></span><span class="status-label">${status.label}</span></span></td>
                    <td class="cell-actions col-sticky-right">
                        <button class="btn btn-small" data-click="openTarget" data-id="${domain.id}">Details</button>
                        <button class="icon-btn icon-btn-danger" data-click="deleteDomain" data-id="${domain.id}" title="Delete">✕</button>
                    </td>
                </tr>`;
                html += rowHtml;
            });
        } else {
            html += `<tr><td colspan="7" class="loading">No domains in this policy</td></tr>`;
        }
    });
    tbody.innerHTML = html;
}

function togglePolicyCollapse(policyId) {
    if (state.collapsedPolicies.has(policyId)) {
        state.collapsedPolicies.delete(policyId);
    } else {
        state.collapsedPolicies.add(policyId);
    }
    renderDomains(document.getElementById('searchDomains').value);
}

function renderPolicies(filterText = '') {
    let tbody = document.getElementById('policiesList');
    let policies = state.policies.filter(policie => {
        return policie.name !== 'DELETED'
    });    
    if (filterText) {
        let search = filterText.toLowerCase();
        policies = policies.filter(policie => {
            return policie.name.toLowerCase().includes(search) ||
            (policie.description && policie.description.toLowerCase().includes(search)) ||
            (policie.mark_hex && policie.mark_hex.includes(search)) ||
            (policie.our_table && policie.our_table.toString().includes(search)) ||
            (policie.keenetic_table && policie.keenetic_table.toString().includes(search))
        });
    }

    if (policies.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" class="loading">No policies found</td></tr>';
        return;
    }
    let html = '';
    policies.forEach(policie => {
        const domainsCount = state.domains.filter(domains => {
            return domains.policy_id === policie.id
        }).length;
        const policyLists = listsData.filter(l => l.policy_id === policie.id);
        const listsCount = policyLists.length;
        const listsRoutes = policyLists.reduce((sum, l) => sum + (l.enabled ? l.n_items : 0), 0);
        const updated = toLocalDate(policie.updated_at);
        html += `<tr style="--policy-hue:${policyHue(policie.id)}">
            <td class="cell-policy-name" data-label="Name" data-col="name"><span class="policy-dot"></span><strong class="mono" data-notr>${escapeHtml(policie.name)}</strong></td>
            <td data-label="Description" data-col="description"${policie.description ? ' data-notr' : ''}>${escapeHtml(policie.description) || '<span class="muted">—</span>'}</td>
            <td data-label="Mark" data-col="mark"><code class="chip chip-mono">${escapeHtml(policie.mark_hex)}</code></td>
            <td class="cell-mono" data-label="Our table" data-col="our-table">${escapeHtml(policie.our_table)}</td>
            <td class="cell-mono" data-label="Keenetic table" data-col="keenetic-table">${escapeHtml(policie.keenetic_table) || '<span class="muted">—</span>'}</td>
            <td class="cell-mono" data-label="Lists table" data-col="lists-table">${Number(policie.our_table) + 100}</td>
            <td class="cell-mono" data-label="Targets" data-col="targets">${domainsCount}</td>
            <td class="cell-mono" data-label="Lists" data-col="lists" title="${escapeHtml(t('{0} networks', listsRoutes))}">${listsCount}</td>
            <td class="cell-mono" data-label="Traffic" data-col="traffic" id="policy-traffic-${policie.id}"><span class="muted">…</span></td>
            <td class="cell-mono" data-label="Gateway" data-col="gateway" id="policy-gateway-${policie.id}"><span class="muted">…</span></td>
            <td data-label="Updated" data-col="updated">${updated ? escapeHtml(i18nDate(updated)) : '-'}</td>
            <td class="cell-actions col-sticky-right" data-label="Actions" data-col="actions">
                <button class="icon-btn" data-click="policyRoutes" data-name="${escapeHtml(policie.name)}" title="View all routes">☰</button>
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;
}
// ============================================ РЕНДЕРИНГ ТАБЛИЦ ============================================
// ============================================ ТАБЛИЦЫ МАРШРУТИЗАЦИИ (live) ============================================
// В отличие от остального state, это не кэшируется между вкладками -
// перечитываем ядро при каждом открытии вкладки/нажатии Refresh.
async function loadRoutingTables() {
    const tbody = document.getElementById('tablesList');
    const btn = document.getElementById('refreshTablesBtn');
    const originalText = btn.textContent;
    btn.textContent = '↻ Loading...';
    btn.disabled = true;

    try {
        const result = await (await apiFetch(API + "?action=getRoutingTables")).json();
        if (!result.tables) {
            let msg = result.error || 'Failed to load';
            if (result.message) {
                msg += `: ${result.message}`;
                if (result.file) msg += ` (${result.file}:${result.line})`;
            }
            tbody.innerHTML = `<tr><td colspan="4" class="loading">${escapeHtml(msg)}</td></tr>`;
            return;
        }
        // Список отрисовывается сразу, БЕЗ количества маршрутов - это
        // дешёвая часть (ip rule show + наши политики из БД). Число
        // маршрутов на таблицу - отдельный su+wc -l на каждую, тяжелее и
        // не должно тормозить сам список.
        renderRoutingTables(result.tables);
        loadAllTableRouteCounts(result.tables);
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="4" class="loading">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

const tableRouteCounts = {};
function updateTablesSummary(tables) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (tables) {
        set('sumTables', tables.length);
        set('sumRules', tables.reduce((a, t) => a + (t.rules ? t.rules.length : 0), 0));
    }
    const vals = Object.values(tableRouteCounts);
    set('sumRoutes', vals.length ? vals.reduce((a, b) => a + b, 0).toLocaleString('ru-RU') : '…');
}

function renderRoutingTables(tables) {
    const tbody = document.getElementById('tablesList');
    for (const k in tableRouteCounts) delete tableRouteCounts[k];
    updateTablesSummary(tables);
    if (!tables.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="loading">No routing tables found</td></tr>';
        return;
    }

    tbody.innerHTML = tables.map(t => {
        let managedHtml;
        if (t.managed_by) {
            managedHtml = `<span class="mgmt-pill" style="--policy-hue:${policyHue(t.managed_by.id)}"><span class="policy-dot"></span>${escapeHtml(t.managed_by.name)}${t.managed_by.kind === 'lists' ? ' <span class="mgmt-kind">lists</span>' : ''}</span>`;
        } else {
            managedHtml = `<span class="mgmt-pill mgmt-pill-external">External</span>`;
        }

        const rulesHtml = t.rules.length
            ? t.rules.map(r => `<div class="rule-line">pref ${r.pref}: <span class="cell-mono">${escapeHtml(r.selector)}</span></div>`).join('')
            : '<span class="muted">no rule</span>';

        const refAttr = escapeHtml(t.ref);

        return `<tr data-table-ref="${refAttr}">
            <td class="mono" data-label="Table" data-col="table"><strong>${escapeHtml(t.ref)}</strong></td>
            <td data-label="Managed by" data-col="managed-by">${managedHtml}</td>
            <td data-label="Rule" data-col="rule">${rulesHtml}</td>
            <td class="cell-mono col-sticky-right" data-label="Routes" data-col="routes">
                <div class="routes-cell">
                    <span class="routes-value muted">…</span>
                    <button class="icon-btn routes-refresh" data-click="tableCount" data-ref="${refAttr}" title="Refresh route count for this table only">↻</button>
                    <button class="icon-btn routes-view" data-click="tableView" data-ref="${refAttr}" title="View routes in this table">👁</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// Считаем маршруты для ВСЕХ таблиц по очереди, не параллельно - каждый
// запрос это su (пароль + процесс), десяток одновременных su на слабом
// CPU роутера лучше не устраивать. Каждая строка обновляется по
// готовности своего запроса, не дожидаясь остальных таблиц.
async function loadAllTableRouteCounts(tables) {
    for (const t of tables) {
        await loadTableRouteCount(t.ref);
    }
}

// Количество маршрутов для ОДНОЙ таблицы - вызывается и автоматически
// после отрисовки списка, и вручную по кнопке "↻" у конкретной строки.
async function loadTableRouteCount(ref) {
    const row = document.querySelector(`tr[data-table-ref="${CSS.escape(ref)}"]`);
    if (!row) return;
    const valueEl = row.querySelector('.routes-value');
    const btnEl = row.querySelector('.routes-refresh');

    if (valueEl) { valueEl.textContent = '…'; valueEl.classList.add('muted'); }
    if (btnEl) btnEl.disabled = true;

    try {
        const result = await (await apiFetch(API + '?action=getTableRoutes&ref=' + encodeURIComponent(ref))).json();
        if (valueEl) {
            if (typeof result.routes === 'number') {
                valueEl.textContent = result.routes;
                valueEl.classList.remove('muted');
                tableRouteCounts[ref] = result.routes;
                updateTablesSummary();
            } else {
                valueEl.textContent = 'error';
            }
        }
    } catch (error) {
        if (valueEl) valueEl.textContent = 'error';
    } finally {
        if (btnEl) btnEl.disabled = false;
    }
}

// ============================================ ОКНО ПРОСМОТРА СОДЕРЖИМОГО ТАБЛИЦЫ ============================================
// Ленивая подгрузка по 100 строк за раз (подгружаются по мере скролла
// вниз), фильтр - СЕРВЕРНЫЙ: каждый ввод переспрашивает роутер заново с
// начала (offset=0), а не фильтрует то, что уже долистали. Иначе можно
// было бы долистать 300 строк, ввести фильтр - и не найти маршрут,
// который реально есть, но лежит дальше уже подгруженного куска.
let tableViewState = { ref: null, offset: 0, limit: 100, filter: '', hasMore: false, loading: false, seq: 0 };
let tableViewFilterTimer = null;

function openTableView(ref) {
    tableViewState = { ref, offset: 0, limit: 100, filter: '', hasMore: false, loading: false, seq: 0 };
    document.getElementById('tableViewTitle').textContent = `Routes in table ${ref}`;
    document.getElementById('tableViewFilter').value = '';
    document.getElementById('tableViewList').innerHTML = '';
    document.getElementById('tableViewStatus').textContent = '';
    document.getElementById('tableViewModal').style.display = 'block';
    loadTableViewPage(true);
}

function closeTableView() {
    document.getElementById('tableViewModal').style.display = 'none';
    tableViewState.ref = null; // ответы на уже улетевшие запросы дальше игнорируются (см. seq ниже)
}

async function loadTableViewPage(reset = false) {
    if (!tableViewState.ref || tableViewState.loading) return;
    if (!reset && !tableViewState.hasMore) return;

    tableViewState.loading = true;
    const mySeq = ++tableViewState.seq; // сменился фильтр/окно закрыли - старый ответ прилетит, но seq уже не совпадёт
    const statusEl = document.getElementById('tableViewStatus');
    const listEl = document.getElementById('tableViewList');
    statusEl.textContent = 'Loading…';

    if (reset) {
        tableViewState.offset = 0;
        listEl.innerHTML = '';
    }

    try {
        const params = new URLSearchParams({
            action: 'getTableRoutesPage',
            ref: tableViewState.ref,
            offset: tableViewState.offset,
            limit: tableViewState.limit,
            q: tableViewState.filter,
        });
        const result = await (await apiFetch(API + '?' + params.toString())).json();

        if (mySeq !== tableViewState.seq || !tableViewState.ref) return; // устарело или окно уже закрыто

        if (!Array.isArray(result.lines)) {
            statusEl.textContent = result.error || 'Failed to load';
            return;
        }

        if (result.lines.length === 0 && tableViewState.offset === 0) {
            listEl.innerHTML = '<div class="table-view-empty">No matching routes</div>';
        } else {
            listEl.insertAdjacentHTML(
                'beforeend',
                result.lines.map(l => `<div class="route-line-item">${escapeHtml(l)}</div>`).join('')
            );
        }

        tableViewState.offset += result.lines.length;
        tableViewState.hasMore = !!result.has_more;
        statusEl.textContent = tableViewState.hasMore
            ? `Loaded ${tableViewState.offset} - scroll for more`
            : `Loaded ${tableViewState.offset} total`;
    } catch (error) {
        if (mySeq === tableViewState.seq) statusEl.textContent = 'Failed to load: ' + error.message;
    } finally {
        if (mySeq === tableViewState.seq) tableViewState.loading = false;
    }
}
// ============================================ ОКНО ПРОСМОТРА СОДЕРЖИМОГО ТАБЛИЦЫ ============================================
// ============================================ TEST ROUTE ============================================
// Симулирует пакет через `ip route get` - показывает, куда РЕАЛЬНО уйдёт
// трафик с учётом всех ip rule. Без выбранной политики пакет не попадёт
// ни под одно fwmark-правило, поэтому выбор политики подставляет её
// mark_hex - это и есть проверка "уйдёт ли этот IP через нужную политику".
// Кнопка "Test" в списке Targets - тот же Test Route, что и на вкладке
// Tools, просто заранее заполнен доменом/IP/CIDR и меткой политики
// конкретной цели, вместо того чтобы переключаться на Tools и вводить
// всё руками.
function quickTestRoute(domainId) {
    const domain = state.domains.find(d => d.id === domainId);
    if (!domain) return;

    const policy = state.policies.find(p => p.id === domain.policy_id);
    openTestRouteModal({ domain: domain.domain, markHex: policy ? policy.mark_hex : null, targetId: domain.id });
}

function openTestRouteModal(prefill = null) {
    const select = document.getElementById('testRoutePolicy');
    select.innerHTML = '<option value="">No policy (plain routing, no mark)</option>' +
        state.policies
            .filter(p => p.name !== 'DELETED')
            .map(p => `<option value="${escapeHtml(p.mark_hex)}">${escapeHtml(p.description || p.name)} (${escapeHtml(p.name)})</option>`)
            .join('');

    document.getElementById('testRouteIp').value = prefill && prefill.domain ? prefill.domain : '';
    if (prefill && prefill.markHex) {
        select.value = prefill.markHex;
    }
    document.getElementById('testRouteResult').textContent = '';
    const own = prefill && prefill.targetId ? state.domains.find(d => d.id === prefill.targetId) : null;
    targetDetailId = own ? own.id : null;
    showTarget('route', { tabs: !!own, title: own ? own.domain : 'Test Route' });
    document.getElementById('testRouteIp').focus();
}

function closeTestRouteModal() {
    closeModal();
}

async function runTestRoute() {
    const target = document.getElementById('testRouteIp').value.trim();
    const mark = document.getElementById('testRoutePolicy').value;
    const resultEl = document.getElementById('testRouteResult');
    const btn = document.getElementById('testRouteRun');

    if (!target) {
        resultEl.textContent = 'Enter a destination IP, CIDR or domain first.';
        return;
    }

    const originalText = btn.textContent;
    btn.textContent = 'Testing...';
    btn.disabled = true;
    resultEl.textContent = 'Resolving and testing…';

    try {
        const params = new URLSearchParams({ action: 'testRoute', target });
        if (mark) params.set('mark', mark);

        const result = await (await apiFetch(API + '?' + params.toString())).json();
        renderTestRouteResult(result);
        if (document.getElementById('trCurlOn').checked) await runTestRouteCurl(target, result);
    } catch (error) {
        resultEl.textContent = 'Failed: ' + error.message;
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// Один хэш-хук для оттенка, привязанный к значению таблицы (а не к id
// политики, как policyHue) - тот же диапазон 190-330°, тот же визуальный
// язык, что и цветные маркеры политик, но своя раскраска именно для
// "какая таблица" внутри результата Test Route.
function hueForTable(tableKey) {
    let hash = 0;
    const s = String(tableKey);
    for (let i = 0; i < s.length; i++) {
        hash = (hash * 31 + s.charCodeAt(i)) % 1000;
    }
    return 190 + (hash % 140);
}

// One row per address; a click opens its details (route fields, raw output, the curl answer) right under it
function renderTestRouteResult(response) {
    const resultEl = document.getElementById('testRouteResult');

    if (!response || response.type === 'error' || !Array.isArray(response.results) || !response.results.length) {
        resultEl.textContent = (response && response.error) || 'Unexpected response';
        return;
    }

    const tableKeys = response.results.map(r => (r.parsed && r.parsed.table) || 'main');
    const distinctTables = new Set(tableKeys);
    const single = response.results.length === 1;
    const curl = document.getElementById('trCurlOn').checked;

    let html = '';
    if (response.type === 'domain') {
        const by = (response.resolver || 'system').split(', ').map(x => x === 'system' ? t('System resolver') : `${dnsName(x)} ${x}`.trim()).join(', ');
        html += `<div class="test-route-summary">${escapeHtml(response.target)} resolved to ${response.results.length} IP(s)` +
            (distinctTables.size > 1 ? ` - across ${distinctTables.size} different tables` : '') +
            `</div><div class="test-route-note">${escapeHtml(t('Resolved by: {0}', by))}</div>`;
    }
    if (response.note) html += `<div class="test-route-note">${escapeHtml(response.note)}</div>`;

    html += `<table class="route-summary-table tr-rows"><thead><tr><th>IP</th><th>Table</th><th>Via</th>${curl ? '<th class="tr-th-curl">curl</th>' : ''}<th></th></tr></thead><tbody>`;
    response.results.forEach((r, i) => {
        const hue = hueForTable(tableKeys[i]);
        const p = r.parsed || {};
        const via = [p.gateway, p.dev].filter(Boolean).join(' / ') || '—';
        const fields = [['Destination', p.destination], ['Gateway', p.gateway], ['Interface', p.dev], ['Table', p.table], ['Source', p.src], ['Mark', p.mark]].filter(([, v]) => !!v);
        const fieldsHtml = fields.length
            ? '<table class="route-result-table">' + fields.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td class="cell-mono">${escapeHtml(value)}</td></tr>`).join('') + '</table>'
            : '<div class="muted">No route found</div>';
        html += `<tr class="tr-row${single ? ' open' : ''}" data-ip="${escapeHtml(r.ip)}" data-dev="${escapeHtml(p.dev || '')}">
                <td class="cell-mono"><span class="policy-dot" style="--policy-hue:${hue}"></span>${escapeHtml(r.ip)}</td>
                <td class="cell-mono">${escapeHtml(p.table || 'main')}</td>
                <td class="cell-mono">${escapeHtml(via)}</td>
                ${curl ? `<td class="tr-curl-pill" data-ip="${escapeHtml(r.ip)}"><span class="muted">—</span></td>` : ''}
                <td class="tr-caret">▸</td>
            </tr>
            <tr class="tr-detail" data-ip="${escapeHtml(r.ip)}"${single ? '' : ' hidden'}><td colspan="${curl ? 5 : 4}">
                ${fieldsHtml}
                <div class="tr-curl-result" data-ip="${escapeHtml(r.ip)}" hidden></div>
                <details class="tr-curl-more"><summary>Raw output</summary><pre class="test-route-raw">${escapeHtml(r.raw || '(empty output)')}</pre></details>
            </td></tr>`;
    });
    html += '</tbody></table>';
    resultEl.innerHTML = html;
}

document.getElementById('testRouteResult').addEventListener('click', (e) => {
    const row = e.target.closest('.tr-row');
    if (!row) return;
    const detail = row.nextElementSibling;
    const open = !row.classList.contains('open');
    row.classList.toggle('open', open);
    detail.hidden = !open;
    // an address beyond the first three gets its curl request when it is opened
    if (open && document.getElementById('trCurlOn').checked && !detail.querySelector('.tr-curl-result').dataset.done) {
        testRouteCurlOne(document.getElementById('testRouteIp').value.trim(), row.dataset.ip, row.dataset.dev);
    }
});

// curl through the interface of each found route: the first three one by one, the others when their row is opened
async function runTestRouteCurl(target, route) {
    if (!route || !Array.isArray(route.results)) return;
    const jobs = route.results.filter(r => r.parsed && /^\d+\.\d+\.\d+\.\d+$/.test(r.ip)).slice(0, 3);
    for (const r of jobs) await testRouteCurlOne(target, r.ip, r.parsed.dev || '');
}

async function testRouteCurlOne(target, ip, dev) {
    const box = document.querySelector(`.tr-curl-result[data-ip="${CSS.escape(ip)}"]`);
    const pill = document.querySelector(`.tr-curl-pill[data-ip="${CSS.escape(ip)}"]`);
    if (!box || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
    box.dataset.done = '1';
    box.hidden = false;
    box.innerHTML = `<div class="muted">${escapeHtml(t('curl: sending the request through {0}…', dev || t('main route')))}</div>`;
    if (pill) pill.innerHTML = '<span class="muted">…</span>';
    const payload = {
        action: 'testRouteCurl', target, ip, dev,
        scheme: document.getElementById('trCurlScheme').value,
        sni: document.getElementById('trCurlSni').value.trim(),
        path: document.getElementById('trCurlPath').value.trim(),
        tls: document.getElementById('trCurlTls').value,
    };
    try {
        const c = await api(payload);
        box.innerHTML = renderTestRouteCurl(c);
        if (pill) pill.innerHTML = c.error ? '<span class="dpi-r rst">ERR</span>' : `<span class="dpi-r ${c.result.class}" data-tip="${escapeHtml(tLines(c.result.note))}">${escapeHtml(t(c.result.code))}</span>`;
    } catch (e) {
        box.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
        if (pill) pill.innerHTML = '<span class="dpi-r rst">ERR</span>';
    }
}

function renderTestRouteCurl(c) {
    if (c.error) return `<div class="tr-curl-head"><span class="dpi-r rst">curl</span> ${escapeHtml(t(c.error))}</div>`;
    const ms = v => v > 0 ? Math.round(v * 1000) + ' ' + t('ms') : '—';
    const facts = [
        c.http ? 'HTTP ' + c.http + (c.http_version ? ' (HTTP/' + c.http_version + ')' : '') : '',
        c.tls,
        t('TCP {0}', ms(c.times.connect)),
        c.times.tls > 0 ? t('TLS {0}', ms(c.times.tls)) : '',
        t('first byte {0}', ms(c.times.first_byte)),
        t('total {0}', ms(c.times.total)),
    ].filter(Boolean);
    let html = `<div class="tr-curl-head"><span class="dpi-r ${c.result.class}" data-tip="${escapeHtml(tLines(c.result.note))}">${escapeHtml(t(c.result.code))}</span>`
        + `<span class="cell-mono">${escapeHtml(c.url)}</span></div>`;
    html += `<div class="tr-curl-line">${escapeHtml(c.ip)} · ${escapeHtml(c.dev || t('main route'))} · ${escapeHtml(c.sni ? t('SNI: {0}', c.sni) : t('without SNI'))}</div>`;
    html += `<div class="tr-curl-line">${facts.map(escapeHtml).join(' · ')}</div>`;
    if (c.result.class !== 'ok') html += `<div class="tr-curl-line muted">${escapeHtml(tLines(c.result.note))}</div>`;
    if (c.redirect) html += `<div class="tr-curl-line">${escapeHtml(t('Redirect: {0}', c.redirect))}</div>`;
    if (c.cert) {
        const names = c.cert.names.length ? c.cert.names.slice(0, 6).join(', ') + (c.cert.names.length > 6 ? ' +' + (c.cert.names.length - 6) : '') : '';
        html += '<table class="route-result-table tr-curl-cert">'
            + [[t('Certificate'), c.cert.subject], [t('Issued by'), c.cert.issuer], [t('Names'), names], [t('Valid until'), c.cert.until]]
                .filter(([, v]) => v).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td class="cell-mono">${escapeHtml(v)}</td></tr>`).join('')
            + '</table>';
    }
    if (c.headers.length) html += `<details class="tr-curl-more"><summary>${escapeHtml(t('Response headers'))}</summary><pre class="test-route-raw" data-notr>${escapeHtml(c.headers.join('\n'))}</pre></details>`;
    html += `<details class="tr-curl-more"><summary>${escapeHtml(t('curl log'))}</summary><pre class="test-route-raw" data-notr>${escapeHtml(c.log.join('\n'))}</pre></details>`;
    return html;
}

// The white SNI picker: the names that passed in the last DPI check first, then the whole White SNI list
async function fillTrWhiteSni() {
    const [lists, dpi] = await Promise.all([
        apiFetch(API + '?action=getDpiLists').then(r => r.json()),
        apiFetch(API + '?action=getDpi').then(r => r.json()),
    ]);
    const passed = {};
    const tried = {};
    ((dpi.run && dpi.run.sni) || []).forEach(g => dpiSniResults(g).forEach(r => {
        tried[r.sni] = (tried[r.sni] || 0) + 1;
        if (r.verdict === 'ok') passed[r.sni] = (passed[r.sni] || 0) + 1;
    }));
    const names = (lists.lists ? lists.lists.sni : '').split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
    const best = Object.keys(passed).sort((a, b) => passed[b] - passed[a]);
    let html = `<option value="">${escapeHtml(t('White SNI…'))}</option>`;
    if (best.length) {
        html += `<optgroup label="${escapeHtml(t('Passed in the last check'))}">`
            + best.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)} — ${escapeHtml(t('{0} of {1}', passed[n], tried[n]))}</option>`).join('')
            + '</optgroup>';
    }
    html += `<optgroup label="${escapeHtml(t('White SNI list'))}">` + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') + '</optgroup>';
    document.getElementById('trCurlWhite').innerHTML = html;
}

document.getElementById('trCurlOn').addEventListener('change', (e) => {
    document.getElementById('trCurlFields').hidden = !e.target.checked;
    if (e.target.checked) fillTrWhiteSni();
});
document.getElementById('trCurlWhite').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('trCurlSni').value = e.target.value;
    e.target.value = '';
});
// ============================================ TEST ROUTE ============================================
// ============================================ ТАБЛИЦЫ МАРШРУТИЗАЦИИ (live) ============================================
// ============================================ РАБОТА С МОДАЛЬНЫМ ОКНОМ ============================================
// A new target starts with the exit its policy already uses, so the fields show what will really be saved
let domainExitAuto = true;

function fillDomainExit() {
    const exit = policyExit(+document.getElementById('domainPolicy').value);
    fillInterfaceSelect('domainInterface', exit.interface);
    document.getElementById('domainGateway').value = exit.gateway;
    domainExitAuto = true;
}

document.getElementById('domainPolicy').addEventListener('change', () => {
    if (!document.getElementById('domainId').value && domainExitAuto) fillDomainExit();
});
document.getElementById('domainInterface').addEventListener('change', () => { domainExitAuto = false; });
document.getElementById('domainGateway').addEventListener('input', () => { domainExitAuto = false; });

function openDomainModal(id = null, prefill = null) {
    const form = document.getElementById('domainForm');
    
    // Заполняем селект политик
    const policySelect = document.getElementById('domainPolicy');
    policySelect.innerHTML = state.policies.filter(policie => {
        return policie.name !== 'DELETED'
    }).map(policie => {
        if (policie.description == "") {
            return '<option value="'+policie.id+'">'+escapeHtml(policie.name)+'</option>'
        } else {
            return '<option value="'+policie.id+'">'+escapeHtml(policie.description)+' ('+escapeHtml(policie.name)+')</option>'
        }
        
    }).join('');    
    if (id) {
        let domain = state.domains.filter(domain=>{
            return domain.id == id
        })[0];
        targetDetailId = domain.id;
        document.getElementById('domainId').value = domain.id;
        document.getElementById('domainName').value = domain.domain;
        document.getElementById('domainPolicy').value = domain.policy_id;
        fillInterfaceSelect('domainInterface', domain.interface || '');
        document.getElementById('domainGateway').value = domain.gateway || '';
        document.getElementById('domainEnabled').checked = domain.enabled == 1;
        document.getElementById('domainNameHint').style.display = 'none'; // редактируем одну существующую запись - подсказка про "по строке на цель" тут не к месту
    } else {
        targetDetailId = null;
        form.reset();
        fillInterfaceSelect('domainInterface', '');
        document.getElementById('domainId').value = '';
        document.getElementById('domainEnabled').checked = true;
        document.getElementById('domainNameHint').style.display = 'block';
        // Быстрое добавление из окна соединений (Clients) - домен/IP и
        // политика уже известны заранее, просто подставляем их в форму,
        // остальное (interface/gateway) пользователь при желании дозаполнит сам.
        if (prefill) {
            if (prefill.domain) document.getElementById('domainName').value = prefill.domain;
            if (prefill.policyId) document.getElementById('domainPolicy').value = prefill.policyId;
        }
        fillDomainExit();
    }
    
    if (id) showTarget('edit', { tabs: true, title: state.domains.find(d => d.id == id).domain });
    else showTarget('edit', { tabs: false, title: 'Add Target' });
}

function closeModal() {
    document.getElementById('targetModal').style.display = 'none';

    if (reopenConnectionsAfterModal) {
        reopenConnectionsAfterModal = false;
        if (currentConnIp) {
            document.getElementById('clientDetailModal').style.display = 'block';
            fetchConnections(); // тот же клиент, что был открыт до Add Target - currentConnIp/currentConnLabel уже сохранены
        }
    }
}
// ============================================ РАБОТА С МОДАЛЬНЫМ ОКНОМ ============================================
// ============================================ СОХРАНЕНИЕ ДОМЕНА ============================================
async function saveDomain(event) {
    event.preventDefault();

    const id = document.getElementById('domainId').value;
    const rawLines = document.getElementById('domainName').value
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');

    if (rawLines.length === 0) {
        showToast('Enter at least one domain, IP or CIDR', 'error');
        return;
    }
    if (id && rawLines.length > 1) {
        // Редактирование - это ровно одна существующая запись, несколько
        // строк тут не имеют смысла (непонятно, какую из них сохранять).
        showToast('Editing only supports a single value - remove the extra lines', 'error', 8000);
        return;
    }

    if (!document.getElementById('domainInterface').value && !document.getElementById('domainGateway').value.trim()) {
        showToast('Set an interface or a gateway: a route needs an exit', 'error', 6000);
        return;
    }

    const common = {
        policy_id: parseInt(document.getElementById('domainPolicy').value),
        interface: document.getElementById('domainInterface').value || null,
        gateway: document.getElementById('domainGateway').value || null,
        enabled: document.getElementById('domainEnabled').checked ? 1 : 0
    };

    try {
        showLoading(rawLines.length > 1 ? `Saving ${rawLines.length} targets…` : 'Saving target…');

        // Один POST на строку - переиспользует тот же addDomain, что и
        // раньше для одиночного добавления, никакого отдельного bulk-
        // эндпоинта не заводим. Последовательно, а не Promise.all - не
        // заваливать php-fpm/SQLite параллельной записью на слабом роутере.
        // One target is applied by the server right away; several are saved first and applied once.
        const bulk = rawLines.length > 1;
        let succeeded = 0;
        const savedIds = [];
        const errors = [];
        for (const line of rawLines) {
            const response = await apiFetch(API, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    action: id ? 'updateDomain' : 'addDomain',
                    id: id || undefined,
                    domain: line,
                    defer: bulk ? 1 : undefined,
                    ...common
                })
            });
            const result = await response.json();
            if (result.success) {
                succeeded++;
                savedIds.push(id || result.id);
            } else {
                errors.push(`${line}: ${result.error}`);
            }
        }

        if (succeeded > 0) {
            closeModal();
            if (bulk) await api({ action: 'startJob', kind: 'sync', targets: savedIds });
            loadData();
            pollJob();
        }

        if (rawLines.length === 1) {
            if (succeeded === 1) {
                showToast(id ? 'Target updated' : 'Target added', 'success');
            } else {
                showToast('Save failed: ' + errors[0], 'error', 8000);
            }
        } else {
            const failed = rawLines.length - succeeded;
            if (failed === 0) {
                showToast(`${succeeded} targets added`, 'success');
            } else {
                showToast(`${succeeded} added, ${failed} failed:\n${errors.join('\n')}`, 'error', 10000);
            }
        }
    } catch (error) {
        showToast('Failed to save domain: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
    }
}
// ============================================ СОХРАНЕНИЕ ДОМЕНА ============================================
// ============================================ УДАЛЕНИЕ ДОМЕНА ============================================
async function deleteDomain(id) {
    const ok = await showConfirm('Delete this target? This can\'t be undone.', 'Delete');
    if (!ok) return;
    
    try {
        showLoading('Deleting target…');
        const response = await apiFetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                action: 'deleteDomain',
                id: id
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            loadData();
            pollJob();
            showToast('Target deleted', 'success');
        } else {
            showToast('Delete failed: ' + result.error, 'error', 8000);
        }
    } catch (error) {
        showToast('Failed to delete domain: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
    }
}
// ============================================ УДАЛЕНИЕ ДОМЕНА ============================================
// ============================================ ЭКСПОРТ / ИМПОРТ НАСТРОЕК ============================================
async function exportConfig() {
    try {
        showLoading('Exporting…');
        const response = await apiFetch(API + "?action=exportConfig");
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast('Export failed: ' + (err.error || response.statusText), 'error', 8000);
            return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const a = document.createElement('a');
        a.href = url;
        a.download = `keenetic-dns-router-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('Config exported', 'success');
    } catch (error) {
        showToast('Export failed: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
    }
}

// Asks which policy of this router receives the targets of each policy in the file.
function showImportDialog(parsed) {
    return new Promise((resolve) => {
        const counts = new Map();
        for (const d of parsed.domains) {
            const n = d && d.policy !== undefined && d.policy !== null ? String(d.policy) : '';
            counts.set(n, (counts.get(n) || 0) + 1);
        }
        const local = state.policies.filter(p => p.name !== 'DELETED');
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.style.display = 'block';
        const box = document.createElement('div');
        box.className = 'modal-content confirm-content imp-dialog';
        const rows = [...counts].map(([name, n], i) => {
            const same = local.some(p => p.name === name);
            const def = same ? name : (local.length === 1 ? local[0].name : '');
            const opts = ['<option value="">' + escapeHtml(t('Do not import')) + '</option>']
                .concat(local.map(p => `<option value="${escapeHtml(p.name)}"${p.name === def ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)).join('');
            return `<div class="imp-row"><div class="imp-src"><b data-notr>${escapeHtml(name || '(no policy)')}</b> <span class="muted">${escapeHtml(t('{0} target(s)', n))}</span></div>`
                + `<span class="imp-arrow">→</span><select class="imp-sel" data-src="${i}">${opts}</select></div>`;
        }).join('');
        box.innerHTML = `<h3>${escapeHtml(t('Import targets'))}</h3>`
            + `<p class="confirm-msg">${escapeHtml(t('Choose which policy of this router receives the targets of each policy in the file.'))}</p>`
            + rows
            + `<label class="imp-prune"><input type="checkbox" id="impPrune"> <span>${escapeHtml(t('Remove targets that are not in the file (from the chosen policies)'))}</span></label>`
            + `<div class="form-actions"><button type="button" class="btn btn-primary" id="impOk">${escapeHtml(t('Import'))}</button><button type="button" class="btn" id="impNo">${escapeHtml(t('Cancel'))}</button></div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const names = [...counts.keys()];
        const done = (r) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(r); };
        const onKey = (e) => { if (e.key === 'Escape') done(null); };
        document.addEventListener('keydown', onKey);
        box.querySelector('#impNo').addEventListener('click', () => done(null));
        box.querySelector('#impOk').addEventListener('click', () => {
            const map = {};
            box.querySelectorAll('.imp-sel').forEach(sel => { map[names[+sel.dataset.src]] = sel.value; });
            if (!Object.values(map).some(v => v)) { showToast('Choose at least one policy to import into', 'warning'); return; }
            done({ map, prune: box.querySelector('#impPrune').checked });
        });
    });
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    event.target.value = ''; // сбрасываем - иначе повторный выбор того же файла не сработает

    if (!file) return;

    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch (error) {
        showToast('Not a valid JSON file: ' + error.message, 'error', 8000);
        return;
    }

    if (!parsed || !Array.isArray(parsed.domains)) {
        showToast('This does not look like a config export (no "domains" array)', 'error', 8000);
        return;
    }

    const choice = await showImportDialog(parsed);
    if (!choice) return;
    parsed = { ...parsed, map: choice.map, prune: choice.prune };

    try {
        showLoading('Importing…');
        const response = await apiFetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ action: 'importConfig', ...parsed })
        });
        const result = await response.json();

        if (result.success) {
            loadData();
            showToast(`Imported ${result.imported}, updated ${result.updated}, removed ${result.removed}`, 'success');
            if (result.skipped && result.skipped.length) {
                showToast('Skipped (unknown policy or invalid):\n' + result.skipped.join(', '), 'warning', 9000);
            }
        } else {
            showToast('Import failed: ' + result.error, 'error', 8000);
        }
    } catch (error) {
        showToast('Import failed: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
    }
}
// ============================================ ЭКСПОРТ / ИМПОРТ НАСТРОЕК ============================================
// ============================================ СИНХРОНИЗАЦИЯ ПОЛИТИК ============================================
async function syncPolicies() {
    const btn = document.getElementById('refreshPolicies');
    const originalText = btn.textContent;
    
    btn.textContent = 'Syncing...';
    btn.disabled = true;
    
    try {
        showLoading('Syncing policies with Keenetic…');
        let result = await api({ action: 'syncPolicies' });
        if (result.success) {
            loadData();
            refreshBirdPolicyOptions();
            const parts = [];
            if (result.added) parts.push(`${result.added} added`);
            if (result.updated) parts.push(`${result.updated} updated`);
            if (result.removed) parts.push(`${result.removed} removed`);
            showToast(parts.length ? `Policies synced: ${parts.join(', ')}` : 'Policies synced: no changes', 'success');
            if (result.php_warnings && result.php_warnings.length) {
                showToast('PHP warnings:\n' + result.php_warnings.join('\n'), 'warning', 9000);
            }
        } else {
            showToast('Sync failed: ' + result.error, 'error', 8000);
        }
    } catch (error) {
        showToast('Failed to sync policies: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        btn.textContent = originalText;
        btn.disabled = false;
    }
}
// ============================================ СИНХРОНИЗАЦИЯ ПОЛИТИК ============================================
// ============================================ Применение маршрутов ============================================
// One window for every long action: a checklist of what the router does, with the log on demand.
const JOB_TITLES = { all: 'Refresh everything', targets: 'Update & apply', lists: 'Update all lists', apply: 'Apply routes', event: 'Refresh after a router event', sync: 'Apply changes' };
// The kinds a person can start; the others are started by the router itself
const JOB_MENU = ['all', 'targets', 'lists', 'apply'];
const JOB_STEPS = {
    all: ['targets', 'lists', 'apply'],
    targets: ['targets', 'apply'],
    lists: ['lists', 'apply'],
    apply: ['apply'],
    event: ['targets', 'lists', 'apply'],
    sync: ['targets', 'lists', 'apply'],
};
// What each kind of task does: the "New task" menu is built from this list, so a new kind is one more line here and in JOB_TITLES / JOB_STEPS
const JOB_NOTES = {
    all: 'Resolves the targets, updates every list and writes the routes.',
    targets: 'Resolves the targets again and writes the routes.',
    lists: 'Downloads every list again and writes the routes.',
    apply: 'Only writes the routes from what is stored.',
};
const JOB_STEP_NAMES = {
    pause: 'Pause between tasks',
    targets: 'Resolving the domains of the targets',
    lists: 'Downloading the lists from the source',
    apply: 'Writing the routes into the tables',
};
let jobTimer = null;
let jobShown = null;
let jobStarting = false;
let jobBusyText = '';
let jobQueue = [];
const JOB_SOURCES = { panel: 'Panel', hook: 'Router event' };

function jobModalOpen() {
    return document.getElementById('jobModal').style.display === 'block';
}

// While a job runs and its window is closed, a pill at the bottom shows where it is; a click brings the window back
function renderJobPill() {
    const pill = document.getElementById('jobPill');
    const job = jobShown;
    const running = !!job && job.state === 'running';
    document.body.classList.toggle('job-running', running);
    for (const id of ['refreshAll', 'applyRoutes', 'checkApply', 'syncListsBtn']) {
        const button = document.getElementById(id);
        if (button.dataset.title === undefined) button.dataset.title = button.title;
        button.disabled = running;
        button.title = running ? t('An update is running: wait for it to finish (the pill at the bottom shows where it is)') : button.dataset.title;
    }
    if (!job || job.state !== 'running' || jobModalOpen()) {
        pill.hidden = true;
        return;
    }
    let text = t(JOB_TITLES[job.kind]) + ' · ' + t(JOB_STEP_NAMES[job.step]);
    if (job.step === 'lists') text += ' · ' + t('{0} of {1}', job.done, job.total);
    if (jobQueue.length) text += ' · ' + t('queued: {0}', jobQueue.length);
    document.getElementById('jobPillText').textContent = text;
    pill.hidden = false;
}

function jobModalShow() {
    document.getElementById('jobModal').style.display = 'block';
    renderJobPill();
    loadJobHistory();
}

function jobModalHide() {
    document.getElementById('jobModal').style.display = 'none';
    renderJobPill();
}

function jobStepRow(cls, text) {
    return `<div class="res-row ${cls}"><i></i><span>${escapeHtml(text)}</span></div>`;
}

function jobStepText(key, job) {
    let text = t(JOB_STEP_NAMES[key]);
    const reached = job.steps.indexOf(job.step) >= job.steps.indexOf(key) || job.state === 'done';
    if (key === 'targets' && job.targets_changed !== undefined) {
        text += ' — ' + t('changed: {0}', job.targets_changed);
        if (job.target_errors) text += ', ' + t('not resolved: {0}', job.target_errors);
    }
    if (key === 'lists' && reached) {
        text += ' — ' + t('{0} of {1}', job.done, job.total);
        if (job.failed) text += ', ' + t('failed: {0}', job.failed);
        if (job.held) text += ', ' + t('held back: {0}', job.held);
    }
    if (key === 'apply' && job.state === 'done') text += ' — ' + t('routes: {0}', job.routes);
    return text;
}

function jobStepsHtml(job) {
    const current = job.steps.indexOf(job.step);
    const pause = job.step === 'pause' ? jobStepRow('res-work', t('Pause before the task: {0} s', job.delay)) : '';
    return pause + job.steps.map((key, i) => {
        let cls = '';
        if (job.state === 'done' || i < current) cls = 'res-ok';
        else if (i === current) cls = { running: 'res-work', error: 'res-bad', cancelled: 'res-warn' }[job.state];
        return jobStepRow(cls, jobStepText(key, job));
    }).join('');
}

function jobTimeText(seconds) {
    return new Date(seconds * 1000).toLocaleTimeString(i18nLocale(), { hour: '2-digit', minute: '2-digit' });
}

function jobDuration(item) {
    const seconds = Math.max(0, item.finished - item.started);
    return seconds < 60 ? t('{0} s', seconds) : t('{0} min {1} s', Math.floor(seconds / 60), seconds % 60);
}

function jobAgo(seconds) {
    return t(timeAgo(new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')));
}

// What the router is doing right now, in words
function jobNoteText(job) {
    let text = '';
    if (job.state === 'running') {
        if (job.step === 'lists' && job.site) {
            const stage = job.stage.split(': ');
            text = job.site + ': ' + t(stage[0]) + (stage[1] ? ': ' + stage[1] : '');
        } else if (job.step === 'targets') {
            text = t('The DNS servers from Settings are asked for every target; this can take a minute.');
        }
        return text;
    }
    if (job.state === 'done') {
        if (job.route_errors) text += t('The router rejected {0} routes: {1}', job.route_errors, job.route_error || '') + ' ';
        if (job.failed) text += t('{0} lists failed to update: see the Status column', job.failed) + ' ';
        if (job.held) text += t('{0} lists held back: too many entries disappeared', job.held);
        return text.trim();
    }
    if (job.state === 'cancelled') return t('Cancelled.');
    return t('Failed') + ': ' + t(job.error || '');
}

// ---- the task manager: one accordion of tasks (running, waiting, finished)
let jobHistoryItems = [];
const taskOpen = new Set(['run']);
const taskLogOpen = new Set();
const taskLogs = {};

function taskHtml(t0) {
    const open = taskOpen.has(t0.key);
    const logShown = taskLogOpen.has(t0.key);
    let body = `<div class="res-box">${t0.steps}</div>`;
    if (t0.note) body += `<div class="card-note job-note">${escapeHtml(t0.note)}</div>`;
    if (logShown) body += `<pre class="job-log">${escapeHtml(t0.log || t('The log is empty.'))}</pre>`;
    let actions = '';
    if (t0.hasLog) actions += `<button type="button" class="btn btn-small" data-act="log" data-key="${escapeHtml(t0.key)}">${escapeHtml(t(logShown ? 'Hide log' : 'Show log'))}</button>`;
    if (t0.stoppable) actions += `<button type="button" class="btn btn-small btn-warn" data-act="stop">${escapeHtml(t('Cancel'))}</button>`;
    if (actions) body += `<div class="job-actions">${actions}</div>`;
    return `<div class="task${open ? ' open' : ''}" data-key="${escapeHtml(t0.key)}">
        <div class="task-bar" role="button" tabindex="0">
            ${t0.lead}
            <div class="task-main"><strong>${escapeHtml(t0.title)}</strong><span class="task-meta">${escapeHtml(t0.meta)}</span></div>
            ${t0.badge ? `<span class="task-badge">${escapeHtml(t0.badge)}</span>` : ''}
            ${t0.remove || ''}
            <span class="task-caret">▾</span>
        </div>
        <div class="task-body">${body}</div>
    </div>`;
}

function taskSection(title, count, items, extra = '') {
    return `<div class="task-section"><h3>${escapeHtml(title)}${count ? `<span>${count}</span>` : ''}</h3>${extra}</div><div class="task-list">${items}</div>`;
}

function renderTasks() {
    const box = document.getElementById('jobTasks');
    const saved = {};
    box.querySelectorAll('.task').forEach(el => {
        const log = el.querySelector('.job-log');
        if (log) saved[el.dataset.key] = [log.scrollTop, log.scrollTop + log.clientHeight >= log.scrollHeight - 20];
    });
    let html = '';
    const job = jobShown;
    if (job && job.state === 'running') {
        const badge = job.step === 'lists' ? t('{0} of {1}', job.done, job.total) : '';
        html += taskSection(t('Running now'), 0, taskHtml({
            key: 'run', lead: '<span class="task-spin"></span>', title: t(JOB_TITLES[job.kind]),
            meta: t(JOB_SOURCES[job.source] || job.source || 'Panel') + (job.started ? ' · ' + t('started {0}', jobTimeText(job.started)) : ''),
            badge, steps: jobStepsHtml(job), note: jobNoteText(job), log: job.log, hasLog: true, stoppable: job.step !== 'apply',
        }));
    } else {
        html += `<p class="card-note task-idle">${escapeHtml(t('Nothing is running'))}</p>`;
    }
    if (jobQueue.length) {
        html += taskSection(t('Queue'), jobQueue.length, jobQueue.map((item, i) => taskHtml({
            key: 'q:' + item.qid, lead: `<span class="task-pos">${i + 1}</span>`, title: t(JOB_TITLES[item.kind]),
            meta: t(JOB_SOURCES[item.source] || item.source) + ' · ' + t('added {0}', jobAgo(item.added)), badge: '',
            steps: (item.kind === 'sync' ? ['targets'].filter(() => item.targets.length).concat(['lists'].filter(() => item.lists.length), ['apply']) : JOB_STEPS[item.kind]).map(key => jobStepRow('', t(JOB_STEP_NAMES[key]))).join(''), note: '', hasLog: false, stoppable: false,
            remove: `<button type="button" class="icon-btn icon-btn-danger" data-qid="${escapeHtml(item.qid)}" title="${escapeHtml(t('Take out of the queue'))}">✕</button>`,
        })).join(''));
    }
    const history = jobHistoryItems.map(item => taskHtml({
        key: 'h:' + item.id, lead: `<span class="led ${{ done: 'led-green', cancelled: 'led-amber', error: 'led-red' }[item.state] || 'led-grey'}"></span>`, title: t(JOB_TITLES[item.kind]),
        meta: t(JOB_SOURCES[item.source] || item.source) + ' · ' + jobAgo(item.finished) + ' · ' + jobDuration(item), badge: '',
        steps: jobStepsHtml(item), note: jobNoteText(item), log: taskLogs['h:' + item.id], hasLog: true, stoppable: false,
    })).join('') || `<p class="card-note">${escapeHtml(t('No finished tasks yet'))}</p>`;
    html += taskSection(t('History'), jobHistoryItems.length, history,
        `<button type="button" class="btn btn-small" data-act="clear"${jobHistoryItems.length ? '' : ' disabled'}>${escapeHtml(t('Clear history'))}</button>`);
    box.innerHTML = html;
    box.querySelectorAll('.task').forEach(el => {
        const log = el.querySelector('.job-log');
        const keep = saved[el.dataset.key];
        if (log && keep) log.scrollTop = keep[1] ? log.scrollHeight : keep[0];
        else if (log) log.scrollTop = log.scrollHeight;
    });
}

function renderJob(job, busy = '') {
    jobShown = job;
    renderJobPill();
    const busyBox = document.getElementById('jobBusy');
    busyBox.textContent = busy;
    busyBox.hidden = busy === '';
    renderTasks();
}

async function loadJobHistory() {
    try {
        const r = await (await apiFetch(API + '?action=getJobHistory')).json();
        jobHistoryItems = r.history || [];
    } catch (error) {
        jobHistoryItems = [];
    }
    renderTasks();
}

document.getElementById('jobTasks').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    const remove = e.target.closest('button[data-qid]');
    if (remove) {
        await api({ action: 'cancelJob', qid: remove.dataset.qid });
        pollJob();
        return;
    }
    if (act) {
        if (act.dataset.act === 'stop') {
            const r = await api({ action: 'cancelJob' });
            if (r.error) showToast(t(r.error), 'warning', 6000);
            pollJob();
        } else if (act.dataset.act === 'clear') {
            await api({ action: 'clearJobHistory' });
            loadJobHistory();
        } else if (act.dataset.act === 'log') {
            const key = act.dataset.key;
            if (taskLogOpen.has(key)) taskLogOpen.delete(key);
            else taskLogOpen.add(key);
            if (key.startsWith('h:') && taskLogOpen.has(key) && taskLogs[key] === undefined) {
                const r = await (await apiFetch(API + '?action=getJobLog&id=' + encodeURIComponent(key.slice(2)))).json();
                taskLogs[key] = r.log;
            }
            renderTasks();
        }
        return;
    }
    const bar = e.target.closest('.task-bar');
    if (!bar) return;
    const key = bar.parentElement.dataset.key;
    if (taskOpen.has(key)) taskOpen.delete(key);
    else taskOpen.add(key);
    renderTasks();
});
function renderJobMenu() {
    document.getElementById('jobQuick').innerHTML = JOB_MENU.map(kind => `<button type="button" class="task-menu-item" data-job-start="${kind}">
        <strong>${escapeHtml(t(JOB_TITLES[kind]))}</strong>
        <span>${escapeHtml(t(JOB_NOTES[kind] || ''))}</span>
    </button>`).join('');
}

function jobMenuToggle(open) {
    const menu = document.getElementById('jobQuick');
    menu.hidden = !open;
    document.getElementById('jobNewBtn').setAttribute('aria-expanded', String(open));
    if (open) renderJobMenu();
}

document.getElementById('jobNewBtn').addEventListener('click', () => jobMenuToggle(document.getElementById('jobQuick').hidden));
document.getElementById('jobQuick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-job-start]');
    if (!b) return;
    jobMenuToggle(false);
    startJob(b.dataset.jobStart);
});

async function pollJob() {
    clearTimeout(jobTimer);
    let job = null;
    try {
        const r = await (await apiFetch(API + '?action=getJob')).json();
        job = r.job;
        jobQueue = r.queue || [];
    } catch (error) {
        if (error.message !== 'Session expired') jobTimer = setTimeout(pollJob, 4000);
        return;
    }
    renderJob(job, job && job.state === 'running' ? jobBusyText : '');
    if ((job && job.state === 'running') || jobQueue.length) {
        jobTimer = setTimeout(pollJob, 2000);
        return;
    }
    loadJobHistory();
    loadData();
    if (document.getElementById('listsTab').classList.contains('active')) loadLists();
    if (job && !jobModalOpen()) showToast(job.state === 'done' ? t('Update finished: {0} routes written', job.routes) : t('Update stopped: open the log'), job.state === 'done' ? 'success' : 'warning', 6000);
}

async function startJob(kind) {
    if (jobStarting) return;
    jobStarting = true;
    try {
        const running = jobShown && jobShown.state === 'running';
        jobBusyText = '';
        jobModalShow();
        if (!running) {
            // The page reacts at once: the buttons lock and the window shows the steps; the router's answer replaces this guess
            taskOpen.add('run');
            renderJob({ state: 'running', kind, source: 'panel', steps: JOB_STEPS[kind], step: JOB_STEPS[kind][0], ids: [], done: 0, total: 0, stage: '', site: '', log: '' });
        }
        const r = await api({ action: 'startJob', kind });
        if (r.error) {
            jobBusyText = t(r.error);
            if (!running) renderJob(null, jobBusyText);
            else renderJob(jobShown, jobBusyText);
            return;
        }
        if (r.already) jobBusyText = t('The same task is already running or waiting.');
        else if (r.queued) jobBusyText = t('Added to the queue: position {0}.', r.position);
        pollJob();
    } finally {
        jobStarting = false;
    }
}

function openJobLog() {
    jobModalShow();
    pollJob();
}

// An update started from another tab or device shows up here within a few seconds
let jobWatch = null;

async function watchJobs() {
    if (document.hidden || (jobShown && jobShown.state === 'running')) return;
    try {
        const r = await (await apiFetch(API + '?action=getJob')).json();
        if ((r.job && r.job.state === 'running') || (r.queue && r.queue.length)) pollJob();
    } catch (error) {
        if (error.message === 'Session expired') {
            clearInterval(jobWatch);
            jobWatch = null;
        }
    }
}

function resumeJob() {
    clearInterval(jobWatch);
    jobWatch = setInterval(oncePerFlight(watchJobs), 8000);
    return watchJobs();
}

document.getElementById('jobClose').addEventListener('click', jobModalHide);
document.getElementById('jobDone').addEventListener('click', jobModalHide);
document.getElementById('jobPill').addEventListener('click', jobModalShow);
document.getElementById('jobLogBtn').addEventListener('click', openJobLog);
document.getElementById('applyRoutes').addEventListener('click', () => startJob('apply'));
document.getElementById('refreshAll').addEventListener('click', () => startJob('all'));
document.getElementById('checkApply').addEventListener('click', () => startJob('targets'));

// ============================================ Применение маршрутов ============================================
function isJSONString(str) {
    if (typeof str !== 'string' || str === '') return false;
    try {
        JSON.parse(str);
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================ FILE EDITOR (generic) ============================================
// Modal text editor: the caller passes title/path/content (or load()) and save(content) -> {success, error/errors}.
let fileEditorConfig = null;

function openFileEditor(config) {
    fileEditorConfig = config;
    document.getElementById('fileEditorTitle').textContent = config.title || 'Edit file';
    document.getElementById('fileEditorPath').textContent = config.path || '';
    document.getElementById('fileEditorTextarea').value = config.content || '';
    document.getElementById('fileEditorStatus').textContent = '';
    document.getElementById('fileEditorWrapToggle').checked = false;
    document.getElementById('fileEditorTextarea').classList.remove('wrap-lines');
    document.getElementById('fileEditorTextarea').setAttribute('wrap', 'off');
    document.getElementById('fileEditorModal').style.display = 'block';

    // load - для случаев, когда актуальное содержимое (и точный путь)
    // ещё не на руках и их нужно донести отдельным запросом - вернуть
    // можно либо просто строку (только content), либо {content, path},
    // если путь тоже приходит только с бэкенда (config.php может
    // переопределять его - незачем дублировать/угадывать дефолт тут).
    if (typeof config.load === 'function') {
        document.getElementById('fileEditorStatus').textContent = 'Loading…';
        config.load().then(result => {
            const content = typeof result === 'string' ? result : result.content;
            const path = (result && typeof result === 'object' && result.path) ? result.path : null;
            document.getElementById('fileEditorTextarea').value = content;
            if (path) document.getElementById('fileEditorPath').textContent = path;
            document.getElementById('fileEditorStatus').textContent = '';
        }).catch(error => {
            document.getElementById('fileEditorStatus').textContent = 'Failed to load: ' + error.message;
        });
    }
}

function closeFileEditor() {
    document.getElementById('fileEditorModal').style.display = 'none';
    fileEditorConfig = null;
}

async function saveFileEditorContent() {
    if (!fileEditorConfig || typeof fileEditorConfig.save !== 'function') return;

    const content = document.getElementById('fileEditorTextarea').value;
    const statusEl = document.getElementById('fileEditorStatus');
    const btn = document.getElementById('fileEditorSaveBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';
    btn.disabled = true;
    statusEl.textContent = '';

    try {
        showLoading(fileEditorConfig.savingMessage || 'Saving…');
        const result = await fileEditorConfig.save(content);

        if (result.success) {
            const onSaved = fileEditorConfig.onSaved;
            closeFileEditor();
            if (onSaved) onSaved(result);
        } else {
            const msg = (result.errors && result.errors.length ? result.errors : [result.error || 'Unknown error']).join('\n');
            statusEl.textContent = msg;
            showToast('Not saved - see errors below the editor', 'error', 8000);
        }
    } catch (error) {
        statusEl.textContent = 'Failed: ' + error.message;
        showToast('Failed to save: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        btn.textContent = originalText;
        btn.disabled = false;
    }
}
// ============================================ FILE EDITOR (generic) ============================================


// ---- updates from GitHub
let githubUpdate = null;

async function checkGithubUpdate(force) {
    const status = document.getElementById('updGhStatus');
    const notes = document.getElementById('updGhNotes');
    const get = document.getElementById('updGhGet');
    if (force) status.textContent = t('Asking GitHub…');
    let r;
    try {
        r = await (await apiFetch(API + '?action=checkGithubUpdate&lang=' + encodeURIComponent(I18N.lang) + (force ? '&force=1' : ''))).json();
    } catch (error) {
        r = { success: false, error: error.message };
    }
    githubUpdate = r.success ? r : null;
    const badge = document.getElementById('versionBtn');
    const card = document.getElementById('updCardGh');
    if (!r.success) {
        if (force) status.textContent = t(r.error || 'Failed');
        return;
    }
    const when = r.published ? new Date(r.published).toLocaleDateString(i18nLocale()) : '';
    badge.classList.toggle('has-update', r.newer);
    badge.title = r.newer ? t('Update available: v{0}', r.latest) : t('Panel update');
    card.hidden = !r.newer;
    card.textContent = r.newer ? t('available v{0}', r.latest) : '';
    get.hidden = !r.newer || !r.asset;
    if (!r.newer) {
        status.textContent = t('v{0} is the latest version (checked {1})', r.current, new Date(r.checked * 1000).toLocaleString(i18nLocale(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }));
        notes.hidden = true;
        return;
    }
    status.innerHTML = `${escapeHtml(t('Available: v{0}', r.latest))}${when ? ' · ' + escapeHtml(when) : ''} · <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(t('release page'))}</a>`;
    notes.hidden = !r.notes.length;
    notes.innerHTML = r.notes.map(n => `<div class="upd-gh-note"><b>${escapeHtml(n.title)}</b><div class="upd-gh-text" data-notr>${escapeHtml(n.text)}</div></div>`).join('');
}

document.getElementById('updGhCheck').addEventListener('click', () => checkGithubUpdate(true));
document.getElementById('updGhGet').addEventListener('click', async () => {
    try {
        showLoading('Downloading from GitHub…');
        showUpdatePreview(await api({ action: 'githubUpdate' }));
    } catch (error) {
        showToast('Failed: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
    }
});
// ============================================ UPDATE ============================================
let updateToken = null;

async function loadUpdateInfo() {
    const cur = document.getElementById('updCur');
    try {
        const r = await (await apiFetch(API + '?action=getUpdateInfo')).json();
        cur.textContent = r.version;
        document.getElementById('updCardVer').textContent = 'v' + r.version;
        document.getElementById('updPrevBox').hidden = !r.prev_files.length;
        document.getElementById('updPrev').textContent = r.prev_version || '';
    } catch (error) {
        cur.textContent = t('Failed to load: {0}', error.message);
        document.getElementById('updCardVer').textContent = '—';
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result.split(',')[1] || '');
        fr.onerror = () => reject(new Error('Cannot read the file'));
        fr.readAsDataURL(file);
    });
}

// Re-downloads the panel files into the browser cache, then reloads: no manual cache clearing after an update.
async function refreshAssets() {
    const files = ['/', '/index.html', '/app.js', '/style.css'];
    if (I18N.lang !== 'en') files.push('/lang.' + I18N.lang + '.json');
    await Promise.all(files.map(f => fetch(f, { cache: 'reload' }).catch(() => null)));
    location.reload();
}

async function afterUpdate(message) {
    showToast(message, 'success', 6000);
    document.getElementById('updatePreview').hidden = true;
    updateToken = null;
    setTimeout(refreshAssets, 1200);
}

document.getElementById('openUpdateBtn').addEventListener('click', () => {
    checkGithubUpdate(false);
    document.getElementById('updateModal').style.display = 'block';
});
document.getElementById('versionBtn').addEventListener('click', () => {
    loadUpdateInfo();
    checkGithubUpdate(false);
    document.getElementById('updateModal').style.display = 'block';
});
document.getElementById('updateClose').addEventListener('click', () => { document.getElementById('updateModal').style.display = 'none'; });
document.getElementById('headerHelpBtn').addEventListener('click', () => { document.getElementById('helpModal').style.display = 'block'; });
document.getElementById('helpClose').addEventListener('click', () => { document.getElementById('helpModal').style.display = 'none'; });

// What an uploaded or downloaded archive would change, with the Install button
function showUpdatePreview(r) {
    const preview = document.getElementById('updatePreview');
    preview.hidden = false;
    if (!r.success) {
        updateToken = null;
        preview.innerHTML = `<div class="upd-error"><b>Not accepted</b><div>${escapeHtml(r.error || 'Unknown error')}</div></div>`;
        return;
    }
    updateToken = r.token;
    const changed = r.files.filter(f => f.changed).length;
    preview.innerHTML = `<div class="upd-title">${r.version_new ? escapeHtml(t('Version {0} → {1}', r.version_current, r.version_new)) : escapeHtml(t('Files only'))}</div>
        <div class="upd-files">${r.files.map(f => `<div class="upd-file${f.changed ? '' : ' u-same'}"><span class="upd-fname" data-notr>${escapeHtml(f.name)}</span><span class="upd-fsize">${(f.size / 1024).toFixed(1)} KB</span><span class="upd-badge ${f.changed ? 'new' : 'same'}">${f.changed ? t('changed') : t('same')}</span></div>`).join('')}</div>
        <div class="form-actions"><button class="btn btn-primary" id="updateApplyBtn"${changed ? '' : ' disabled'}>Install</button><button class="btn" id="updateCancelBtn">Cancel</button></div>`;
    document.getElementById('updateCancelBtn').addEventListener('click', () => { updateToken = null; preview.hidden = true; });
    document.getElementById('updateApplyBtn').addEventListener('click', async () => {
        try {
            showLoading('Installing…');
            const a = await api({ action: 'applyUpdate', token: updateToken });
            if (a.success) afterUpdate('Updated to ' + (a.version || 'the new version') + ', reloading…');
            else showToast(a.error || 'Failed', 'error', 8000);
        } catch (error) {
            showToast('Failed: ' + error.message, 'error', 8000);
        } finally {
            hideLoading();
        }
    });
}

function initUpdate() {
    const pick = document.getElementById('updatePickBtn');
    const input = document.getElementById('updateFile');
    const drop = document.getElementById('updateDrop');
    const preview = document.getElementById('updatePreview');
    pick.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) checkUpdateFile(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => {
        const file = input.files[0];
        input.value = '';
        if (file) checkUpdateFile(file);
    });
    async function checkUpdateFile(file) {
        try {
            showLoading('Checking the archive…');
            const r = await api({ action: 'uploadUpdate', data: await fileToBase64(file) });
            showUpdatePreview(r);
        } catch (error) {
            showToast('Failed: ' + error.message, 'error', 8000);
        } finally {
            hideLoading();
        }
    }
    document.getElementById('updateRollbackBtn').addEventListener('click', async () => {
        if (!confirm(t('Return to the previous version?'))) return;
        try {
            showLoading('Rolling back…');
            const a = await api({ action: 'rollbackUpdate' });
            if (a.success) afterUpdate('Rolled back to ' + (a.version || 'the previous version') + ', reloading…');
            else showToast(a.error || 'Failed', 'error', 8000);
        } catch (error) {
            showToast('Failed: ' + error.message, 'error', 8000);
        } finally {
            hideLoading();
        }
    });
}
// ============================================ UPDATE ============================================

// ============================================ HOOKS + BIRD LOG ============================================
async function api(payload) {
    return (await apiFetch(API, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })).json();
}

async function loadHooks() {
    const el = document.getElementById('hooksList');
    try {
        const r = await (await apiFetch(API + '?action=getHooks')).json();
        el.innerHTML = r.hooks.map(h => {
            const led = !h.enabled ? 'led-grey' : (h.installed ? 'led-green' : (h.available ? 'led-red' : 'led-grey'));
            const state = !h.enabled ? 'off' : (h.installed ? 'installed' : (h.available ? 'not installed' : 'not configured'));
            const when = h.last_run ? i18nDate(new Date(h.last_run * 1000)) : t('Not run yet');
            const tip = t(h.description) + '\n' + h.path;
            return `<div class="hook-row${h.enabled ? '' : ' off'}" data-id="${h.id}">
                <span class="led ${led}"></span>
                <div class="hook-name">${escapeHtml(h.label)} <span class="muted">(${state}${h.custom ? ', edited by hand' : ''})</span> <span class="info-tip" tabindex="0" role="img" aria-label="Info" data-tip="${escapeHtml(tip)}">i</span></div>
                <span class="hook-when" title="${escapeHtml(t('Last run'))}">${escapeHtml(when)}</span>
                <label class="hook-switch" title="${escapeHtml(t('on'))}"><input type="checkbox" data-hook-toggle="${h.id}" ${h.enabled ? 'checked' : ''}></label>
                <button class="btn btn-small" data-hook-edit="${h.id}">✎ Edit</button>
                ${h.custom ? `<button class="btn btn-small" data-hook-reset="${h.id}" title="Back to the generated version">Reset</button>` : ''}
            </div>`;
        }).join('');
    } catch (error) {
        el.textContent = 'Failed to load: ' + error.message;
    }
}

async function hookAction(payload, okMessage) {
    try {
        showLoading('Working…');
        const r = await api(payload);
        if (r.success === false) showToast(r.error || 'Failed', 'error', 8000);
        else if (okMessage) showToast(okMessage, 'success');
    } catch (error) {
        showToast('Failed: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        loadHooks();
        loadDependencyStatus();
        loadBirdHook();
    }
}

function openHookEditor(id) {
    openFileEditor({
        title: 'Edit hook',
        load: async () => {
            const r = await (await apiFetch(API + '?action=getHookContent&id=' + encodeURIComponent(id))).json();
            if (r.error) throw new Error(r.error);
            return { content: r.content, path: r.path };
        },
        save: (content) => api({ action: 'saveHook', id, content }),
        savingMessage: 'Saving the hook…',
        onSaved: () => { showToast('Hook saved and written to the router', 'success'); loadHooks(); loadDependencyStatus(); },
    });
}

let birdLogTimer = null;

async function loadBirdLog() {
    const pre = document.getElementById('birdLogText');
    try {
        const n = document.getElementById('birdLogLines').value;
        const r = await (await apiFetch(API + '?action=getBirdLog&lines=' + encodeURIComponent(n))).json();
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = r.content || (r.file_log
            ? t('The log file is empty so far.')
            : t('Nothing found in the system log. Press "Enable file log": bird will then write to /opt/var/log/bird.log.'));
        if (atBottom || !birdLogTimer) pre.scrollTop = pre.scrollHeight;
        document.getElementById('birdLogSource').textContent = 'source: ' + r.source;
        document.getElementById('birdLogEnable').hidden = !!r.file_log;
        document.getElementById('birdLogClear').hidden = !r.file_exists;
    } catch (error) {
        pre.textContent = 'Failed to load: ' + error.message;
    }
}

function closeBirdLog() {
    document.getElementById('birdLogModal').style.display = 'none';
    document.getElementById('birdLogAuto').checked = false;
    clearInterval(birdLogTimer);
    birdLogTimer = null;
}

function initHooksAndLog() {
    document.getElementById('hooksList').addEventListener('change', (e) => {
        const id = e.target.dataset.hookToggle;
        if (id) hookAction({ action: 'setHookEnabled', id, enabled: e.target.checked }, e.target.checked ? 'Hook switched on' : 'Hook switched off and removed from the router');
    });
    document.getElementById('hooksList').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.hookEdit) openHookEditor(btn.dataset.hookEdit);
        else if (btn.dataset.hookReset && confirm(t('Replace your text with the generated hook?'))) hookAction({ action: 'resetHook', id: btn.dataset.hookReset }, 'Hook reset to the generated version');
    });

    document.getElementById('birdLogBtn').addEventListener('click', () => {
        document.getElementById('birdLogModal').style.display = 'block';
        document.getElementById('birdLogText').textContent = 'Loading…';
        loadBirdLog();
    });
    document.getElementById('birdLogClose').addEventListener('click', closeBirdLog);
    document.getElementById('birdLogModal').addEventListener('click', (e) => { if (e.target.id === 'birdLogModal') closeBirdLog(); });
    document.getElementById('birdLogRefresh').addEventListener('click', loadBirdLog);
    document.getElementById('birdLogLines').addEventListener('change', loadBirdLog);
    document.getElementById('birdLogAuto').addEventListener('change', (e) => {
        clearInterval(birdLogTimer);
        birdLogTimer = e.target.checked ? setInterval(oncePerFlight(loadBirdLog), 3000) : null;
    });
    document.getElementById('birdLogClear').addEventListener('click', async () => {
        await api({ action: 'clearBirdLog' });
        loadBirdLog();
    });
    document.getElementById('birdLogEnable').addEventListener('click', async () => {
        try {
            showLoading('Enabling the file log and restarting bird…');
            const r = await api({ action: 'enableBirdLog' });
            if (r.success === false) showToast(r.error || 'Failed', 'error', 8000);
            else showToast('bird now writes to /opt/var/log/bird.log', 'success');
        } catch (error) {
            showToast('Failed: ' + error.message, 'error', 8000);
        } finally {
            hideLoading();
            loadBirdLog();
            loadBirdStatus();
        }
    });
}
// ============================================ HOOKS + BIRD LOG ============================================

// ============================================ BIRD4 (BGP) ============================================
async function loadBirdStatus() {
    const led = document.getElementById('birdLed');
    const text = document.getElementById('birdStateText');
    const stats = document.getElementById('birdStats');
    text.textContent = 'Loading…';

    try {
        const [status, session] = await Promise.all([
            apiFetch(API + '?action=getBirdStatus').then(r => r.json()),
            apiFetch(API + '?action=getBirdSession').then(r => r.json()).catch(() => null),
        ]);
        if (status.error) {
            led.className = 'led led-grey';
            text.textContent = status.error;
            stats.hidden = true;
            return;
        }
        const running = status.running === true;
        led.className = 'led ' + (running ? 'led-green' : 'led-red');
        text.className = 'bgp-state ' + (running ? 'ok' : 'bad');
        text.textContent = running ? 'bird4 is running' : 'bird4 is not running';
        text.title = status.raw || '';
        renderBirdStats(session, running);
    } catch (error) {
        led.className = 'led led-grey';
        text.textContent = 'Failed to load: ' + error.message;
        stats.hidden = true;
    }
}

// One line under the BGP header: session, routes in the table, hold time, graceful restart. The details are in the tooltips.
function renderBirdStats(s, running) {
    const el = document.getElementById('birdStats');
    if (!s || s.error) { el.hidden = true; return; }
    const cell = (label, value, sub, cls) => `<span class="bgp-m">${escapeHtml(t(label))} <b class="${cls || ''}" data-notr>${escapeHtml(value)}</b>${sub ? ` <span class="info-tip" tabindex="0" role="img" aria-label="Info" data-tip="${escapeHtml(sub)}">i</span>` : ''}</span>`;
    const cells = [];
    const sess = s.sessions || [];
    const c = s.config || {};

    if (sess.length) {
        sess.forEach(x => {
            const up = x.state === 'Established';
            const who = [x.neighbor, x.as ? 'AS ' + x.as : ''].filter(Boolean).join(' · ');
            cells.push(cell('Session', x.state || '-', who + (!up && x.error ? ' · ' + x.error : ''), up ? 'ok' : 'warn'));
        });
    } else if (!s.client) {
        cells.push(cell('Session', '-', t('no bird client: opkg install bird1cl-ipv4'), 'muted'));
    } else {
        cells.push(cell('Session', running ? '-' : 'stopped', running ? t('no BGP protocol found') : '', 'muted'));
    }

    if (s.routes !== null && s.routes !== undefined) {
        cells.push(cell('Routes in the table', Number(s.routes).toLocaleString('ru-RU').replace(/\u00a0/g, ' '), t('table {0}', s.table)));
    }

    const est = sess.find(x => x.hold);
    const hold = est ? est.hold : (parseInt(c.hold, 10) || 240);
    const ka = est && est.keepalive ? est.keepalive : (parseInt(c.keepalive, 10) || Math.floor(hold / 3));
    const cfgHold = parseInt(c.hold, 10);
    const differs = est && cfgHold && cfgHold !== est.hold;
    cells.push(cell('Hold time', t('{0} s', hold), differs ? t('agreed with the neighbor; the file says {0} s', cfgHold) : t('keepalive {0} s', ka), differs ? 'warn' : ''));

    const gr = c.graceful === 'on';
    const capGr = est ? /restart/.test(est.caps) : null;
    let grSub = '';
    if (gr) grSub = capGr === null ? t('time {0} s', c.graceful_time || 120) : (capGr ? t('the neighbor supports it') : t('the neighbor does not support it'));
    else grSub = t('not in bird4.conf');
    cells.push(cell('Graceful restart', gr ? 'on' : 'off', grSub, gr && capGr !== false ? '' : 'muted'));

    el.innerHTML = cells.join('');
    el.hidden = false;
}

// save() checks the text with "bird -p" and does not restart bird:
// the live BGP process re-reads the config only on the explicit "Restart bird" button.
function openBirdConfigEditor() {
    openFileEditor({
        title: 'Edit bird4.conf',
        load: async () => {
            const result = await (await apiFetch(API + '?action=getBirdConfig')).json();
            if (typeof result.content !== 'string') throw new Error(result.error || 'Failed to load');
            return { content: result.content, path: result.file }; // path - реальный, каким его вернул бэкенд (учитывает $bird_config_file из config.php, если задан), не угаданный дефолт
        },
        savingMessage: 'Saving bird4.conf and checking syntax…',
        save: async (content) => {
            const response = await apiFetch(API, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ action: 'saveBirdConfig', content }),
            });
            return await response.json();
        },
        onSaved: (result) => {
            if (result.checked) showToast(t('bird4.conf saved, bird accepted the syntax (backup: {0}). Restart bird to apply.', result.backup_file), 'success', 9000);
            else showToast(t('bird4.conf saved without a syntax check: bird was not found (backup: {0}).', result.backup_file), 'warning', 12000);
        },
    });
}

async function restartBird() {
    const btn = document.getElementById('restartBirdBtn');
    const originalText = btn.textContent;
    btn.textContent = '↻ Restarting...';
    btn.disabled = true;

    try {
        showLoading('Restarting bird4…');
        const response = await apiFetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ action: 'restartBird' }),
        });
        const result = await response.json();
        if (result.success) {
            showToast('bird4 restart output:\n' + (result.raw || '(no output)'), 'success', 8000);
        } else {
            showToast('Failed to restart bird4: ' + (result.error || 'unknown error'), 'error', 8000);
        }
        loadBirdStatus();
    } catch (error) {
        showToast('Failed to restart bird4: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

let birdHookPolicies = [];

// Shows the commands the hook will run for the current form values.
function renderBirdPreview() {
    const dev = document.getElementById('birdTunnel').value || '<tunnel>';
    const table = document.getElementById('birdTable').value || '<table>';
    const pol = birdHookPolicies.find(p => p.name === document.getElementById('birdPolicy').value);
    const mark = pol ? pol.mark_hex : '<mark>';
    const peer = document.getElementById('birdPeerRoute').checked;
    const rule = `fwmark ${mark} table ${table} pref ${routePrefs.bgp}`;
    document.getElementById('birdHookPreview').dataset.tip =
        `${dev} up:\n` + (peer ? `  ip route replace <neighbor>/32 dev ${dev}\n` : '') + `  bird start\n  ip rule add ${rule}\n\n`
        + `${dev} down:\n  bird stop\n  ip rule del ${rule}\n` + (peer ? `  ip route del <neighbor>/32 dev ${dev}\n` : '');
    document.getElementById('birdMarkHint').dataset.tip = pol ? t('Only devices of this policy use the BGP routes.') + ' fwmark ' + mark : t('Only devices of this policy use the BGP routes.');
}

// After "Sync policies": the policy list of the BGP block must follow without reloading the whole form.
async function refreshBirdPolicyOptions() {
    const sel = document.getElementById('birdPolicy');
    if (!sel || document.getElementById('birdHookBox').hidden) return;
    try {
        const r = await (await apiFetch(API + '?action=getBirdHook')).json();
        if (!Array.isArray(r.policies)) return;
        const keep = sel.value;
        birdHookPolicies = r.policies;
        sel.innerHTML = r.policies.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.description ? p.description + ' (' + p.name + ')' : p.name)}</option>`).join('')
            || '<option value="">No policies - create one in Keenetic and sync</option>';
        if (r.policies.some(p => p.name === keep)) sel.value = keep;
        renderBirdPreview();
    } catch (error) { /* the list refreshes on the next visit to the tab anyway */ }
}

async function loadBirdHook() {
    const box = document.getElementById('birdHookBox');
    const missing = document.getElementById('birdHookMissing');
    try {
        const r = await (await apiFetch(API + '?action=getBirdHook')).json();
        if (r.error || !r.bird_installed) {
            box.hidden = true;
            missing.hidden = false;
            missing.textContent = r.error || 'bird4 is not installed: run "opkg install bird1-ipv4", then reload this page.';
            return;
        }
        missing.hidden = true;
        box.hidden = false;
        const cur = r.settings;
        birdHookPolicies = r.policies;

        const tunnel = document.getElementById('birdTunnel');
        tunnel.innerHTML = r.tunnels.map(t => `<option value="${escapeHtml(t.system)}">${escapeHtml(t.name)}${t.up ? '' : ' - down'}</option>`).join('')
            || '<option value="">No VPN interfaces found</option>';
        const firstUp = r.tunnels.find(t => t.up) || r.tunnels[0];
        tunnel.value = cur ? cur.iface : (firstUp ? firstUp.system : '');

        const policy = document.getElementById('birdPolicy');
        policy.innerHTML = r.policies.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.description ? p.description + ' (' + p.name + ')' : p.name)}</option>`).join('')
            || '<option value="">No policies - create one in Keenetic and sync</option>';
        if (cur) policy.value = cur.policy;

        document.getElementById('birdPeerRoute').checked = cur ? !!cur.peer_route : true;
        const table = document.getElementById('birdTable');
        table.value = cur ? cur.table : (r.detected_table || '');
        document.getElementById('birdTableHint').dataset.tip = r.detected_table
            ? t('bird puts its routes into this table.') + ' ' + t('bird4.conf says: kernel table {0}', r.detected_table)
            : t('No "kernel table N;" in bird4.conf. Enter the table bird writes its routes to (usually 1000), not the Keenetic policy table.');

        renderBirdPreview();
        const state = document.getElementById('birdHookState');
        const ok = !!(cur && r.installed);
        state.innerHTML = `<span class="led ${ok ? 'led-green' : 'led-red'}"></span>${
            ok ? 'Active: the hook is installed' : (cur ? 'Settings saved, the hook is missing: press Apply' : 'Not configured')}`;
        state.className = 'bh-state' + (ok ? ' ok' : '');
    } catch (error) {
        box.hidden = true;
        missing.hidden = false;
        missing.textContent = 'Failed to load: ' + error.message;
    }
}

async function saveBirdHook(enabled) {
    try {
        showLoading(enabled ? 'Applying…' : 'Disabling…');
        const result = await (await apiFetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                action: 'saveBirdHook',
                enabled,
                iface: document.getElementById('birdTunnel').value,
                policy: document.getElementById('birdPolicy').value,
                table: document.getElementById('birdTable').value,
                peer_route: document.getElementById('birdPeerRoute').checked,
            }),
        })).json();
        if (result.success) {
            showToast(enabled ? (result.applied_now ? 'Saved, bird started and the rule is added' : 'Saved: bird starts when the tunnel comes up') : 'BGP routing disabled', 'success');
        } else {
            showToast(result.error || 'Failed to save', 'error', 8000);
        }
    } catch (error) {
        showToast('Failed to save: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        loadBirdHook();
        loadBirdStatus();
        loadDependencyStatus();
    }
}

// ============================================ BIRD4 CONFIG WIZARD ============================================
// The form is the source of truth until "Edit the text by hand" is on; then the text is saved exactly as typed.
const BW_IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const BW_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
let bwState = null;

const BW_NEIGHBOR_PRESETS = [
    { ip: '45.154.73.71', as: '65432', label: 'antifilter.download: blocked in Russia, /24 aggregates (public)' },
    { ip: '45.148.244.55', as: '65444', label: '45.148.244.55 AS 65444: from your config, owner not confirmed' },
    { ip: '51.75.66.20', as: '65444', label: '51.75.66.20 AS 65444: from your config, owner not confirmed' },
];
const BW_ROUTE_PRESETS = [
    { label: 'Telegram data centers via the tunnel (as in your config)', gateway: true, routes: ['91.108.56.0/24', '95.161.64.0/20', '149.154.167.0/24', '172.121.0.0/16'] },
    { label: 'Directly through the ISP (as in your config, set your ISP gateway)', gateway: false, routes: ['69.197.157.176/29', '198.204.249.0/24'] },
];

// Splits bird config text (comments already removed) into top-level items: "name args;" statements and "name args { ... }" blocks.
function birdSplit(text) {
    const items = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                items.push(text.slice(start, i + 1).trim());
                start = i + 1;
                const semi = /^\s*;/.exec(text.slice(start));
                if (semi) start += semi[0].length;
            }
        } else if (ch === ';' && depth === 0) {
            items.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    const tail = text.slice(start).trim();
    if (tail) items.push(tail);
    return items.filter(Boolean);
}

function birdFlat(s) {
    return s.replace(/\s+/g, ' ').trim();
}

function birdBody(item) {
    return birdSplit(item.slice(item.indexOf('{') + 1, item.lastIndexOf('}'))).map(birdFlat);
}

// One statement or block as config lines. A block gets ";" after its outermost "}" only when it sits inside another block.
function birdPretty(stmt, level) {
    const pad = (n) => '    '.repeat(n);
    if (!stmt.includes('{')) return [pad(level) + stmt + ';'];
    const out = [];
    let cur = '';
    let depth = level;
    for (const ch of stmt) {
        if (ch === '{') {
            out.push(pad(depth) + cur.trim() + ' {');
            cur = '';
            depth++;
        } else if (ch === ';') {
            if (cur.trim()) out.push(pad(depth) + cur.trim() + ';');
            cur = '';
        } else if (ch === '}') {
            if (cur.trim()) out.push(pad(depth) + cur.trim() + ';');
            cur = '';
            depth--;
            out.push(pad(depth) + '}' + (depth === level && level > 0 ? ';' : ''));
        } else {
            cur += ch;
        }
    }
    if (cur.trim()) out.push(pad(depth) + cur.trim() + ';');
    return out;
}

function birdGenerate(m) {
    const x = m.extra;
    const L = ['log syslog all;', 'log stderr all;'];
    if (m.fileLog) L.push('log "/opt/var/log/bird.log" all;');
    x.head.forEach(item => L.push(...birdPretty(item, 0)));
    L.push('', `router id ${m.routerId};`, '');

    L.push('protocol device {');
    (x.device || ['scan time 15']).forEach(s => L.push(...birdPretty(s, 1)));
    L.push('}', '');

    L.push('protocol kernel {');
    if (!x.kernelOverride.import) L.push('    import none;');
    if (!x.kernelOverride.export) L.push('    export all;');
    L.push(`    kernel table ${m.table};`);
    x.kernel.forEach(s => L.push(...birdPretty(s, 1)));
    L.push('}', '');

    L.push('protocol static {');
    if (!x.staticOverride.import) L.push('    import all;');
    const full = (p) => (p.includes('/') ? p : p + '/32');
    m.routes.forEach(r => L.push(`    route ${full(r.prefix)} via ${r.via};`));
    x.static.forEach(s => L.push(...birdPretty(s, 1)));
    L.push('}', '');

    const active = m.neighbors.filter(n => n.active);
    const spare = m.neighbors.filter(n => !n.active);
    active.forEach((n, k) => {
        const o = n.override;
        L.push(`protocol bgp${n.name ? ' ' + n.name : ''} {`);
        if (!o.import) L.push('    import filter {', `        gw = ${m.gateway};`, '        accept;', '    };');
        if (!o.export) L.push('    export none;');
        if (!o.local) L.push(`    local as ${m.localAs};`);
        if (!o.neighbor) L.push(`    neighbor ${n.ip} as ${n.as};`);
        if (k === 0) spare.forEach(s => L.push(`    #neighbor ${s.ip} as ${s.as};`));
        if (m.multihop && !o.multihop) L.push('    multihop;');
        if (m.holdTime && !o.hold) L.push(`    hold time ${m.holdTime};`);
        if (m.keepalive && !o.keepalive) L.push(`    keepalive time ${m.keepalive};`);
        if (m.graceful && !o.graceful) {
            L.push('    graceful restart on;');
            if (m.gracefulTime) L.push(`    graceful restart time ${m.gracefulTime};`);
        }
        if (m.connectRetry && !o.connect) L.push(`    connect retry time ${m.connectRetry};`);
        if (m.errorMin && !o.error) L.push(`    error wait time ${m.errorMin}, ${m.errorMax};`);
        n.extra.forEach(s => L.push(...birdPretty(s, 1)));
        L.push('}', '');
    });
    x.tail.forEach(item => L.push(...birdPretty(item, 0), ''));
    return L.join('\n');
}

// Reads the file into the wizard model. Everything the form has no field for goes to model.extra / neighbor.extra
// and is written back as it was; only comments are lost (reported through model.hasComments).
function birdParse(raw) {
    const m = {
        neighbors: [], routes: [], hasComments: false,
        extra: { head: [], tail: [], device: null, kernel: [], static: [], kernelOverride: {}, staticOverride: {} },
    };
    const spare = [];
    const code = raw.split('\n').map(line => {
        const nb = /^\s*#\s*neighbor\s+([\d.]+)\s+as\s+(\d+)\s*;/.exec(line);
        if (nb) {
            spare.push({ ip: nb[1], as: nb[2], active: false, name: '', extra: [], override: {} });
            return '';
        }
        const at = line.indexOf('#');
        if (at < 0) return line;
        if (line.slice(at + 1).trim()) m.hasComments = true;
        return line.slice(0, at);
    }).join('\n');

    let seenDevice = false;
    let seenKernel = false;
    let seenStatic = false;
    for (const item of birdSplit(code)) {
        const f = birdFlat(item);
        let x;
        if ((x = /^router id ([\d.]+)$/.exec(f))) {
            m.routerId = x[1];
        } else if (/^log (syslog|stderr) all$/.test(f)) {
            continue;
        } else if (f === 'log "/opt/var/log/bird.log" all') {
            m.fileLog = true;
        } else if (/^protocol device\b/.test(f) && !seenDevice) {
            seenDevice = true;
            m.extra.device = birdBody(item);
        } else if (/^protocol kernel\b/.test(f) && !seenKernel) {
            seenKernel = true;
            for (const s of birdBody(item)) {
                if (s === 'import none' || s === 'export all') continue;
                if ((x = /^kernel table (\d+)$/.exec(s))) { m.table = x[1]; continue; }
                const kw = s.split(' ')[0];
                if (kw === 'import' || kw === 'export') m.extra.kernelOverride[kw] = true;
                m.extra.kernel.push(s);
            }
        } else if (/^protocol static\b/.test(f) && !seenStatic) {
            seenStatic = true;
            for (const s of birdBody(item)) {
                if (s === 'import all') continue;
                if ((x = /^route ([\d.\/]+) via ([\d.]+)$/.exec(s))) { m.routes.push({ prefix: x[1], via: x[2] }); continue; }
                if (s.split(' ')[0] === 'import') m.extra.staticOverride.import = true;
                m.extra.static.push(s);
            }
        } else if ((x = /^protocol bgp(?: (\w+))?\s*\{/.exec(f))) {
            const nb = { ip: '', as: '', active: true, name: x[1] || '', extra: [], override: {} };
            for (const s of birdBody(item)) {
                let y;
                if ((y = /^local as (\d+)$/.exec(s))) { if (m.localAs === undefined) m.localAs = y[1]; }
                else if ((y = /^neighbor ([\d.]+) as (\d+)$/.exec(s))) { nb.ip = y[1]; nb.as = y[2]; }
                else if (s === 'multihop') m.multihop = true;
                else if ((y = /^hold time (\d+)$/.exec(s))) { if (m.holdTime === undefined) m.holdTime = y[1]; }
                else if ((y = /^keepalive time (\d+)$/.exec(s))) { if (m.keepalive === undefined) m.keepalive = y[1]; }
                else if ((y = /^graceful restart (on|off)$/.exec(s))) { if (m.graceful === undefined) m.graceful = y[1] === 'on'; }
                else if ((y = /^graceful restart time (\d+)$/.exec(s))) { if (m.gracefulTime === undefined) m.gracefulTime = y[1]; }
                else if ((y = /^connect retry time (\d+)$/.exec(s))) { if (m.connectRetry === undefined) m.connectRetry = y[1]; }
                else if ((y = /^error wait time (\d+) ?, ?(\d+)$/.exec(s))) { if (m.errorMin === undefined) { m.errorMin = y[1]; m.errorMax = y[2]; } }
                else if ((y = /^import filter \{ gw = ([\d.]+); accept; \}$/.exec(s))) { if (m.gateway === undefined) m.gateway = y[1]; }
                else if (s === 'export none') { /* generated */ }
                else {
                    const kw = s.split(' ')[0];
                    if (['import', 'export', 'multihop', 'local', 'neighbor', 'hold', 'keepalive', 'graceful', 'connect', 'error'].includes(kw)) nb.override[kw] = true;
                    nb.extra.push(s);
                }
            }
            m.neighbors.push(nb);
        } else if (/^(define|filter|function|template|table)\b/.test(f)) {
            m.extra.head.push(item);
        } else {
            m.extra.tail.push(item);
        }
    }
    m.neighbors.push(...spare);
    return m;
}

// Short names of everything that was kept as is, for the note above the form.
function birdExtraList(m) {
    const x = m.extra;
    const list = [];
    const add = (where, s) => list.push(`${where}: ${birdFlat(s).slice(0, 90)}`);
    x.head.forEach(s => add('top', s));
    (x.device || []).filter(s => s !== 'scan time 15').forEach(s => add('device', s));
    x.kernel.forEach(s => add('kernel', s));
    x.static.forEach(s => add('static', s));
    m.neighbors.forEach(n => n.extra.forEach(s => add('bgp', s)));
    x.tail.forEach(s => add('protocol', s));
    return list;
}

function birdWizardDefaults(hook, fresh) {
    const host = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : '192.168.1.1';
    return {
        routerId: host,
        table: (hook && hook.settings && hook.settings.table) || (hook && hook.detected_table) || 1000,
        gateway: '',
        localAs: 64999,
        holdTime: 240,
        keepalive: 0,
        multihop: true,
        fileLog: true,
        graceful: fresh,
        gracefulTime: fresh ? 600 : 0,
        connectRetry: fresh ? 30 : 0,
        errorMin: fresh ? 10 : 0,
        errorMax: fresh ? 120 : 0,
        neighbors: [{ ip: '', as: '', active: true, name: '', extra: [], override: {} }],
        routes: [],
        extra: { head: [], tail: [], device: null, kernel: [], static: [], kernelOverride: {}, staticOverride: {} },
        hasComments: false,
    };
}

function birdWizardFill() {
    const m = bwState.model;
    const set = (id, v) => { document.getElementById(id).value = v || v === 0 ? v : ''; };
    set('bwRouterId', m.routerId);
    set('bwTable', m.table);
    set('bwGateway', m.gateway);
    set('bwLocalAs', m.localAs);
    set('bwHold', m.holdTime);
    set('bwKeepalive', m.keepalive || '');
    set('bwGracefulTime', m.gracefulTime || '');
    set('bwRetry', m.connectRetry || '');
    set('bwErrMin', m.errorMin || '');
    set('bwErrMax', m.errorMax || '');
    document.getElementById('bwMultihop').checked = !!m.multihop;
    document.getElementById('bwFileLog').checked = !!m.fileLog;
    document.getElementById('bwGraceful').checked = !!m.graceful;
    birdWizardRows();
    birdWizardSync();
}

function birdWizardRows() {
    const m = bwState.model;
    document.getElementById('bwNeighbors').innerHTML = m.neighbors.map((n, i) => `<div class="bw-row">
        <input type="checkbox" data-nb-active="${i}" ${n.active ? 'checked' : ''} title="Active neighbor">
        <input type="text" data-nb="${i}" data-f="ip" value="${escapeHtml(n.ip)}" placeholder="Neighbor IP" spellcheck="false">
        <input type="number" class="bw-as" data-nb="${i}" data-f="as" value="${escapeHtml(n.as)}" placeholder="AS">
        <button type="button" class="btn btn-small" data-nb-del="${i}" title="Remove">✕</button>
    </div>`).join('');
    document.getElementById('bwRoutes').innerHTML = m.routes.map((r, i) => `<div class="bw-row">
        <input type="text" data-rt="${i}" data-f="prefix" value="${escapeHtml(r.prefix)}" placeholder="Prefix, e.g. 91.108.56.0/24" spellcheck="false">
        <input type="text" data-rt="${i}" data-f="via" value="${escapeHtml(r.via)}" placeholder="Via, e.g. ${escapeHtml(m.gateway || '10.8.1.0')}" spellcheck="false">
        <button type="button" class="btn btn-small" data-rt-del="${i}" title="Remove">✕</button>
    </div>`).join('');
}

function birdWizardValidate(m) {
    const errs = [];
    if (!BW_IPV4.test(m.routerId)) errs.push('Router ID must be an IPv4 address');
    if (!(m.table >= 1 && m.table <= 65535)) errs.push('Kernel table must be 1-65535');
    if (!BW_IPV4.test(m.gateway)) errs.push('Next hop must be an IPv4 address');
    if (!(m.localAs >= 1)) errs.push('Local AS is required');
    if (m.holdTime && m.holdTime < 3) errs.push('Hold time must be at least 3');
    if (m.keepalive && (m.keepalive < 1 || (m.holdTime && m.keepalive >= m.holdTime))) errs.push('Keepalive must be shorter than hold time (leave empty for a third of it)');
    if (m.graceful && m.gracefulTime && !(m.gracefulTime >= 1 && m.gracefulTime <= 4095)) errs.push('Graceful restart time must be 1-4095');
    if (m.errorMin && !(m.errorMax >= m.errorMin)) errs.push('Error wait: the maximum must not be below the minimum');
    if (!m.errorMin && m.errorMax) errs.push('Error wait needs both the minimum and the maximum');
    const active = m.neighbors.filter(n => n.active);
    if (!active.length) errs.push('Choose at least one active neighbor');
    m.neighbors.forEach((n, i) => {
        if (n.override.neighbor) return;
        if (!BW_IPV4.test(n.ip) || !(n.as >= 1)) errs.push(`Neighbor ${i + 1}: IPv4 address and AS are required`);
    });
    if (active.some(n => n.as && parseInt(n.as, 10) === m.localAs)) errs.push('Local AS must differ from the neighbor AS (for antifilter use anything but 65432)');
    m.routes.forEach((r, i) => {
        if (!BW_CIDR.test(r.prefix) || !BW_IPV4.test(r.via)) errs.push(`Route ${i + 1}: prefix (a.b.c.d/len) and via (IPv4) are required`);
    });
    return errs;
}

// Form -> text. Does nothing while the text is edited by hand.
function birdWizardSync() {
    if (!bwState || bwState.manual) return;
    document.getElementById('birdWizardText').value = birdGenerate(bwState.model);
    const errs = birdWizardValidate(bwState.model);
    document.getElementById('birdWizardStatus').textContent = errs.length ? errs[0] : '';
}

function birdWizardReadForm() {
    const m = bwState.model;
    const val = (id) => document.getElementById(id).value.trim();
    const num = (id) => parseInt(val(id), 10) || 0;
    m.routerId = val('bwRouterId');
    m.table = num('bwTable');
    m.gateway = val('bwGateway');
    m.localAs = num('bwLocalAs');
    m.holdTime = num('bwHold');
    m.keepalive = num('bwKeepalive');
    m.gracefulTime = num('bwGracefulTime');
    m.connectRetry = num('bwRetry');
    m.errorMin = num('bwErrMin');
    m.errorMax = num('bwErrMax');
    m.multihop = document.getElementById('bwMultihop').checked;
    m.fileLog = document.getElementById('bwFileLog').checked;
    m.graceful = document.getElementById('bwGraceful').checked;
}

async function openBirdWizard() {
    const status = document.getElementById('birdWizardStatus');
    const note = document.getElementById('birdWizardNote');
    status.textContent = 'Loading…';
    note.hidden = true;
    document.getElementById('birdWizardModal').style.display = 'block';

    let current = '';
    let hook = null;
    try { current = (await (await apiFetch(API + '?action=getBirdConfig')).json()).content || ''; } catch (e) { /* no config yet */ }
    try { hook = await (await apiFetch(API + '?action=getBirdHook')).json(); } catch (e) { /* defaults only */ }

    const fresh = !current.trim();
    const parsed = birdParse(current);
    const model = birdWizardDefaults(hook, fresh);
    for (const [k, v] of Object.entries(parsed)) {
        if (v !== undefined && k !== 'neighbors' && k !== 'routes' && k !== 'extra') model[k] = v;
    }
    model.neighbors = parsed.neighbors.length ? parsed.neighbors : model.neighbors;
    model.routes = parsed.routes;
    model.extra = parsed.extra;
    model.table = parseInt(model.table, 10);
    model.localAs = parseInt(model.localAs, 10);
    for (const k of ['holdTime', 'keepalive', 'gracefulTime', 'connectRetry', 'errorMin', 'errorMax']) model[k] = parseInt(model[k], 10) || 0;
    if (!fresh && parsed.holdTime === undefined) model.holdTime = 0;
    if (!model.neighbors.some(n => n.active) && parsed.neighbors.length === 0) model.neighbors[0].active = true;

    bwState = { model, manual: false };
    const kept = birdExtraList(model);
    note.hidden = !kept.length && !parsed.hasComments;
    if (!note.hidden) {
        note.innerHTML = '';
        if (kept.length) {
            note.append(Object.assign(document.createElement('div'), { textContent: 'The wizard does not know these parts of bird4.conf. They are kept as they are:' }));
            note.append(Object.assign(document.createElement('pre'), { textContent: kept.join('\n') }));
        }
        if (parsed.hasComments) {
            note.append(Object.assign(document.createElement('div'), { textContent: 'Comments in the file are not kept. A .bak copy of the old file is saved.' }));
        }
        note.querySelectorAll('pre').forEach(el => el.setAttribute('data-notr', ''));
    }
    document.getElementById('birdWizardManual').checked = false;
    document.getElementById('birdWizardText').readOnly = true;
    document.getElementById('birdWizardForm').classList.remove('disabled');
    birdWizardFill();
}

function closeBirdWizard() {
    document.getElementById('birdWizardModal').style.display = 'none';
    bwState = null;
}

async function saveBirdWizard() {
    if (!bwState) return;
    const status = document.getElementById('birdWizardStatus');
    if (!bwState.manual) {
        const errs = birdWizardValidate(bwState.model);
        if (errs.length) { status.textContent = errs.join('\n'); return; }
    }
    const content = document.getElementById('birdWizardText').value;
    const restart = document.getElementById('birdWizardRestart').checked;
    try {
        showLoading('Saving bird4.conf…');
        const saved = await (await apiFetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ action: 'saveBirdConfig', content }),
        })).json();
        if (!saved.success) {
            status.textContent = (saved.errors && saved.errors.length ? saved.errors : [saved.error || 'Unknown error']).join('\n');
            return;
        }
        let message = 'bird4.conf saved (backup: ' + saved.backup_file + ')';
        if (restart) {
            const r = await (await apiFetch(API, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ action: 'restartBird' }),
            })).json();
            message += r.success ? '\nbird restarted: ' + (r.raw || '') : '\nRestart failed: ' + (r.error || 'unknown error');
        }
        closeBirdWizard();
        showToast(message, 'success', 9000);
    } catch (error) {
        status.textContent = 'Failed: ' + error.message;
    } finally {
        hideLoading();
        loadBirdStatus();
        loadBirdHook();
    }
}

function initBirdWizard() {
    const nbSel = document.getElementById('bwNbPreset');
    nbSel.innerHTML = '<option value="">+ Known neighbor…</option>' + BW_NEIGHBOR_PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p.label)}</option>`).join('');
    const rtSel = document.getElementById('bwRoutePreset');
    rtSel.innerHTML = '<option value="">+ Example routes…</option>' + BW_ROUTE_PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p.label)}</option>`).join('');

    nbSel.addEventListener('change', () => {
        const preset = BW_NEIGHBOR_PRESETS[parseInt(nbSel.value, 10)];
        nbSel.value = '';
        if (!preset || !bwState) return;
        const m = bwState.model;
        let idx = m.neighbors.findIndex(n => n.ip === preset.ip);
        if (idx < 0) {
            idx = m.neighbors.findIndex(n => !n.ip);
            if (idx < 0) idx = m.neighbors.push({ ip: '', as: '', active: false, name: '', extra: [], override: {} }) - 1;
            Object.assign(m.neighbors[idx], { ip: preset.ip, as: preset.as });
        }
        if (!m.neighbors.some(n => n.active && n.ip)) m.neighbors[idx].active = true;
        birdWizardRows();
        birdWizardSync();
    });
    rtSel.addEventListener('change', () => {
        const preset = BW_ROUTE_PRESETS[parseInt(rtSel.value, 10)];
        rtSel.value = '';
        if (!preset || !bwState) return;
        const m = bwState.model;
        preset.routes.filter(r => !m.routes.some(x => x.prefix === r)).forEach(r => m.routes.push({ prefix: r, via: preset.gateway ? m.gateway : '' }));
        birdWizardRows();
        birdWizardSync();
    });

    document.getElementById('birdWizardBtn').addEventListener('click', openBirdWizard);
    document.getElementById('birdWizardClose').addEventListener('click', closeBirdWizard);
    document.getElementById('birdWizardSave').addEventListener('click', saveBirdWizard);

    document.getElementById('birdWizardForm').addEventListener('input', (e) => {
        if (!bwState) return;
        const t = e.target;
        if (t.dataset.nb !== undefined) bwState.model.neighbors[+t.dataset.nb][t.dataset.f] = t.value.trim();
        else if (t.dataset.rt !== undefined) bwState.model.routes[+t.dataset.rt][t.dataset.f] = t.value.trim();
        else birdWizardReadForm();
        birdWizardSync();
    });
    document.getElementById('birdWizardForm').addEventListener('change', (e) => {
        if (!bwState) return;
        if (e.target.dataset.nbActive !== undefined) bwState.model.neighbors[+e.target.dataset.nbActive].active = e.target.checked;
        else if (e.target.id === 'bwMultihop' || e.target.id === 'bwFileLog' || e.target.id === 'bwGraceful') birdWizardReadForm();
        birdWizardSync();
    });
    document.getElementById('birdWizardForm').addEventListener('click', (e) => {
        if (!bwState) return;
        const m = bwState.model;
        const t = e.target.closest('button');
        if (!t) return;
        if (t.id === 'bwAddNeighbor') m.neighbors.push({ ip: '', as: m.neighbors.length ? m.neighbors[m.neighbors.length - 1].as : '', active: false, name: '', extra: [], override: {} });
        else if (t.id === 'bwAddRoute') m.routes.push({ prefix: '', via: m.gateway });
        else if (t.dataset.nbDel !== undefined) {
            const i = +t.dataset.nbDel;
            m.neighbors.splice(i, 1);
        } else if (t.dataset.rtDel !== undefined) m.routes.splice(+t.dataset.rtDel, 1);
        else return;
        birdWizardRows();
        birdWizardSync();
    });

    document.getElementById('birdWizardManual').addEventListener('change', (e) => {
        const textarea = document.getElementById('birdWizardText');
        if (e.target.checked) {
            bwState.manual = true;
            textarea.readOnly = false;
            document.getElementById('birdWizardForm').classList.add('disabled');
        } else {
            if (textarea.value !== birdGenerate(bwState.model) && !confirm('Discard the manual edits and generate the text from the form again?')) {
                e.target.checked = true;
                return;
            }
            bwState.manual = false;
            textarea.readOnly = true;
            document.getElementById('birdWizardForm').classList.remove('disabled');
            birdWizardSync();
        }
    });
}
// ============================================ BIRD4 (BGP) ============================================

async function installCurl() {
    try {
        showLoading('Installing curl…');
        const result = await api({ action: 'installCurl' });
        if (result.success) showToast('curl installed', 'success');
        else showToast(t(result.error || 'Failed to install curl'), 'error', 9000);
    } catch (error) {
        showToast('Failed to install curl: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        if (typeof loadDependencyStatus === 'function') loadDependencyStatus();
        loadLists();
    }
}
async function installPhpModule(action, name) {
    try {
        showLoading(t('Installing the PHP module {0}…', name));
        const result = await api({ action });
        if (result.success) showToast(t('The PHP module {0} is installed; php-fpm restarts in a moment', name), 'success', 7000);
        else showToast(t(result.error || 'Install failed'), 'error', 9000);
    } catch (error) {
        showToast(t('Install failed') + ': ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        setTimeout(loadDependencyStatus, 4000);
    }
}
// ============================================ SYSTEM ACCESS / DNS ============================================

// The checks of the Tools tab: one chip per check; the commands that fix a failed one are listed below the chips
function renderCheckChips(el, checks) {
    let fixes = '';
    const chips = checks.map((c, i) => {
        const led = c.ok === true ? 'led-green' : (c.ok === null ? 'led-grey' : (c.level === 'optional' ? 'led-amber' : 'led-red'));
        const cls = c.ok === false ? (c.level === 'optional' ? ' opt' : ' bad') : '';
        let action = '';
        if (c.ok === false && c.action === 'installHooks') action = '<button type="button" class="btn btn-small btn-primary" data-click="installHooks">Install hooks</button>';
        if (c.ok === false && c.action === 'installCurl') action = '<button type="button" class="btn btn-small btn-primary" data-click="installCurl">Install curl</button>';
        if (c.ok === false && c.action === 'installOpenssl') action = '<button type="button" class="btn btn-small btn-primary" data-click="installPhp" data-action="installOpenssl" data-name="OpenSSL">Install</button>';
        if (c.ok === false && c.action === 'installSockets') action = '<button type="button" class="btn btn-small btn-primary" data-click="installPhp" data-action="installSockets" data-name="sockets">Install</button>';
        if (c.ok === false && c.fix && c.fix.length) {
            fixes += `<div class="chk-fix"><span>${escapeHtml(c.label)}</span>` + c.fix.map((cmd, k) => `<div class="check-fix-row"><code>${escapeHtml(cmd)}</code><button type="button" class="btn btn-small" data-copy="${i}:${k}">Copy</button></div>`).join('') + '</div>';
        }
        const tip = c.detail ? ` <span class="info-tip" tabindex="0" role="img" aria-label="Info" data-tip="${escapeHtml(t(c.detail))}">i</span>` : '';
        return `<span class="chk${cls}"><span class="led ${led}"></span>${escapeHtml(c.label)}${tip}${action}</span>`;
    }).join('');
    el.innerHTML = `<div class="chk-chips">${chips}</div>${fixes}`;
    el.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const [i, k] = btn.dataset.copy.split(':').map(Number);
            try {
                await navigator.clipboard.writeText(checks[i].fix[k]);
                btn.textContent = t('Copied');
            } catch (e) {
                btn.textContent = t('Select manually');
            }
        });
    });
}

async function loadDependencyStatus() {
    const el = document.getElementById('depsStatus');
    el.innerHTML = '<span class="muted">Checking…</span>';
    try {
        const result = await (await apiFetch(API + '?action=getSystemChecks')).json();
        renderCheckChips(el, result.checks.concat(await webExposureChecks()));
    } catch (error) {
        el.innerHTML = `<span class="led led-red"></span> Failed to check: ${escapeHtml(error.message)}`;
    }
}

async function installHooks() {
    try {
        showLoading('Installing ndm hooks…');
        const result = await api({ action: 'installHooks' });
        if (result.success) {
            showToast('ndm hooks installed', 'success');
        } else {
            showToast(result.error || 'Failed to install hooks', 'error', 9000);
        }
    } catch (error) {
        showToast('Failed to install hooks: ' + error.message, 'error', 8000);
    } finally {
        hideLoading();
        loadDependencyStatus();
    }
}
// ============================================ SYSTEM ACCESS / DNS ============================================

// ============================================ CLIENTS ============================================
let allClients = [];
let currentConnIp = null;
let currentConnLabel = null;
let currentConnections = [];
let autoRefreshTimer = null;
let currentConnTotal = 0;
let currentConnTruncated = false;
let currentConnCapped = false;
// Кэш обратного DNS на весь сеанс страницы - переживает и обычный
// Refresh, и авто-рефреш. Ключ - IP, значение - имя (или null, если PTR
// нет вообще - тоже кэшируем, чтобы не спрашивать снова и снова).
let hostnameCache = {};
// Ставится в quickAddTarget() - после закрытия формы Add Target нужно
// вернуться к окну соединений, а не оставить пользователя на голой
// вкладке Clients. Проверяется и сбрасывается в closeModal().
let reopenConnectionsAfterModal = false;

function formatBytes(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' ' + t('B');
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' ' + t('KB');
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' ' + t('MB');
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' ' + t('GB');
}

function formatUptime(seconds) {
    if (!seconds) return '-';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return t('{0}d {1}h', d, h);
    if (h > 0) return t('{0}h {1}m', h, m);
    return t('{0}m', m);
}

async function loadClients() {
    const tbody = document.getElementById('clientsList');
    tbody.innerHTML = '<tr><td colspan="9" class="loading">Loading…</td></tr>';
    try {
        const result = await (await apiFetch(API + '?action=getClients')).json();
        if (!Array.isArray(result.clients)) {
            tbody.innerHTML = `<tr><td colspan="9" class="loading">${escapeHtml(result.error || 'Failed to load')}</td></tr>`;
            return;
        }
        allClients = result.clients;
        renderClients(document.getElementById('searchClients').value);
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="9" class="loading">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
    }
}

let clientFilter = 'all';
let clientPolicy = 'all';
let clientSort = (function () { try { return JSON.parse(localStorage.getItem('cliSort')) || { key: '', dir: 1 }; } catch (e) { return { key: '', dir: 1 }; } })();

function clientSortValue(c, key) {
    switch (key) {
        case 'status': return c.online ? 0 : 1;
        case 'name': return c.name;
        case 'ip': return /^\d+(\.\d+){3}$/.test(c.ip) && c.ip !== '0.0.0.0' ? c.ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0) : null;
        case 'mac': return c.mac;
        case 'policy': return c.policy;
        case 'uptime': return c.online ? c.uptime : null;
        case 'rx': return c.rxbytes;
        case 'tx': return c.txbytes;
        case 'connection': return c.online ? (c.is_wifi ? 'Wi-Fi' : 'Wired') : null;
    }
    return null;
}

function setClientSort(key) {
    if (clientSort.key !== key) { clientSort.key = key; clientSort.dir = 1; }
    else if (clientSort.dir === 1) clientSort.dir = -1;
    else { clientSort.key = ''; clientSort.dir = 1; }
    try { localStorage.setItem('cliSort', JSON.stringify(clientSort)); } catch (e) {}
    renderClients(document.getElementById('searchClients').value);
}

function renderClients(filterText = '') {
    const tbody = document.getElementById('clientsList');
    const q = filterText.trim().toLowerCase();

    document.getElementById('cfAll').textContent = allClients.length;
    document.getElementById('cfOnline').textContent = allClients.filter(c => c.online).length;
    document.getElementById('cfWifi').textContent = allClients.filter(c => c.is_wifi).length;
    document.getElementById('cfWired').textContent = allClients.filter(c => !c.is_wifi).length;
    document.getElementById('cfUnreg').textContent = allClients.filter(c => !c.registered).length;
    document.querySelectorAll('#clientsFilter button').forEach(b => b.classList.toggle('active', b.dataset.f === clientFilter));

    // the policy filter lists the policies the clients really have, with the number of clients
    const policyCount = {};
    allClients.forEach(c => { policyCount[c.policy || ''] = (policyCount[c.policy || ''] || 0) + 1; });
    const policyNames = Object.keys(policyCount).filter(name => name !== '').sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    if (clientPolicy !== 'all' && !(clientPolicy === '__none__' ? policyCount[''] : policyCount[clientPolicy])) clientPolicy = 'all';
    const policyOptions = [`<option value="all">${escapeHtml(t('All policies'))} (${allClients.length})</option>`]
        .concat(policyNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${policyCount[name]})</option>`));
    if (policyCount['']) policyOptions.push(`<option value="__none__">${escapeHtml(t('No policy'))} (${policyCount['']})</option>`);
    const policySelect = document.getElementById('clientsPolicy');
    policySelect.innerHTML = policyOptions.join('');
    policySelect.value = clientPolicy;
    document.querySelectorAll('#clientsTable [data-sort]').forEach(th => {
        const on = th.dataset.sort === clientSort.key;
        th.classList.toggle('sorted', on);
        th.dataset.dir = on ? (clientSort.dir === 1 ? 'asc' : 'desc') : '';
    });

    const filtered = allClients.filter(c => {
        if (clientPolicy === '__none__' && c.policy) return false;
        if (clientPolicy !== 'all' && clientPolicy !== '__none__' && c.policy !== clientPolicy) return false;
        if (clientFilter === 'online' && !c.online) return false;
        if (clientFilter === 'wifi' && !c.is_wifi) return false;
        if (clientFilter === 'wired' && c.is_wifi) return false;
        if (clientFilter === 'unreg' && c.registered) return false;
        if (!q) return true;
        return (c.name && c.name.toLowerCase().includes(q))
            || (c.mac && c.mac.toLowerCase().includes(q))
            || (c.ip && c.ip.toLowerCase().includes(q));
    });

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="loading">No clients found</td></tr>';
        return;
    }

    // Without a sort, or sorted by status, the clients stay in the groups Online / Offline; any other column gives one sorted list
    const flat = clientSort.key !== '' && clientSort.key !== 'status';
    const sorted = flat ? sortList(filtered, clientSort, clientSortValue, c => c.name || c.mac) : filtered;
    const online = sorted.filter(c => c.online);
    const offline = sorted.filter(c => !c.online);

    function row(c) {
        const statusLed = c.online ? 'led-green' : 'led-grey';
        const statusText = c.online ? 'online' : 'offline';
        const hasIp = c.ip && c.ip !== '0.0.0.0';
        const connIcon = c.is_wifi
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"></path><circle cx="12" cy="19" r="1"></circle></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"></rect><path d="M7 18v2M17 18v2M8 10v3M12 10v3M16 10v3"></path></svg>';
        const connType = c.is_wifi ? 'Wi-Fi' : 'Wired';
        const speed = c.speed ? `${c.speed} Mbps` : '';

        return `<tr class="domain-row">
            <td data-label="Status" data-col="status"><span class="status-pill"><span class="led ${statusLed}"></span><span class="status-label">${statusText}</span></span></td>
            <td class="cell-domain" data-label="Name" data-col="name"><span data-notr>${escapeHtml(c.name || '(no name)')}</span>${c.registered ? '' : ` <span class="chip chip-warn">${escapeHtml(t('Not registered'))}</span>`}</td>
            <td class="cell-mono" data-label="IP" data-col="ip">${hasIp ? escapeHtml(c.ip) : '<span class="muted">-</span>'}</td>
            <td class="cell-mono" data-label="MAC" data-col="mac">${escapeHtml(c.mac)}</td>
            <td data-label="Policy" data-col="policy">${c.policy ? `<span class="chip" data-notr>${escapeHtml(c.policy)}</span>` : '<span class="muted">-</span>'}</td>
            <td class="cell-mono" data-label="Uptime" data-col="uptime">${c.online ? formatUptime(c.uptime) : '<span class="muted">-</span>'}</td>
            <td class="cell-mono" data-label="Down / Up" data-col="down-up"><span class="traffic-rx">↓ ${formatBytes(c.rxbytes)}</span> / <span class="traffic-tx">↑ ${formatBytes(c.txbytes)}</span></td>
            <td data-label="Connection" data-col="connection">${c.online ? `<span class="conn">${connIcon}<span class="conn-text"><span class="conn-type">${connType}</span>${c.via ? '<span class="conn-via">' + escapeHtml(t('via {0}', c.via)) + '</span>' : ''}${speed ? '<span class="conn-speed">' + escapeHtml(speed) + '</span>' : ''}</span></span>` : '<span class="muted">-</span>'}</td>
            <td class="cell-actions col-sticky-right" data-label="Actions" data-col="actions">
                <button class="btn btn-small" data-click="clientDetail" data-mac="${escapeHtml(c.mac)}" data-label="${escapeHtml(c.name || c.mac)}" data-ip="${hasIp ? escapeHtml(c.ip) : ''}">Details</button>
            </td>
        </tr>`;
    }

    let html = '';
    if (flat) {
        html = sorted.map(row).join('');
    } else {
        const groups = [['Online', online], ['Offline', offline]];
        if (clientSort.key === 'status' && clientSort.dir === -1) groups.reverse();
        groups.forEach(([name, list]) => {
            if (!list.length) return;
            html += `<tr class="group-divider"><td colspan="9">${name} (${list.length})</td></tr>`;
            html += list.map(row).join('');
        });
    }

    tbody.innerHTML = html;
}

function resetConnections(ip, label) {
    currentConnIp = ip;
    currentConnLabel = label;
    document.getElementById('connFilterIp').value = '';
    document.getElementById('connProtoFilter').value = '';
    document.getElementById('connAutoRefresh').checked = false;
    stopAutoRefresh();
}

// An interval must not start a new request while the previous one is still running
function oncePerFlight(fn) {
    let running = false;
    return async () => {
        if (running) return;
        running = true;
        try {
            await fn();
        } finally {
            running = false;
        }
    };
}

function startAutoRefresh() {
    stopAutoRefresh();
    const seconds = parseInt(document.getElementById('connAutoRefreshInterval').value, 10) || 10;
    autoRefreshTimer = setInterval(oncePerFlight(fetchConnections), seconds * 1000);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

async function fetchConnections() {
    const titleEl = document.getElementById('connTitle');
    const listEl = document.getElementById('connList');
    const statusEl = document.getElementById('connStatus');

    titleEl.textContent = t('Connections of {0}', currentConnIp);
    if (!autoRefreshTimer) {
        listEl.innerHTML = '';
        statusEl.textContent = 'Loading…';
    }

    try {
        const ip = currentConnIp;
        const result = await (await apiFetch(API + '?action=getClientConnections&ip=' + encodeURIComponent(ip))).json();
        if (ip !== currentConnIp) return;
        if (!Array.isArray(result.connections)) {
            statusEl.textContent = result.error || 'Failed to load';
            currentConnections = [];
            return;
        }
        currentConnections = result.connections;
        currentConnTotal = result.total;
        currentConnTruncated = result.truncated;
        currentConnCapped = result.route_lookups_capped;
        renderConnections();
        resolveNewHostnames(); // не блокирует отрисовку - подтянет имена, когда придут
    } catch (error) {
        statusEl.textContent = 'Failed to load: ' + error.message;
    }
}

// Запрашивает имена ТОЛЬКО для IP, которых ещё нет в hostnameCache - не
// дёргается вообще, если все адреса уже известны (обычный случай при
// авто-рефреже одного и того же клиента - набор адресов почти не
// меняется между тиками). Помечает "в процессе" undefined-значением в
// кэше, чтобы не запросить один и тот же IP дважды параллельно.
async function resolveNewHostnames() {
    const unresolved = [...new Set(currentConnections.map(c => c.dst))]
        .filter(ip => !(ip in hostnameCache));
    if (!unresolved.length) return;

    unresolved.forEach(ip => { hostnameCache[ip] = undefined; });
    renderConnections(); // сразу показать "resolving…" - строка уже займёт своё
                          // место, а не появится резким скачком позже

    try {
        const response = await apiFetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resolveHostnames', ips: unresolved }),
        });
        const result = await response.json();
        Object.assign(hostnameCache, result.hostnames || {});
    } catch (error) {
        // Не критично - убираем пометку "в процессе", попробуем на
        // следующем фетче вместо того, чтобы навсегда застрять пустыми.
        unresolved.forEach(ip => { delete hostnameCache[ip]; });
        return;
    }
    renderConnections(); // перерисовать с уже пришедшими именами
}

function renderConnections() {
    const listEl = document.getElementById('connList');
    const statusEl = document.getElementById('connStatus');
    const ipFilter = document.getElementById('connFilterIp').value.trim().toLowerCase();
    const protoFilter = document.getElementById('connProtoFilter').value;

    const filtered = currentConnections.filter(c => {
        if (protoFilter && c.proto.toLowerCase() !== protoFilter) return false;
        if (ipFilter && !c.dst.toLowerCase().includes(ipFilter)) return false;
        return true;
    });

    if (!filtered.length) {
        listEl.innerHTML = '<div class="table-view-empty">No matching connections</div>';
        statusEl.textContent = '';
        return;
    }

    listEl.innerHTML = filtered.map(c => {
        const countBadge = c.count > 1 ? `<span class="chip conn-count">×${c.count}</span>` : '<span class="conn-count"></span>';

        const detailParts = [];
        if (c.managed) {
            detailParts.push(`<span class="chip conn-managed-chip">🎯 ${escapeHtml(c.managed.target)}</span>`);
        }
        if (c.policy) {
            const tableNote = c.table
                ? ` (table ${escapeHtml(String(c.table))}${c.table_confirmed ? '' : ', assumed'})`
                : '';
            detailParts.push(`<span class="conn-policy">via <strong>${escapeHtml(c.policy)}</strong>${tableNote}</span>`);
        } else if (c.mark) {
            detailParts.push(`<span class="conn-policy muted">mark 0x${c.mark.toString(16)} (not one of our policies)</span>`);
        } else if (c.table && c.table !== 'main') {
            // Без метки, но живой запрос почему-то нашёл не main - значит
            // это подхватило какое-то другое правило (не по нашей метке).
            detailParts.push(`<span class="conn-policy muted">table ${escapeHtml(String(c.table))}${c.table_confirmed ? '' : ', assumed'}</span>`);
        } else {
            detailParts.push('<span class="conn-policy muted">main routing (no policy mark)</span>');
        }
        if (c.gateway || c.interface) {
            // Для multicast-адресов (224.0.0.0/4, например SSDP/WS-Discovery
            // на 239.x.x.x) шлюза может не быть в принципе - такой трафик
            // маршрутизируется по исходящему интерфейсу, а не через next-hop.
            // Показываем что есть, а не молчим целиком, если нет именно gateway.
            const bits = [];
            if (c.gateway) bits.push(c.gateway);
            if (c.interface) bits.push(c.interface);
            detailParts.push(`<span class="conn-gw">via ${escapeHtml(bits.join(' / '))}</span>`);
        }
        if (!c.managed) {
            // Уже отслеживаемые цели незачем предлагать добавить снова -
            // кнопка только для того, чего ещё нет в базе.
            detailParts.push(`<button type="button" class="btn btn-small conn-quick-add" data-click="quickAdd" data-ip="${escapeHtml(c.dst)}" data-policy="${escapeHtml(c.policy || '')}">+ Add as target</button>`);
        }

        const detail = detailParts.length
            ? `<div class="conn-detail">${detailParts.join('')}</div>`
            : '';
        const hostKnown = c.dst in hostnameCache;
        const cachedHost = hostnameCache[c.dst];
        let hostLine = '';
        if (hostKnown && cachedHost === undefined) {
            hostLine = `<div class="conn-host conn-host-loading">resolving…</div>`;
        } else if (cachedHost) {
            hostLine = `<div class="conn-host conn-host-ready">${escapeHtml(cachedHost)}</div>`;
        }

        return `<div class="conn-row-wrap${c.managed ? ' conn-managed' : ''}">
            <div class="conn-row">
                <span class="conn-proto">${escapeHtml(c.proto)}</span>
                <span class="conn-dst">${escapeHtml(c.dst)}${c.dport ? ':' + c.dport : ''}</span>
                ${countBadge}
                <span class="conn-meta">${(c.packets || 0).toLocaleString(i18nLocale())} packets, ${formatBytes(c.bytes)}</span>
            </div>
            ${hostLine}
            ${detail}
        </div>`;
    }).join('');

    // filtered.length - число СТРОК (после схлопывания дублей), а не
    // реальных соединений - если где-то есть ×7, это одна строка, но
    // 7 соединений. Суммируем c.count по всем строкам, а не считаем
    // сами строки.
    const sumCount = (arr) => arr.reduce((sum, c) => sum + (c.count || 1), 0);
    const filteredConns = sumCount(filtered);
    const loadedConns = sumCount(currentConnections);
    const isFiltered = filtered.length !== currentConnections.length;

    let msg = currentConnTruncated
        ? `Loaded ${loadedConns} of ${currentConnTotal} total connections`
        : `${loadedConns} connection(s)`;
    if (isFiltered) {
        msg += ` (${filteredConns} shown after filter)`;
    }
    if (currentConnCapped) {
        msg += ' - gateway lookup skipped for some rows (too many unique destinations)';
    }
    statusEl.textContent = msg;
}

// Быстрое добавление цели прямо из окна соединений - закрывает модалку
// соединений и открывает уже существующую форму добавления таргета
// (Targets), с заранее подставленными IP и политикой. Ничего не
// сохраняется автоматически - пользователь по-прежнему видит и
// подтверждает форму перед сохранением, как при обычном добавлении.
function quickAddTarget(ip, policyName) {
    document.getElementById('clientDetailModal').style.display = 'none';
    stopAutoRefresh();
    reopenConnectionsAfterModal = true; // проверяется и сбрасывается в closeModal()

    const policy = state.policies.find(p => p.name === policyName);
    openDomainModal(null, { domain: ip, policyId: policy ? policy.id : null });
}

// Доп. информация по клиенту (rci/show/ip/hotspot/host?mac=...) -
// отдельный запрос по требованию, не входит в основной список Clients.
// Самое ценное - device (SSDP/UPnP: производитель/модель), которого нет
// в общем списке.
let clientDetailSeq = 0;
async function openClientDetail(mac, label, ip = '') {
    const modal = document.getElementById('clientDetailModal');
    const titleEl = document.getElementById('clientDetailTitle');
    const listEl = document.getElementById('clientDetailList');

    titleEl.textContent = label;
    const connSection = document.getElementById('clientConnSection');
    connSection.hidden = !ip;
    resetConnections(ip, label);
    listEl.innerHTML = '<div class="route-line-item muted">Loading…</div>';
    document.getElementById('clientDetailRaw').innerHTML = '';
    modal.style.display = 'block';
    if (ip) fetchConnections();
    renderClientManage(mac);

    try {
        const seq = ++clientDetailSeq;
        const info = await (await apiFetch(API + '?action=getClientDetail&mac=' + encodeURIComponent(mac))).json();
        // another client was opened while this answer was on its way
        if (seq !== clientDetailSeq || modal.style.display !== 'block') return;
        if (info.error) {
            listEl.innerHTML = `<div class="route-line-item muted">${escapeHtml(info.error)}</div>`;
            return;
        }

        const parts = [];

        if (info.device && (info.device.manufacturer || info.device.model)) {
            const d = info.device;
            const modelLine = [d.manufacturer, d.model].filter(Boolean).join(' ');
            parts.push(`<div class="route-line-item"><strong>Device:</strong> ${escapeHtml(modelLine)}</div>`);
            if (d.model_desc) parts.push(`<div class="route-line-item">${escapeHtml(d.model_desc)}</div>`);
            if (d.serial) parts.push(`<div class="route-line-item">Serial: ${escapeHtml(d.serial)}</div>`);
        }

        if (info.ip6 && info.ip6.length) {
            const addrs = info.ip6.map(a => (a && a.address) ? a.address : a).filter(Boolean);
            if (addrs.length) parts.push(`<div class="route-line-item cell-mono">IPv6: ${addrs.map(escapeHtml).join(', ')}</div>`);
        }

        if (info.traffic_shape) {
            parts.push(`<div class="route-line-item">Rate limit: <span class="traffic-rx">↓ ${formatBytes(info.traffic_shape.rx)}/s</span> · <span class="traffic-tx">↑ ${formatBytes(info.traffic_shape.tx)}/s</span></div>`);
        }

        if (info.wifi) {
            const w = info.wifi;
            const bits = [];
            if (w.ap) bits.push(`AP: ${w.ap}`);
            if (w.rssi != null) {
                const quality = w.rssi >= -60 ? 'good' : (w.rssi >= -70 ? 'fair' : 'weak');
                bits.push(`signal: ${w.rssi} dBm (${quality})`);
            }
            if (w.txrate != null) bits.push(`rate: ${w.txrate} Mbps`);
            if (w.mode) bits.push(w.mode);
            if (w.security) bits.push(w.security);
            if (bits.length) parts.push(`<div class="route-line-item">Wi-Fi: ${bits.map(escapeHtml).join(' · ')}</div>`);
        }

        if (info.access) {
            parts.push(`<div class="route-line-item">Access: ${escapeHtml(info.access)}${info.schedule ? ' (schedule: ' + escapeHtml(info.schedule) + ')' : ''}</div>`);
        }

        if (info.first_seen != null) {
            parts.push(`<div class="route-line-item">First seen: ${formatUptime(info.first_seen)} ago</div>`);
        }

        if (info.raw) {
            document.getElementById('clientDetailRaw').innerHTML = `<details class="raw-details"><summary>Raw data</summary><pre data-notr>${escapeHtml(JSON.stringify(info.raw, null, 2))}</pre></details>`;
        }

        listEl.innerHTML = parts.length ? parts.join('') : '<div class="route-line-item muted">No extra info available</div>';
    } catch (error) {
        listEl.innerHTML = `<div class="route-line-item muted">Failed to load: ${escapeHtml(error.message)}</div>`;
    }
}

let manageMac = '';

function renderClientManage(mac) {
    manageMac = mac;
    const c = allClients.find(x => x.mac === mac);
    document.getElementById('clientManage').hidden = !c;
    if (!c) return;
    const nameInput = document.getElementById('clientRegName');
    if (document.activeElement !== nameInput) nameInput.value = c.registered ? c.name : '';
    document.getElementById('clientRegBtn').textContent = t(c.registered ? 'Rename' : 'Register');
    document.getElementById('clientUnregBtn').hidden = !c.registered;
    const options = [`<option value="">${escapeHtml(t('Default policy'))}</option>`].concat(
        state.policies.filter(p => p.name !== 'DELETED').map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.description || p.name)} (${escapeHtml(p.name)})</option>`));
    if (c.policy && !state.policies.some(p => p.name === c.policy)) options.push(`<option value="${escapeHtml(c.policy)}">${escapeHtml(c.policy)}</option>`);
    const sel = document.getElementById('clientPolicySel');
    sel.innerHTML = options.join('');
    sel.value = c.policy;
    sel.disabled = !c.registered;
    document.getElementById('clientPolicyBtn').disabled = !c.registered;
    document.getElementById('clientManageHint').hidden = c.registered;
}

async function clientManageCall(payload, title) {
    payload.mac = manageMac;
    const r = await rciCall(payload, title, 'clientDryRun');
    if (r.success && !r.dry_run) {
        showToast(t('Done'), 'success');
        await loadClients();
        renderClientManage(manageMac);
    }
}

document.getElementById('clientRegBtn').addEventListener('click', () => {
    clientManageCall({ action: 'registerClient', name: document.getElementById('clientRegName').value }, 'Register the client');
});
document.getElementById('clientUnregBtn').addEventListener('click', () => {
    if (!confirm(t('Unregister this client? Its individual policy will be lost.'))) return;
    clientManageCall({ action: 'unregisterClient' }, 'Unregister the client');
});
document.getElementById('clientPolicyBtn').addEventListener('click', () => {
    clientManageCall({ action: 'setClientPolicy', policy: document.getElementById('clientPolicySel').value }, 'Client policy');
});
// ============================================ CLIENTS ============================================

// ============================================ POLICY TRAFFIC ============================================
// Живая сводка трафика по политикам - переиспользует formatBytes из
// блока Clients, ничего нового не заводит. Заполняет ячейки, уже
// отрисованные renderPolicies() как "…" - не блокирует основной рендер
// таблицы политик, догружается отдельно.
async function loadPolicyTrafficSummary() {
    try {
        const result = await (await apiFetch(API + '?action=getPolicyTrafficSummary')).json();
        const summary = result.summary || {};

        state.policies.forEach(p => {
            const cell = document.getElementById(`policy-traffic-${p.id}`);
            if (!cell) return; // строка могла быть отфильтрована поиском - не страшно

            const s = summary[p.name];
            cell.innerHTML = s
                ? `<span class="traffic-rx">↓ ${formatBytes(s.rxbytes)}</span> / <span class="traffic-tx">↑ ${formatBytes(s.txbytes)}</span>`
                : '<span class="muted">—</span>';
        });
    } catch (error) {
        // Не критично - ячейки остаются с "…", страницу это не ломает.
    }
}
// ============================================ POLICY TRAFFIC ============================================

// ============================================ POLICY ROUTES ============================================
// Маршруты каждой политики, как их видит сам Keenetic (show/ip/policy),
// а не live ip route show - полный список открывается по кнопке в
// модалке, в самой таблице только дефолтный маршрут (0.0.0.0/0) как
// краткая сводка "куда эта политика вообще смотрит".
let policyRoutesData = {};

async function loadPolicyRoutesSummary() {
    try {
        const result = await (await apiFetch(API + '?action=getPolicyRoutes')).json();
        policyRoutesData = result.policies || {};

        state.policies.forEach(p => {
            const cell = document.getElementById(`policy-gateway-${p.id}`);
            if (!cell) return;

            const info = policyRoutesData[p.name];
            const routes = (info && info.routes) || [];
            if (!routes.length) {
                cell.innerHTML = '<span class="muted">—</span>';
                return;
            }

            const defaultRoute = routes.find(r => r.destination === '0.0.0.0/0');
            let summary;
            if (defaultRoute) {
                const gw = defaultRoute.gateway && defaultRoute.gateway !== '0.0.0.0' ? defaultRoute.gateway + ' ' : '';
                summary = `${gw}(${defaultRoute.interface})`;
            } else {
                summary = `${routes.length} route(s)`;
            }

            cell.innerHTML = escapeHtml(summary);
        });
    } catch (error) {
        // Не критично - ячейки остаются с "…", страницу это не ломает.
    }
}

function openPolicyRoutes(policyName) {
    const modal = document.getElementById('policyRoutesModal');
    const titleEl = document.getElementById('policyRoutesTitle');
    const listEl = document.getElementById('policyRoutesList');

    titleEl.textContent = `Routes - ${policyName}`;

    const info = policyRoutesData[policyName];
    const routes = (info && info.routes) || [];

    if (!routes.length) {
        listEl.innerHTML = '<div class="table-view-empty">No routes</div>';
    } else {
        listEl.innerHTML = routes.map(r => {
            const gw = r.gateway && r.gateway !== '0.0.0.0' ? `via ${escapeHtml(r.gateway)} ` : '';
            const badges = [];
            if (r.floating) badges.push('<span class="chip">floating</span>');
            if (r.static) badges.push('<span class="chip">static</span>');
            return `<div class="route-line-item">${escapeHtml(r.destination)} ${gw}dev ${escapeHtml(r.interface)} <span class="muted">metric ${r.metric ?? '-'}</span> ${badges.join(' ')}</div>`;
        }).join('');
    }

    modal.style.display = 'block';
}
// ============================================ POLICY ROUTES ============================================

// ============================================ DASHBOARD ============================================
// Сборка того, что и так уже грузят остальные вкладки (Clients,
// Interfaces) - никакого отдельного цикла по каждому интерфейсу за
// живой статистикой, это осталось точечным действием на Interfaces.
// Только ручное обновление, без таймера - раз вкладка не показывает
// ничего, что меняется секунда в секунду, авто-обновление тут не
// оправдано (в отличие от Live traffic конкретного интерфейса).
async function loadDashboard() {
    const btn = document.getElementById('dashboardRefreshBtn');
    btn.disabled = true;

    try {
        const result = await (await apiFetch(API + '?action=getDashboard')).json();
        const ok = result.uptime != null;
        document.getElementById('dashLed').className = 'led ' + (ok ? 'led-green' : 'led-amber');
        document.getElementById('dashRouter').textContent = ok ? 'Router online' : 'No data';
        document.getElementById('dashUptime').textContent = ok ? formatUptime(result.uptime) : '—';
        document.getElementById('dashInterfaces').textContent = `${result.interfaces_up ?? 0}/${result.total_interfaces ?? 0}`;
        document.getElementById('cntClients').textContent = `${result.online_clients ?? 0}/${result.total_clients ?? 0}`;
    } catch (error) {
        showToast('Failed to load dashboard: ' + error.message, 'error', 8000);
    } finally {
        btn.disabled = false;
    }

    const birdChip = document.getElementById('dashBirdChip');
    try {
        const bird = await (await apiFetch(API + '?action=getBirdStatus')).json();
        birdChip.hidden = !!bird.error;
        const bv = document.getElementById('dashBird');
        bv.textContent = bird.running ? t('alive') : t('stopped');
        bv.className = 'dash-chip-value ' + (bird.running ? 'ok' : 'bad');
    } catch (error) {
        birdChip.hidden = true;
    }
}

// Counters next to the menu items: targets and policies come from the loaded lists.
function updateNavCounts() {
    document.getElementById('cntDomains').textContent = state.domains.filter(d => d.policy_name !== 'DELETED').length;
    document.getElementById('cntPolicies').textContent = state.policies.filter(p => p.name !== 'DELETED').length;
}
// ============================================ DASHBOARD ============================================

// ============================================ INTERFACES ============================================
// Живой снимок всех интерфейсов Keenetic (show/interface) - Wi-Fi радио/
// точки доступа, мосты, туннели (GRE/WireGuard) с пирами. Не кэшируется
// в state - перечитывается при каждом открытии вкладки и по Refresh.
// Таблица нарочно голая (Status/Name/Type/Description) - всё остальное
// (IP, скорость, SSID, пиры, живая статистика трафика) - по кнопке
// Details, чтобы не сваливать разнородные факты в одну строку таблицы.
let interfacesData = [];
let interfaceChoices = [];
const TUNNEL_TYPES = ['Wireguard', 'OpenVPN', 'IPsec', 'L2TP', 'PPTP', 'SSTP', 'Gre', 'Ipip', 'Eoip'];
const HIDDEN_TYPES = ['Port', 'WifiMaster', 'AccessPoint', 'WifiStation', 'Bridge'];
const INTERFACE_SELECTS = ['domainInterface', 'catalogInterface', 'listInterface', 'panelNetInterface', 'dpiIsp', 'dpiTun'];

// Fills an interface drop-down with the router's interfaces (system names such as nwg0, eth3) and picks the value
function fillInterfaceSelect(id, value) {
    const select = document.getElementById(id);
    const option = (iface) => {
        const note = iface.description || iface.name;
        const state = iface.connected ? '' : ' · ' + t('down');
        return `<option value="${escapeHtml(iface.system)}">${escapeHtml(iface.system + ' — ' + note + state)}</option>`;
    };
    const tunnels = interfaceChoices.filter(i => TUNNEL_TYPES.includes(i.type));
    const others = interfaceChoices.filter(i => !TUNNEL_TYPES.includes(i.type));
    let html = `<option value="">${escapeHtml(t(select.dataset.empty || 'Not set'))}</option>`;
    if (tunnels.length) html += `<optgroup label="${escapeHtml(t('Tunnels'))}">${tunnels.map(option).join('')}</optgroup>`;
    if (others.length) html += `<optgroup label="${escapeHtml(t('Other interfaces'))}">${others.map(option).join('')}</optgroup>`;
    if (value && !interfaceChoices.some(i => i.system === value)) {
        html += `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
    }
    select.innerHTML = html;
    select.value = value || '';
}

async function loadInterfaceChoices() {
    try {
        const r = await (await apiFetch(API + '?action=getInterfaces')).json();
        interfaceChoices = r.interfaces.filter(i => i.system && !HIDDEN_TYPES.includes(i.type));
        // interfaces the router did not describe with a system name: taken from the kernel by their address
        r.kernel.forEach(k => {
            if (interfaceChoices.some(i => i.system === k.name)) return;
            interfaceChoices.push({ system: k.name, name: k.address, description: k.address, type: 'Kernel', connected: k.up });
        });
    } catch (e) {
        interfaceChoices = [];
    }
    INTERFACE_SELECTS.forEach(id => fillInterfaceSelect(id, document.getElementById(id).value));
}
let currentInterfaceId = null;
let interfaceStatAutoRefreshTimer = null;

const IF_TUNNEL_TYPES = ['Wireguard', 'OpenVPN', 'IPsec', 'L2TP', 'PPTP', 'SSTP', 'Gre', 'Ipip', 'Eoip'];
let interfaceFilter = 'active';
let birdTunnelId = '';
try { interfaceFilter = localStorage.getItem('ifaceFilter') === 'all' ? 'all' : 'active'; } catch (e) { /* storage may be blocked */ }

async function loadInterfaces() {
    const grid = document.getElementById('interfacesList');
    grid.innerHTML = '<div class="loading">Loading…</div>';
    try {
        const [result, hook] = await Promise.all([
            apiFetch(API + '?action=getInterfaces').then(r => r.json()),
            apiFetch(API + '?action=getBirdHook').then(r => r.json()).catch(() => null),
        ]);
        if (!Array.isArray(result.interfaces)) {
            grid.innerHTML = `<div class="loading">${escapeHtml(result.error || 'Failed to load')}</div>`;
            return;
        }
        interfacesData = result.interfaces;
        birdTunnelId = '';
        if (hook && hook.settings) {
            const tun = (hook.tunnels || []).find(x => x.system === hook.settings.iface);
            const m = tun ? /\(([^)]+)\)$/.exec(tun.name) : null;
            birdTunnelId = tun ? (m ? m[1] : tun.name) : '';
        }
        renderInterfaces(document.getElementById('searchInterfaces').value);
    } catch (error) {
        grid.innerHTML = `<div class="loading">Failed to load: ${escapeHtml(error.message)}</div>`;
    }
}

function ifaceAddress(iface) {
    if (iface.ssid) return iface.ssid;
    if (!iface.address) return '—';
    let bits = '';
    if (/^\d+$/.test(iface.mask)) {
        bits = '/' + iface.mask;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(iface.mask)) {
        const n = iface.mask.split('.').reduce((acc, o) => acc + parseInt(o, 10).toString(2).split('1').length - 1, 0);
        bits = '/' + n;
    }
    return iface.address + bits;
}

const IF_ICONS = {
    tunnel: '<circle cx="6" cy="12" r="2.5"></circle><circle cx="18" cy="6" r="2.5"></circle><circle cx="18" cy="18" r="2.5"></circle><path d="M8.3 11l7.4-4M8.3 13l7.4 4"></path>',
    wifi: '<path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"></path><circle cx="12" cy="19.5" r="1"></circle>',
    wired: '<rect x="3" y="7" width="18" height="10" rx="2"></rect><path d="M7 17v-3M11 17v-3M15 17v-3"></path>',
};

function renderInterfaces(filterText = '') {
    const grid = document.getElementById('interfacesList');
    const q = filterText.trim().toLowerCase();
    const isUp = (i) => i.link === 'up';

    document.querySelectorAll('#interfacesFilter button').forEach(b => b.classList.toggle('active', b.dataset.f === interfaceFilter));
    const upCount = interfacesData.filter(isUp).length;
    document.getElementById('ifActive').textContent = upCount;
    document.getElementById('ifAll').textContent = interfacesData.length;
    document.getElementById('interfacesSummary').textContent = t('Tunnels first');

    const list = interfacesData.filter(i => {
        if (interfaceFilter === 'active' && !isUp(i)) return false;
        if (!q) return true;
        return (i.name && i.name.toLowerCase().includes(q))
            || (i.type && i.type.toLowerCase().includes(q))
            || (i.description && i.description.toLowerCase().includes(q));
    });

    if (!list.length) {
        grid.innerHTML = '<div class="loading">No interfaces found</div>';
        return;
    }

    const rank = (i) => (IF_TUNNEL_TYPES.includes(i.type) ? 0 : (i.defaultgw ? 1 : 2));
    list.sort((x, y) => (isUp(y) - isUp(x)) || (rank(x) - rank(y)) || x.name.localeCompare(y.name));

    grid.innerHTML = list.map(i => {
        const kind = IF_TUNNEL_TYPES.includes(i.type) ? 'tunnel' : (/^Wifi|AccessPoint|Station/i.test(i.type) ? 'wifi' : 'wired');
        const tags = [`<span class="if-tag" data-notr>${escapeHtml(i.type)}</span>`];
        if (i.defaultgw) tags.push('<span class="if-tag if-tag-gw">Default gateway</span>');
        if (birdTunnelId && (i.id === birdTunnelId || i.name === birdTunnelId)) tags.push('<span class="if-tag if-tag-bgp">BGP tunnel</span>');
        return `<article class="if-card${isUp(i) ? '' : ' is-down'}" tabindex="0" role="button" data-click="ifaceDetail" data-id="${escapeHtml(i.id)}">
            <div class="if-top">
                <span class="if-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${IF_ICONS[kind]}</svg></span>
                <span class="if-name"><b data-notr>${escapeHtml(i.name)}</b><span class="if-desc" data-notr>${escapeHtml(i.description) || ''}</span></span>
                <span class="if-link ${isUp(i) ? 'up' : 'down'}" title="${isUp(i) ? 'up' : 'down'}"></span>
            </div>
            <div class="if-tags">${tags.join('')}</div>
            <div class="if-addr" data-notr>${escapeHtml(ifaceAddress(i))}</div>
        </article>`;
    }).join('');
}

function formatTimeAgo(seconds) {
    if (seconds == null) return 'never';
    if (seconds < 60) return `${seconds}s ago`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

// Собирает все статические факты об интерфейсе (IP/MAC/скорость/SSID/
// канал/туннель/IPsec/приоритет), которые раньше были размазаны по
// колонкам таблицы - теперь только тут, в одном месте.
function buildInterfaceFacts(iface) {
    const parts = [];
    if (iface.priority != null) {
        parts.push(`<div class="route-line-item">WAN priority: ${iface.priority}${iface.defaultgw ? ' <span class="chip">current default gateway</span>' : ''}</div>`);
    }
    if (iface.address) {
        parts.push(`<div class="route-line-item">IP: ${escapeHtml(iface.address)}${iface.mask ? '/' + escapeHtml(iface.mask) : ''}</div>`);
    }
    if (iface.speed) {
        parts.push(`<div class="route-line-item">Link: ${escapeHtml(iface.speed)} Mbps${iface.duplex ? ' ' + escapeHtml(iface.duplex) + ' duplex' : ''}${iface.auto_negotiation ? ', auto-negotiation on' : ''}</div>`);
    }
    if (iface.ssid) {
        parts.push(`<div class="route-line-item">SSID: ${escapeHtml(iface.ssid)}${iface.encryption ? ' (' + escapeHtml(iface.encryption) + ')' : ''}</div>`);
    }
    if (iface.channel != null) {
        parts.push(`<div class="route-line-item">Radio: channel ${iface.channel}${iface.bandwidth ? ', ' + escapeHtml(iface.bandwidth) + 'MHz' : ''}${iface.temperature != null ? ', ' + iface.temperature + '°C' : ''}</div>`);
    }
    if (iface.bridge_members && iface.bridge_members.length) {
        parts.push(`<div class="route-line-item">Bridge members: ${iface.bridge_members.map(escapeHtml).join(', ')}</div>`);
    }
    if (iface.ipsec_enabled != null) {
        const bits = [iface.ipsec_enabled ? 'IPsec enabled' : 'IPsec disabled'];
        bits.push(iface.ipsec_ikev2_enabled ? 'IKEv2 enabled' : 'IKEv2 disabled');
        if (iface.ipsec_encryption_level) bits.push(`encryption: ${iface.ipsec_encryption_level}`);
        parts.push(`<div class="route-line-item">${bits.map(escapeHtml).join(' · ')}</div>`);
    }
    if (iface.mac) parts.push(`<div class="route-line-item">MAC: ${escapeHtml(iface.mac)}</div>`);
    if (iface.remote) parts.push(`<div class="route-line-item">Tunnel remote endpoint: ${escapeHtml(iface.remote)}</div>`);
    if (iface.wireguard_public_key) parts.push(`<div class="route-line-item cell-mono">Public key: ${escapeHtml(iface.wireguard_public_key)}</div>`);

    if (iface.wireguard_peers && iface.wireguard_peers.length) {
        iface.wireguard_peers.forEach((p, i) => {
            const ledCls = p.online ? 'led-green' : 'led-grey';
            const name = p.description || `Peer ${i + 1}`;
            parts.push(`<div class="peer-row">
                <div class="peer-header">
                    <span class="led ${ledCls}"></span>
                    <span class="peer-name">${escapeHtml(name)}</span>
                    ${p.remote ? `<span class="peer-remote">${escapeHtml(p.remote)}</span>` : ''}
                </div>
                <div class="peer-detail">handshake ${formatTimeAgo(p.last_handshake)} · <span class="traffic-rx">↓ ${formatBytes(p.rxbytes)}</span> / <span class="traffic-tx">↑ ${formatBytes(p.txbytes)}</span></div>
            </div>`);
        });
    }

    return parts;
}

// Живая статистика (rci/show/interface/stat?name=...) - отдельный
// запрос по требованию, не входит в основной список интерфейсов.
function buildInterfaceStatBlock(stat) {
    if (!stat || stat.error) {
        return `<div class="route-line-item muted">Traffic stats unavailable${stat && stat.error ? ': ' + escapeHtml(stat.error) : ''}</div>`;
    }
    const speedLine = `<span class="traffic-rx">↓ ${formatBytes(stat.rxspeed)}/s</span> · <span class="traffic-tx">↑ ${formatBytes(stat.txspeed)}/s</span>`;
    const totalLine = `<span class="traffic-rx">↓ ${formatBytes(stat.rxbytes)}</span> (${stat.rxpackets.toLocaleString(i18nLocale())} pkts) · <span class="traffic-tx">↑ ${formatBytes(stat.txbytes)}</span> (${stat.txpackets.toLocaleString(i18nLocale())} pkts)`;
    const errLine = (stat.rxerrors || stat.txerrors || stat.rxdropped || stat.txdropped)
        ? `<div class="route-line-item">Errors/dropped: rx ${stat.rxerrors}/${stat.rxdropped} · tx ${stat.txerrors}/${stat.txdropped}</div>`
        : '';
    return `<div class="route-line-item"><strong>Current speed:</strong> ${speedLine}</div>
        <div class="route-line-item"><strong>Total traffic:</strong> ${totalLine}</div>
        ${errLine}`;
}

function openInterfaceDetail(id) {
    const iface = interfacesData.find(i => i.id === id);
    if (!iface) return;

    currentInterfaceId = id;
    stopInterfaceStatAutoRefresh();
    document.getElementById('interfaceStatAutoRefresh').checked = false;

    const modal = document.getElementById('interfaceDetailModal');
    const titleEl = document.getElementById('interfaceDetailTitle');
    const factsEl = document.getElementById('interfaceDetailFacts');

    titleEl.textContent = `${iface.name} - details`;

    // Статические факты (IP/MAC/скорость/SSID/туннель/пиры) - отдельно
    // от трафика, задаются один раз при открытии, не участвуют в
    // обновлении/автообновлении (это не live-данные, тянуть их заново
    // ради статистики трафика незачем).
    const facts = buildInterfaceFacts(iface);
    factsEl.innerHTML = facts.length ? facts.join('') : '<div class="route-line-item muted">No extra static info</div>';
    renderInterfaceControl(iface);
    document.getElementById('interfaceDetailStat').innerHTML = '<div class="route-line-item muted">Loading traffic stats…</div>';

    modal.style.display = 'block';
    fetchInterfaceStat();
}

// Живая статистика (rci/show/interface/stat) - отдельно от статических
// фактов, вызывается и при открытии, и по кнопке Refresh, и таймером
// автообновления.
async function fetchInterfaceStat() {
    if (!currentInterfaceId) return;
    const statEl = document.getElementById('interfaceDetailStat');

    try {
        const id = currentInterfaceId;
        const stat = await (await apiFetch(API + '?action=getInterfaceStat&name=' + encodeURIComponent(id))).json();
        if (id !== currentInterfaceId) return;
        statEl.innerHTML = buildInterfaceStatBlock(stat);
    } catch (error) {
        statEl.innerHTML = `<div class="route-line-item muted">Traffic stats unavailable: ${escapeHtml(error.message)}</div>`;
    }
}

function startInterfaceStatAutoRefresh() {
    stopInterfaceStatAutoRefresh();
    const seconds = parseInt(document.getElementById('interfaceStatAutoRefreshInterval').value, 10) || 10;
    interfaceStatAutoRefreshTimer = setInterval(oncePerFlight(fetchInterfaceStat), seconds * 1000);
}

function stopInterfaceStatAutoRefresh() {
    if (interfaceStatAutoRefreshTimer) {
        clearInterval(interfaceStatAutoRefreshTimer);
        interfaceStatAutoRefreshTimer = null;
    }
}
// ============================================ INTERFACES ============================================

// Глобальные функции для onclick
window.editDomain = openDomainModal;
window.quickTestRoute = quickTestRoute;
window.openPolicyRoutes = openPolicyRoutes;
window.openInterfaceDetail = openInterfaceDetail;
window.deleteDomain = deleteDomain;
window.installHooks = installHooks;
window.installCurl = installCurl;
window.installPhpModule = installPhpModule;
window.togglePolicyCollapse = togglePolicyCollapse;
window.loadTableRouteCount = loadTableRouteCount;
window.openTableView = openTableView;
window.openClientDetail = openClientDetail;
window.quickAddTarget = quickAddTarget;


// ============================================ AUTH / SETUP ============================================
let appInitialized = false;
const byId = (id) => document.getElementById(id);

async function postJson(payload) {
    const response = await fetch(API, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    return response.json();
}

async function currentState() {
    const result = await (await fetch(API + '?action=state', { cache: 'no-store' })).json();
    return result.state;
}

// state: noconfig -> nodb -> login -> ok
function enterState(st) {
    const authView = byId('authView');
    const app = document.querySelector('.container');

    if (st === 'ok') {
        authView.style.display = 'none';
        app.style.display = '';
        if (!appInitialized) {
            appInitialized = true;
            initApp();
            loadInterfaceChoices();
            loadLists();
            loadRoutePrefs();
            const startTab = document.querySelector('.tab-btn[data-tab="' + location.hash.slice(1).replace(/[^a-z]/g, '') + '"]');
            if (startTab) startTab.click();
        }
        return;
    }

    app.style.display = 'none';
    authView.style.display = 'flex';
    const setup = st === 'noconfig' || st === 'nodb';
    byId('loginForm').style.display = st === 'login' ? '' : 'none';
    byId('setupCard').style.display = setup ? '' : 'none';
    if (setup) renderSetup(st);
}

async function boot() {
    byId('loginForm').addEventListener('submit', submitLogin);
    byId('setupConfigForm').addEventListener('submit', submitSetupConfig);
    byId('setupDbBtn').addEventListener('click', createDatabase);

    try {
        const result = await (await fetch(API + '?action=state')).json();
        if (result.version && result.version !== JS_VERSION) {
            let tried = null;
            try { tried = sessionStorage.getItem('assetsRefreshed'); } catch (e) { /* storage may be blocked */ }
            if (tried !== result.version) {
                try { sessionStorage.setItem('assetsRefreshed', result.version); } catch (e) { /* ignore */ }
                await i18nInit(result.langs);
                await refreshAssets();
                return;
            }
        }
        await i18nInit(result.langs);
        enterState(result.state);
    } catch (error) {
        document.body.innerHTML = '<p style="padding:24px">Cannot reach app.php: ' + escapeHtml(error.message) + '. Check the web server and php-fpm.</p>';
    }
}

async function submitLogin(e) {
    e.preventDefault();
    const errEl = byId('loginError');
    errEl.style.display = 'none';
    const result = await postJson({ action: 'login', username: byId('loginUser').value.trim(), password: byId('loginPass').value });
    if (result.success) {
        byId('loginPass').value = '';
        enterState('ok');
    } else {
        errEl.textContent = result.error || 'Sign in failed';
        errEl.style.display = '';
    }
}

// Checks that only the browser can do: are the secrets reachable over HTTP?
async function webExposureChecks() {
    const fix = ['location ~ ^/(config\\.php|routes\\.db)$ { deny all; }   # in the nginx server block, then: nginx -s reload'];
    const probe = async (path) => {
        try {
            const response = await fetch(path, { cache: 'no-store' });
            return response.ok ? await response.text() : null;
        } catch (e) {
            return null;
        }
    };
    const [db, cfg] = await Promise.all([probe('/routes.db'), probe('/config.php')]);
    const dbOpen = db !== null && db.startsWith('SQLite format');
    const cfgOpen = cfg !== null && cfg.includes('$passwd');
    return [{
        id: 'web',
        label: 'config.php and routes.db hidden from the web',
        ok: !dbOpen && !cfgOpen,
        level: 'required',
        detail: dbOpen || cfgOpen ? 'They can be downloaded over HTTP.' : 'Not reachable over HTTP.',
        fix: dbOpen || cfgOpen ? fix : []
    }];
}

function renderChecks(el, checks) {
    el.classList.add('checks-compact');
    el.innerHTML = checks.map((c, i) => {
        const led = c.ok === true ? 'led-green' : (c.ok === null ? 'led-grey' : (c.level === 'optional' ? 'led-amber' : 'led-red'));
        const fixes = (c.ok === false && c.fix) ? c.fix.map((cmd, k) => `
            <div class="check-fix-row">
                <code>${escapeHtml(cmd)}</code>
                <button type="button" class="btn btn-small" data-copy="${i}:${k}">Copy</button>
            </div>`).join('') : '';
        let action = '';
        if (c.ok === false && c.action === 'installHooks') action = '<button type="button" class="btn btn-small btn-primary" data-click="installHooks">Install hooks</button>';
        if (c.ok === false && c.action === 'installCurl') action = '<button type="button" class="btn btn-small btn-primary" data-click="installCurl">Install curl</button>';
        if (c.ok === false && c.action === 'installOpenssl') action = '<button type="button" class="btn btn-small btn-primary" data-click="installPhp" data-action="installOpenssl" data-name="OpenSSL">Install</button>';
        if (c.ok === false && c.action === 'installSockets') action = '<button type="button" class="btn btn-small btn-primary" data-click="installPhp" data-action="installSockets" data-name="sockets">Install</button>';
        return `<div class="check-row${c.ok === true ? ' is-ok' : ''}"${c.detail ? ` title="${escapeHtml(c.detail)}"` : ''}>
            <span class="led ${led}"></span>
            <div class="check-text">
                <div class="check-label">${escapeHtml(c.label)}${c.level === 'optional' ? ' <span class="muted">(optional)</span>' : ''}</div>
                ${c.detail ? `<div class="check-line">${escapeHtml(c.detail)}</div>` : ''}
                ${fixes ? `<div class="check-fix">${fixes}</div>` : ''}
            </div>
            ${action}
        </div>`;
    }).join('');

    el.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const [i, k] = btn.dataset.copy.split(':').map(Number);
            try {
                await navigator.clipboard.writeText(checks[i].fix[k]);
                btn.textContent = 'Copied';
            } catch (e) {
                btn.textContent = 'Select manually';
            }
        });
    });
}

async function renderSetup(st) {
    byId('setupStepLabel').textContent = st === 'noconfig'
        ? 'Step 1 of 2: fix what is red, then enter the router access details.'
        : 'Step 2 of 2: create the database.';
    byId('setupConfigForm').style.display = st === 'noconfig' ? '' : 'none';
    byId('setupDbBlock').style.display = st === 'nodb' ? '' : 'none';

    const el = byId('setupChecks');
    el.innerHTML = '<span class="muted">Checking…</span>';
    try {
        const result = await (await fetch(API + '?action=setupCheck', { cache: 'no-store' })).json();
        renderChecks(el, result.checks.concat(await webExposureChecks()));
    } catch (error) {
        el.textContent = 'Failed to check: ' + error.message;
    }
}

async function submitSetupConfig(e) {
    e.preventDefault();
    const btn = byId('setupConfigBtn');
    const resultEl = byId('setupConfigResult');
    btn.disabled = true;
    resultEl.textContent = 'Checking su and RCI…';
    const result = await postJson({
        action: 'setupConfig',
        passwd: byId('setupPasswd').value,
        rci_host: byId('setupRci').value.trim(),
        our_table_start: parseInt(byId('setupTableStart').value, 10),
        auth_user: byId('setupUser').value.trim(),
        auth_password: byId('setupPassword').value
    });
    btn.disabled = false;
    if (result.success) {
        resultEl.textContent = '';
        byId('setupPasswd').value = '';
        byId('setupPassword').value = '';
        const next = await currentState();
        if (next === 'noconfig') {
            resultEl.innerHTML = '<span class="led led-red"></span> config.php was saved but the server cannot read it - the php-fpm user needs read access to the file.';
        } else {
            enterState(next);
        }
    } else {
        resultEl.innerHTML = `<span class="led led-red"></span> ${escapeHtml(result.error || 'Unknown error')}`;
    }
}

async function createDatabase() {
    const btn = byId('setupDbBtn');
    const resultEl = byId('setupDbResult');
    btn.disabled = true;
    resultEl.textContent = 'Working…';
    const result = await postJson({ action: 'setupDb' });
    if (result.success) {
        const hooks = result.hooks && result.hooks.success ? 'ndm hooks installed.' : 'ndm hooks NOT installed (see Tools after sign-in).';
        resultEl.innerHTML = `<span class="led led-green"></span> ${result.policies_imported} policies imported. ${hooks}`;
        setTimeout(async () => enterState(await currentState()), 1800);
    } else {
        btn.disabled = false;
        resultEl.innerHTML = `<span class="led led-red"></span> ${escapeHtml(result.error || 'Unknown error')}`;
        const actual = await currentState();
        if (actual !== 'nodb') setTimeout(() => enterState(actual), 1500);
    }
}

document.addEventListener('DOMContentLoaded', boot);


// ============================================ DNS FOR DOMAIN LOOKUPS ============================================
const DNS_PRESETS = [
    ['Google', '8.8.8.8'], ['Cloudflare', '1.1.1.1'], ['Quad9', '9.9.9.9'],
    ['OpenDNS', '208.67.222.222'], ['AdGuard', '94.140.14.14'], ['Yandex', '77.88.8.8'],
    ['Google 2', '8.8.4.4'], ['Cloudflare 2', '1.0.0.1'], ['Quad9 2', '149.112.112.112'],
];
let dnsPicked = [];
let dnsMode = 'first';
let dnsSaved = '';

function dnsSnapshot() { return dnsPicked.join(' ') + '|' + dnsMode; }

let routerDns = [];

function dnsName(ip) {
    const p = DNS_PRESETS.find(x => x[1] === ip) || routerDns.find(x => x[1] === ip);
    return p ? p[0] : '';
}

// Servers configured on the router itself: provider DNS and the upstreams of Keenetic DNS proxies
async function loadRouterDns() {
    try {
        const r = await (await apiFetch(API + '?action=getDnsInfo')).json();
        const list = [];
        (r.isp_servers || []).forEach(ip => list.push(['ISP', ip]));
        (r.proxies || []).forEach(p => (p.servers || []).forEach(sv => list.push([p.name === 'System' ? 'Keenetic' : p.name, sv.address])));
        const seen = new Set();
        routerDns = list.filter(([, ip]) => BW_IPV4.test(ip) && !seen.has(ip) && seen.add(ip));
    } catch (e) {
        routerDns = [];
    }
}

function renderDnsPicker(results = {}) {
    document.querySelectorAll('#dnsMode button').forEach(b => b.classList.toggle('active', b.dataset.m === dnsMode));
    document.getElementById('dnsModeTip').dataset.tip = t(dnsMode === 'all'
        ? 'Every server is asked and all answers are used. Useful when different DNS return different CDN addresses; slower.'
        : 'Servers are asked in order, the first one that answers is used.');
    const picked = document.getElementById('dnsPicked');
    if (!dnsPicked.length) {
        picked.innerHTML = '<span class="dns-badge dns-badge-system">System resolver</span>';
    } else {
        picked.innerHTML = dnsPicked.map((ip, n) => {
            const r = results[ip];
            const state = r ? (r.ok ? ' ok' : ' bad') : '';
            const tail = r ? (r.ok ? `<span class="dns-ms">${r.ms} ms</span>` : '<span class="dns-ms">✕</span>') : '';
            return `<span class="dns-badge dns-badge-on${state}"><span class="dns-n">${n + 1}</span>${escapeHtml(dnsName(ip))} <span class="dns-ip">${escapeHtml(ip)}</span>${tail}<button type="button" data-ip="${escapeHtml(ip)}" aria-label="Remove">×</button></span>`;
        }).join('');
    }
    const badge = ([name, ip]) => `<button type="button" class="dns-badge dns-badge-preset" data-ip="${ip}"><span class="dns-plus">+</span><span data-notr>${escapeHtml(name)}</span> <span class="dns-ip">${ip}</span></button>`;
    const freeRouter = routerDns.filter(([, ip]) => !dnsPicked.includes(ip));
    const freePublic = DNS_PRESETS.filter(([, ip]) => !dnsPicked.includes(ip) && !routerDns.some(r => r[1] === ip));
    let html = '';
    if (freeRouter.length) html += `<div class="dns-group"><span class="dns-group-name">${escapeHtml(t('From the router'))}</span>${freeRouter.map(badge).join('')}</div>`;
    if (freePublic.length) html += `<div class="dns-group"><span class="dns-group-name">${escapeHtml(t('Public DNS'))}</span>${freePublic.map(badge).join('')}</div>`;
    document.getElementById('dnsPresets').innerHTML = html || `<span class="card-note dns-none">${escapeHtml(t('All suggested servers are in use.'))}</span>`;
    const dirty = dnsSnapshot() !== dnsSaved;
    document.getElementById('dnsDirty').hidden = !dirty;
    document.getElementById('saveDnsBtn').disabled = !dirty;
}

function dnsAdd(ip) {
    ip = ip.trim();
    if (!BW_IPV4.test(ip)) { showToast(t('Not an IPv4 address: {0}', ip), 'error'); return; }
    if (dnsPicked.includes(ip)) return;
    if (dnsPicked.length >= 8) { showToast('At most 8 DNS servers', 'error'); return; }
    dnsPicked.push(ip);
    renderDnsPicker();
}

async function loadDnsResolver() {
    const r = await (await apiFetch(API + '?action=getDnsResolver')).json();
    dnsPicked = (r.servers || '').split(/\s+/).filter(Boolean);
    document.getElementById('dnsNoNslookup').hidden = r.nslookup !== false;
    dnsMode = r.mode === 'all' ? 'all' : 'first';
    dnsSaved = dnsSnapshot();
    renderDnsPicker();
    await loadRouterDns();
    renderDnsPicker();
}

async function saveDnsResolver() {
    const r = await api({ action: 'saveDnsResolver', servers: dnsPicked.join(' '), mode: dnsMode });
    if (r.success) {
        dnsSaved = dnsSnapshot();
        renderDnsPicker();
        dnsGlobalLoaded = false;
        showToast(r.servers ? 'DNS saved: domains are resolved through these servers' : 'DNS reset: the system resolver is used', 'success');
    } else {
        showToast(r.error || 'Failed to save', 'error', 8000);
    }
}

async function testDnsResolver() {
    const out = document.getElementById('dnsResult');
    out.textContent = t('Checking…');
    const r = await api({ action: 'testDnsResolver', servers: dnsPicked.join(' '), host: document.getElementById('dnsTestHost').value });
    if (r.error) {
        out.textContent = t(r.error);
        return;
    }
    const byIp = {};
    r.results.forEach(x => { byIp[x.server] = { ok: x.ips.length > 0, ms: x.ms }; });
    renderDnsPicker(byIp);
    out.innerHTML = `<div class="dns-res-head">${escapeHtml(t('Test domain: {0}', r.host))}</div>` + r.results.map(x => {
        const label = x.server ? `${escapeHtml(dnsName(x.server))} ${escapeHtml(x.server)}` : t('System resolver');
        return x.ips.length
            ? `<div class="dns-res ok"><span>${label}</span><span class="cell-mono">${escapeHtml(x.ips.join(', '))}</span></div>`
            : `<div class="dns-res bad"><span>${label}</span><span>${t('no answer')}</span></div>`;
    }).join('');
}

document.getElementById('dnsPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ip]');
    if (!b) return;
    const ip = b.dataset.ip;
    if (dnsPicked.includes(ip)) dnsPicked = dnsPicked.filter(x => x !== ip);
    else dnsAdd(ip);
    renderDnsPicker();
});
document.getElementById('dnsPicked').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ip]');
    if (!b) return;
    dnsPicked = dnsPicked.filter(x => x !== b.dataset.ip);
    renderDnsPicker();
});
document.getElementById('dnsAddBtn').addEventListener('click', (e) => {
    const menu = document.getElementById('dnsMenu');
    menu.hidden = !menu.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
    const menu = document.getElementById('dnsMenu');
    if (menu.hidden || e.target.closest('.dns-add')) return;
    menu.hidden = true;
    document.getElementById('dnsAddBtn').setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.getElementById('dnsMenu').hidden = true;
    document.getElementById('birdConfMenu').hidden = true;
});
document.getElementById('addDnsBtn').addEventListener('click', () => {
    const input = document.getElementById('dnsServers');
    dnsAdd(input.value);
    input.value = '';
});
document.getElementById('dnsServers').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('addDnsBtn').click(); });
document.getElementById('dnsMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    dnsMode = b.dataset.m;
    renderDnsPicker();
});
document.getElementById('saveDnsBtn').addEventListener('click', saveDnsResolver);

async function loadPanelNet() {
    const r = await (await apiFetch(API + '?action=getPanelNet')).json();
    fillInterfaceSelect('panelNetInterface', r.interface);
}

// The selects of the Panel card save at once; "Saved" shows for a moment next to the one that changed
function flashSaved(id) {
    const mark = document.getElementById(id);
    mark.classList.add('on');
    setTimeout(() => mark.classList.remove('on'), 1800);
}

document.getElementById('panelNetInterface').addEventListener('change', async (e) => {
    const r = await api({ action: 'savePanelNet', interface: e.target.value });
    if (r.error) { showToast(t(r.error), 'error'); return; }
    flashSaved('panelNetSaved');
});

async function loadJobDelay() {
    const r = await (await apiFetch(API + '?action=getJobSettings')).json();
    document.getElementById('jobDelay').value = r.delay;
}
document.getElementById('jobDelay').addEventListener('change', async (e) => {
    const r = await api({ action: 'saveJobSettings', delay: +e.target.value });
    if (r.error) { showToast(t(r.error), 'error'); return; }
    flashSaved('jobDelaySaved');
});
document.getElementById('testDnsBtn').addEventListener('click', testDnsResolver);

// ============================================ THEME ============================================
function applyTheme(name) {
    if (name === 'graphite') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = name;
    try { localStorage.setItem('theme', name); } catch (e) {}
    document.querySelectorAll('#themePick button').forEach(b => b.classList.toggle('active', b.dataset.theme === name));
}
document.getElementById('themePick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (b) applyTheme(b.dataset.theme);
});
applyTheme(document.documentElement.dataset.theme || 'graphite');


// ============================================ LISTS ============================================
let listsData = [];
let pendingLists = [];
let listsInfo = { source: '', downloader: true };
let catalogSites = null;
const catalogCache = {};
let listId = null;
let catalogGroup = '';
const listGroupsCollapsed = new Set();

// 'working:<unix time>' is written by the server while a list is being downloaded or resolved
function listWorkingSince(status) {
    if (status.indexOf('working:') !== 0) return 0;
    return Number(status.slice(8));
}

// Rows of lists that are being added: shown at once, replaced by the server rows when they appear
function setLists(serverLists) {
    pendingLists = pendingLists.filter(p => !serverLists.some(l => l.policy_id == p.policy_id && l.site === p.site));
    listsData = serverLists.concat(pendingLists);
}

function addPendingList(site, group, policyId, exit, mode, source) {
    const row = {
        id: 0, pending: true, site, grp: group, policy_id: policyId, enabled: 1,
        interface: exit.interface, gateway: exit.gateway, excl: '', items: '', domains: '',
        n_items: 0, n_domains: 0, last_sync: 0, status: 'queued', diff: '', mode, stats: '', dropped: '', resolved: '', source,
    };
    pendingLists.push(row);
    listsData.push(row);
    return row;
}

function dropPendingLists(onlyQueued, site, policyId) {
    const drop = l => l.pending && (!onlyQueued || l.status === 'queued') && (!site || (l.site === site && l.policy_id == policyId));
    pendingLists = pendingLists.filter(l => !drop(l));
    listsData = listsData.filter(l => !drop(l));
}

function listIsWorking(l) {
    const since = listWorkingSince(l.status);
    return since > Date.now() / 1000 - 1800;
}

// What the running update does with this list: its own stage, or "waiting" when another list is being processed
function listStageText(l, stage) {
    if (!listIsWorking(l)) return '';
    if (!stage) return t('Starting…');
    if (stage.id === l.id) return t(stage.text.split(': ')[0]) + (stage.text.includes(': ') ? ': ' + stage.text.split(': ')[1] : '');
    if (stage.id === 0 && stage.text === 'Applying the routes') return t(stage.text);
    return t('Waiting in the queue');
}

// The list waits for its turn in a running update of the whole panel (the update works on one list at a time)
function listQueuedInJob(l, stage) {
    if (!jobShown || jobShown.state !== 'running' || !jobShown.ids.includes(l.id)) return false;
    return !stage || stage.id !== l.id;
}

function listStatus(l) {
    if (l.status === 'queued') return { cls: 'led-grey', label: 'Queued' };
    if (l.status === 'cancelled') return { cls: 'led-amber', label: 'Cancelled' };
    if (listWorkingSince(l.status)) {
        return listIsWorking(l) ? { cls: 'led-blue', label: 'Updating…' } : { cls: 'led-red', label: 'Interrupted' };
    }
    if (!l.enabled) return { cls: 'led-grey', label: 'Off' };
    if (!l.interface && !l.gateway) return { cls: 'led-amber', label: 'No exit set' };
    if (l.status === 'ok') return { cls: 'led-green', label: 'Up to date' };
    if (l.status.startsWith('held')) return { cls: 'led-amber', label: 'Held' };
    if (!l.last_sync) return { cls: 'led-grey', label: 'Not synced' };
    return { cls: 'led-red', label: 'Source error' };
}

function policyOptions(selected) {
    return state.policies
        .filter(p => p.name !== 'DELETED')
        .map(p => `<option value="${p.id}"${p.id == selected ? ' selected' : ''}>${escapeHtml(p.description || p.name)} (${escapeHtml(p.name)})</option>`)
        .join('');
}

// The exit most targets of the policy use: a good default for a new list.
// The exit most of the policy's lists and targets use; an interface wins over a gateway on a tie
function policyExit(policyId) {
    const counts = new Map();
    const rows = state.domains.concat(listsData);
    rows.forEach(row => {
        if (row.policy_id != policyId || row.pending) return;
        if (!row.interface && !row.gateway) return;
        const key = row.interface ? 'i:' + row.interface : 'g:' + row.gateway;
        counts.set(key, (counts.get(key) || 0) + (row.interface ? 1.01 : 1));
    });
    let best = '';
    let bestCount = 0;
    counts.forEach((count, key) => {
        if (count > bestCount) { best = key; bestCount = count; }
    });
    if (!best) return { interface: '', gateway: '' };
    if (best[0] === 'i') return { interface: best.slice(2), gateway: '' };
    return { interface: '', gateway: best.slice(2) };
}

const catalogPolicies = new Set();

function catalogPolicyIds() {
    return [...catalogPolicies].filter(id => state.policies.some(p => p.id == id));
}

// One policy: the fields hold its exit. Several: each policy uses its own exit, the fields are the fallback.
function fillCatalogExit() {
    const exit = policyExit(catalogPolicyIds()[0]);
    fillInterfaceSelect('catalogInterface', exit.interface);
    document.getElementById('catalogGateway').value = exit.gateway;
}

function renderCatalogPolicies() {
    const select = document.getElementById('catalogPolicy');
    if (!catalogPolicies.size) {
        const first = state.policies.find(p => p.name !== 'DELETED');
        if (first) catalogPolicies.add(first.id);
    }
    select.innerHTML = policyOptions([...catalogPolicies][0]);
}

// Adds one site to every chosen policy that does not have it yet
function catalogExit() {
    return { interface: document.getElementById('catalogInterface').value, gateway: document.getElementById('catalogGateway').value.trim() };
}

async function addSiteToPolicies(site, group) {
    const ids = catalogPolicyIds();
    const exit = catalogExit();
    const result = { added: 0, failed: 0, exitError: null, items: 0, domains: 0, working: false };
    for (const id of ids) {
        if (listsData.some(l => !l.pending && l.policy_id == id && l.site === site)) continue;
        const mode = document.getElementById('catalogMode').value;
        let row = listsData.find(l => l.pending && l.policy_id == id && l.site === site);
        if (!row) row = addPendingList(site, group, id, exit, mode, catalogSourceName());
        row.status = 'working:' + Math.floor(Date.now() / 1000);
        renderLists();
        const r = await api({ action: 'addList', site, group, source: catalogSourceName(), policy_id: id, mode, interface: exit.interface, gateway: exit.gateway });
        if (r.error) {
            dropPendingLists(false, site, id);
            renderLists();
            result.failed++;
            if (/exit/.test(r.error)) { result.exitError = r.error; break; }
            continue;
        }
        result.added++;
        result.items = r.items;
        result.domains = r.domains;
        result.found = r.stats ? r.stats.entries : 0;
        result.working = !!r.working;
    }
    return result;
}

let listsTimer = null;
let listsWasBusy = false;

async function loadLists() {
    clearTimeout(listsTimer);
    let r;
    try {
        r = await (await apiFetch(API + '?action=getLists')).json();
        if (!r.lists) throw new Error(r.error || t('The router did not answer'));
        setLists(r.lists);
        listsInfo = r;
    } catch (e) {
        document.getElementById('listsList').innerHTML = `<tr><td colspan="8" class="loading">${escapeHtml(e.message)}</td></tr>`;
        return;
    }
    document.getElementById('cntLists').textContent = listsData.length || '';
    renderLists();
    renderPolicies(document.getElementById('searchPolicies').value);

    const busy = listsData.some(listIsWorking) || pendingLists.length > 0;
    if (busy) {
        listsTimer = setTimeout(loadLists, 3000);
    } else if (listsWasBusy && document.getElementById('listModal').style.display !== 'block') {
        reportListsJob(r.job);
    }
    listsWasBusy = busy;
}

// What the background update did, as a toast (the list window shows its own result)
function reportListsJob(job) {
    if (!job) return;
    if (job.failed) showToast(t('{0} lists failed to update: see the Status column', job.failed), 'error', 8000);
    else if (job.applied && job.applied.route_errors) showToast(t('The router rejected {0} routes: {1}', job.applied.route_errors, job.applied.route_error || ''), 'error', 10000);
    else if (job.held) showToast(t('{0} lists held back: too many entries disappeared', job.held), 'info', 8000);
    else showToast(t('Lists updated from the source: {0} routes written to the router in total', job.applied ? job.applied.routes : 0), 'success', 6000);
}

function renderLists() {
    const q = document.getElementById('searchLists').value.trim().toLowerCase();
    const shown = listsData.filter(l => !q || l.site.toLowerCase().includes(q) || l.grp.toLowerCase().includes(q));

    let last = null;
    let held = 0;
    listsData.forEach(l => {
        if (l.last_sync && (!last || l.last_sync > last)) last = l.last_sync;
        if (l.status.startsWith('held')) held++;
    });
    document.getElementById('listsNoCurl').hidden = listsInfo.downloader !== false;
    document.getElementById('listsStrip').innerHTML = `
        <div class="stat-card"><span class="stat-label"><span class="led led-green"></span>Lists</span><span class="stat-value">${listsData.length}</span></div>
        <div class="stat-card"><span class="stat-label"><span class="led led-blue"></span>Networks in tables</span><span class="stat-value">${listsInfo.routes || 0}</span></div>
        <div class="stat-card"><span class="stat-label"><span class="led led-amber"></span>Held back</span><span class="stat-value">${held}</span></div>
        <div class="stat-card"><span class="stat-label"><span class="led led-blue"></span>Last update</span><span class="stat-value">${timeAgo(last)}</span></div>`;

    const body = document.getElementById('listsList');
    if (q && !shown.length) {
        body.innerHTML = `<tr><td colspan="8" class="loading">${escapeHtml(t('Nothing found'))}</td></tr>`;
    } else {
        const policies = state.policies.filter(p => p.name !== 'DELETED' && (!q || shown.some(l => l.policy_id == p.id)));
        body.innerHTML = policies.map(p => {
            const inPolicy = shown.filter(l => l.policy_id == p.id);
            const routes = inPolicy.reduce((sum, l) => sum + (l.enabled ? l.n_items : 0), 0);
            const collapsed = !q && listGroupsCollapsed.has(p.id);
            const head = `<tr class="policy-group" style="--policy-hue:${policyHue(p.id)}"><td colspan="8"><div class="policy-group-row">
                <div class="policy-group-left"><button class="policy-toggle" data-policy="${p.id}">${collapsed ? '▸' : '▾'}</button><span class="policy-dot"></span><span class="policy-name" data-policy="${p.id}">${escapeHtml(p.name)}</span>${p.description ? `<span class="policy-desc">${escapeHtml(p.description)}</span>` : ''}</div>
                <div class="policy-meta"><span class="meta-mark">mark <code>${escapeHtml(p.mark_hex)}</code></span> <span class="meta-table">table ${Number(p.our_table) + 100}</span> <span class="meta-count">${t('{0} list(s)', inPolicy.length)}</span> <span class="meta-table">${t('{0} networks', routes)}</span></div>
            </div></td></tr>`;
            const empty = `<tr class="domain-row"><td colspan="8" class="loading">${escapeHtml(t('No lists in this policy'))}</td></tr>`;
            return head + (collapsed ? '' : (inPolicy.length ? inPolicy.map(listRow).join('') : empty));
        }).join('');
    }
    document.getElementById('listsNote').textContent = t('Sources: {0}', (listsInfo.sources || []).map(s => s.name + ' (' + s.url.replace(/^https?:\/\//, '') + ')').join(', '));
}

// ---------- entries of one list: what goes into the table and what does not ----------
let listEntries = null;
let entTab = 'table';
let entListId = null;

// One resolved domain: a short line, the addresses and who answered open on click
function listDomainRow(row) {
    const r = listResolved(row);
    const ips = Object.keys(r.answers);
    if (!ips.length) {
        return { cls: 'none', text: r.domain, right: t('no answer'), detail: `<p class="card-note">${escapeHtml(t('No DNS server returned an address for this domain.'))}</p>` };
    }
    const detail = '<div class="ip-src-list">' + ips.map(ip => {
        const by = r.answers[ip].map(server => server === 'system' ? 'system' : server);
        return `<div class="ip-src-row"><span class="chip">${escapeHtml(ip)}</span>${sourceBadges(by)}</div>`;
    }).join('') + '</div>';
    return { cls: 'ok', text: r.domain, right: t('{0} address(es)', ips.length), detail };
}

const REJECT_WHY = {
    private: 'private network',
    wide: 'wider than /8',
    special: 'multicast or reserved',
    invalid: 'not an IPv4 address',
};

const ENT_PAGE = 100;
let entLimit = ENT_PAGE;

// A stored resolve log row: [domain, {ip: [servers]}] (older rows: [domain, [ips], [servers]])
function listResolved(row) {
    const answers = {};
    if (Array.isArray(row[1])) {
        row[1].forEach(ip => { answers[ip] = row[2] || []; });
    } else {
        Object.assign(answers, row[1]);
    }
    return { domain: row[0], answers };
}

function renderEntries() {
    const box = document.getElementById('entList');
    if (!box) return;
    const q = document.getElementById('entSearch').value.trim().toLowerCase();
    const d = listEntries.dropped;
    const resolve = listEntries.mode !== 'networks';
    const domainCount = resolve ? listEntries.resolved.length : listEntries.domains.length;
    const tabs = [
        ['table', t('In the table'), listEntries.total],
        ['lost', t('Dropped'), d.rejected.length + d.excluded.length],
        ['merged', t('Merged'), d.merged.length],
        ['domains', t('Domains'), domainCount],
    ];
    document.getElementById('entTabs').innerHTML = tabs.map(x => `<button type="button" data-ent="${x[0]}" class="${x[0] === entTab ? 'active' : ''}">${escapeHtml(x[1])} <span>${x[2]}</span></button>`).join('');

    let rows = [];
    let hint = '';
    if (entTab === 'table') {
        rows = listEntries.inTable.map(e => ({ cls: 'ok', text: e, right: '' }));
        hint = t('These routes are written into the policy table.');
    } else if (entTab === 'lost') {
        rows = d.rejected.map(x => ({ cls: 'bad', text: x[0], right: t(REJECT_WHY[x[1]]) })).concat(d.excluded.map(x => ({ cls: 'warn', text: x[0], right: t('your exclusion') })));
        hint = t('These entries are not routed at all.');
    } else if (entTab === 'merged') {
        rows = d.merged.map(x => ({ cls: 'merge', text: x[0], right: '→ ' + x[1] }));
        hint = t('Covered by a bigger block that is in the table: the traffic still goes through the exit.');
    } else if (resolve) {
        rows = listEntries.resolved.map(listDomainRow);
        hint = t('Click a domain to see its addresses and who answered.');
    } else {
        rows = listEntries.domains.map(x => ({ cls: 'merge', text: x, right: '' }));
        hint = t('Domains the source knows for this site. Nothing is resolved in this mode: the networks come from the source.');
    }
    if (q) rows = rows.filter(x => x.text.toLowerCase().includes(q) || x.right.toLowerCase().includes(q));
    const shown = rows.slice(0, entLimit);
    let html = shown.map(x => x.detail !== undefined
        ? `<div class="ent ent-${x.cls} ent-dom"><span>${escapeHtml(x.text)}</span><i>${escapeHtml(x.right)}</i></div><div class="ent-detail" hidden>${x.detail}</div>`
        : `<div class="ent ent-${x.cls}"><span>${escapeHtml(x.text)}</span><i>${escapeHtml(x.right)}</i></div>`).join('');
    if (rows.length > shown.length) html += `<button type="button" class="ent ent-more" id="entMore">${escapeHtml(t('Show more ({0} left)', rows.length - shown.length))}</button>`;
    box.innerHTML = html || `<div class="ent ent-more">${escapeHtml(t('Nothing here'))}</div>`;
    document.getElementById('entHint').textContent = hint;
}

// How the list gets its addresses: networks straight from the source (CIDR + IP) or the source's domains resolved by our DNS
function listSourcePill(l) {
    const sources = listsInfo.sources || [];
    if (sources.length < 2) return '';
    const known = sources.find(s => s.name === l.source) || sources[0];
    return ` <span class="mode-pill mode-src" title="${escapeHtml(known.url)}">${escapeHtml(known.name)}</span>`;
}

function listModePill(l) {
    return listSourcePill(l) + listModePillOnly(l);
}

function listModePillOnly(l) {
    const cidrPill = ` <span class="mode-pill mode-cidr" title="${escapeHtml(t('Networks and addresses are taken from the source as they are'))}">CIDR</span>`;
    const dnsPill = ` <span class="mode-pill mode-dns" title="${escapeHtml(t('Domains of the source are resolved through your DNS'))}">DNS</span>`;
    if (l.mode === 'both') return cidrPill + dnsPill;
    if (l.mode === 'resolve') return ` <span class="mode-pill mode-dns" title="${escapeHtml(t('Domains of the source are resolved through your DNS'))}">DNS</span>`;
    return ` <span class="mode-pill mode-cidr" title="${escapeHtml(t('Networks and addresses are taken from the source as they are'))}">CIDR</span>`;
}

// Under the number of networks: where they came from
function listSource(l) {
    if (!l.stats) return '';
    const s = JSON.parse(l.stats);
    if (s.mode === 'resolve') return `<div class="card-note list-sub">${escapeHtml(t('resolved from domains'))}</div>`;
    if (s.mode === 'both') return `<div class="card-note list-sub">${escapeHtml(t('{0} from the source + {1} resolved', s.cidrs + s.addresses, s.resolved_ips))}</div>`;
    if (s.entries === l.n_items) return '';
    return `<div class="card-note list-sub">${escapeHtml(t('{0} in the source', s.entries))}</div>`;
}

// What happened to the entries between the source and the table
function listFlow(r) {
    if (!r.stats) return '';
    const s = JSON.parse(r.stats);
    const policy = state.policies.find(p => p.id == r.policy_id);
    const row = (label, value, cls = '') => `<div class="flow-row ${cls}"><span>${escapeHtml(label)}</span><b>${value}</b></div>`;
    let html = '';
    if (s.mode === 'resolve') {
        html += row(t('Domains in the source'), s.domains);
        html += row(t('Domains that got an answer'), t('{0} of {1}', s.answered, s.asked));
        if (s.domains > s.asked) html += row(t('Not resolved: over the limit'), s.domains - s.asked, 'warn');
        html += row(t('Addresses obtained'), s.entries);
    } else if (s.mode === 'both') {
        html += row(t('Networks from the source'), s.cidrs);
        html += row(t('Single addresses from the source'), s.addresses);
        html += row(t('Domains that got an answer'), t('{0} of {1}', s.answered, s.asked));
        if (s.domains > s.asked) html += row(t('Not resolved: over the limit'), s.domains - s.asked, 'warn');
        html += row(t('Addresses obtained'), s.resolved_ips);
        html += row(t('Different entries'), s.entries);
    } else {
        html += row(t('Networks from the source'), s.cidrs);
        html += row(t('Single addresses from the source'), s.addresses);
        html += row(t('Different entries'), s.entries);
    }
    if (s.rejected) html += row(t('Dropped: private, special or wider than /8'), '−' + s.rejected);
    if (s.excluded) html += row(t('Dropped by your exclusions'), '−' + s.excluded);
    if (s.merged) html += row(t('Merged: nested or neighbouring blocks'), '−' + s.merged);
    html += row(t('Routes in the table'), s.final, 'flow-total');
    const where = policy ? t('Table {0} of policy {1}, exit {2}', Number(policy.our_table) + 100, policy.name, exitText(r) || '—') : '';
    return `<section class="tg-sec"><h3>${escapeHtml(t('From the source to the table'))}</h3><div class="flow">${html}</div><p class="card-note">${escapeHtml(where)}</p></section>`;
}

// "+3 −1": what the last update changed
function listDelta(l) {
    if (!l.diff) return '';
    const d = JSON.parse(l.diff);
    if (!d.added && !d.removed) return '';
    return `<div class="card-note list-sub">+${d.added} −${d.removed}</div>`;
}

function exitText(r) {
    if (r.interface && r.gateway) return r.interface + ' via ' + r.gateway;
    return r.interface || r.gateway;
}

function listRow(l) {
            const st = listStatus(l);
            return `<tr class="domain-row">
                <td data-label="List"><strong data-notr>${escapeHtml(l.site)}</strong>${listModePill(l)}${l.grp ? `<div class="card-note list-sub">${escapeHtml(l.grp)}</div>` : ''}</td>
                <td data-label="Interface" class="cell-mono">${escapeHtml(l.interface) || '<span class="muted">—</span>'}</td>
                <td data-label="Gateway" class="cell-mono">${escapeHtml(l.gateway) || '<span class="muted">—</span>'}</td>
                <td data-label="Domains in source" class="cell-mono">${l.n_domains}</td>
                <td data-label="Networks" class="cell-mono">${l.n_items}${listSource(l)}</td>
                <td data-label="Updated" class="cell-mono">${timeAgo(l.last_sync)}${listDelta(l)}</td>
                <td data-label="Status"><span class="status-pill" title="${escapeHtml(l.status === 'ok' ? '' : l.status)}"><span class="led ${st.cls}"></span><span class="status-label">${escapeHtml(t(st.label))}</span></span>${listIsWorking(l) ? `<div class="card-note list-sub">${escapeHtml(listStageText(l, listsInfo && listsInfo.stage))}</div>` : ''}</td>
                <td data-label="Actions" class="col-actions">${l.pending ? '' : `${listIsWorking(l) ? `<button class="btn btn-small" data-list-stop="${l.id}">Stop</button> ` : ''}<button class="btn btn-small" data-list="${l.id}">Details</button> <button class="icon-btn icon-btn-danger" data-list-del="${l.id}" title="Delete">✕</button>`}</td>
            </tr>`;
}

document.getElementById('searchLists').addEventListener('input', renderLists);
document.getElementById('installCurlBtn').addEventListener('click', installCurl);
document.getElementById('listsList').addEventListener('click', (e) => {
    const g = e.target.closest('[data-policy]');
    if (g) {
        const name = +g.dataset.policy;
        if (listGroupsCollapsed.has(name)) listGroupsCollapsed.delete(name); else listGroupsCollapsed.add(name);
        renderLists();
        return;
    }
    const del = e.target.closest('button[data-list-del]');
    if (del) { deleteList(+del.dataset.listDel); return; }
    const stop = e.target.closest('button[data-list-stop]');
    if (stop) { cancelLists(+stop.dataset.listStop); return; }
    const b = e.target.closest('button[data-list]');
    if (b) openList(+b.dataset.list, true);
});

async function cancelLists(id) {
    const r = await api({ action: 'cancelLists', id });
    if (r.error) { showToast(t(r.error), 'error'); return; }
    listAwait = null;
    showToast(r.cancelled ? t('Update cancelled') : t('Nothing to cancel'), 'info');
    await loadLists();
    if (id && document.getElementById('listModal').style.display === 'block' && listId === id) openList(id);
}

document.getElementById('syncListsBtn').addEventListener('click', () => startJob('lists'));

// ---------- catalog ----------
function catalogSourceName() {
    return document.getElementById('catalogSource').value;
}

function renderSourcesEditor(sources) {
    document.getElementById('sourcesList').innerHTML = sources.map(s => `<div class="src-row">
        <input type="text" class="src-name" value="${escapeHtml(s.name)}" placeholder="${escapeHtml(t('Name'))}" autocomplete="off" spellcheck="false">
        <input type="text" class="src-url" value="${escapeHtml(s.url)}" placeholder="https://..." autocomplete="off" spellcheck="false">
        <button type="button" class="icon-btn icon-btn-danger src-del" title="${escapeHtml(t('Delete'))}">✕</button>
    </div>`).join('');
}

async function openCatalog(refresh = false) {
    renderCatalogPolicies();
    fillCatalogExit();
    const select = document.getElementById('catalogSource');
    const wanted = select.value;
    select.innerHTML = listsInfo.sources.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} · ${escapeHtml(s.url.replace(/^https?:\/\//, ''))}</option>`).join('');
    if (listsInfo.sources.some(s => s.name === wanted)) select.value = wanted;
    document.getElementById('catalogSourceBox').hidden = listsInfo.sources.length < 2;
    document.getElementById('listCatalogModal').style.display = 'block';
    const name = catalogSourceName();
    if (catalogCache[name] && !refresh) { catalogSites = catalogCache[name]; renderCatalog(); return; }
    document.getElementById('catalogList').innerHTML = `<p class="card-note">${escapeHtml(t('Loading the catalog from the source, this can take a while…'))}</p>`;
    try {
        const r = await (await apiFetch(API + '?action=getListsCatalog&source=' + encodeURIComponent(name) + (refresh ? '&refresh=1' : ''))).json();
        if (r.error) throw new Error(r.error);
        catalogCache[name] = r.sites;
        catalogSites = r.sites;
    } catch (e) {
        catalogSites = [];
        document.getElementById('catalogMsg').textContent = t(e.message);
    }
    renderCatalog();
}

const catalogSel = new Map();
let catalogStep = 1;

function catalogShownSites() {
    const q = document.getElementById('catalogSearch').value.trim().toLowerCase();
    return (catalogSites || []).filter(s => (!catalogGroup || s.group === catalogGroup) && (!q || s.site.toLowerCase().includes(q) || s.group.toLowerCase().includes(q)));
}

function catalogUpdateCounter() {
    const n = catalogSel.size;
    document.getElementById('catalogNext').disabled = !n;
    document.getElementById('catalogNext').textContent = n ? t('Next: {0} selected', n) : t('Next');
    const shown = catalogShownSites();
    document.getElementById('catalogSelAll').disabled = !shown.length || shown.every(s => catalogSel.has(s.site));
    document.getElementById('catalogSelNone').disabled = !n;
    document.getElementById('catalogGroupName').textContent = t('Selected: {0}', n) + ' · ' + t('shown: {0}', shown.length);
}

function renderCatalog() {
    const q = document.getElementById('catalogSearch').value.trim().toLowerCase();
    const counts = {};
    (catalogSites || []).forEach(s => { counts[s.group] = (counts[s.group] || 0) + 1; });
    const names = Object.keys(counts).sort();
    document.getElementById('catalogGroups').innerHTML = names.length
        ? [''].concat(names).map(g => `<button type="button" class="chip${g === catalogGroup ? ' active' : ''}" data-cgroup="${escapeHtml(g)}">${escapeHtml(g || t('All'))}<span>${g ? counts[g] : catalogSites.length}</span></button>`).join('')
        : '';
    const hits = catalogShownSites();
    const row = (site, group) => `<label class="look-row catalog-row">
        <input type="checkbox" data-site="${escapeHtml(site)}" data-group="${escapeHtml(group)}"${catalogSel.has(site) ? ' checked' : ''}>
        <div class="catalog-name"><strong>${escapeHtml(site)}</strong>${group ? `<div class="card-note list-sub">${escapeHtml(group)}</div>` : ''}</div>
        ${listsData.some(l => !l.pending && l.site === site) ? `<span class="status-pill"><span class="led led-green"></span><span class="status-label">${escapeHtml(t('Already in lists'))}</span></span>` : ''}
    </label>`;
    let html = hits.slice(0, 80).map(s => row(s.site, s.group)).join('');
    if (hits.length > 80) html += `<p class="card-note">${escapeHtml(t('Showing 80 of {0}: narrow the search', hits.length))}</p>`;
    // a name that is not in the catalog can only be tried when the catalog itself could not be loaded
    const catalogEmpty = !catalogSites || !catalogSites.length;
    if (catalogEmpty && q && /^[A-Za-z0-9._-]+$/.test(q)) html += row(q, '');
    document.getElementById('catalogList').innerHTML = html || `<p class="card-note">${escapeHtml(t('Nothing found'))}</p>`;
    catalogUpdateCounter();
}

function catalogSetStep(step) {
    catalogStep = step;
    document.getElementById('catalogStep1').hidden = step !== 1;
    document.getElementById('catalogStep2').hidden = step !== 2;
    document.querySelectorAll('#catalogSteps .catalog-step').forEach(el => {
        el.classList.toggle('active', +el.dataset.step === step);
        el.classList.toggle('done', +el.dataset.step < step);
    });
    document.getElementById('catalogRefresh').hidden = step !== 1;
    document.getElementById('catalogNext').hidden = step !== 1;
    document.getElementById('catalogBack').hidden = step !== 2;
    document.getElementById('catalogAdd').hidden = step !== 2;
    document.getElementById('catalogMsg').textContent = '';
    if (step === 2) renderCatalogStep2();
}

// Step 2: what will really be added to the chosen policy
function catalogTodo() {
    const id = catalogPolicyIds()[0];
    return [...catalogSel].map(([site, group]) => ({ site, group })).filter(s => !listsData.some(l => l.policy_id == id && l.site === s.site));
}

function renderCatalogStep2() {
    const todo = catalogTodo();
    const names = [...catalogSel.keys()];
    const head = names.slice(0, 6).join(', ') + (names.length > 6 ? '…' : '');
    let text = t('Selected lists: {0}', names.length) + ' — ' + head;
    if (todo.length < names.length) text += '. ' + t('Already in this policy, skipped: {0}', names.length - todo.length);
    document.getElementById('catalogSummary').textContent = text;
    const add = document.getElementById('catalogAdd');
    const exit = catalogExit();
    add.disabled = !todo.length || (!exit.interface && !exit.gateway);
    add.textContent = todo.length ? t('Add {0} lists', todo.length) : t('Nothing to add');
}

document.getElementById('addListBtn').addEventListener('click', () => {
    catalogSel.clear();
    document.getElementById('catalogSearch').value = '';
    catalogGroup = '';
    catalogSetStep(1);
    openCatalog();
});
document.getElementById('catalogSearch').addEventListener('input', renderCatalog);
document.getElementById('catalogPolicy').addEventListener('change', (e) => {
    catalogPolicies.clear();
    catalogPolicies.add(+e.target.value);
    fillCatalogExit();
    renderCatalogStep2();
});
document.getElementById('catalogGroups').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cgroup]');
    if (!b) return;
    catalogGroup = b.dataset.cgroup;
    renderCatalog();
});
document.getElementById('catalogList').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-site]');
    if (!box) return;
    if (box.checked) catalogSel.set(box.dataset.site, box.dataset.group);
    else catalogSel.delete(box.dataset.site);
    catalogUpdateCounter();
});
document.getElementById('catalogSelAll').addEventListener('click', () => {
    catalogShownSites().forEach(s => catalogSel.set(s.site, s.group));
    renderCatalog();
});
document.getElementById('catalogSelNone').addEventListener('click', () => {
    catalogSel.clear();
    renderCatalog();
});
document.getElementById('catalogInterface').addEventListener('change', renderCatalogStep2);
document.getElementById('catalogGateway').addEventListener('input', renderCatalogStep2);
document.getElementById('catalogNext').addEventListener('click', () => { if (catalogSel.size) catalogSetStep(2); });
document.getElementById('catalogBack').addEventListener('click', () => catalogSetStep(1));
document.getElementById('catalogAdd').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ids = catalogPolicyIds();
    const todo = catalogTodo();
    if (!todo.length) return;
    const msg = document.getElementById('catalogMsg');
    if (!catalogExit().interface && !catalogExit().gateway) {
        msg.textContent = t('Set an interface or a gateway: a route needs an exit');
        return;
    }
    btn.disabled = true;
    document.getElementById('catalogBack').disabled = true;
    let added = 0;
    let failed = 0;
    const exit = catalogExit();
    const queueMode = document.getElementById('catalogMode').value;
    todo.forEach(s => {
        ids.forEach(id => {
            if (listsData.some(l => l.policy_id == id && l.site === s.site)) return;
            addPendingList(s.site, s.group, id, exit, queueMode, catalogSourceName());
        });
    });
    renderLists();
    for (let i = 0; i < todo.length; i++) {
        msg.textContent = t('Adding {0} of {1}: {2}', i + 1, todo.length, todo[i].site);
        try {
            const r = await addSiteToPolicies(todo[i].site, todo[i].group);
            added += r.added;
            failed += r.failed;
            if (r.exitError) { showToast(t(r.exitError), 'error', 8000); break; }
        } catch (err) {
            failed++;
        }
    }
    dropPendingLists(true);
    pollJob();
    msg.textContent = '';
    document.getElementById('catalogBack').disabled = false;
    showToast(failed ? t('Lists added with errors: {0} of {1} failed', failed, added + failed) : t('Lists added: {0}', added), failed ? 'warning' : 'success', 8000);
    await loadLists();
    if (!failed) {
        catalogSel.clear();
        document.getElementById('listCatalogModal').style.display = 'none';
    } else {
        renderCatalogStep2();
    }
});
document.getElementById('catalogRefresh').addEventListener('click', () => { document.getElementById('catalogMsg').textContent = ''; openCatalog(true); });
document.getElementById('listCatalogClose').addEventListener('click', () => { document.getElementById('listCatalogModal').style.display = 'none'; });
document.getElementById('catalogSource').addEventListener('change', () => { catalogGroup = ''; catalogSel.clear(); document.getElementById('catalogMsg').textContent = ''; openCatalog(); });
document.getElementById('sourcesBtn').addEventListener('click', () => {
    renderSourcesEditor(listsInfo.sources);
    document.getElementById('sourcesModal').style.display = 'block';
});
document.getElementById('sourcesClose').addEventListener('click', () => { document.getElementById('sourcesModal').style.display = 'none'; });
document.getElementById('sourceAdd').addEventListener('click', () => {
    renderSourcesEditor(readSourcesEditor().concat([{ name: '', url: '' }]));
    const inputs = document.querySelectorAll('#sourcesList .src-name');
    inputs[inputs.length - 1].focus();
});
document.getElementById('sourcesList').addEventListener('click', (e) => {
    if (!e.target.closest('.src-del')) return;
    const row = e.target.closest('.src-row');
    row.remove();
});

function readSourcesEditor() {
    return [...document.querySelectorAll('#sourcesList .src-row')].map(row => ({
        name: row.querySelector('.src-name').value,
        url: row.querySelector('.src-url').value,
    }));
}

document.getElementById('listsSourceSave').addEventListener('click', async () => {
    const r = await api({ action: 'saveListsSources', sources: readSourcesEditor() });
    if (r.error) { showToast(t(r.error), 'error'); return; }
    Object.keys(catalogCache).forEach(k => delete catalogCache[k]);
    listsInfo.sources = r.sources;
    showToast('Sources saved', 'success');
    document.getElementById('sourcesModal').style.display = 'none';
    loadLists();
});

// ---------- one list ----------
function switchListPane(pane) {
    document.getElementById('listModal').dataset.pane = pane;
    document.querySelectorAll('#listTabs button').forEach(b => b.classList.toggle('active', b.dataset.pane === pane));
}

// "held: 319 of 336 entries disappeared" and other stored statuses, in the UI language
function listStatusText(status) {
    if (listWorkingSince(status)) return t('The update did not finish: the server stopped it. Try again.');
    if (status === 'cancelled') return t('The update was cancelled by you');
    const held = status.match(/^held: (\d+) of (\d+) entries disappeared$/);
    if (held) return t('Held back: {0} of {1} entries disappeared from the source. The table keeps the previous list.', held[1], held[2]);
    return t(status);
}

// What a save or an update did: each step on its own line
function listResultHtml(r, applied, saved) {
    const rows = [];
    const row = (cls, text) => rows.push(`<div class="res-row res-${cls}"><i></i><span>${escapeHtml(text)}</span></div>`);
    if (saved) row('ok', t('Settings saved'));
    const s = r.stats ? JSON.parse(r.stats) : null;
    if (r.status === 'ok' && s) {
        if (s.mode !== 'networks' && s.domains > s.asked) row('warn', t('Only the first {0} of {1} domains are resolved: the rest are over the limit', s.asked, s.domains));
        if (s.mode === 'resolve') row('ok', t('Resolved {0} of {1} domains of the source: {2} addresses', s.answered, s.asked, s.entries));
        else if (s.mode === 'both') {
            row('ok', t('Resolved {0} of {1} domains of the source: {2} addresses', s.answered, s.asked, s.resolved_ips));
            row('ok', t('Downloaded from the source: {0} entries, {1} routes after cleanup', s.entries, s.final));
        } else row('ok', t('Downloaded from the source: {0} entries, {1} routes after cleanup', s.entries, s.final));
    } else if (r.status.startsWith('held')) {
        row('warn', t('New data held back: the table keeps the previous list'));
    } else if (r.status !== 'ok') {
        row('bad', listStatusText(r.status));
    }
    if (applied === null) {
        row('warn', t('Routes are not applied yet'));
    } else if (applied && applied.success) {
        row('ok', t('Written to the router: {0} routes in total (targets and lists)', applied.routes));
        if (applied.route_errors) row('bad', t('The router rejected {0} routes: {1}', applied.route_errors, applied.route_error || ''));
    } else if (applied) {
        row('bad', t(applied.error || 'Routes were not applied'));
    }
    const policy = state.policies.find(p => p.id == r.policy_id);
    if (policy) row(r.interface || r.gateway ? 'ok' : 'warn', t('This list: table {0} of policy {1}, exit {2}', Number(policy.our_table) + 100, policy.name, exitText(r) || t('not set')));
    return `<div class="res-box">${rows.join('')}</div>`;
}

let listAwait = null;
let listPoll = null;

// While a list is being updated only the seconds counter changes: the window is not redrawn under the user
async function pollListWork(id) {
    if (listId !== id || document.getElementById('listModal').style.display !== 'block') return;
    const all = await (await apiFetch(API + '?action=getLists')).json();
    if (listId !== id || document.getElementById('listModal').style.display !== 'block') return;
    const r = all.lists.find(l => l.id === id);
    if (!r || !listIsWorking(r)) { openList(id); return; }
    const box = document.getElementById('listWorkBox');
    if (box && (box.dataset.queued === '1') !== listQueuedInJob(r, all.stage)) { openList(id); return; }
    const secs = document.getElementById('listWorkSecs');
    const stageNow = listStageText(r, all.stage);
    if (secs && stageNow) secs.parentNode.firstChild.textContent = stageNow + '. ';
    if (secs) secs.textContent = t('Running for {0} s. You can close this window: the result will appear in the list.', Math.max(0, Math.round(Date.now() / 1000 - listWorkingSince(r.status))));
    listPoll = setTimeout(() => pollListWork(id), 2500);
}

// fresh: opened by the user; otherwise it is a refresh of the window that must not reappear after it was closed
async function openList(id, fresh) {
    clearTimeout(listPoll);
    listId = id;
    if (fresh) listAwait = null;
    const r = await (await apiFetch(API + '?action=getListDetail&id=' + id)).json();
    if (id !== listId) return;
    if (!fresh && document.getElementById('listModal').style.display !== 'block') return;
    if (r.error) { showToast(t(r.error), 'error'); return; }
    const diff = r.diff ? JSON.parse(r.diff) : null;
    const held = r.status.startsWith('held');
    document.getElementById('listTitle').textContent = r.site;
    document.getElementById('listMsg').textContent = '';

    const working = listIsWorking(r);
    let html = '';
    if (working && listQueuedInJob(r, r.stage)) {
        const where = t('The update "{0}" is running now, at the step "{1}".', t(JOB_TITLES[jobShown.kind]), t(JOB_STEP_NAMES[jobShown.step]));
        html += `<div class="res-box" id="listWorkBox" data-queued="1"><div class="res-row res-work"><i class="spin"></i><span>${escapeHtml(t('This list waits for its turn.'))} ${escapeHtml(where)}</span></div><div class="res-actions"><button type="button" class="btn btn-small" id="listJobBtn">${escapeHtml(t('Show progress'))}</button><button type="button" class="btn btn-small res-stop" id="listStopBtn">${escapeHtml(t('Skip this list'))}</button></div></div>`;
        listAwait = listAwait || { saved: false };
        listPoll = setTimeout(() => pollListWork(id), 2500);
    } else if (working) {
        const seconds = Math.max(0, Math.round(Date.now() / 1000 - listWorkingSince(r.status)));
        const stageText = listStageText(r, r.stage);
        const what = stageText ? stageText + '.' : r.mode !== 'networks' ? t('Downloading the domains and resolving them through your DNS: this can take several minutes.') : t('Downloading the list from the source.');
        html += `<div class="res-box" id="listWorkBox" data-queued="0"><div class="res-row res-work"><i class="spin"></i><span>${escapeHtml(what)} <span id="listWorkSecs">${escapeHtml(t('Running for {0} s. You can close this window: the result will appear in the list.', seconds))}</span></span><button type="button" class="btn btn-small res-stop" id="listStopBtn">${escapeHtml(t('Cancel the update'))}</button></div></div>`;
        listAwait = listAwait || { saved: false };
        listPoll = setTimeout(() => pollListWork(id), 2500);
    } else if (listAwait) {
        html += listResultHtml(r, r.job ? r.job.applied : null, listAwait.saved);
        listAwait = null;
    }
    document.getElementById('listSyncBtn').disabled = working;
    document.getElementById('listSaveBtn').disabled = working;
    document.getElementById('listDeleteBtn').disabled = working;
    html += `<div class="sum-grid">
        <div class="sum-card"><span class="sum-k">Networks</span><span class="sum-v">${r.n_items}</span></div>
        <div class="sum-card"><span class="sum-k">Domains in source</span><span class="sum-v">${r.n_domains}</span></div>
        <div class="sum-card"><span class="sum-k">Updated</span><span class="sum-v list-when">${timeAgo(r.last_sync)}</span></div>
    </div>`;
    if (r.status !== 'ok' && !working) {
        html += `<div class="list-status ${held ? 'warn' : 'bad'}"><span>${escapeHtml(listStatusText(r.status))}</span>${held ? `<button type="button" class="btn btn-small" id="listForceBtn">Apply anyway</button>` : ''}</div>`;
    }
    html += listFlow(r);
    if (diff && (diff.added || diff.removed)) {
        html += `<details class="tg-sec list-changes"><summary>${escapeHtml(t('Changes at the last sync'))} <span class="ch-add">+${diff.added}</span> <span class="ch-del">−${diff.removed}</span></summary>`;
        if (diff.added) html += `<div class="dns-res ok"><span class="cell-mono">${escapeHtml(diff.added_sample.join(' · '))}${diff.added > diff.added_sample.length ? ' …' : ''}</span></div>`;
        if (diff.removed) html += `<div class="dns-res bad"><span class="cell-mono">${escapeHtml(diff.removed_sample.join(' · '))}${diff.removed > diff.removed_sample.length ? ' …' : ''}</span></div>`;
        html += '</details>';
    }
    if (r.items_all.length || r.dropped) {
        html += `<section class="tg-sec"><h3>${escapeHtml(t('Entries'))}</h3>
            <div class="seg ent-tabs" id="entTabs" role="group"></div>
            <input type="text" id="entSearch" class="ent-search" placeholder="${escapeHtml(t('Filter entries...'))}" autocomplete="off" spellcheck="false">
            <div class="ent-list cell-mono" id="entList"></div>
            <p class="card-note" id="entHint"></p></section>`;
    }
    document.getElementById('listInfo').innerHTML = html;
    listEntries = { mode: r.mode, resolved: r.resolved ? JSON.parse(r.resolved) : [], domains: r.domains_all || [], inTable: r.items_all, dropped: r.dropped ? JSON.parse(r.dropped) : { rejected: [], excluded: [], merged: [] }, total: r.n_items };
    if (entListId !== id) { entTab = 'table'; entLimit = ENT_PAGE; entListId = id; }
    renderEntries();

    document.getElementById('listPolicy').innerHTML = policyOptions(r.policy_id);
    document.getElementById('listExcl').value = r.excl;
    fillInterfaceSelect('listInterface', r.interface);
    document.getElementById('listGateway').value = r.gateway;
    document.getElementById('listMode').value = r.mode;
    document.getElementById('listEnabled').checked = !!r.enabled;
    listUrls = r.urls;
    renderListUrls();
    switchListPane('info');
    document.getElementById('listModal').style.display = 'block';
}

// The addresses the list is downloaded from, for the mode picked in the form
let listUrls = null;
function renderListUrls() {
    const mode = document.getElementById('listMode').value;
    const keys = mode === 'resolve' ? ['domains'] : (mode === 'both' ? ['cidr4', 'ip4', 'domains'] : ['cidr4', 'ip4']);
    document.getElementById('listUrls').innerHTML = keys.map(k => `<a href="${escapeHtml(listUrls[k])}" target="_blank" rel="noopener noreferrer">${escapeHtml(listUrls[k])}</a>`).join('');
}
document.getElementById('listMode').addEventListener('change', renderListUrls);

// Switches to the Overview at once and says what is going on, before anything is sent to the server
function listBusy(text) {
    switchListPane('info');
    document.getElementById('listInfo').innerHTML = `<div class="res-box"><div class="res-row res-work"><i class="spin"></i><span>${escapeHtml(text)}</span></div></div>`;
    ['listSyncBtn', 'listSaveBtn', 'listDeleteBtn'].forEach(id => { document.getElementById(id).disabled = true; });
}

async function syncOneList(force) {
    listBusy(t('Starting the update…'));
    const r = await api({ action: 'syncLists', id: listId, force });
    if (r.error) { showToast(t(r.error), 'error', 8000); openList(listId); return; }
    listAwait = { saved: false };
    await loadLists();
    openList(listId);
}

document.getElementById('listSyncBtn').addEventListener('click', () => syncOneList(false));
document.getElementById('listInfo').addEventListener('click', (e) => {
    if (e.target.id === 'listForceBtn') syncOneList(true);
    if (e.target.id === 'listStopBtn') cancelLists(listId);
    if (e.target.id === 'listJobBtn') jobModalShow();
    const tab = e.target.closest('[data-ent]');
    if (tab) { entTab = tab.dataset.ent; entLimit = ENT_PAGE; renderEntries(); }
    if (e.target.id === 'entMore') { entLimit += 300; renderEntries(); }
    const dom = e.target.closest('.ent-dom');
    if (dom) {
        dom.classList.toggle('open');
        dom.nextElementSibling.hidden = !dom.nextElementSibling.hidden;
    }
});
document.getElementById('listInfo').addEventListener('input', (e) => { if (e.target.id === 'entSearch') { entLimit = ENT_PAGE; renderEntries(); } });
document.querySelectorAll('#listTabs button').forEach(b => b.addEventListener('click', () => switchListPane(b.dataset.pane)));
document.getElementById('listClose').addEventListener('click', () => {
    clearTimeout(listPoll);
    listAwait = null;
    document.getElementById('listModal').style.display = 'none';
});
document.getElementById('listCancelBtn').addEventListener('click', () => switchListPane('info'));
document.getElementById('listSaveBtn').addEventListener('click', async () => {
    const body = {
        action: 'saveList', id: listId,
        policy_id: +document.getElementById('listPolicy').value,
        mode: document.getElementById('listMode').value,
        excl: document.getElementById('listExcl').value,
        interface: document.getElementById('listInterface').value,
        gateway: document.getElementById('listGateway').value,
        enabled: document.getElementById('listEnabled').checked,
    };
    listBusy(t('Saving the settings and starting the update…'));
    const r = await api(body);
    if (r.error) {
        showToast(t(r.error), 'error', 8000);
        ['listSyncBtn', 'listSaveBtn', 'listDeleteBtn'].forEach(id => { document.getElementById(id).disabled = false; });
        switchListPane('edit');
        return;
    }
    listAwait = { saved: true };
    await loadLists();
    openList(listId);
});
async function deleteList(id) {
    const list = listsData.find(l => l.id === id);
    const name = list ? list.site : '';
    if (!await showConfirm(t('Delete the list {0}? Its routes are removed from the tables.', name), t('Delete'))) return;
    const r = await api({ action: 'deleteList', id });
    if (r.error) { showToast(t(r.error), 'error'); return; }
    document.getElementById('listModal').style.display = 'none';
    showToast(t('List deleted'), 'success');
    loadLists();
    pollJob();
}

document.getElementById('listDeleteBtn').addEventListener('click', () => deleteList(listId));

// ============================================ TARGET DETAILS ============================================
let targetDetailId = null;

function parseJsonObject(raw) {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}

function serverBadge(by) {
    if (by === 'system') return `<span class="src-badge src-system">${escapeHtml(t('System resolver'))}</span>`;
    return `<span class="src-badge">${escapeHtml(dnsName(by))} <span class="dns-ip">${escapeHtml(by)}</span></span>`;
}

// ip_sources holds an array of servers per IP (older records: one string)
function sourceBadges(by) {
    const list = Array.isArray(by) ? by : (by ? [by] : []);
    if (!list.length) return `<span class="src-badge src-unknown">${escapeHtml(t('unknown source'))}</span>`;
    return `<span class="src-list">${list.map(serverBadge).join('')}</span>`;
}

function ipSourceList(raw, sources, isCidr) {
    const ips = isJSONString(raw) ? JSON.parse(raw) : [];
    if (!ips.length) return '<span class="muted">—</span>';
    return '<div class="ip-src-list">' + ips.map(ip =>
        `<div class="ip-src-row"><span class="chip">${escapeHtml(ip)}</span>${isCidr ? `<span class="src-badge src-system">${escapeHtml(t('entered manually'))}</span>` : sourceBadges(sources[ip])}</div>`).join('') + '</div>';
}

async function openTargetDetail(id) {
    targetDetailId = id;
    renderTargetDetail();
    showTarget('info', { tabs: true, title: state.domains.find(d => d.id === id).domain });
    if (!dnsGlobalLoaded) {
        const r = await (await apiFetch(API + '?action=getDnsResolver')).json();
        dnsGlobal = (r.servers || '').split(/\s+/).filter(Boolean);
        await loadRouterDns();
        dnsGlobalLoaded = true;
        renderTargetDetail();
    }
}

function showTarget(pane, { tabs, title }) {
    const m = document.getElementById('targetModal');
    m.dataset.pane = pane;
    document.getElementById('targetTabs').hidden = !tabs;
    document.getElementById('targetTitle').textContent = t(title);
    document.querySelectorAll('#targetTabs button').forEach(b => b.classList.toggle('active', b.dataset.pane === pane));
    m.style.display = 'block';
}

function switchTargetPane(pane) {
    const id = targetDetailId;
    if (pane === 'info') openTargetDetail(id);
    else if (pane === 'edit') openDomainModal(id);
    else quickTestRoute(id);
}

let dnsGlobal = [];
let dnsGlobalLoaded = false;

function renderTargetDetail() {
    const d = state.domains.find(x => x.id === targetDetailId);
    if (!d) return;
    const isCidr = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(d.domain);
    const status = domainStatus(d);
    const policy = state.policies.find(p => p.id === d.policy_id);
    const src = parseJsonObject(d.ip_sources);
    const skip = (d.dns_skip || '').split(/\s+/).filter(Boolean);
    const last = toLocalDate(d.last_check);

    let dnsBlock = '';
    if (isCidr) {
        dnsBlock = '';
    } else if (!dnsGlobal.length) {
        dnsBlock = `<section class="tg-sec"><h3>${escapeHtml(t('DNS for this target'))}</h3><p class="card-note">${escapeHtml(t('Own DNS servers are not set (Settings, DNS for domain lookups): the system resolver is used.'))}</p></section>`;
    } else {
        dnsBlock = `<section class="tg-sec"><h3>${escapeHtml(t('DNS for this target'))}</h3>
            <p class="card-note">${escapeHtml(t('Click a server to exclude it for this target. If every server is excluded, the system resolver answers.'))}</p>
            <div class="dns-picked" id="targetDnsBadges">${dnsGlobal.map(ip => {
                const off = skip.includes(ip);
                return `<button type="button" class="dns-badge dns-badge-preset target-dns${off ? ' off' : ' used'}" data-ip="${escapeHtml(ip)}"><span data-notr>${escapeHtml(dnsName(ip))}</span> <span class="dns-ip">${escapeHtml(ip)}</span>${off ? `<span class="dns-off">${escapeHtml(t('excluded'))}</span>` : ''}</button>`;
            }).join('')}</div></section>`;
    }

    document.getElementById('targetInfo').innerHTML = `
        <div class="tg-meta">
            <div><span class="sum-k">${escapeHtml(t('Status'))}</span><span class="status-pill"><span class="led ${status.cls}"></span><span class="status-label">${escapeHtml(t(status.label))}</span></span></div>
            <div><span class="sum-k">${escapeHtml(t('Policy'))}</span><span>${escapeHtml(policy ? policy.name : '—')}</span></div>
            <div><span class="sum-k">${escapeHtml(t('Interface'))}</span><span class="cell-mono">${escapeHtml(d.interface) || '—'}</span></div>
            <div><span class="sum-k">${escapeHtml(t('Gateway'))}</span><span class="cell-mono">${escapeHtml(d.gateway) || '—'}</span></div>
            <div><span class="sum-k">${escapeHtml(t('Last check'))}</span><span class="cell-mono">${last ? escapeHtml(i18nDate(last)) : '—'}</span></div>
        </div>
        <section class="tg-sec"><h3>${escapeHtml(t('Current IP'))}</h3>${ipSourceList(d.current_ip, src.cur || {}, isCidr)}</section>
        <section class="tg-sec"><h3>${escapeHtml(t('Previous IP'))}</h3>${ipSourceList(d.previous_ip, src.prev || {}, isCidr)}</section>
        ${dnsBlock}`;


    document.querySelectorAll('#targetDnsBadges button').forEach(b => b.addEventListener('click', () => toggleTargetDns(b.dataset.ip)));
}

async function toggleTargetDns(ip) {
    const d = state.domains.find(x => x.id === targetDetailId);
    const skip = (d.dns_skip || '').split(/\s+/).filter(Boolean);
    const next = skip.includes(ip) ? skip.filter(x => x !== ip) : skip.concat(ip);
    const r = await api({ action: 'saveTargetDns', id: d.id, skip: next.join(' ') });
    if (!r.success) { showToast(r.error || 'Failed to save', 'error', 8000); return; }
    d.dns_skip = next.join(' ');
    renderTargetDetail();
    document.getElementById('targetMsg').textContent = t('Saved. Press "Resolve again" to apply.');
}

async function refreshTargetDetail() {
    const btn = document.getElementById('targetRefreshBtn');
    const msg = document.getElementById('targetMsg');
    btn.disabled = true;
    const r = await api({ action: 'refreshTarget', id: targetDetailId });
    if (!r.success) {
        btn.disabled = false;
        showToast(r.error || 'Failed to update', 'error', 8000);
        return;
    }
    msg.textContent = r.queued ? t('Waiting in the task queue…') : t('Resolving…');
    pollJob();
    for (let i = 0; i < 300; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const status = await (await apiFetch(API + '?action=getJob')).json();
        if (!(status.job && status.job.state === 'running') && !status.queue.length) break;
    }
    await loadData();
    renderTargetDetail();
    msg.textContent = t('Done: the task is finished, see the sources above.');
}

window.openTargetDetail = openTargetDetail;


// ============================================ TOOLTIPS ============================================
const tipBox = document.createElement('div');
tipBox.className = 'tip-box';
tipBox.hidden = true;
document.body.appendChild(tipBox);

const TIP_SELECTOR = '.info-tip, .dpi-r[data-tip], .dpi-kb[data-tip]';
function tipShow(el) {
    if (!el.dataset.tip) return;
    tipBox.textContent = el.dataset.tip;
    tipBox.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipBox.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    tipBox.style.left = left + 'px';
    const below = r.bottom + 8 + tipBox.offsetHeight < window.innerHeight;
    tipBox.style.top = (below ? r.bottom + 8 : r.top - 8 - tipBox.offsetHeight) + 'px';
}
function tipHide() { tipBox.hidden = true; }
document.addEventListener('mouseover', (e) => { const el = e.target.closest(TIP_SELECTOR); if (el) tipShow(el); });
document.addEventListener('mouseout', (e) => { if (e.target.closest(TIP_SELECTOR)) tipHide(); });
document.addEventListener('focusin', (e) => { const el = e.target.closest(TIP_SELECTOR); if (el) tipShow(el); });
document.addEventListener('focusout', tipHide);
document.addEventListener('click', (e) => {
    const el = e.target.closest(TIP_SELECTOR);
    if (el) tipShow(el); else tipHide();
});


// ============================================ ROUTING ORDER ============================================
let routePrefs = { targets: 4, lists: 6, bgp: 5 };
let lanePrefs = { targets: 4, lists: 6, bgp: 5 };
let prefsSaved = '';
let laneDrag = null;

function laneItems(prefs) {
    return [
        { key: 'targets', name: t('Targets'), hint: t('your domains and IPs'), pref: prefs.targets },
        { key: 'lists', name: t('Lists'), hint: t('ready-made IP lists'), pref: prefs.lists },
        { key: 'bgp', name: 'BGP', hint: t('bird table'), pref: prefs.bgp },
    ].sort((a, b) => a.pref - b.pref);
}

// "1 Targets pref 4 → 2 BGP table pref 5 → 3 Keenetic routing", sorted by pref
function orderText(prefs) {
    const items = laneItems(prefs).map(it => [it.pref, it.key === 'bgp' ? t('BGP table') : it.name]);
    items.push([null, t('Keenetic routing')]);
    return items.map((it, n) => `${n + 1} ${it[1]}${it[0] === null ? '' : ` pref ${it[0]}`}`).join(' → ');
}

function laneHtml() {
    const items = laneItems(lanePrefs);
    const prefValues = items.map(it => it.pref);
    const dup = prefValues.some((v, n) => prefValues.indexOf(v) !== n);
    let html = '';
    items.forEach((it, n) => {
        html += `<div class="lane-card lane-${it.key}" draggable="true" data-key="${it.key}" title="${escapeHtml(it.hint)}">
            <span class="lane-num">${n + 1}</span>
            <span class="lane-name">${escapeHtml(it.name)}</span>
            <span class="lane-pref"><span>pref</span><input type="number" min="1" max="99" value="${it.pref}" data-key="${it.key}"></span>
            <span class="lane-move">
                <button type="button" class="lane-btn" data-move="-1" data-key="${it.key}" ${n === 0 ? 'disabled' : ''} aria-label="${escapeHtml(t('Earlier'))}">◀</button>
                <button type="button" class="lane-btn" data-move="1" data-key="${it.key}" ${n === items.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(t('Later'))}">▶</button>
            </span>
        </div>
        <div class="lane-arrow">→</div>`;
    });
    html += `<div class="lane-card lane-fixed" title="${escapeHtml(t('everything else'))}">
        <span class="lane-num">${items.length + 1}</span>
        <span class="lane-name">Keenetic</span>
    </div>`;
    if (dup) html += `<div class="lane-warn">${escapeHtml(t('Prefs must be different'))}</div>`;
    return { html, dup };
}

function renderPrefs() {
    document.getElementById('prefNote').textContent = t('The panel does not change Keenetic\'s own tables. Rules with pref {0} are set by the panel for your targets, pref {1} for your lists, pref {2} by bird for BGP.', routePrefs.targets, routePrefs.lists, routePrefs.bgp);
    document.getElementById('birdOrder').dataset.tip = orderText(routePrefs);
    const lane = laneHtml();
    document.getElementById('prefLane').innerHTML = lane.html;
    const dirty = lanePrefs.targets + ' ' + lanePrefs.lists + ' ' + lanePrefs.bgp !== prefsSaved;
    document.getElementById('prefDirty').hidden = !dirty;
    document.getElementById('savePrefsBtn').disabled = !dirty || lane.dup;
}

// Swap the pref numbers of two cards: the order changes, the set of numbers stays
function laneSwap(keyA, keyB) {
    const tmp = lanePrefs[keyA];
    lanePrefs[keyA] = lanePrefs[keyB];
    lanePrefs[keyB] = tmp;
    renderPrefs();
}

async function loadRoutePrefs() {
    routePrefs = await (await apiFetch(API + '?action=getRoutePrefs')).json();
    lanePrefs = { targets: routePrefs.targets, lists: routePrefs.lists, bgp: routePrefs.bgp };
    prefsSaved = routePrefs.targets + ' ' + routePrefs.lists + ' ' + routePrefs.bgp;
    renderPrefs();
}

const prefLane = document.getElementById('prefLane');
prefLane.addEventListener('click', (e) => {
    const btn = e.target.closest('.lane-btn');
    if (!btn) return;
    const items = laneItems(lanePrefs);
    const pos = items.findIndex(it => it.key === btn.dataset.key);
    const other = items[pos + Number(btn.dataset.move)];
    laneSwap(btn.dataset.key, other.key);
});
prefLane.addEventListener('change', (e) => {
    if (!e.target.matches('.lane-pref input')) return;
    const value = parseInt(e.target.value, 10);
    if (value >= 1 && value <= 99) lanePrefs[e.target.dataset.key] = value;
    renderPrefs();
});
prefLane.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.lane-card[data-key]');
    if (!card) return;
    laneDrag = card.dataset.key;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', laneDrag);
});
prefLane.addEventListener('dragover', (e) => {
    const card = e.target.closest('.lane-card[data-key]');
    if (!card || !laneDrag) return;
    e.preventDefault();
    prefLane.querySelectorAll('.drop').forEach(el => el.classList.remove('drop'));
    if (card.dataset.key !== laneDrag) card.classList.add('drop');
});
prefLane.addEventListener('drop', (e) => {
    const card = e.target.closest('.lane-card[data-key]');
    if (!card || !laneDrag) return;
    e.preventDefault();
    if (card.dataset.key !== laneDrag) laneSwap(laneDrag, card.dataset.key);
    laneDrag = null;
});
prefLane.addEventListener('dragend', () => {
    laneDrag = null;
    prefLane.querySelectorAll('.dragging, .drop').forEach(el => el.classList.remove('dragging', 'drop'));
});

document.getElementById('savePrefsBtn').addEventListener('click', async () => {
    const r = await api({ action: 'saveRoutePrefs', targets: lanePrefs.targets, lists: lanePrefs.lists, bgp: lanePrefs.bgp });
    if (r.error) { showToast(t(r.error), 'error', 8000); return; }
    showToast('Order saved, routes re-applied', 'success');
    await loadRoutePrefs();
});

// ---------- the router's own configuration: static routes and interface state ----------
function showRciResult(r, title) {
    document.getElementById('rciTitle').textContent = t(title);
    document.getElementById('rciNote').textContent = r.dry_run ? t('Preview only: nothing was sent to the router.') : t(r.error || '');
    document.getElementById('rciSent').textContent = JSON.stringify(r.sent, null, 2);
    document.getElementById('rciReply').textContent = r.reply || '';
    document.getElementById('rciReplyHead').hidden = !r.reply;
    document.getElementById('rciReply').hidden = !r.reply;
    document.getElementById('rciModal').style.display = 'block';
}

// Sends a change to the router; with the preview box ticked only the request is shown
async function rciCall(payload, title, dryRunId = 'rciDryRun') {
    payload.dry_run = document.getElementById(dryRunId).checked;
    const r = await api(payload);
    if (r.dry_run || (r.error && r.sent)) showRciResult(r, title);
    else if (r.error) showToast(t(r.error), 'error', 8000);
    return r;
}

document.getElementById('rciClose').addEventListener('click', () => { document.getElementById('rciModal').style.display = 'none'; });

async function loadStaticRoutes() {
    const body = document.getElementById('staticList');
    try {
        const r = await (await apiFetch(API + '?action=getStaticRoutes')).json();
        if (r.error) {
            body.innerHTML = `<tr><td colspan="6" class="loading">${escapeHtml(t(r.error))}</td></tr>`;
            return;
        }
        if (!r.routes.length) {
            body.innerHTML = `<tr><td colspan="6" class="loading">${escapeHtml(t('No static routes'))}</td></tr>`;
            return;
        }
        body.innerHTML = r.routes.map(x => {
            const status = x.active
                ? `<span class="status-pill"><span class="led led-green"></span><span class="status-label">${escapeHtml(t('Active'))}</span></span>`
                : `<span class="status-pill"><span class="led led-amber"></span><span class="status-label">${escapeHtml(t(x.auto ? 'Waiting for the interface' : 'Not in the table'))}</span></span>`;
            return `<tr class="domain-row">
                <td data-label="Network" class="cell-mono">${escapeHtml(x.dest)}</td>
                <td data-label="Gateway" class="cell-mono">${escapeHtml(x.gateway) || '<span class="muted">—</span>'}</td>
                <td data-label="Interface" class="cell-mono">${escapeHtml(x.interface) || '<span class="muted">—</span>'}</td>
                <td data-label="Comment" class="cell-mono">${escapeHtml(x.comment) || '<span class="muted">—</span>'}</td>
                <td data-label="Status">${status}</td>
                <td data-label="Actions" class="col-actions col-sticky-right"><button type="button" class="icon-btn icon-btn-danger" data-static-del="${escapeHtml(x.dest)}" title="${escapeHtml(t('Delete'))}">✕</button></td>
            </tr>`;
        }).join('');
    } catch (error) {
        body.innerHTML = `<tr><td colspan="6" class="loading">${escapeHtml(error.message)}</td></tr>`;
    }
}

function fillStaticInterface() {
    const select = document.getElementById('staticRouteInterface');
    const rows = interfaceChoices.filter(i => i.id);
    select.innerHTML = `<option value="">${escapeHtml(t('Not set'))}</option>` + rows.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.id + ' — ' + (i.description || i.name))}</option>`).join('');
}

document.getElementById('staticRefreshBtn').addEventListener('click', loadStaticRoutes);
document.getElementById('staticAddBtn').addEventListener('click', () => {
    fillStaticInterface();
    document.getElementById('staticRouteNames').value = '';
    document.getElementById('staticRouteGateway').value = '';
    document.getElementById('staticRouteComment').value = '';
    document.getElementById('staticRouteMsg').textContent = '';
    document.getElementById('staticRouteDry').checked = document.getElementById('rciDryRun').checked;
    document.getElementById('staticRouteModal').style.display = 'block';
});
document.getElementById('staticRouteDry').addEventListener('change', (e) => { document.getElementById('rciDryRun').checked = e.target.checked; });
document.getElementById('staticRouteClose').addEventListener('click', () => { document.getElementById('staticRouteModal').style.display = 'none'; });
document.getElementById('staticRouteSave').addEventListener('click', async () => {
    const routes = document.getElementById('staticRouteNames').value.split(/[\s,;]+/).filter(Boolean);
    const msg = document.getElementById('staticRouteMsg');
    const iface = document.getElementById('staticRouteInterface').value;
    const gateway = document.getElementById('staticRouteGateway').value.trim();
    if (!routes.length) { msg.textContent = t('Enter at least one address or network'); return; }
    if (!iface && !gateway) { msg.textContent = t('Set an interface or a gateway: a route needs an exit'); return; }
    msg.textContent = '';
    const wide = routes.filter(r => /\/[0-7]$/.test(r));
    if (wide.length && !confirm(t('{0} covers a large part of the Internet (0.0.0.0/0 is all of it). Add anyway?', wide.join(', ')))) return;
    const r = await rciCall({ action: 'addStaticRoutes', routes, wide: wide.length > 0, interface: iface, gateway, comment: document.getElementById('staticRouteComment').value, auto: document.getElementById('staticRouteAuto').checked }, 'Add routes');
    if (r.error) { msg.textContent = t(r.error); return; }
    if (r.dry_run) return;
    document.getElementById('staticRouteModal').style.display = 'none';
    showToast(t('Routes added: {0}', routes.length), 'success');
    loadStaticRoutes();
});
document.getElementById('staticList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-static-del]');
    if (!b) return;
    const dest = b.dataset.staticDel;
    if (!confirm(t('Delete the route {0}?', dest))) return;
    const r = await rciCall({ action: 'deleteStaticRoutes', routes: [dest] }, 'Delete the route');
    if (r.error || r.dry_run) return;
    showToast(t('Route deleted'), 'success');
    loadStaticRoutes();
});

function renderInterfaceControl(iface) {
    const box = document.getElementById('interfaceControl');
    box.hidden = !iface.state;
    if (!iface.state) return;
    const up = iface.state === 'up';
    document.getElementById('ifStateText').textContent = t(up ? 'The interface is turned on' : 'The interface is turned off');
    document.getElementById('ifToggleBtn').textContent = t(up ? 'Turn off' : 'Turn on');
    document.getElementById('ifDescInput').value = iface.description || '';
}

document.getElementById('ifToggleBtn').addEventListener('click', async () => {
    const iface = interfacesData.find(i => i.id === currentInterfaceId);
    if (!iface) return;
    const up = iface.state !== 'up';
    const critical = iface.defaultgw || iface.type === 'Bridge';
    if (!up && critical && !confirm(t('{0} carries the router or the internet. Turning it off can cut off access to the panel. Turn off?', iface.name))) return;
    const r = await rciCall({ action: 'setInterfaceState', id: iface.id, up, force: !up && critical }, up ? 'Turn on' : 'Turn off');
    if (r.error || r.dry_run) return;
    showToast(t(up ? 'Interface turned on' : 'Interface turned off'), 'success');
    await loadInterfaces();
    const fresh = interfacesData.find(i => i.id === currentInterfaceId);
    if (fresh) renderInterfaceControl(fresh);
});
document.getElementById('ifDescSave').addEventListener('click', async () => {
    const iface = interfacesData.find(i => i.id === currentInterfaceId);
    if (!iface) return;
    const r = await rciCall({ action: 'setInterfaceDescription', id: iface.id, description: document.getElementById('ifDescInput').value }, 'Save description');
    if (r.error || r.dry_run) return;
    showToast(t('Description saved'), 'success');
    await loadInterfaces();
    loadInterfaceChoices();
});

// ============================================ DPI CHECK ============================================
// One order everywhere: the check boxes, the order the tests run in, the result tabs and the Lists window
const DPI_ORDER = ['dns', 'domains', 'tcp', 'sni', 'tg'];
const DPI_TEST_NAMES = { dns: 'DNS', domains: 'Domains', tcp: 'Cut at 16-20 KB', sni: 'White SNI', tg: 'Telegram' };
const DPI_LED = { ok: 'led-green', partial: 'led-amber', block: 'led-red', stub: 'led-red', down: 'led-amber', pending: 'led-grey' };
let dpiRunning = false;
let dpiLastStep = '';
let dpiData = null;
let dpiRunId = '';
let dpiTab = 'dns';
let dpiDomainFilter = 'bad';
let dpiTcpFilter = 'cut';
let dpiSniFilter = 'all';
const dpiSniOpen = new Set();
let dpiSniTouched = false;
const dpiSniTopOpen = new Set();
let dpiPollTimer = null;
let dpiSetupFilled = false;
let dpiParams = { mode: 'both', isp: '', tun: '', tests: ['dns', 'domains', 'tcp'], source: 'builtin', custom: '' };
try { Object.assign(dpiParams, JSON.parse(localStorage.getItem('dpiParams') || '{}')); } catch (e) { /* storage may be blocked */ }

function dpiSaveParams() {
    try { localStorage.setItem('dpiParams', JSON.stringify(dpiParams)); } catch (e) { /* storage may be blocked */ }
}

function dpiRenderSetup() {
    document.querySelectorAll('#dpiMode button').forEach(b => b.classList.toggle('active', b.dataset.v === dpiParams.mode));
    document.querySelectorAll('#dpiSource button').forEach(b => b.classList.toggle('active', b.dataset.v === dpiParams.source));
    // white SNI are looked for on the hostings the cut test found: with it the cut test is on and cannot be switched off
    if (dpiParams.tests.includes('sni') && !dpiParams.tests.includes('tcp')) dpiParams.tests.push('tcp');
    const sniOn = dpiParams.tests.includes('sni');
    document.querySelectorAll('#dpiTests input').forEach(i => {
        i.checked = dpiParams.tests.includes(i.value);
        const label = i.closest('label');
        label.classList.toggle('off', !i.checked);
        if (i.value === 'tcp') {
            i.disabled = sniOn;
            label.classList.toggle('locked', sniOn);
            label.title = sniOn ? t('Needed for White SNI: they are looked for on the hostings this test finds') : '';
        }
    });
    document.getElementById('dpiIsp').hidden = dpiParams.mode === 'tun';
    document.getElementById('dpiTun').hidden = dpiParams.mode === 'isp';
    const custom = document.getElementById('dpiCustom');
    custom.hidden = dpiParams.source !== 'custom';
    if (document.activeElement !== custom) custom.value = dpiParams.custom;
    const count = { builtin: dpiData ? dpiData.base_count : 0, mine: dpiData ? dpiData.my_targets : 0, custom: dpiParams.custom.split(/[\s,]+/).filter(Boolean).length }[dpiParams.source];
    document.getElementById('dpiSourceCount').textContent = t('{0} domains', count);
}

async function loadDpi(id = dpiRunId) {
    const r = await (await apiFetch(API + '?action=getDpi' + (id ? '&id=' + encodeURIComponent(id) : ''))).json();
    if (r.error) return;
    dpiData = r;
    if (r.run) dpiRunId = r.run.id;
    // while the check runs the tab of the test in progress opens by itself, once per step
    if (r.state && r.state.state === 'running' && r.state.step !== dpiLastStep && r.run && r.run.id === r.state.id) {
        dpiLastStep = r.state.step;
        dpiTab = r.state.step;
    }
    if (!dpiSetupFilled) {
        dpiSetupFilled = true;
        fillInterfaceSelect('dpiIsp', dpiParams.isp);
        fillInterfaceSelect('dpiTun', dpiParams.tun);
    }
    dpiRenderSetup();
    dpiRenderState();
    dpiRenderResults();
}

function dpiRenderState() {
    const s = dpiData.state;
    const running = s && s.state === 'running';
    document.getElementById('dpiStartBtn').hidden = running;
    document.getElementById('dpiStopBtn').hidden = !running;
    document.getElementById('dpiBar').hidden = !running;
    let stage = '';
    if (running) {
        const step = s.tests.indexOf(s.step);
        const part = s.total ? s.done / s.total : 0;
        document.getElementById('dpiBarFill').style.width = Math.round((step + part) / s.tests.length * 100) + '%';
        stage = [t(DPI_TEST_NAMES[s.step]), s.stage ? t(s.stage) : '', s.total ? `${s.done} / ${s.total}` : ''].filter(Boolean).join(' · ');
    } else if (s && s.state === 'error') {
        stage = t(s.error);
    } else if (!dpiData.curl) {
        stage = t('curl is not installed: Service, System checks, "curl"');
    }
    document.getElementById('dpiStage').textContent = stage;
    const run = dpiData.run;
    document.getElementById('dpiMeta').textContent = run
        ? t('last run: {0}, {1}', new Date(run.started * 1000).toLocaleString(i18nLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), run.finished ? Math.round((run.finished - run.started) / 60 * 10) / 10 + ' ' + t('min') : t('running'))
        : '';
    clearTimeout(dpiPollTimer);
    if (running) dpiPollTimer = setTimeout(() => { if (state.currentTab === 'diag') loadDpi(''); }, 2500);
}

function dpiIfaceLabel(run, key) {
    const name = run.ifaces[key];
    return (key === 'tun' ? t('Tunnel') : t('Provider')) + ' · ' + (name || t('main route'));
}

function dpiCell(c, pending = false) {
    if (!c) return pending ? '<span class="dpi-r pend">…</span>' : '<span class="dpi-r na">—</span>';
    return `<span class="dpi-r ${c.class}" data-tip="${escapeHtml(tLines(c.note))}">${escapeHtml(t(c.code))}</span>`;
}

function dpiVerdict(level, text) {
    return `<span class="dpi-vd"><span class="led ${DPI_LED[level] || 'led-grey'}"></span>${escapeHtml(t(text))}</span>`;
}

function dpiNotYet(run, test) {
    let text = 'Not checked yet.';
    if (dpiRunning && run.tests.includes(test)) text = dpiData.state.step === test ? 'Checking…' : 'Waiting for its turn…';
    return `<p class="card-note">${escapeHtml(t(text))}</p>`;
}

function dpiRenderResults() {
    const box = document.getElementById('dpiResults');
    const run = dpiData.run;
    const st = dpiData.state;
    dpiRunning = !!(run && st && st.state === 'running' && st.id === run.id);
    if (!run) {
        box.innerHTML = `<p class="card-note">${escapeHtml(t('No checks yet.'))}</p>`;
        return;
    }
    const s = run.summary;
    // only the tiles of the tests this run has
    const has = k => run.tests.includes(k);
    const tiles = [];
    if (has('domains')) {
        tiles.push([s.blocked || 0, run.ifaces.isp === undefined ? 'blocked through the tunnel' : 'blocked by the provider', 'bad']);
        if (run.ifaces.tun) tiles.push([s.fixed || 0, 'of them open through the tunnel', 'good']);
        tiles.push([s.down || 0, 'unreachable everywhere', 'warn']);
    }
    if (has('dns')) tiles.push([s.dns || 0, 'DNS is spoofed', 'warn']);
    if (has('tcp')) tiles.push([s.cut || 0, 'hostings cut at 16-20 KB', 'bad']);
    const keys = Object.keys(run.ifaces);
    const counts = {
        domains: run.domains.filter(d => d.level !== 'ok' && d.level !== 'pending').length,
        dns: run.dns ? run.dns.rows.filter(d => d.level === 'block').length : null,
        tcp: run.tcp.length ? s.cut : null,
        sni: run.sni ? run.sni.length : null,
        tg: run.tg ? run.tg.dcs.filter(d => Object.values(d.res).some(c => c.class !== 'ok')).length + (Object.values(run.tg.file).some(c => c.class !== 'ok') ? 1 : 0) : null,
    };
    const tabs = DPI_ORDER.filter(k => run.tests.includes(k));
    if (!tabs.includes(dpiTab)) dpiTab = tabs[0];
    let html = !tiles.length ? '' : `<div class="dpi-summary">${tiles.map(([n, label, cls]) => `<div class="dpi-tile ${n ? cls : ''}"><b>${n}</b><span>${escapeHtml(t(label))}</span></div>`).join('')}</div>`;
    html += `<div class="dpi-tabs">${tabs.map(k => `<button type="button" data-tab="${k}" class="${k === dpiTab ? 'active' : ''}">${escapeHtml(t(DPI_TEST_NAMES[k]))} <span class="dpi-cnt ${counts[k] ? 'bad' : ''}">${counts[k] === null ? '…' : counts[k]}</span></button>`).join('')}</div>`;
    html += '<div class="dpi-pane">';
    if (dpiTab === 'domains') html += dpiRenderDomains(run, keys);
    if (dpiTab === 'dns') html += dpiRenderDns(run);
    if (dpiTab === 'tcp') html += dpiRenderTcp(run, keys);
    if (dpiTab === 'sni') html += dpiRenderSni(run);
    if (dpiTab === 'tg') html += dpiRenderTg(run, keys);
    html += '</div>';
    if (dpiData.runs.length) {
        html += `<div class="dpi-hist"><span class="muted">${escapeHtml(t('Previous runs'))}</span>`
            + dpiData.runs.map(r => {
                const current = st && st.state === 'running' && st.id === r.id;
                const label = new Date(r.started * 1000).toLocaleString(i18nLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · ' + t('{0} blocked', (r.summary && r.summary.blocked) || 0);
                return `<span class="dpi-run-chip ${r.id === run.id ? 'active' : ''}"><button type="button" class="dpi-run-open" data-run="${r.id}">${escapeHtml(label)}</button>`
                    + (current ? '' : `<button type="button" class="dpi-run-del" data-del="${r.id}" title="${escapeHtml(t('Delete this run'))}" aria-label="${escapeHtml(t('Delete this run'))}">×</button>`) + '</span>';
            }).join('')
            + `<button type="button" class="btn btn-small" id="dpiExport">${escapeHtml(t('Export JSON'))}</button>`
            + (dpiData.runs.length > 1 ? `<button type="button" class="btn btn-small btn-danger" id="dpiClearRuns">${escapeHtml(t('Delete all'))}</button>` : '')
            + '</div>';
    }
    box.innerHTML = html;
}

function dpiRenderDomains(run, keys) {
    if (!run.domains.length) return dpiNotYet(run, 'domains');
    const bad = run.domains.filter(d => d.level !== 'ok' && d.level !== 'pending');
    const noTarget = bad.filter(d => !run.targets[d.domain]);
    // while the check runs the rows still waiting stay in every filter, so the list does not jump
    const list = dpiDomainFilter === 'all' ? run.domains
        : run.domains.filter(d => d.level === 'pending' || (dpiDomainFilter === 'bad' ? bad : noTarget).includes(d));
    let html = `<div class="dpi-tools"><div class="seg" id="dpiDomainFilter">
        <button type="button" data-v="all" class="${dpiDomainFilter === 'all' ? 'active' : ''}">${escapeHtml(t('All'))} <span class="seg-n">${run.domains.length}</span></button>
        <button type="button" data-v="bad" class="${dpiDomainFilter === 'bad' ? 'active' : ''}">${escapeHtml(t('Blocked'))} <span class="seg-n">${bad.length}</span></button>
        <button type="button" data-v="free" class="${dpiDomainFilter === 'free' ? 'active' : ''}">${escapeHtml(t('Not routed'))} <span class="seg-n">${noTarget.length}</span></button>
    </div></div>`;
    html += '<div class="dpi-wrap"><table class="dpi-table"><thead><tr><th rowspan="2">' + escapeHtml(t('Domain')) + '</th>';
    keys.forEach(k => { html += `<th class="dpi-grp" colspan="4"><span>${escapeHtml(dpiIfaceLabel(run, k))}</span></th>`; });
    html += `<th rowspan="2">${escapeHtml(t('Verdict'))}</th><th rowspan="2">${escapeHtml(t('Routed by'))}</th></tr><tr>`;
    keys.forEach(() => { html += '<th class="c">HTTP</th><th class="c">TLS 1.2</th><th class="c">TLS 1.3</th><th class="c">QUIC</th>'; });
    html += '</tr></thead><tbody>';
    if (!list.length) html += `<tr><td colspan="${3 + keys.length * 4}" class="loading">${escapeHtml(t('Nothing here'))}</td></tr>`;
    list.forEach(d => {
        const sub = d.dns ? t('DNS: {0} at the provider', d.dns) : d.ip;
        html += `<tr><td><span class="dpi-dom" data-notr>${escapeHtml(d.domain)}</span><span class="dpi-sub">${escapeHtml(sub)}</span></td>`;
        keys.forEach(k => {
            const c = (d.cells || {})[k] || {};
            const wait = d.level === 'pending' || dpiRunning;
            html += `<td class="c">${dpiCell(c.http, wait)}</td><td class="c">${dpiCell(c.tls12, wait)}</td><td class="c">${dpiCell(c.tls13, wait)}</td><td class="c">${dpiCell(c.quic, wait)}</td>`;
        });
        const route = run.targets[d.domain];
        let target = '';
        if (route) target = `<span class="chip" data-notr>${escapeHtml(route.policy)}</span><span class="dpi-sub">${escapeHtml(t(route.via === 'list' ? 'list {0}' : 'target {0}', route.what))}</span>`;
        else if (d.level !== 'ok' && d.level !== 'pending') target = `<button type="button" class="btn btn-small" data-add="${escapeHtml(d.domain)}">+ ${escapeHtml(t('Target'))}</button>`;
        html += `<td>${dpiVerdict(d.level, d.verdict)}</td><td>${target}</td></tr>`;
    });
    html += '</tbody></table></div>';
    html += `<div class="dpi-legend">
        <span><span class="dpi-r ok">OK</span> ${escapeHtml(t('opened, the certificate is right'))}</span>
        <span><span class="dpi-r rst">RST</span> ${escapeHtml(t('the connection was reset'))}</span>
        <span><span class="dpi-r to">TIMEOUT</span> ${escapeHtml(t('no answer (dropped)'))}</span>
        <span><span class="dpi-r mitm">CERT / STUB</span> ${escapeHtml(t('foreign certificate or a provider page'))}</span>
        <span><span class="dpi-r na">N/A</span> ${escapeHtml(t('not a verdict: the site does not support it'))}</span>
        <span><span class="dpi-r na">CLOSED</span> ${escapeHtml(t('QUIC: the server itself closed the connection, UDP got through'))}</span>
    </div>`;
    return html;
}

function dpiRenderDns(run) {
    if (!run.dns) return dpiNotYet(run, 'dns');
    const cols = [['isp', run.dns.isp_server ? t('Provider DNS ({0})', run.dns.isp_server) : t('Provider DNS')], ['google', '8.8.8.8 UDP'], ['doh', 'Cloudflare DoH'], ['dot', 'Quad9 DoT']];
    let html = '<div class="dpi-wrap"><table class="dpi-table"><thead><tr><th>' + escapeHtml(t('Domain')) + '</th>'
        + cols.map(([k, label]) => {
            const dev = (run.dns.routes || {})[k];
            return `<th>${escapeHtml(label)}${dev ? `<span class="dpi-sub dpi-route">→ ${escapeHtml(dev)}</span>` : ''}</th>`;
        }).join('') + `<th>${escapeHtml(t('Verdict'))}</th></tr></thead><tbody>`;
    run.dns.rows.forEach(r => {
        html += `<tr><td><span class="dpi-dom" data-notr>${escapeHtml(r.domain)}</span>${r.control ? ` <span class="chip">${escapeHtml(t('control'))}</span>` : ''}</td>`
            + cols.map(([k]) => `<td>${dpiCell(r.cells[k])}</td>`).join('')
            + `<td>${dpiVerdict(r.level, r.verdict)}</td></tr>`;
    });
    html += '</tbody></table></div>';
    html += `<p class="card-note">${escapeHtml(t('The DNS queries go from the router itself, through the interface shown under each column (the router\'s routing table); the provider/tunnel choice above does not apply to them.'))}</p>`
        + `<p class="card-note">${escapeHtml(t('NXDOMAIN: the server says there is no such name. NODATA: the name exists but has no IPv4 address. If DoH knows the address, either of them from 8.8.8.8 or the provider DNS is a spoof.'))}</p>`
        + `<p class="card-note">${escapeHtml(t('If the provider spoofs the answers, turn on DoH or DoT in the DNS settings of the router (Settings tab).'))}</p>`;
    return html;
}

function dpiKbBar(res) {
    if (!res) return dpiRunning ? '<span class="dpi-r pend">…</span>' : '<span class="dpi-r na">—</span>';
    const width = Math.min(100, res.kb / 40 * 100);
    const cls = res.verdict === 'ok' ? 'ok' : 'cut';
    const note = tLines(res.note) + (res.timeout ? '\n' + t('Read timeout: {0} s', res.timeout) : '');
    return `<div class="dpi-kb" data-tip="${escapeHtml(note)}"><span class="dpi-track"><span class="dpi-zone"></span><span class="dpi-fill ${cls}" style="width:${width}%"></span></span><b>${res.verdict === 'down' ? '—' : res.kb + ' ' + t('KB')}</b></div>`;
}

function dpiRenderTcp(run, keys) {
    if (!run.tcp.length) return dpiNotYet(run, 'tcp');
    const first = keys[0];
    const cut = run.tcp.filter(r => r.res[first] && r.res[first].verdict === 'cut');
    const list = dpiTcpFilter === 'cut' ? run.tcp.filter(r => cut.includes(r) || (dpiRunning && !r.res[first])) : run.tcp;
    const verdicts = { ok: ['ok', 'No cut'], cut: ['block', 'Cut at ~{0} KB'], fail: ['partial', 'Broke off at {0} KB'], down: ['down', 'Unreachable'] };
    let html = `<div class="dpi-tools"><div class="seg" id="dpiTcpFilter">
        <button type="button" data-v="all" class="${dpiTcpFilter === 'all' ? 'active' : ''}">${escapeHtml(t('All'))} <span class="seg-n">${run.tcp.length}</span></button>
        <button type="button" data-v="cut" class="${dpiTcpFilter === 'cut' ? 'active' : ''}">${escapeHtml(t('With a cut'))} <span class="seg-n">${cut.length}</span></button>
    </div><span class="info-tip" tabindex="0" role="img" aria-label="Info" data-tip="${escapeHtml(t('Ten requests of about 4 KB go over one connection. If the transfer stops between 12 and 36 KB (the yellow zone), it is the typical DPI cut on foreign hostings.'))}">i</span>
    <span class="muted dpi-sni-used">${escapeHtml(run.tcp_sni === '' ? t('SNI: none, requests go to the bare IP') : t('SNI: {0}', run.tcp_sni || 'example.com'))}</span></div>`;
    html += '<div class="dpi-wrap"><table class="dpi-table"><thead><tr><th>' + escapeHtml(t('Hosting')) + '</th><th>IP</th>'
        + keys.map(k => `<th>${escapeHtml(dpiIfaceLabel(run, k))}</th>`).join('') + `<th>${escapeHtml(t('Verdict'))}</th></tr></thead><tbody>`;
    if (!list.length) html += `<tr><td colspan="${3 + keys.length}" class="loading">${escapeHtml(t('Nothing here'))}</td></tr>`;
    list.forEach(r => {
        const res = r.res[first];
        const [level, text] = res ? verdicts[res.verdict] : (dpiRunning ? ['pending', 'Checking…'] : ['', '—']);
        html += `<tr><td>${escapeHtml(r.provider)}<span class="dpi-sub">${r.asn ? 'AS' + escapeHtml(r.asn) + ' · ' : ''}${escapeHtml(r.id)}</span></td><td class="dpi-dom" data-notr>${escapeHtml(r.ip)}${r.port === 80 ? ':80' : ''}</td>`
            + keys.map(k => `<td>${dpiKbBar(r.res[k])}</td>`).join('')
            + `<td>${dpiVerdict(level, t(text, res ? Math.round(res.kb) : ''))}</td></tr>`;
    });
    html += '</tbody></table></div>';
    return html;
}

// Results of every name on a hosting; older runs kept only the passed names and the failed ones apart
function dpiSniResults(g) {
    if (g.results) return g.results;
    return g.ok.map(sni => ({ sni, verdict: 'ok', kb: 40.8, note: '' })).concat(g.failed || []);
}

// The names that get through on the most hostings: the short answer of the whole test.
// A click on a name lists the hostings where it passed and where it did not.
function dpiSniTop(run) {
    const stats = {};
    run.sni.forEach(g => dpiSniResults(g).forEach(r => {
        const one = stats[r.sni] ??= { sni: r.sni, tried: 0, passed: [], failed: [] };
        const name = g.provider + (g.asn ? ' · AS' + g.asn : '');
        one.tried++;
        if (r.verdict === 'ok') one.passed.push(name);
        else one.failed.push({ name, how: r.verdict === 'down' ? t('no connection') : Math.round(r.kb) + ' ' + t('KB') });
    }));
    const top = Object.values(stats).filter(x => x.passed.length)
        .sort((a, b) => b.passed.length - a.passed.length || b.passed.length / b.tried - a.passed.length / a.tried || a.sni.localeCompare(b.sni))
        .slice(0, 5);
    const hostings = run.sni.length;
    const allNames = run.sni.map(g => g.provider + (g.asn ? ' · AS' + g.asn : ''));
    let html = `<div class="dpi-sni-top"><h4>${escapeHtml(t('Top names that get through'))}${dpiRunning ? ` <span class="muted">${escapeHtml(t('(so far)'))}</span>` : ''}</h4>`;
    if (!top.length) return html + `<p class="card-note">${escapeHtml(t(dpiRunning ? 'No name has got through yet.' : 'No name got through on any hosting.'))}</p></div>`;
    html += '<table class="dpi-table dpi-top-table"><tbody>';
    top.forEach((x, i) => {
        const width = Math.round(x.passed.length / hostings * 100);
        const open = dpiSniTopOpen.has(x.sni);
        html += `<tr class="dpi-top-row${open ? ' open' : ''}" data-top="${escapeHtml(x.sni)}"><td class="dpi-top-n"><span class="dpi-caret">▸</span>${i + 1}</td><td class="dpi-dom" data-notr>${escapeHtml(x.sni)}</td>
            <td><div class="dpi-kb"><span class="dpi-track"><span class="dpi-fill ok" style="width:${width}%"></span></span>
            <b class="dpi-top-score">${escapeHtml(t('{0} of {1}', x.passed.length, hostings))}</b></div></td>
            <td class="muted dpi-top-tried">${escapeHtml(t('tried on {0}', x.tried))}</td></tr>`;
        if (!open) return;
        html += `<tr class="dpi-top-detail"><td></td><td colspan="3">
            <div class="dpi-top-line"><span class="dpi-top-label">${escapeHtml(t('Passes'))}</span>${x.passed.map(n => `<span class="dpi-hchip ok">${escapeHtml(n)}</span>`).join('')}</div>
            ${x.failed.length ? `<div class="dpi-top-line"><span class="dpi-top-label">${escapeHtml(t('Does not pass'))}</span>${x.failed.map(f => `<span class="dpi-hchip bad">${escapeHtml(f.name)} <b>${escapeHtml(f.how)}</b></span>`).join('')}</div>` : ''}
            ${(() => {
                const seen = new Set(x.passed.concat(x.failed.map(f => f.name)));
                const rest = allNames.filter(n => !seen.has(n));
                return rest.length ? `<div class="dpi-top-line"><span class="dpi-top-label">${escapeHtml(t(dpiRunning ? 'Not yet' : 'Not checked'))}</span>${rest.map(n => `<span class="dpi-hchip">${escapeHtml(n)}</span>`).join('')}</div>` : '';
            })()}
        </td></tr>`;
    });
    html += '</tbody></table>';
    html += `<button type="button" class="btn btn-small" id="dpiSniCopy" data-names="${escapeHtml(top.map(x => x.sni).join('\n'))}">${escapeHtml(t('Copy the names'))}</button></div>`;
    return html;
}

function dpiRenderSni(run) {
    if (!run.sni) return dpiNotYet(run, 'sni');
    if (!run.sni.length) return `<p class="card-note">${escapeHtml(t('No hosting cut the connection: nothing to look for.'))}</p>`;
    const first = Object.keys(run.ifaces)[0];
    const base = run.tcp_sni === '' ? t('without SNI') : (run.tcp_sni || 'example.com');
    const verdicts = { ok: ['ok', 'Passes'], cut: ['block', 'Cut at ~{0} KB'], fail: ['partial', 'Broke off at {0} KB'], down: ['down', 'No connection'] };
    const show = r => dpiSniFilter === 'all' || (dpiSniFilter === 'ok' ? r.verdict === 'ok' : r.verdict !== 'ok');
    let passAll = 0;
    let failAll = 0;
    run.sni.forEach(g => dpiSniResults(g).forEach(r => { if (r.verdict === 'ok') passAll++; else failAll++; }));

    let html = `<p class="card-note">${escapeHtml(t('Every name from the White SNI list is tried on one address of each hosting that cut the connection (up to 10 hostings), only through {0}: through the tunnel there is nothing to bypass.', dpiIfaceLabel(run, first)))}</p>`;
    html += dpiSniTop(run);
    html += `<div class="dpi-tools"><div class="seg" id="dpiSniFilter">
        <button type="button" data-v="all" class="${dpiSniFilter === 'all' ? 'active' : ''}">${escapeHtml(t('All'))} <span class="seg-n">${passAll + failAll}</span></button>
        <button type="button" data-v="ok" class="${dpiSniFilter === 'ok' ? 'active' : ''}">${escapeHtml(t('Pass'))} <span class="seg-n">${passAll}</span></button>
        <button type="button" data-v="bad" class="${dpiSniFilter === 'bad' ? 'active' : ''}">${escapeHtml(t('Do not pass'))} <span class="seg-n">${failAll}</span></button>
    </div><button type="button" class="btn btn-small" id="dpiSniToggleAll">${escapeHtml(t(dpiSniOpen.size ? 'Collapse all' : 'Expand all'))}</button></div>`;
    html += '<div class="dpi-wrap"><table class="dpi-table dpi-sni-table"><thead><tr><th>' + escapeHtml(t('SNI')) + '</th><th>' + escapeHtml(t('How far it went')) + '</th><th>' + escapeHtml(t('Verdict')) + '</th></tr></thead><tbody>';
    run.sni.forEach(g => {
        const id = g.asn || g.provider;
        const results = dpiSniResults(g);
        const passed = results.filter(r => r.verdict === 'ok').length;
        // while the check runs, the hosting being tested is open until the user opens or closes something himself
        const open = dpiSniOpen.has(id) || (dpiRunning && g.active && !dpiSniTouched);
        const total = g.names ? g.names.length : results.length;
        const score = results.length < total ? t('checked {0} of {1}, pass {2}', results.length, total, passed) : t('pass {0} of {1}', passed, results.length);
        const baseLine = g.base ? t('with {0}: cut at ~{1} KB', base, Math.round(g.base.kb)) : '';
        html += `<tr class="dpi-sni-group${open ? ' open' : ''}" data-group="${escapeHtml(id)}"><td colspan="3">
            <span class="dpi-caret">▸</span>
            <strong>${escapeHtml(g.provider)}</strong>${g.asn ? ` <span class="chip">AS${escapeHtml(g.asn)}</span>` : ''}
            <span class="dpi-sub dpi-inline">${escapeHtml(g.ip)}${baseLine ? ' · ' + escapeHtml(baseLine) : ''}</span>
            <span class="dpi-sni-score ${passed ? 'ok' : (results.length < total ? 'wait' : 'bad')}">${escapeHtml(score)}</span>
        </td></tr>`;
        if (!open) return;
        const done = new Set(results.map(r => r.sni));
        const waiting = dpiRunning && g.names ? g.names.filter(n => !done.has(n)).map(sni => ({ sni, verdict: 'pending' })) : [];
        const list = results.filter(show).concat(waiting);
        if (!list.length) html += `<tr class="dpi-sni-row"><td colspan="3" class="loading">${escapeHtml(t('Nothing here'))}</td></tr>`;
        list.forEach(r => {
            if (r.verdict === 'pending') {
                html += `<tr class="dpi-sni-row"><td class="dpi-dom" data-notr>${escapeHtml(r.sni)}</td><td><span class="dpi-r pend">…</span></td><td>${dpiVerdict('pending', t(g.active ? 'Checking…' : 'Waiting'))}</td></tr>`;
                return;
            }
            const [level, text] = verdicts[r.verdict];
            html += `<tr class="dpi-sni-row"><td class="dpi-dom" data-notr>${escapeHtml(r.sni)}</td><td>${dpiKbBar(r)}</td><td>${dpiVerdict(level, t(text, Math.round(r.kb)))}</td></tr>`;
        });
    });
    html += '</tbody></table></div>';
    return html;
}

function dpiRenderTg(run, keys) {
    if (!run.tg) return dpiNotYet(run, 'tg');
    let html = '<div class="dpi-wrap"><table class="dpi-table"><thead><tr><th></th>' + keys.map(k => `<th>${escapeHtml(dpiIfaceLabel(run, k))}</th>`).join('') + '</tr></thead><tbody>';
    run.tg.dcs.forEach(d => {
        html += `<tr><td>${escapeHtml(d.name)}<span class="dpi-sub">${escapeHtml(d.ip)}:443</span></td>` + keys.map(k => `<td>${dpiCell(d.res[k])}</td>`).join('') + '</tr>';
    });
    html += `<tr><td>${escapeHtml(t('Download 5 MB'))}<span class="dpi-sub">telegram.org</span></td>` + keys.map(k => `<td>${dpiCell(run.tg.file[k])}</td>`).join('') + '</tr>';
    return html + '</tbody></table></div>';
}

document.getElementById('dpiCard').addEventListener('click', async (e) => {
    const mode = e.target.closest('#dpiMode button');
    if (mode) { dpiParams.mode = mode.dataset.v; dpiSaveParams(); dpiRenderSetup(); return; }
    const source = e.target.closest('#dpiSource button');
    if (source) { dpiParams.source = source.dataset.v; dpiSaveParams(); dpiRenderSetup(); return; }
    const tab = e.target.closest('.dpi-tabs button');
    if (tab) { dpiTab = tab.dataset.tab; dpiRenderResults(); return; }
    const df = e.target.closest('#dpiDomainFilter button');
    if (df) { dpiDomainFilter = df.dataset.v; dpiRenderResults(); return; }
    const sf = e.target.closest('#dpiSniFilter button');
    if (sf) { dpiSniFilter = sf.dataset.v; dpiRenderResults(); return; }
    const group = e.target.closest('.dpi-sni-group');
    if (group) {
        const id = group.dataset.group;
        dpiSniTouched = true;
        if (group.classList.contains('open')) dpiSniOpen.add(id);
        if (dpiSniOpen.has(id)) dpiSniOpen.delete(id); else dpiSniOpen.add(id);
        dpiRenderResults();
        return;
    }
    const topRow = e.target.closest('.dpi-top-row');
    if (topRow) {
        const name = topRow.dataset.top;
        if (dpiSniTopOpen.has(name)) dpiSniTopOpen.delete(name); else dpiSniTopOpen.add(name);
        dpiRenderResults();
        return;
    }
    const copy = e.target.closest('#dpiSniCopy');
    if (copy) {
        navigator.clipboard.writeText(copy.dataset.names).then(() => showToast(t('Copied'), 'success'), () => showToast(copy.dataset.names, 'info', 10000));
        return;
    }
    if (e.target.closest('#dpiSniToggleAll')) {
        dpiSniTouched = true;
        if (dpiSniOpen.size) dpiSniOpen.clear();
        else dpiData.run.sni.forEach(g => dpiSniOpen.add(g.asn || g.provider));
        dpiRenderResults();
        return;
    }
    const tf = e.target.closest('#dpiTcpFilter button');
    if (tf) { dpiTcpFilter = tf.dataset.v; dpiRenderResults(); return; }
    const add = e.target.closest('[data-add]');
    if (add) { openDomainModal(null, { domain: add.dataset.add }); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
        const r = await api({ action: 'deleteDpiRuns', id: del.dataset.del });
        if (r.error) { showToast(t(r.error), 'error'); return; }
        if (del.dataset.del === dpiRunId) dpiRunId = '';
        loadDpi();
        return;
    }
    if (e.target.closest('#dpiClearRuns')) {
        if (!confirm(t('Delete all saved DPI check runs?'))) return;
        const r = await api({ action: 'deleteDpiRuns' });
        if (r.error) { showToast(t(r.error), 'error'); return; }
        showToast(t('Deleted: {0}', r.deleted), 'success');
        dpiRunId = '';
        loadDpi();
        return;
    }
    const run = e.target.closest('[data-run]');
    if (run) { loadDpi(run.dataset.run); return; }
    if (e.target.closest('#dpiExport')) {
        const blob = new Blob([JSON.stringify(dpiData.run, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'dpi-check-' + dpiData.run.id + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }
});

document.getElementById('dpiTests').addEventListener('change', () => {
    dpiParams.tests = [...document.querySelectorAll('#dpiTests input:checked')].map(i => i.value);
    dpiSaveParams();
    dpiRenderSetup();
});
document.getElementById('dpiIsp').addEventListener('change', (e) => { dpiParams.isp = e.target.value; dpiSaveParams(); });
document.getElementById('dpiTun').addEventListener('change', (e) => { dpiParams.tun = e.target.value; dpiSaveParams(); });
document.getElementById('dpiCustom').addEventListener('input', (e) => { dpiParams.custom = e.target.value; dpiSaveParams(); dpiRenderSetup(); });

document.getElementById('dpiStartBtn').addEventListener('click', async () => {
    if (dpiParams.mode !== 'isp' && !dpiParams.tun) {
        showToast(t('Choose the tunnel interface'), 'error');
        return;
    }
    const r = await api({ action: 'startDpi', ...dpiParams });
    if (r.error) { showToast(t(r.error), 'error', 8000); return; }
    dpiRunId = '';
    loadDpi('');
});
document.getElementById('dpiStopBtn').addEventListener('click', async () => {
    await api({ action: 'stopDpi' });
    loadDpi('');
});

// ---- lists of the DPI check
let dpiLists = null;
let dpiListsPane = 'dns';

function dpiListsCount() {
    const area = document.querySelectorAll(`.dpi-list-pane[data-p="${dpiListsPane}"] textarea`);
    let n = 0;
    area.forEach(a => { n += a.value.split('\n').filter(l => l.replace(/#.*$/, '').trim()).length; });
    const changed = DPI_LIST_PANES[dpiListsPane].some(k => document.querySelector(`[data-list="${k}"]`).value.trim() !== dpiLists.defaults[k]);
    document.getElementById('dpiListsMsg').textContent = t('{0} entries', n) + (changed ? ' · ' + t('changed') : '');
}

const DPI_LIST_PANES = { domains: ['domains'], dns: ['dns', 'dns_control'], tcp: ['tcp'], sni: ['sni'], tg: ['tg'] };

function dpiListsShow(pane) {
    dpiListsPane = pane;
    document.querySelectorAll('#dpiListsSeg button').forEach(b => b.classList.toggle('active', b.dataset.p === pane));
    document.querySelectorAll('.dpi-list-pane').forEach(p => { p.hidden = p.dataset.p !== pane; });
    dpiListsCount();
}

document.getElementById('dpiListsBtn').addEventListener('click', async () => {
    const r = await (await apiFetch(API + '?action=getDpiLists')).json();
    if (r.error) { showToast(t(r.error), 'error'); return; }
    dpiLists = r;
    document.querySelectorAll('.dpi-list-text').forEach(a => { a.value = r.lists[a.dataset.list]; });
    document.getElementById('dpiTcpSni').value = r.tcp_sni;
    dpiListsShow(dpiListsPane);
    document.getElementById('dpiListsModal').style.display = 'block';
});
document.getElementById('dpiListsSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) dpiListsShow(b.dataset.p);
});
document.querySelectorAll('.dpi-list-text').forEach(a => a.addEventListener('input', dpiListsCount));
document.getElementById('dpiListsReset').addEventListener('click', () => {
    DPI_LIST_PANES[dpiListsPane].forEach(k => { document.querySelector(`[data-list="${k}"]`).value = dpiLists.defaults[k]; });
    if (dpiListsPane === 'tcp') document.getElementById('dpiTcpSni').value = 'example.com';
    dpiListsCount();
});
function dpiListsClose() { document.getElementById('dpiListsModal').style.display = 'none'; }
document.getElementById('dpiListsClose').addEventListener('click', dpiListsClose);
document.getElementById('dpiListsCancel').addEventListener('click', dpiListsClose);
document.getElementById('dpiListsSave').addEventListener('click', async () => {
    const lists = {};
    document.querySelectorAll('.dpi-list-text').forEach(a => { lists[a.dataset.list] = a.value; });
    const r = await api({ action: 'saveDpiLists', lists, tcp_sni: document.getElementById('dpiTcpSni').value });
    if (r.error) { showToast(t(r.error), 'error', 9000); return; }
    showToast(t('Lists saved'), 'success');
    dpiListsClose();
    loadDpi();
});

// One click handler for the buttons rendered from data: the values travel in data-* attributes,
// never inside JavaScript written into the page, so a client or policy name cannot become code
const CLICK_ACTIONS = {
    togglePolicy: el => togglePolicyCollapse(+el.dataset.id),
    openTarget: el => openTargetDetail(+el.dataset.id),
    deleteDomain: el => deleteDomain(+el.dataset.id),
    policyRoutes: el => openPolicyRoutes(el.dataset.name),
    tableCount: el => loadTableRouteCount(el.dataset.ref),
    tableView: el => openTableView(el.dataset.ref),
    clientDetail: el => openClientDetail(el.dataset.mac, el.dataset.label, el.dataset.ip),
    quickAdd: el => quickAddTarget(el.dataset.ip, el.dataset.policy),
    ifaceDetail: el => openInterfaceDetail(el.dataset.id),
    installHooks: () => installHooks(),
    installCurl: () => installCurl(),
    installPhp: el => installPhpModule(el.dataset.action, el.dataset.name),
};
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-click]');
    if (el && CLICK_ACTIONS[el.dataset.click]) CLICK_ACTIONS[el.dataset.click](el);
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target.closest('[data-click="ifaceDetail"]');
    if (el) openInterfaceDetail(el.dataset.id);
});
