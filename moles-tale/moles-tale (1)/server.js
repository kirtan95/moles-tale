// The Mole's Tale — multiplayer word party game server
// Node.js + ws. Single process, in-memory rooms. Deploy-ready (uses PORT env).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 45;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;

// ---------------------------------------------------------------- words ---

const SMUGGLE_WORDS = [
  'penguin','spaceship','pickle','trombone','volcano','pancake','wizard','rollercoaster',
  'cactus','submarine','disco','spaghetti','dragon','trampoline','mustache','igloo',
  'pirate','waffle','tornado','robot','unicorn','burrito','lighthouse','ninja','donut',
  'avalanche','kangaroo','helicopter','marshmallow','vampire','saxophone','jellyfish',
  'blizzard','taco','phoenix','zipline','goblin','cupcake','earthquake','mermaid',
  'banjo','crocodile','snowman','rocket','pretzel','werewolf','telescope','flamingo',
  'carousel','yeti','saxophone','dumpling','parachute','skeleton','tofu','ukulele',
  'vortex','walrus','xylophone','yodel','zebra','backpack','compass','dungeon',
  'espresso','fireworks','gondola','hammock','igloo','jukebox','kayak','lantern'
].filter((w, i, a) => a.indexOf(w) === i);

const PROMPTS = [
  'The detective pushed open the bakery door and froze, because',
  'On the morning the moon turned green, Maya decided to',
  'The last pizza on Earth was guarded by',
  'Captain Rao stared at the radar and whispered',
  'Nobody expected the wedding to be interrupted by',
  'The robot learned to cry when',
  'Deep beneath the library, the children discovered',
  'The dragon applied for a job as',
  'At midnight the statues in the park began to',
  'The time traveler packed only three things:',
  'Grandma\'s secret recipe called for one illegal ingredient:',
  'The haunted elevator always stopped at floor thirteen, where',
  'The alien ambassador\'s first words were',
  'The treasure map was tattooed on',
  'During the blackout, the neighbors decided to',
  'The cat knocked the vase off the shelf, revealing',
  'The inventor\'s greatest machine could only',
  'On the first day of school on Mars,',
  'The pirate radio station broadcast only',
  'The snowman came to life and immediately demanded',
  'The museum\'s newest exhibit was stolen by',
  'The soccer final went into overtime when'
];

// ---------------------------------------------------------------- helpers ---

function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}
function makeId() { return crypto.randomBytes(8).toString('hex'); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cleanName(n) {
  return String(n || '').trim().replace(/[<>]/g, '').slice(0, 14) || 'Player';
}
function validWord(w) {
  return typeof w === 'string' && /^[A-Za-z][A-Za-z'\-]{0,15}$/.test(w.trim());
}
function wordInStory(storyText, word) {
  return new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(storyText);
}

// ---------------------------------------------------------------- state ---

const rooms = new Map(); // code -> room

function newRoom() {
  let code;
  do { code = makeCode(); } while (rooms.has(code));
  const room = {
    code,
    players: new Map(),   // sessionId -> {id, name, socket, connected}
    order: [],
    phase: 'lobby',
    hostId: null,
    round: 0,
    totalRounds: 3,
    wordsPerRound: 24,
    prompt: '',
    usedPrompts: [],
    storyWords: [],       // {text, by}
    turnIdx: 0,
    turnEndsAt: 0,
    turnTimer: null,
    smuggle: new Map(),   // sessionId -> word
    votes: new Map(),     // voterId -> {word: playerId}
    scores: new Map(),    // sessionId -> total
    lastResults: null,
    winner: null,
    lastActivity: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function touch(room) { room.lastActivity = Date.now(); }

function connectedPlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.socket && p.socket.readyState === WebSocket.OPEN) {
      p.socket.send(JSON.stringify(viewFor(room, p.id)));
    }
  }
}

function viewFor(room, pid) {
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, connected: p.connected,
    isHost: p.id === room.hostId, score: room.scores.get(p.id) || 0
  }));
  const v = {
    t: 'state', code: room.code, phase: room.phase, me: pid,
    round: room.round, totalRounds: room.totalRounds,
    wordsPerRound: room.wordsPerRound, players
  };
  if (['story','reveal','voting','scores'].includes(room.phase)) {
    v.story = {
      prompt: room.prompt,
      words: room.storyWords.map(w => ({
        text: w.text,
        by: (room.players.get(w.by) || {}).name || '?'
      })),
      count: room.storyWords.length, target: room.wordsPerRound
    };
  }
  if (room.phase === 'story') {
    const cur = room.order[room.turnIdx];
    const cp = cur && room.players.get(cur);
    v.turn = {
      currentId: cur || null,
      currentName: cp ? cp.name : null,
      endsAt: room.turnEndsAt,
      isMine: cur === pid
    };
    v.myWord = room.smuggle.get(pid) || null;
  }
  if (room.phase === 'voting') {
    const myWord = room.smuggle.get(pid);
    const words = shuffle([...room.smuggle.entries()]
      .filter(([id]) => id !== pid).map(([, w]) => w));
    v.ballot = {
      words,
      players: players.filter(p => p.id !== pid).map(p => ({ id: p.id, name: p.name }))
    };
    v.voted = [...room.votes.keys()];
    v.myWord = myWord || null;
  }
  if (room.phase === 'scores' && room.lastResults) v.results = room.lastResults;
  if (room.phase === 'gameover') {
    v.winner = room.winner;
    v.standings = players.slice().sort((a, b) => b.score - a.score);
  }
  return v;
}

