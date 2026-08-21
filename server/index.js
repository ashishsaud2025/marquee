const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static files 
app.use(express.static(path.join(__dirname, '..', 'public')));
// express.static automatically supports HTTP Range requests, which is
// required for the <video> element to seek/scrub properly.
app.use('/videos', express.static(UPLOAD_DIR));

// Upload endpoint 
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${nanoid(12)}${ext}`);
  }
});

const ALLOWED_MIME = /^video\//;
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // 8GB ceiling, adjust as needed
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    url: `/videos/${req.file.filename}`
  });
});

app.use((err, req, res, next) => {
  // Handles multer errors (file too large, wrong type, etc.)
  res.status(400).json({ error: err.message || 'Upload failed' });
});

// Room / sync state 
// rooms: Map<roomCode, {
//   hostId: string,
//   video: { filename, originalName, url } | null,
//   playback: { playing: boolean, currentTime: number, updatedAt: number (ms) },
//   members: Map<socketId, { name: string }>
// }>
const rooms = new Map();

function computeCurrentTime(playback) {
  if (!playback) return 0;
  if (!playback.playing) return playback.currentTime;
  const elapsed = (Date.now() - playback.updatedAt) / 1000;
  return playback.currentTime + elapsed;
}

function roomSummary(room) {
  return {
    video: room.video,
    playback: {
      playing: room.playback.playing,
      currentTime: computeCurrentTime(room.playback),
      updatedAt: room.playback.updatedAt
    },
    memberCount: room.members.size
  };
}

function makeRoomCode() {
  // Short, human-typeable code
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.name = null;

  socket.on('create-room', ({ name } = {}, ack) => {
    const roomCode = makeRoomCode();
    const room = {
      hostId: socket.id,
      video: null,
      playback: { playing: false, currentTime: 0, updatedAt: Date.now() },
      members: new Map()
    };
    room.members.set(socket.id, { name: name || 'Host' });
    rooms.set(roomCode, room);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = name || 'Host';

    if (typeof ack === 'function') {
      ack({ ok: true, roomCode, isHost: true, ...roomSummary(room) });
    }
  });

  socket.on('join-room', ({ roomCode, name } = {}, ack) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room not found' });
      return;
    }

    room.members.set(socket.id, { name: name || 'Guest' });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name || 'Guest';

    if (typeof ack === 'function') {
      ack({ ok: true, roomCode: code, isHost: room.hostId === socket.id, ...roomSummary(room) });
    }

    socket.to(code).emit('member-update', {
      memberCount: room.members.size,
      joined: socket.data.name
    });
  });

  socket.on('set-video', ({ filename, originalName, url } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return; // only host can set video
    room.video = { filename, originalName, url };
    room.playback = { playing: false, currentTime: 0, updatedAt: Date.now() };
    io.to(socket.data.roomCode).emit('video-changed', room.video);
  });

  socket.on('play', ({ currentTime } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return; // only host drives playback
    room.playback = { playing: true, currentTime: currentTime || 0, updatedAt: Date.now() };
    socket.to(socket.data.roomCode).emit('play', { currentTime: room.playback.currentTime });
  });

  socket.on('pause', ({ currentTime } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.playback = { playing: false, currentTime: currentTime || 0, updatedAt: Date.now() };
    socket.to(socket.data.roomCode).emit('pause', { currentTime: room.playback.currentTime });
  });

  socket.on('seek', ({ currentTime } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.playback.currentTime = currentTime || 0;
    room.playback.updatedAt = Date.now();
    socket.to(socket.data.roomCode).emit('seek', { currentTime: room.playback.currentTime });
  });

  socket.on('sync-request', (_, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const payload = { currentTime: computeCurrentTime(room.playback), playing: room.playback.playing };
    if (typeof ack === 'function') ack(payload);
    else socket.emit('sync-response', payload);
  });

  socket.on('chat-message', ({ text } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !text) return;
    io.to(socket.data.roomCode).emit('chat-message', {
      name: socket.data.name,
      text: String(text).slice(0, 500),
      at: Date.now()
    });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    room.members.delete(socket.id);

    if (room.members.size === 0) {
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      // Promote the next member to host
      const nextHostId = room.members.keys().next().value;
      room.hostId = nextHostId;
      io.to(nextHostId).emit('promoted-to-host');
    }

    io.to(code).emit('member-update', {
      memberCount: room.members.size,
      left: socket.data.name
    });
  });
});

server.listen(PORT, () => {
  console.log(`Watch party server running on http://localhost:${PORT}`);
});
