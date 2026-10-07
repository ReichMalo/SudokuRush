'use strict';

const $ = (sel) => document.querySelector(sel);

const screens = { home: $('#screen-home'), lobby: $('#screen-lobby'), game: $('#screen-game') };
function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

function makeEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function dot(color) {
    const d = makeEl('span', 'dot');
    d.style.background = color;
    return d;
}

function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

let toastTimer;
function showToast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

const S = {
    ws: null,
    me: null,
    code: null,
    hostId: null,
    players: [],
    phase: 'home',
    puzzle: new Array(81).fill(0),
    grid: new Array(81).fill(0),
    owners: new Array(81).fill(0),
    remaining: 0,
    sel: null,
    flashes: [],
};

const colorOf = (id) => (S.players.find((p) => p.id === id) || {}).color || '#888888';

function send(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function connect(firstMessage) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) return send(firstMessage);
    if (S.ws && S.ws.readyState === WebSocket.CONNECTING) return;

    setHomeError('');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    S.ws = ws;

    ws.addEventListener('open', () => ws.send(JSON.stringify(firstMessage)));
    ws.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
    ws.addEventListener('close', () => {
        if (S.ws !== ws) return;
        S.ws = null;
        if (S.phase === 'home') setHomeError('Connexion au serveur impossible. Vérifie qu\'il est bien lancé.');
        else showToast('Connexion perdue. Recharge la page pour revenir.');
    });
}


function onMessage(msg) {
    switch (msg.type) {
        case 'welcome':
            S.me = msg.you;
            break;

        case 'lobby':
            S.code = msg.code;
            S.hostId = msg.hostId;
            S.players = msg.players;
            S.phase = 'lobby';
            $('#end').hidden = true;
            showScreen('lobby');
            renderLobby();
            break;

        case 'start':
            S.puzzle = msg.puzzle;
            S.grid = msg.puzzle.slice();
            S.owners = new Array(81).fill(0);
            S.remaining = msg.remaining;
            S.players = msg.players;
            S.sel = null;
            S.flashes = [];
            S.phase = 'playing';
            $('#end').hidden = true;
            showScreen('game');
            renderScores();
            updateRemaining();
            updateNumpad();
            break;

        case 'cell': {
            const i = msg.row * 9 + msg.col;
            S.grid[i] = msg.value;
            S.owners[i] = msg.by;
            S.remaining = msg.remaining;
            S.players = msg.players;
            S.flashes.push({ type: 'ok', i, color: colorOf(msg.by), t: performance.now(), dur: 700 });
            renderScores(msg.by, 1);
            updateRemaining();
            updateNumpad();
            break;
        }

        case 'wrong': {
            const i = msg.row * 9 + msg.col;
            S.players = msg.players;
            S.flashes.push({ type: 'bad', i, value: msg.value, t: performance.now(), dur: 900 });
            renderScores(msg.by, -3);
            break;
        }

        case 'players':
            S.hostId = msg.hostId;
            S.players = msg.players;
            renderScores();
            if (S.phase === 'finished') showEnd();
            break;

        case 'end':
            S.players = msg.players;
            S.phase = 'finished';
            renderScores();
            showEnd();
            break;

        case 'error':
            if (S.phase === 'home') setHomeError(msg.message);
            else showToast(msg.message);
            break;
    }
}

function setHomeError(text) {
    const el = $('#home-error');
    el.textContent = text;
    el.hidden = !text;
}

function getName() {
    const name = $('#name').value.trim();
    try { localStorage.setItem('sudoku-rush-name', name); } catch {}
    return name;
}

$('#btn-create').addEventListener('click', () => connect({ type: 'create', name: getName() }));

$('#btn-join').addEventListener('click', () => {
    const code = $('#code').value.trim().toUpperCase();
    if (code.length !== 4) return setHomeError('Le code d\'un salon fait 4 lettres.');
    connect({ type: 'join', name: getName(), code });
});

$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('#code').value.trim() ? $('#btn-join') : $('#btn-create')).click();
});

try { $('#name').value = localStorage.getItem('sudoku-rush-name') || ''; } catch {}
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
    $('#code').value = urlRoom.slice(0, 4).toUpperCase();
    $('#name').focus();
}