function sendError(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', msg }));
}

// ---------------------------------------------------------------- game flow ---

function startRound(room) {
  room.round += 1;
  room.phase = 'story';
  room.storyWords = [];
  const pool = PROMPTS.filter(p => !room.usedPrompts.includes(p));
  room.prompt = (pool.length ? pool : PROMPTS)[crypto.randomInt((pool.length ? pool : PROMPTS).length)];
  room.usedPrompts.push(room.prompt);
  const ids = shuffle([...room.players.keys()]);
  room.order = ids;
  const words = shuffle(SMUGGLE_WORDS);
  room.smuggle = new Map(ids.map((id, i) => [id, words[i % words.length]]));
  room.votes = new Map();
  room.turnIdx = -1;
  advanceTurn(room);
}

function advanceTurn(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.phase !== 'story') return;
  if (room.storyWords.length >= room.wordsPerRound) { endStory(room); return; }
  // find next connected player
  for (let n = 0; n < room.order.length; n++) {
    room.turnIdx = (room.turnIdx + 1) % room.order.length;
    const p = room.players.get(room.order[room.turnIdx]);
    if (p && p.connected) break;
  }
  const cur = room.players.get(room.order[room.turnIdx]);
  if (!cur || !cur.connected) { // nobody connected; park the game
    room.turnEndsAt = 0;
    broadcast(room);
    return;
  }
  room.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
  room.turnTimer = setTimeout(() => {
    // turn timed out: skip without adding a word
    advanceTurn(room);
  }, TURN_SECONDS * 1000);
  touch(room);
  broadcast(room);
}

function endStory(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.phase = 'reveal';
  touch(room);
  broadcast(room);
}

function tallyVotes(room) {
  const storyText = room.storyWords.map(w => w.text).join(' ');
  const ownerOf = new Map(); // word -> playerId
  for (const [id, w] of room.smuggle.entries()) ownerOf.set(w, id);

  const rows = [];
  for (const [pid, p] of room.players.entries()) {
    const word = room.smuggle.get(pid);
    const smuggled = wordInStory(storyText, word);
    let detect = 0;
    const votersMatches = room.votes.get(pid) || {};
    for (const [w, guessedId] of Object.entries(votersMatches)) {
      if (ownerOf.get(w) === guessedId) detect += 1;
    }
    // sneak bonus: nobody else correctly pinned my word on me
    let caught = false;
    for (const [vid, matches] of room.votes.entries()) {
      if (vid === pid) continue;
      if (matches[word] === pid) { caught = true; break; }
    }
    const sneak = (smuggled && !caught) ? 2 : 0;
    const roundTotal = (smuggled ? 1 : 0) + sneak + detect;
    const total = (room.scores.get(pid) || 0) + roundTotal;
    room.scores.set(pid, total);
    rows.push({
      id: pid, name: p.name, word, smuggled, sneak, detect,
      roundTotal, total
    });
  }
  rows.sort((a, b) => b.roundTotal - a.roundTotal);
  room.lastResults = { rows, storyText: room.prompt + ' ' + storyText };
  room.phase = 'scores';
  touch(room);
  broadcast(room);
}

function maybeTally(room) {
  const active = connectedPlayers(room).map(p => p.id);
  if (active.length > 0 && active.every(id => room.votes.has(id))) tallyVotes(room);
  else broadcast(room);
}

// ---------------------------------------------------------------- sockets ---

