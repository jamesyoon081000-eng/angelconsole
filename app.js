'use strict';

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const views = { auth: $('#auth'), unlock: $('#unlock'), app: $('#app'), manage: $('#manage'), list: $('#list'), files: $('#files') };
const logEl = $('#log');
const MAX_DOM_LINES = 1500;
let BACKEND = ''; // backend.json 에서 읽음 (서버가 켜질 때마다 자동으로 바뀌는 https 주소)
const TOKEN_KEY = 'mcConsoleToken';

let token = '';
let ws = null;
let reconnectTimer = null;
let upstreamConnected = false;
let serverStatus = 'unknown';
let history = [];
let histIdx = -1;
let me = {};

// ---------- 로그인 토큰 저장 (브라우저가 막아도 동작은 하게)
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch {}
function saveToken(t) {
    token = t || '';
    try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch {}
}

// ---------- 서버 API
function backendProblem() {
    if (location.protocol === 'https:' && BACKEND.startsWith('http:')) {
        return '콘솔 서버 주소가 https 가 아니라서 이 페이지에서 연결할 수 없어요. (backend.json 의 url 을 https 주소로 바꿔야 해요)';
    }
    return '';
}

async function api(path, body) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const opt = { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) };
    if (body !== undefined) {
        opt.method = 'POST';
        headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
    }
    const res = await fetch(BACKEND + path, opt);
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

// ---------- 화면 전환
function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    if (name !== 'app') closeWs();
}

function applyMe(data) {
    if (data.server) {
        document.title = `${data.server} 콘솔`;
        $$('.srvName').forEach(el => { el.textContent = data.server; });
    }
    $$('.userName').forEach(el => { el.textContent = data.user || ''; });
    me = data;
    $$('.ownerOnly').forEach(el => { el.hidden = !data.owner; });
}

function route(data) {
    applyMe(data);
    if (!data.ok) { saveToken(''); showAuth(); return; }
    if (!data.admin) { showUnlock(); return; }
    showApp();
}

function showAuth(msg) {
    show('auth');
    $('#authMsg').textContent = msg || backendProblem();
    $('#username').focus();
}

function showUnlock(msg) {
    show('unlock');
    $('#unlockMsg').textContent = msg || '';
    $('#adminPw').value = '';
    $('#adminPw').focus();
}

function showApp() {
    show('app');
    logEl.textContent = '';
    connect();
    $('#cmd').focus();
}

const NOT_READY = '콘솔 서버가 꺼져 있거나 아직 준비 중이에요. 잠시 후 새로고침해 주세요.';

