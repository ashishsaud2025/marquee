const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { Server } = require('socket.io');
const { detectUrlType, downloadVideo, isYtdlpAvailable } = require('./url-handler');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LIBRARY_FILE = path.join(UPLOAD_DIR, 'library.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Video library: persists metadata (original filename, size, upload time) for
// every file that's ever been uploaded, so the host can re-select an old
// video after a server restart without losing its display name. Filenames on
// disk are nanoid-based, so this is the only place the human-readable name
// lives.
function libraryEntryFromFile(filename) {
  const stat = fs.statSync(path.join(UPLOAD_DIR, filename));
  return {
    filename,
    originalName: filename, // no upload metadata for this one, so just show the filename
    url: `/videos/${filename}`,
    size: stat.size,
    uploadedAt: stat.mtimeMs
  };
}

function loadLibrary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch (_) { /* missing or corrupt manifest, fall through to a rebuild */ }

  // First run, or a manifest that didn't survive: rebuild from whatever's
  // already sitting in the uploads folder so those files aren't orphaned.
  try {
    return fs.readdirSync(UPLOAD_DIR)
      .filter((f) => f !== 'library.json' && f !== '.gitkeep')
      .map(libraryEntryFromFile);
  } catch (_) {
    return [];
  }
}

let library = loadLibrary();

function saveLibrary() {
  fs.writeFile(LIBRARY_FILE, JSON.stringify(library, null, 2), (err) => {
    if (err) console.error('Failed to save video library:', err);
  });
}

// Reconciles the in-memory library against what's actually in the uploads
// folder: drops entries whose file is gone, and picks up any file that
// landed there some other way (e.g. copied in by hand rather than through
// the upload endpoint). Called before every /api/videos response so manual
// additions/removals show up without a server restart.
function reconcileLibrary() {
  let changed = false;

  const onDisk = new Set(
    fs.readdirSync(UPLOAD_DIR).filter((f) => f !== 'library.json' && f !== '.gitkeep')
  );

  const stillPresent = library.filter((v) => onDisk.has(v.filename));
  if (stillPresent.length !== library.length) changed = true;

  const known = new Set(stillPresent.map((v) => v.filename));
  const untracked = [...onDisk].filter((f) => !known.has(f));
  if (untracked.length) changed = true;

  library = [...stillPresent, ...untracked.map(libraryEntryFromFile)];
  if (changed) saveLibrary();
}

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
  const entry = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    url: `/videos/${req.file.filename}`,
    size: req.file.size,
    uploadedAt: Date.now()
  };
  library.push(entry);
  saveLibrary();
  res.json(entry);
});

// List every video available on the server, newest first. Self-heals if a
// file was deleted, or added, from outside the app (e.g. manually on disk).
app.get('/api/videos', (req, res) => {
  try {
    reconcileLibrary();
  } catch (err) {
    return res.status(500).json({ error: 'Could not read the uploads folder' });
  }
  res.json([...library].sort((a, b) => b.uploadedAt - a.uploadedAt));
});

// Remove a video from disk and from the library.
app.delete('/api/videos/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // guard against path traversal
  const idx = library.findIndex((v) => v.filename === filename);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  fs.unlink(path.join(UPLOAD_DIR, filename), (err) => {
    if (err && err.code !== 'ENOENT') return res.status(500).json({ error: 'Could not delete file' });
    library.splice(idx, 1);
    saveLibrary();
    res.json({ ok: true });
  });
});

app.use((err, req, res, next) => {
  // Handles multer errors (file too large, wrong type, etc.)
  res.status(400).json({ error: err.message || 'Upload failed' });
});

// URL video endpoint
app.post('/api/url', express.json(), async (req, res) => {
  const { url } = req.body;
  
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const urlType = detectUrlType(url);

  if (urlType.type === 'unsupported') {
    return res.status(400).json({ error: 'Unsupported URL format. Please use YouTube, Vimeo, or direct video URLs.' });
  }

  // For iframe types (YouTube/Vimeo), return metadata immediately
  if (urlType.type === 'iframe') {
    const entry = {
      type: 'iframe',
      platform: urlType.platform,
      videoId: urlType.videoId,
      originalName: `${urlType.platform} video`,
      url: url
    };
    return res.json(entry);
  }

  // For direct URLs, check if yt-dlp is available
  const hasYtdlp = await isYtdlpAvailable();
  if (!hasYtdlp) {
    return res.status(500).json({ 
      error: 'yt-dlp is not installed. Please install it to download videos from URLs.',
      hint: 'Install with: pip install yt-dlp'
    });
  }

  // Download the video
  try {
    const result = await downloadVideo(url, {
      onProgress: (progress) => {
        // Could emit progress via socket if needed
      }
    });

    const entry = {
      filename: result.filename,
      originalName: result.originalName,
      url: result.url,
      size: fs.statSync(path.join(UPLOAD_DIR, result.filename)).size,
      uploadedAt: Date.now()
    };

    library.push(entry);
    saveLibrary();

    res.json(entry);
  } catch (err) {
    console.error('URL download failed:', err);
    res.status(500).json({ error: `Failed to download video: ${err.message}` });
  }
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

  socket.on('set-video', ({ filename, originalName, url, type, platform, videoId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return; // only host can set video
    room.video = { filename, originalName, url, type, platform, videoId };
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