const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fp = path.join(__dirname, 'public', decodeURIComponent(file));
  if (!fp.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = fp.endsWith('.html') ? 'text/html' : fp.endsWith('.js') ? 'text/javascript'
      : fp.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let room = null, pid = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'create') {
      room = newRoom();
      pid = makeId();
      const name = cleanName(m.name);
      room.players.set(pid, { id: pid, name, socket: ws, connected: true });
      room.hostId = pid;
      room.scores.set(pid, 0);
      ws.send(JSON.stringify({ t: 'hello', session: pid, code: room.code }));
      touch(room); broadcast(room);
      return;
    }

    if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase().trim();
      room = rooms.get(code);
      if (!room) { sendError(ws, 'Room not found. Check the code!'); return; }
      if (m.session && room.players.has(m.session)) {
        // rejoin
        pid = m.session;
        const p = room.players.get(pid);
        p.socket = ws; p.connected = true;
        if (!room.hostId || !room.players.get(room.hostId).connected) room.hostId = pid;
        ws.send(JSON.stringify({ t: 'hello', session: pid, code: room.code, rejoin: true }));
        touch(room); broadcast(room);
        return;
      }
      if (room.phase !== 'lobby') { sendError(ws, 'That game already started.'); return; }
      if (room.players.size >= MAX_PLAYERS) { sendError(ws, 'Room is full.'); return; }
      const name = cleanName(m.name);
      if ([...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) {
        sendError(ws, 'That name is taken in this room.'); return;
      }
      pid = makeId();
      room.players.set(pid, { id: pid, name, socket: ws, connected: true });
      room.scores.set(pid, 0);
      ws.send(JSON.stringify({ t: 'hello', session: pid, code: room.code }));
      touch(room); broadcast(room);
      return;
    }

    if (!room || !pid || !room.players.has(pid)) { sendError(ws, 'Join a room first.'); return; }
    const me = room.players.get(pid);
    me.socket = ws; me.connected = true;
    const isHost = pid === room.hostId;

    if (m.t === 'start' && room.phase === 'lobby') {
      if (!isHost) { sendError(ws, 'Only the host can start.'); return; }
      const n = connectedPlayers(room).length;
      if (n < MIN_PLAYERS) { sendError(ws, `Need at least ${MIN_PLAYERS} players to start.`); return; }
      room.totalRounds = Math.min(5, Math.max(1, parseInt(m.rounds) || 3));
      room.wordsPerRound = Math.min(40, Math.max(9, parseInt(m.wordsPerRound) || 24));
      room.round = 0;
      startRound(room);
      return;
    }

    if (m.t === 'word' && room.phase === 'story') {
      const cur = room.order[room.turnIdx];
      if (cur !== pid) { sendError(ws, 'Not your turn!'); return; }
      const w = String(m.word || '').trim();
      if (!validWord(w)) { sendError(ws, 'One word only (letters, up to 16).'); return; }
      room.storyWords.push({ text: w, by: pid });
      touch(room);
      advanceTurn(room);
      return;
    }

    if (m.t === 'reveal_done' && room.phase === 'reveal') {
      if (!isHost) { sendError(ws, 'Only the host can continue.'); return; }
      room.phase = 'voting';
      touch(room); broadcast(room);
      return;
    }

    if (m.t === 'votes' && room.phase === 'voting') {
      const matches = m.matches || {};
      const myWord = room.smuggle.get(pid);
      const expected = [...room.smuggle.values()].filter(w => w !== myWord);
      const keys = Object.keys(matches);
      if (keys.length !== expected.length || !expected.every(w => keys.includes(w))) {
        sendError(ws, 'Match every word to a player.'); return;
      }
      const validIds = new Set([...room.players.keys()].filter(id => id !== pid));
      if (!Object.values(matches).every(id => validIds.has(id))) {
        sendError(ws, 'Invalid vote.'); return;
      }
      room.votes.set(pid, matches);
      touch(room);
      maybeTally(room);
      return;
    }

    if (m.t === 'tally' && room.phase === 'voting') {
      if (!isHost) { sendError(ws, 'Only the host can skip.'); return; }
      tallyVotes(room);
      return;
    }

    if (m.t === 'next' && room.phase === 'scores') {
      if (!isHost) { sendError(ws, 'Only the host can continue.'); return; }
      if (room.round < room.totalRounds) startRound(room);
      else {
        room.phase = 'gameover';
        const champ = [...room.scores.entries()].sort((a, b) => b[1] - a[1])[0];
        room.winner = champ ? { id: champ[0], name: (room.players.get(champ[0]) || {}).name, score: champ[1] } : null;
        touch(room); broadcast(room);
      }
      return;
    }

    if (m.t === 'lobby' && ['scores', 'gameover'].includes(room.phase)) {
      if (!isHost) { sendError(ws, 'Only the host can do that.'); return; }
      room.phase = 'lobby'; room.round = 0; room.lastResults = null; room.winner = null;
      room.storyWords = []; room.smuggle = new Map(); room.votes = new Map();
      for (const id of room.scores.keys()) room.scores.set(id, 0);
      touch(room); broadcast(room);
      return;
    }
  });

  ws.on('close', () => {
    if (!room || !pid || !room.players.has(pid)) return;
    const p = room.players.get(pid);
    p.connected = false;
    touch(room);
    if (room.phase === 'story' && room.order[room.turnIdx] === pid) {
      setTimeout(() => advanceTurn(room), 500);
    }
    if (room.hostId === pid) {
      const next = connectedPlayers(room)[0];
      if (next) room.hostId = next.id;
    }
    if (room.phase === 'voting') maybeTally(room);
    broadcast(room);
  });
});

// sweep dead rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (connectedPlayers(room).length === 0 && now - room.lastActivity > 30 * 60 * 1000) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`The Mole's Tale running on port ${PORT}`));