async function loadBackend() {
    try {
        const res = await fetch(`backend.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        const j = await res.json();
        BACKEND = String(j.url || '').trim().replace(/\/+$/, '');
    } catch {
        BACKEND = '';
    }
}

async function boot() {
    showAuth('콘솔 서버 확인 중…');
    await loadBackend();
    const problem = backendProblem();
    if (problem) { showAuth(problem); return; }
    try {
        const { status, data } = await api('/api/me');
        if (status !== 200) { showAuth(NOT_READY); return; }
        route(data);
        if (!data.ok) $('#authMsg').textContent = '';
    } catch {
        showAuth(NOT_READY);
    }
}

// ---------- 로그인
$('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const problem = backendProblem();
    if (problem) { $('#authMsg').textContent = problem; return; }

    const btn = $('#authBtn');
    btn.disabled = true;
    $('#authMsg').textContent = '';
    try {
        const { status, data } = await api('/api/login', { username, password });
        if (status === 200 && data.token) {
            saveToken(data.token);
            $('#password').value = '';
            route(data);
        } else {
            $('#authMsg').textContent = data.error || `실패했어요 (${status})`;
        }
    } catch {
        $('#authMsg').textContent = '콘솔 서버에 연결할 수 없어요.';
    } finally {
        btn.disabled = false;
    }
});

// ---------- 관리자 잠금 해제
$('#unlockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#unlockForm button[type=submit]');
    btn.disabled = true;
    $('#unlockMsg').textContent = '';
    try {
        const { status, data } = await api('/api/unlock', { password: $('#adminPw').value });
        if (status === 200 && data.admin) route(data);
        else if (status === 401 && !data.error?.includes('관리자')) { saveToken(''); showAuth('로그인이 만료됐어요. 다시 로그인해 주세요.'); }
        else { $('#unlockMsg').textContent = data.error || `실패했어요 (${status})`; $('#adminPw').select(); }
    } catch {
        $('#unlockMsg').textContent = '콘솔 서버에 연결할 수 없어요.';
    } finally {
        btn.disabled = false;
    }
});

// ---------- 계정 만들기 (주인 계정 전용)
$$('.manageBtn').forEach(b => b.addEventListener('click', () => {
    show('manage');
    $('#createMsg').textContent = '';
    $('#createMsg').className = 'msg';
    $('#newUser').focus();
}));

$('#manageBack').addEventListener('click', () => route(me));

$('#createForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#createMsg');
    msg.className = 'msg';
    const username = $('#newUser').value.trim();
    const password = $('#newPw').value;
    if (password !== $('#newPw2').value) { msg.textContent = '비밀번호 확인이 달라요.'; return; }

    const btn = $('#createForm button[type=submit]');
    btn.disabled = true;
    msg.textContent = '';
    try {
        const { status, data } = await api('/api/accounts', { username, password });
        if (status === 200 && data.created) {
            msg.className = 'msg ok';
            msg.textContent = `✅ '${data.created}' 계정을 만들었어요.`;
            $('#newUser').value = '';
            $('#newPw').value = '';
            $('#newPw2').value = '';
            $('#newUser').focus();
        } else if (status === 401) {
            saveToken('');
            showAuth('로그인이 만료됐어요. 다시 로그인해 주세요.');
        } else {
            msg.textContent = data.error || `실패했어요 (${status})`;
        }
    } catch {
        msg.textContent = '콘솔 서버에 연결할 수 없어요.';
    } finally {
        btn.disabled = false;
    }
});

// ---------- 계정 목록 + 비밀번호 재설정 (주인 계정 전용)
let resetTarget = '';

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d) ? '-' : d.toLocaleDateString('ko-KR');
}

function closeReset() {
    resetTarget = '';
    $('#resetForm').hidden = true;
    $('#resetPw').value = '';
    $('#resetPw2').value = '';
}

function openReset(name) {
    resetTarget = name;
    $('#resetName').textContent = name;
    $('#resetForm').hidden = false;
    $('#listMsg').className = 'msg';
    $('#listMsg').textContent = '';
    $('#resetPw').focus();
}

async function loadAccounts() {
    const rows = $('#accRows');
    const msg = $('#listMsg');
    rows.textContent = '';
    msg.className = 'msg';
    msg.textContent = '불러오는 중…';
    try {
        const { status, data } = await api('/api/accounts');
        if (status === 401) { saveToken(''); showAuth('로그인이 만료됐어요. 다시 로그인해 주세요.'); return; }
        if (status !== 200) { msg.textContent = data.error || `불러오지 못했어요 (${status})`; return; }
        msg.textContent = data.accounts.length ? '' : '아직 계정이 없어요.';
        for (const a of data.accounts) {
            const tr = document.createElement('tr');
            const name = document.createElement('td');
            name.textContent = a.owner ? `${a.name} 👑` : a.name;
            const created = document.createElement('td');
            created.textContent = fmtDate(a.created);
            const act = document.createElement('td');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = '비밀번호 재설정';
            btn.addEventListener('click', () => openReset(a.name));
            act.appendChild(btn);
            tr.append(name, created, act);
            rows.appendChild(tr);
        }
    } catch {
        msg.textContent = '콘솔 서버에 연결할 수 없어요.';
    }
}

$$('.listBtn').forEach(b => b.addEventListener('click', () => {
    show('list');
    closeReset();
    loadAccounts();
}));

$('#listBack').addEventListener('click', () => { closeReset(); route(me); });
$('#resetCancel').addEventListener('click', closeReset);

$('#resetForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#listMsg');
    msg.className = 'msg';
    const password = $('#resetPw').value;
    if (password !== $('#resetPw2').value) { msg.textContent = '비밀번호 확인이 달라요.'; return; }
    if (!confirm(`'${resetTarget}' 계정의 비밀번호를 바꿀까요? 그 계정은 로그아웃돼요.`)) return;

    const btn = $('#resetForm button[type=submit]');
    btn.disabled = true;
    try {
        const { status, data } = await api('/api/accounts/reset', { username: resetTarget, password });
        if (status === 200 && data.reset) {
            closeReset();
            msg.className = 'msg ok';
            msg.textContent = `✅ '${data.reset}' 계정의 비밀번호를 바꿨어요. 새 비밀번호를 그 사람에게 알려주세요.`;
        } else if (status === 401) {
            saveToken('');
            showAuth('로그인이 만료됐어요. 다시 로그인해 주세요.');
        } else {
            msg.textContent = data.error || `실패했어요 (${status})`;
        }
    } catch {
        msg.textContent = '콘솔 서버에 연결할 수 없어요.';
    } finally {
        btn.disabled = false;
    }
});

// ---------- 마크 서버 파일 보기 / 올리기
let filePath = '/';

function fmtSize(n) {
    if (!n) return '-';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function joinPath(dir, name) { return (dir.endsWith('/') ? dir : dir + '/') + name; }

async function loadFiles(path = filePath) {
    const rows = $('#fileRows');
    const msg = $('#fileMsg');
    msg.className = 'msg';
    msg.textContent = '불러오는 중…';
    rows.textContent = '';
    try {
        const { status, data } = await api(`/api/files/list?path=${encodeURIComponent(path)}`);
        if (status === 401) { saveToken(''); showAuth('로그인이 만료됐어요. 다시 로그인해 주세요.'); return; }
        if (status === 403) { showUnlock('관리자 확인이 필요해요.'); return; }
        if (status !== 200) { msg.textContent = data.error || `불러오지 못했어요 (${status})`; return; }

        filePath = data.path || path;
        $('#filePath').textContent = filePath;
        msg.textContent = data.files.length ? '' : '빈 폴더예요.';
        for (const f of data.files) {
            const tr = document.createElement('tr');
            const name = document.createElement('td');
            if (f.isFile) {
                name.textContent = `📄 ${f.name}`;
            } else {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'link';
                b.textContent = `📁 ${f.name}`;
                b.addEventListener('click', () => loadFiles(joinPath(filePath, f.name)));
                name.appendChild(b);
            }
            const size = document.createElement('td');
            size.textContent = f.isFile ? fmtSize(f.size) : '';
            const act = document.createElement('td');
            if (f.isFile) {
                const d = document.createElement('button');
                d.type = 'button';
                d.textContent = '받기';
                d.addEventListener('click', () => downloadFile(joinPath(filePath, f.name), d));
                act.appendChild(d);
            }
            tr.append(name, size, act);
            rows.appendChild(tr);
        }
    } catch {
        msg.textContent = '콘솔 서버에 연결할 수 없어요.';
    }
}

async function downloadFile(path, btn) {
    btn.disabled = true;
    try {
        const { status, data } = await api(`/api/files/url?path=${encodeURIComponent(path)}`);
        if (status === 200 && data.url) window.open(data.url, '_blank', 'noopener');
        else $('#fileMsg').textContent = data.error || `받지 못했어요 (${status})`;
    } catch {
        $('#fileMsg').textContent = '콘솔 서버에 연결할 수 없어요.';
    } finally {
        btn.disabled = false;
    }
}

$$('.filesBtn').forEach(b => b.addEventListener('click', () => { show('files'); loadFiles('/'); }));
$('#filesBack').addEventListener('click', () => route(me));
$('#fileRefresh').addEventListener('click', () => loadFiles());
$('#fileUp').addEventListener('click', () => {
    if (filePath === '/') return;
    loadFiles(filePath.replace(/\/[^/]+\/?$/, '') || '/');
});
$('#fileUploadBtn').addEventListener('click', () => $('#fileInput').click());

$('#fileInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const msg = $('#fileMsg');
    msg.className = 'msg';
    if (file.size > 10 * 1024 * 1024) { msg.textContent = '10MB 까지만 올릴 수 있어요.'; return; }
    const target = joinPath(filePath, file.name);
    if (!confirm(`${target} 로 올릴까요? 같은 이름이 있으면 덮어써요.`)) return;

    msg.textContent = '올리는 중…';
    try {
        const headers = { 'Content-Type': 'application/octet-stream' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${BACKEND}/api/files/upload?path=${encodeURIComponent(target)}`, {
            method: 'POST', headers, body: await file.arrayBuffer(),
        });
        let data = {};
        try { data = await res.json(); } catch {}
        if (res.status === 200) {
            msg.className = 'msg ok';
            msg.textContent = `✅ ${file.name} 올렸어요.`;
            loadFiles();
        } else {
            msg.textContent = data.error || `올리지 못했어요 (${res.status})`;
        }
    } catch {
        msg.textContent = '콘솔 서버에 연결할 수 없어요.';
    }
});

