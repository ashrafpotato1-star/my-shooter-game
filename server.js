'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 8000,
  perMessageDeflate: false // lower latency, less CPU
});

const MAX_PLAYERS = 8;
const DMG = 25;
const DMG_HEAD = 50;
const RESPAWN_MS = 3000;
const SHOT_GAP_MS = 80;
const BOUND = 30;
const SPAWNS = [[-24, -24], [24, -24], [-24, 24], [24, 24], [0, -26], [0, 26], [-26, 0], [26, 0]];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map(); // code -> { code, players: Map, dirty: Set }

const num = (v, lo, hi) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;
};
const vec3 = (a, lim) => {
  if (!Array.isArray(a) || a.length !== 3) return null;
  const out = a.map(v => num(v, -lim, lim));
  return out.some(v => v === null) ? null : out;
};
const cleanName = n => {
  n = String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);
  return n || 'Player' + (100 + Math.floor(Math.random() * 900));
};
const genCode = () => {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
};
const pub = p => ({
  id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, ry: p.ry, rx: p.rx,
  hp: p.hp, kills: p.kills, deaths: p.deaths, alive: p.alive
});

function pickSpawn(room) {
  let best = SPAWNS[0], bestScore = -1;
  for (const s of SPAWNS) {
    let md = 1e9;
    for (const o of room.players.values()) {
      if (!o.alive) continue;
      md = Math.min(md, Math.hypot(o.x - s[0], o.z - s[1]));
    }
    const score = md + Math.random() * 4;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function addPlayer(socket, room, name) {
  const s = pickSpawn(room);
  const p = {
    id: socket.id, name: cleanName(name), room: room.code,
    x: s[0], y: 0, z: s[1], ry: Math.atan2(s[0], s[1]), rx: 0,
    hp: 100, kills: 0, deaths: 0, alive: true, lastShot: 0, timer: null
  };
  room.players.set(p.id, p);
  socket.join(room.code);
  socket.data.room = room.code;
  socket.to(room.code).emit('playerJoined', pub(p));
  return p;
}

io.on('connection', socket => {
  const noop = () => {};

  socket.on('createRoom', (data, cb) => {
    cb = typeof cb === 'function' ? cb : noop;
    if (socket.data.room) return cb({ ok: false, error: 'أنت داخل غرفة بالفعل' });
    const room = { code: genCode(), players: new Map(), dirty: new Set() };
    rooms.set(room.code, room);
    const me = addPlayer(socket, room, data && data.name);
    cb({ ok: true, code: room.code, id: me.id, players: [...room.players.values()].map(pub) });
  });

  socket.on('joinRoom', (data, cb) => {
    cb = typeof cb === 'function' ? cb : noop;
    if (socket.data.room) return cb({ ok: false, error: 'أنت داخل غرفة بالفعل' });
    const code = String((data && data.code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'كود الغرفة غير صحيح' });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'الغرفة ممتلئة' });
    const me = addPlayer(socket, room, data && data.name);
    cb({ ok: true, code: room.code, id: me.id, players: [...room.players.values()].map(pub) });
  });

  socket.on('state', a => {
    const room = rooms.get(socket.data.room);
    const p = room && room.players.get(socket.id);
    if (!p || !p.alive || !Array.isArray(a) || a.length !== 5) return;
    const x = num(a[0], -BOUND, BOUND), y = num(a[1], -1, 30), z = num(a[2], -BOUND, BOUND);
    const ry = num(a[3], -100, 100), rx = num(a[4], -2, 2);
    if (x === null || y === null || z === null || ry === null || rx === null) return;
    p.x = x; p.y = y; p.z = z; p.ry = ry; p.rx = rx;
    room.dirty.add(p.id);
  });

  socket.on('shoot', d => {
    const room = rooms.get(socket.data.room);
    const p = room && room.players.get(socket.id);
    if (!p || !p.alive || !d) return;
    const now = Date.now();
    if (now - p.lastShot < SHOT_GAP_MS) return;
    p.lastShot = now;
    const o = vec3(d.o, 200), pt = vec3(d.p, 400);
    if (!o || !pt) return;
    socket.to(room.code).emit('shot', { id: p.id, o, p: pt });

    const t = d.hit && room.players.get(String(d.hit));
    if (!t || t.id === p.id || !t.alive) return;
    // light sanity checks (tolerant of latency)
    if (Math.hypot(pt[0] - t.x, pt[2] - t.z) > 4) return;
    if (Math.hypot(p.x - t.x, p.z - t.z) > 170) return;

    t.hp -= d.head ? DMG_HEAD : DMG;
    if (t.hp > 0) {
      io.to(room.code).emit('hp', { id: t.id, hp: t.hp });
      return;
    }
    t.hp = 0;
    t.alive = false;
    t.deaths++;
    p.kills++;
    io.to(room.code).emit('hp', { id: t.id, hp: 0 });
    io.to(room.code).emit('kill', {
      killer: p.id, victim: t.id, kills: p.kills, deaths: t.deaths
    });
    t.timer = setTimeout(() => {
      t.timer = null;
      if (!room.players.has(t.id)) return;
      const s = pickSpawn(room);
      t.x = s[0]; t.y = 0; t.z = s[1]; t.hp = 100; t.alive = true;
      io.to(room.code).emit('respawn', { id: t.id, x: t.x, y: 0, z: t.z, hp: 100 });
    }, RESPAWN_MS);
  });

  socket.on('pingc', cb => { if (typeof cb === 'function') cb(); });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = code && rooms.get(code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p && p.timer) clearTimeout(p.timer);
    room.players.delete(socket.id);
    room.dirty.delete(socket.id);
    io.to(code).emit('playerLeft', socket.id);
    if (room.players.size === 0) rooms.delete(code);
  });
});

// Batched position snapshots, 20 Hz: one packet per room instead of one per player.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.dirty.size === 0) continue;
    const snap = [];
    for (const id of room.dirty) {
      const p = room.players.get(id);
      if (p) snap.push([p.id, p.x, p.y, p.z, p.ry, p.rx]);
    }
    room.dirty.clear();
    if (snap.length) io.to(room.code).volatile.emit('snap', snap);
  }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('FPS server running on port ' + PORT));
