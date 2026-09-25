# 🕵️ The Mole's Tale

A multiplayer word party game. 3–8 players build a story one word at a time —
while secretly smuggling an assigned word into the story. Then everyone votes
on who smuggled what. Points for sneaking yours in unseen, and for catching
the other moles.

Join with a 4-letter room code. No logins, no app installs. Works on any phone
or laptop.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000 — one player creates a room, the rest join with the code.

## Run the automated test

```bash
npm test
```

Simulates 4 players through a full 2-round game and asserts the scoring rules.

## Put it on a public URL (for the challenge submission)

The game is deployment-ready: single Node process, respects the `PORT`
environment variable, no database needed.

**Easiest free path — Render:**
1. Push this folder to a GitHub repo.
2. Go to render.com → New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`. (Free tier is fine.)
4. Render gives you a public `https://your-game.onrender.com` URL — that's your submission link.

Railway, Fly.io, or any Node host works the same way.

## How a round works

1. **Lobby** — host sets rounds (1–5) and words per round, then starts.
2. **Story** — players take turns adding one word each (45s per turn, auto-skip).
   Everyone holds a secret word to sneak in naturally.
3. **Reveal** — the full story is read aloud. Suspicions form. 👀
4. **Voting** — match each secret word to the player you think smuggled it.
5. **Scores** — +1 for getting your word in, +2 sneak bonus if nobody caught you,
   +1 per mole you correctly identify. Highest total after all rounds wins.