$$('.logoutBtn').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch {}
    saveToken('');
    showAuth('로그아웃했어요.');
}));

// ---------- 실시간 콘솔 연결
function wsUrl() {
    if (BACKEND) return BACKEND.replace(/^http/, 'ws') + '/ws';
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function connect() {
    clearTimeout(reconnectTimer);
    const sock = new WebSocket(wsUrl());
    ws = sock;
    upstreamConnected = false;
    renderState();
    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token }));
    sock.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        handle(m);
    };
    sock.onclose = async ev => {
        if (ws !== sock) return;
        ws = null;
        upstreamConnected = false;
        if (ev.code === 4003) { showUnlock('관리자 확인이 필요해요.'); return; }
        renderState('서버 연결 끊김 · 다시 연결 중…');
        try {
            const { data } = await api('/api/me');
            if (!data.ok || !data.admin) { route(data); return; }
        } catch {}
        if (!views.app.hidden) reconnectTimer = setTimeout(connect, 3000);
    };
}

function closeWs() {
    clearTimeout(reconnectTimer);
    if (ws) { const sock = ws; ws = null; sock.close(); }
}

function handle(m) {
    switch (m.type) {
        case 'init':
            logEl.textContent = '';
            (m.lines || []).forEach(l => addLine(l));
            serverStatus = m.status || 'unknown';
            upstreamConnected = !!m.connected;
            setStats(m.stats);
            renderState();
            break;
        case 'clear': logEl.textContent = ''; break;
        case 'line': addLine(m.line); break;
        case 'status': serverStatus = m.status; renderState(); break;
        case 'stats': setStats(m.stats); break;
        case 'conn': upstreamConnected = !!m.connected; renderState(); break;
        case 'notice': addNotice(m.text, m.level); break;
    }
}