function renderLobby() {
    $('#room-code').textContent = S.code;
    $('#player-count').textContent = `${S.players.length} / 8`;

    const ul = $('#lobby-players');
    ul.innerHTML = '';
    for (const p of S.players) {
        const li = makeEl('li');
        li.append(dot(p.color), makeEl('span', 'name', p.name));
        const tags = [];
        if (p.id === S.hostId) tags.push('hôte');
        if (p.id === S.me) tags.push('toi');
        if (tags.length) li.append(makeEl('span', 'tag', tags.join(', ')));
        ul.append(li);
    }

    const isHost = S.me === S.hostId;
    $('#host-controls').hidden = !isHost;
    $('#wait-host').hidden = isHost;
}

$('#btn-leave').addEventListener('click', () => {
    if (!confirm('Veux-tu vraiment quitter la partie ?')) return;

    const ws = S.ws;
    S.ws = null;
    S.phase = 'home';
    S.code = null;
    S.hostId = null;
    S.players = [];
    showScreen('home');

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
    }
});


$('#btn-copy').addEventListener('click', async () => {
    const code = document.querySelector('#room-code').textContent;
    try {
        await navigator.clipboard.writeText(code);
        showToast('Lien copié.');
    } catch {
        window.prompt('Copie ce lien et envoie-le aux autres joueurs :', url);
    }
});

$('#btn-start').addEventListener('click', () => {
    send({ type: 'start', difficulty: $('#difficulty').value });
});

function renderScores(changedId, delta) {
    const ul = $('#scores');
    ul.innerHTML = '';
    const sorted = [...S.players].sort((a, b) => b.score - a.score);
    for (const p of sorted) {
        const li = makeEl('li');
        if (!p.connected) li.classList.add('off');
        li.append(dot(p.color), makeEl('span', 'name', p.id === S.me ? `${p.name} (toi)` : p.name), makeEl('span', 'score', String(p.score)));
        if (p.id === changedId && delta) {
            li.classList.add(delta > 0 ? 'up' : 'down');
            li.append(makeEl('span', `delta ${delta > 0 ? 'plus' : 'minus'}`, delta > 0 ? `+${delta}` : `−${-delta}`));
        }
        ul.append(li);
    }
}

function updateRemaining() {
    $('#remaining').textContent = S.remaining;
}

const numpadButtons = [];
for (let v = 1; v <= 9; v++) {
    const b = makeEl('button', '', String(v));
    b.type = 'button';
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); tryPlace(v); });
    $('#numpad').append(b);
    numpadButtons.push(b);
}

function updateNumpad() {
    const counts = new Array(10).fill(0);
    for (const v of S.grid) counts[v]++;
    numpadButtons.forEach((b, idx) => { b.disabled = counts[idx + 1] >= 9; });
}

function tryPlace(value) {
    if (S.phase !== 'playing' || S.sel === null) return;
    if (S.grid[S.sel] !== 0) return;
    send({ type: 'move', row: Math.floor(S.sel / 9), col: S.sel % 9, value });
}

window.addEventListener('keydown', (e) => {
    if (S.phase !== 'playing') return;
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
        tryPlace(Number(e.key));
        return;
    }
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
        e.preventDefault();
        if (S.sel === null) { S.sel = 40; return; }
        const [dr, dc] = moves[e.key];
        const r = Math.min(8, Math.max(0, Math.floor(S.sel / 9) + dr));
        const c = Math.min(8, Math.max(0, (S.sel % 9) + dc));
        S.sel = r * 9 + c;
    }
});

function showEnd() {
    const sorted = [...S.players].sort((a, b) => b.score - a.score);
    const best = sorted[0].score;
    const winners = sorted.filter((p) => p.score === best);

    $('#end-title').textContent = winners.length > 1
        ? 'Égalité !'
        : `${winners[0].name} remporte la partie`;

    const ol = $('#end-ranking');
    ol.innerHTML = '';
    for (const p of sorted) {
        const li = makeEl('li', p.score === best ? 'winner' : '');
        li.append(dot(p.color), makeEl('span', 'name', p.name), makeEl('span', 'score', String(p.score)));
        ol.append(li);
    }

    const isHost = S.me === S.hostId;
    $('#btn-rematch').hidden = !isHost;
    $('#end-wait').hidden = isHost;
    $('#end').hidden = false;
}

