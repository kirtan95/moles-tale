// Full-game playthrough test: 4 simulated players, 2 rounds, scoring assertions.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3131;
const URL = `ws://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class PC {
  constructor(name) { this.name = name; this.state = null; this.hello = null; this.errors = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.t === 'hello') { this.hello = m; }
        else if (m.t === 'state') { this.state = m; }
        else if (m.t === 'error') { this.errors.push(m.msg); }
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { this.ws.close(); }
}

async function until(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(80);
  }
  throw new Error('TIMEOUT: ' + label);
}

function assert(cond, msg) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

const FILLERS = ['the','quick','brown','fox','jumped','over','lazy','dogs','and','then','a','wild','tale','began','softly','under','bright','stars'];

async function main() {
  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    cwd: path.join(__dirname, '..')
  });
  server.stderr.on('data', d => process.stderr.write(d));
  await until(() => false, 1, '').catch(() => {});
  await sleep(1200); // let it boot

  try {
    const names = ['Asha', 'Bablu', 'Chet', 'Dev'];
    const clients = names.map(n => new PC(n));
    for (const c of clients) await c.connect();

    // bad room code -> error
    const ghost = new PC('Ghost');
    await ghost.connect();
    ghost.send({ t: 'join', code: 'ZZZZ', name: 'Ghost' });
    await until(() => ghost.errors.length > 0, 5000, 'bad code error');
    assert(ghost.errors[0].includes('not found'), 'joining bad code errors');

    // create + join
    clients[0].send({ t: 'create', name: 'Asha' });
    const hello = await until(() => clients[0].hello, 5000, 'host hello');
    const code = hello.code;
    assert(/^[A-Z2-9]{4}$/.test(code), 'room code format: ' + code);

    // duplicate name -> error
    const dup = new PC('Asha');
    await dup.connect();
    dup.send({ t: 'join', code, name: 'Asha' });
    await until(() => dup.errors.length > 0, 5000, 'dup name error');
    assert(dup.errors[0].includes('taken'), 'duplicate name rejected');

    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', code, name: names[i] });
      await until(() => clients[i].hello, 5000, names[i] + ' joined');
    }
    await until(() => clients.every(c => c.state && c.state.players.length === 4), 5000, 'lobby full');
    assert(clients[0].state.players.find(p => p.id === clients[0].state.me).isHost, 'creator is host');

    // start with 2 rounds, 8 words per round
    clients[0].send({ t: 'start', rounds: 2, wordsPerRound: 8 });
    await until(() => clients.every(c => c.state.phase === 'story'), 5000, 'story phase');
    assert(clients[0].state.round === 1, 'round 1 started');
    for (const c of clients) assert(c.state.myWord, c.name + ' got a secret word');
    const words = clients.map(c => c.state.myWord);
    assert(new Set(words).size === 4, 'secret words unique: ' + words.join(','));

    // wrong-turn word -> error
    const notTurn = clients.find(c => c.state.me !== c.state.turn.currentId);
    notTurn.send({ t: 'word', word: 'sneaky' });
    await until(() => notTurn.errors.length > 0, 5000, 'wrong turn error');
    assert(notTurn.errors.some(e => e.includes('Not your turn')), 'wrong-turn word rejected');

    // invalid word (two words) on the actual turn player
    const turnCli = clients.find(c => c.hello.session === clients[0].state.turn.currentId);
    turnCli.send({ t: 'word', word: 'two words' });
    await until(() => turnCli.errors.length > 0, 5000, 'invalid word error');
    assert(turnCli.errors.some(e => e.includes('One word')), 'multi-word rejected');

    // ---- play round 1: everyone smuggles their secret word ----
    let fi = 0;
    const smuggled = new Set();
    console.log('Round 1 secret words:', clients.map(c => `${c.name}=${c.state.myWord}`).join(' '));
    while (clients[0].state.phase === 'story') {
      const s = clients[0].state;
      const cur = clients.find(c => c.hello.session === s.turn.currentId);
      await until(() => cur.state && cur.state.turn.isMine, 5000, 'turn sync');
      let w;
      if (!smuggled.has(cur.name) && s.story.count >= 2) { w = cur.state.myWord; smuggled.add(cur.name); }
      else { w = FILLERS[fi++ % FILLERS.length]; }
      const before = s.story.count;
      cur.send({ t: 'word', word: w });
      await until(() => {
        const ns = clients[0].state;
        return ns.phase !== 'story' || ns.story.count > before;
      }, 8000, 'word accepted: ' + w);
    }
    assert(clients[0].state.phase === 'reveal', 'story ended -> reveal');
    assert(smuggled.size === 4, 'everyone smuggled their word');

    // host advances to voting
    clients[0].send({ t: 'reveal_done' });
    await until(() => clients.every(c => c.state.phase === 'voting'), 5000, 'voting phase');

    // votes: EVERYONE deliberately misattributes Bablu's word (each to someone
    // other than themselves) -> sneak bonus for Bablu
    const bWord = clients[1].state.myWord;
    const owner = {};
    for (const c of clients) owner[c.state.myWord] = c.hello.session;
    const sid = Object.fromEntries(clients.map(c => [c.name, c.hello.session]));
    const wrongTarget = { Asha: sid['Chet'], Chet: sid['Dev'], Dev: sid['Asha'] };
    for (const c of clients) {
      await until(() => c.state.ballot, 5000, c.name + ' ballot');
      const matches = {};
      for (const w of c.state.ballot.words) {
        matches[w] = (w === bWord && wrongTarget[c.name]) ? wrongTarget[c.name] : owner[w];
      }
      c.send({ t: 'votes', matches });
    }
    await until(() => clients[0].state.phase === 'scores', 8000, 'scores phase');

    const rows = clients[0].state.results.rows;
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    console.log('Round 1 results:', rows.map(r => `${r.name}: in=${r.smuggled} sneak=${r.sneak} detect=${r.detect} round=${r.roundTotal} total=${r.total}`).join(' | '));
    assert(byName['Bablu'].smuggled && byName['Bablu'].sneak === 2, 'Bablu sneak bonus +2 (nobody caught him)');
    assert(byName['Bablu'].detect === 3 && byName['Bablu'].roundTotal === 6, 'Bablu round total 6');
    assert(byName['Asha'].roundTotal === 3 && byName['Chet'].roundTotal === 3 && byName['Dev'].roundTotal === 3, 'others round total 3');

    // ---- round 2: quick filler round, everyone votes correctly ----
    clients[0].send({ t: 'next' });
    await until(() => clients.every(c => c.state.phase === 'story' && c.state.round === 2), 5000, 'round 2');
    const sm2 = new Set();
    while (clients[0].state.phase === 'story') {
      const s = clients[0].state;
      const cur = clients.find(c => c.hello.session === s.turn.currentId);
      await until(() => cur.state && cur.state.turn.isMine, 5000, 'turn sync r2');
      let w;
      if (!sm2.has(cur.name) && s.story.count >= 2) { w = cur.state.myWord; sm2.add(cur.name); }
      else { w = FILLERS[fi++ % FILLERS.length]; }
      const before = s.story.count;
      cur.send({ t: 'word', word: w });
      await until(() => {
        const ns = clients[0].state;
        return ns.phase !== 'story' || ns.story.count > before;
      }, 8000, 'word accepted r2');
    }
    clients[0].send({ t: 'reveal_done' });
    await until(() => clients.every(c => c.state.phase === 'voting'), 5000, 'voting r2');
    const owner2 = {};
    for (const c of clients) owner2[c.state.myWord] = c.hello.session;
    for (const c of clients) {
      await until(() => c.state.ballot, 5000, c.name + ' ballot r2');
      const matches = {};
      for (const w of c.state.ballot.words) matches[w] = owner2[w];
      c.send({ t: 'votes', matches });
    }
    await until(() => clients[0].state.phase === 'scores', 8000, 'scores r2');
    const rows2 = clients[0].state.results.rows;
    for (const r of rows2) {
      // all correct votes: detect=3, smuggled, but everyone caught -> no sneak
      assert(r.smuggled && r.sneak === 0 && r.detect === 3 && r.roundTotal === 4,
        `${r.name} round 2 scoring (4 pts): got ${r.roundTotal}`);
    }

    clients[0].send({ t: 'next' });
    await until(() => clients[0].state.phase === 'gameover', 5000, 'gameover');
    const go = clients[0].state;
    assert(go.winner && go.winner.name === 'Bablu', 'Bablu wins overall, got: ' + (go.winner && go.winner.name));
    console.log('Winner:', go.winner.name, go.winner.score, '| standings:', go.standings.map(s => `${s.name}=${s.score}`).join(' '));

    // back to lobby
    clients[0].send({ t: 'lobby' });
    await until(() => clients[0].state.phase === 'lobby', 5000, 'back to lobby');
    assert(clients[0].state.players.every(p => p.score === 0), 'scores reset in lobby');

    for (const c of [...clients, ghost, dup]) c.close();
    console.log('\nALL TESTS PASSED');
  } finally {
    server.kill();
  }
}

main().catch(e => { console.error('\nTEST FAILED:', e.message); process.exit(1); });