// ---------- 상태 표시
const STATUS = {
    running: ['켜짐', 'on'],
    starting: ['켜는 중…', 'wait'],
    stopping: ['끄는 중…', 'wait'],
    offline: ['꺼짐', 'off'],
};

function renderState(override) {
    const dot = $('#dot');
    const state = $('#state');
    if (override) { state.textContent = override; dot.className = 'dot off'; return; }
    if (!upstreamConnected) { state.textContent = '콘솔 연결 중…'; dot.className = 'dot wait'; return; }
    const [label, cls] = STATUS[serverStatus] || ['상태 확인 중…', 'wait'];
    state.textContent = label;
    dot.className = `dot ${cls}`;
}

function mb(bytes) { return `${Math.round((bytes || 0) / 1048576).toLocaleString()} MiB`; }

function uptimeText(ms) {
    const s = Math.floor((ms || 0) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}시간 ${m}분` : `${m}분`;
}

function setStats(s) {
    const el = $('#stats');
    if (!s || serverStatus === 'offline') { el.textContent = ''; return; }
    const parts = [`CPU ${Number(s.cpu_absolute || 0).toFixed(1)}%`];
    parts.push(s.memory_limit_bytes ? `RAM ${mb(s.memory_bytes)} / ${mb(s.memory_limit_bytes)}` : `RAM ${mb(s.memory_bytes)}`);
    if (s.uptime) parts.push(`켜진 지 ${uptimeText(s.uptime)}`);
    el.textContent = parts.join(' · ');
}

// ---------- 로그 출력 (ANSI 색 지원, 모든 글자는 textContent 로만 넣음)
const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function xterm256(n) {
    n = Number(n) || 0;
    if (n < 16) return BASIC[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16;
    const c = v => (v ? 55 + v * 40 : 0);
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}

const ANSI_RE = /\x1b\[([0-9;?]*)([A-Za-z])/g;

function isNearBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80; }

function appendRow(row) {
    const stick = isNearBottom();
    logEl.appendChild(row);
    while (logEl.childElementCount > MAX_DOM_LINES) logEl.firstElementChild.remove();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function addLine(raw) {
    const text = String(raw ?? '').replace(/\r/g, '').replace(/§[0-9a-fk-orx]/gi, '');
    const row = document.createElement('div');
    row.className = 'ln';
    let color = null;
    let bold = false;
    let last = 0;

    const push = s => {
        if (!s) return;
        const span = document.createElement('span');
        span.textContent = s;
        if (color) span.style.color = color;
        if (bold) span.className = 'b';
        row.appendChild(span);
    };

    for (const match of text.matchAll(ANSI_RE)) {
        push(text.slice(last, match.index));
        last = match.index + match[0].length;
        if (match[2] !== 'm') continue;
        const codes = (match[1] || '0').split(';').map(n => parseInt(n || '0', 10));
        for (let i = 0; i < codes.length; i++) {
            const c = codes[i];
            if (c === 0) { color = null; bold = false; }
            else if (c === 1) bold = true;
            else if (c === 22) bold = false;
            else if (c >= 30 && c <= 37) color = BASIC[c - 30];
            else if (c >= 90 && c <= 97) color = BASIC[c - 90 + 8];
            else if (c === 39) color = null;
            else if (c === 38 && codes[i + 1] === 2) { color = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`; i += 4; }
            else if (c === 38 && codes[i + 1] === 5) { color = xterm256(codes[i + 2]); i += 2; }
            else if (c === 48 && codes[i + 1] === 2) i += 4;
            else if (c === 48 && codes[i + 1] === 5) i += 2;
        }
    }
    push(text.slice(last));
    if (!row.childElementCount) row.appendChild(document.createTextNode('​'));
    appendRow(row);
}