$('#btn-rematch').addEventListener('click', () => send({ type: 'rematch' }));

const BOARD = 540;
const FONT = 'Bricolage Grotesque, system-ui, sans-serif';
const C = {
    board: '#ffffff',
    ink: '#16213e',
    line: '#cfd6e6',
    area: '#eef2fb',
    same: '#dbe5fb',
    sel: '#c3d4fa',
    bad: '#e5383b',
};
let cnv;

function setup() {
    cnv = createCanvas(BOARD, BOARD);
    cnv.parent('canvas-holder');
    cnv.elt.addEventListener('pointerdown', (e) => {
        if (S.phase !== 'playing' && S.phase !== 'finished') return;
        const rect = cnv.elt.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * BOARD;
        const y = ((e.clientY - rect.top) / rect.height) * BOARD;
        const c = Math.floor(x / (BOARD / 9));
        const r = Math.floor(y / (BOARD / 9));
        if (r >= 0 && r < 9 && c >= 0 && c < 9) S.sel = r * 9 + c;
    });
}

function draw() {
    background(C.board);
    if (S.phase !== 'playing' && S.phase !== 'finished') return;

    const cs = BOARD / 9;
    const now = performance.now();
    const selR = S.sel === null ? -1 : Math.floor(S.sel / 9);
    const selC = S.sel === null ? -1 : S.sel % 9;
    const selVal = S.sel === null ? 0 : S.grid[S.sel];

    noStroke();
    for (let i = 0; i < 81; i++) {
        const r = Math.floor(i / 9), c = i % 9;
        let bg = null;
        if (S.sel !== null) {
            const sameBox = Math.floor(r / 3) === Math.floor(selR / 3) && Math.floor(c / 3) === Math.floor(selC / 3);
            if (r === selR || c === selC || sameBox) bg = C.area;
            if (selVal && S.grid[i] === selVal) bg = C.same;
            if (i === S.sel) bg = C.sel;
        }
        if (bg) { fill(bg); rect(c * cs, r * cs, cs, cs); }
        if (S.owners[i]) { fill(rgba(colorOf(S.owners[i]), 0.14)); rect(c * cs, r * cs, cs, cs); }
    }

    S.flashes = S.flashes.filter((f) => now - f.t < f.dur);
    textAlign(CENTER, CENTER);
    textFont(FONT);
    textSize(cs * 0.56);
    for (const f of S.flashes) {
        const k = 1 - (now - f.t) / f.dur;
        const r = Math.floor(f.i / 9), c = f.i % 9;
        if (f.type === 'ok') {
            fill(rgba(f.color, 0.55 * k));
            rect(c * cs, r * cs, cs, cs);
        } else {
            fill(rgba(C.bad, 0.3 * k));
            rect(c * cs, r * cs, cs, cs);
            fill(rgba(C.bad, k));
            textStyle(BOLD);
            text(f.value, c * cs + cs / 2 + Math.sin((now - f.t) * 0.06) * 4 * k, r * cs + cs / 2 + cs * 0.04);
        }
    }

    for (let i = 0; i < 81; i++) {
        const v = S.grid[i];
        if (!v) continue;
        const r = Math.floor(i / 9), c = i % 9;
        if (S.puzzle[i] !== 0) {
            fill(C.ink);
            textStyle(BOLD);
        } else {
            fill(colorOf(S.owners[i]));
            textStyle(NORMAL);
        }
        text(v, c * cs + cs / 2, r * cs + cs / 2 + cs * 0.04);
    }

    noFill();
    for (let k = 1; k < 9; k++) {
        const thick = k % 3 === 0;
        stroke(thick ? C.ink : C.line);
        strokeWeight(thick ? 3 : 1);
        line(k * cs, 0, k * cs, BOARD);
        line(0, k * cs, BOARD, k * cs);
    }
    stroke(C.ink);
    strokeWeight(3);
    rect(1.5, 1.5, BOARD - 3, BOARD - 3);
}
