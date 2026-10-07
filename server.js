'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 1;
const POINTS_OK = 1;
const POINTS_FAIL = -3;
const HOLES = { easy: 36, medium: 46, hard: 54 };
const COLORS = ['#ef476f', '#118ab2', '#06a77d', '#e08a00', '#7b5cd6', '#d6336c', '#0b8f8f', '#5c6b8a'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlace(g, r, c, v) {
  for (let i = 0; i < 9; i++) {
    if (g[r * 9 + i] === v || g[i * 9 + c] === v) return false;
  }
  const br = r - (r % 3), bc = c - (c % 3);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (g[(br + i) * 9 + bc + j] === v) return false;
    }
  }
  return true;
}

function fill(g) {
  const i = g.indexOf(0);
  if (i === -1) return true;
  const r = Math.floor(i / 9), c = i % 9;
  for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
    if (canPlace(g, r, c, v)) {
      g[i] = v;
      if (fill(g)) return true;
      g[i] = 0;
    }
  }
  return false;
}

function generateSolution() {
  const g = new Array(81).fill(0);
  for (let b = 0; b < 3; b++) {
    const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (let i = 0; i < 9; i++) {
      g[(b * 3 + Math.floor(i / 3)) * 9 + b * 3 + (i % 3)] = nums[i];
    }
  }
  fill(g);
  return g;
}

function countSolutions(g, limit = 2) {
  let best = -1, bestCands = null;
  for (let i = 0; i < 81; i++) {
    if (g[i] !== 0) continue;
    const r = Math.floor(i / 9), c = i % 9;
    const cands = [];
    for (let v = 1; v <= 9; v++) if (canPlace(g, r, c, v)) cands.push(v);
    if (cands.length === 0) return 0;
    if (!bestCands || cands.length < bestCands.length) {
      best = i;
      bestCands = cands;
      if (cands.length === 1) break;
    }
  }
  if (best === -1) return 1;
  let count = 0;
  for (const v of bestCands) {
    g[best] = v;
    count += countSolutions(g, limit - count);
    g[best] = 0;
    if (count >= limit) break;
  }
  return count;
}

function makePuzzle(holes) {
  const solution = generateSolution();
  const puzzle = solution.slice();
  let removed = 0;
  for (const i of shuffle([...Array(81).keys()])) {
    if (removed >= holes) break;
    const backup = puzzle[i];
    puzzle[i] = 0;
    if (countSolutions(puzzle.slice(), 2) === 1) removed++;
    else puzzle[i] = backup;
  }
  return { puzzle, solution };
}

const rooms = new Map();
let nextPlayerId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players.values()) if (p.connected) send(p.ws, msg);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected,
  }));
}

function lobbyMessage(room) {
  return { type: 'lobby', code: room.code, hostId: room.hostId, state: room.state, players: publicPlayers(room) };
}

function addPlayer(room, ws, name) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const player = {
    id: nextPlayerId++,
    name: String(name || '').trim().slice(0, 16) || 'Joueur',
    color: COLORS.find((c) => !used.has(c)) || COLORS[0],
    score: 0,
    connected: true,
    ws,
  };
  room.players.set(player.id, player);
  ws.player = player;
  ws.room = room;
  return player;
}

function resetScores(room) {
  for (const p of room.players.values()) p.score = 0;
}

function handleCreate(ws, msg) {
  if (ws.room) return;
  const room = {
    code: makeCode(),
    players: new Map(),
    hostId: null,
    state: 'lobby',
    puzzle: null, solution: null, grid: null, remaining: 0,
  };
  const player = addPlayer(room, ws, msg.name);
  room.hostId = player.id;
  rooms.set(room.code, room);
  send(ws, { type: 'welcome', you: player.id });
  broadcast(room, lobbyMessage(room));
}

function handleJoin(ws, msg) {
  if (ws.room) return;
  const room = rooms.get(String(msg.code || '').trim().toUpperCase());
  if (!room) return send(ws, { type: 'error', message: 'Salon introuvable. Vérifie le code.' });
  if (room.state !== 'lobby') return send(ws, { type: 'error', message: 'La partie a déjà commencé.' });
  if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Le salon est plein.' });
  const player = addPlayer(room, ws, msg.name);
  send(ws, { type: 'welcome', you: player.id });
  broadcast(room, lobbyMessage(room));
}

function handleStart(ws, msg) {
  const room = ws.room;
  if (!room || room.hostId !== ws.player.id || room.state !== 'lobby') return;
  if (room.players.size < MIN_PLAYERS) {
    return send(ws, { type: 'error', message: `Il faut au moins ${MIN_PLAYERS} joueurs.` });
  }
  const holes = HOLES[msg.difficulty] || HOLES.medium;
  const { puzzle, solution } = makePuzzle(holes);
  room.puzzle = puzzle;
  room.solution = solution;
  room.grid = puzzle.slice();
  room.remaining = puzzle.filter((v) => v === 0).length;
  room.state = 'playing';
  resetScores(room);
  broadcast(room, { type: 'start', puzzle, remaining: room.remaining, players: publicPlayers(room) });
}

function handleMove(ws, msg) {
  const room = ws.room, player = ws.player;
  if (!room || room.state !== 'playing') return;
  const { row, col, value } = msg;
  if (![row, col, value].every(Number.isInteger)) return;
  if (row < 0 || row > 8 || col < 0 || col > 8 || value < 1 || value > 9) return;

  const i = row * 9 + col;
  if (room.grid[i] !== 0) return;

  if (room.solution[i] === value) {
    room.grid[i] = value;
    room.remaining--;
    player.score += POINTS_OK;
    broadcast(room, {
      type: 'cell', row, col, value, by: player.id,
      remaining: room.remaining, players: publicPlayers(room),
    });
    if (room.remaining === 0) {
      room.state = 'finished';
      broadcast(room, { type: 'end', players: publicPlayers(room) });
    }
  } else {
    player.score += POINTS_FAIL;
    broadcast(room, { type: 'wrong', row, col, value, by: player.id, players: publicPlayers(room) });
  }
}

function handleRematch(ws) {
  const room = ws.room;
  if (!room || room.hostId !== ws.player.id || room.state !== 'finished') return;
  for (const [id, p] of room.players) if (!p.connected) room.players.delete(id);
  room.state = 'lobby';
  resetScores(room);
  broadcast(room, lobbyMessage(room));
}

function handleClose(ws) {
  const room = ws.room, player = ws.player;
  if (!room || !player) return;
  player.connected = false;
  if (room.state === 'lobby') room.players.delete(player.id);

  const connected = [...room.players.values()].filter((p) => p.connected);
  if (connected.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) room.hostId = connected[0].id;
  broadcast(room, room.state === 'lobby'
    ? lobbyMessage(room)
    : { type: 'players', hostId: room.hostId, players: publicPlayers(room) });
}

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'create': return handleCreate(ws, msg);
      case 'join': return handleJoin(ws, msg);
      case 'start': return handleStart(ws, msg);
      case 'move': return handleMove(ws, msg);
      case 'rematch': return handleRematch(ws);
    }
  });

  ws.on('close', () => handleClose(ws));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Sudoku Rush prêt : http://localhost:${PORT}`);
});