function addNotice(text, level = 'info') {
    const row = document.createElement('div');
    row.className = `ln note ${level}`;
    row.textContent = String(text ?? '');
    appendRow(row);
}

// ---------- 명령어 입력
function sendWs(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) { addNotice('콘솔에 연결돼 있지 않아요. 잠시 후 다시 해주세요.', 'error'); return false; }
    ws.send(JSON.stringify(msg));
    return true;
}

$('#cmdForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#cmd');
    const cmd = input.value.trim().replace(/^\//, '');
    if (!cmd) return;
    if (!sendWs({ type: 'cmd', cmd })) return;
    addNotice(`> ${cmd}`, 'cmd');
    history = [cmd, ...history.filter(h => h !== cmd)].slice(0, 50);
    histIdx = -1;
    input.value = '';
    logEl.scrollTop = logEl.scrollHeight;
});

$('#cmd').addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && history.length) {
        histIdx = Math.min(histIdx + 1, history.length - 1);
        e.target.value = history[histIdx];
        e.preventDefault();
    } else if (e.key === 'ArrowDown') {
        histIdx = Math.max(histIdx - 1, -1);
        e.target.value = histIdx >= 0 ? history[histIdx] : '';
        e.preventDefault();
    }
});

// ---------- 전원 버튼
const POWER_LABEL = { start: '시작', restart: '재시작', stop: '정지' };
$$('[data-power]').forEach(btn => {
    btn.addEventListener('click', () => {
        const signal = btn.dataset.power;
        const label = POWER_LABEL[signal];
        if (signal !== 'start' && !confirm(`정말 서버를 ${label}할까요?`)) return;
        if (sendWs({ type: 'power', signal })) addNotice(`[${label} 요청을 보냈어요]`, 'info');
    });
});

boot();
