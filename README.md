# Marquee: A watch-party web app

Pick a video from your device, upload it once as the host, share a room code, and watch together in sync. The video is streamed directly from your server, so your friends don't need to have the file themselves.

## How it works

* The **host** uploads a video file or pastes a URL. Files are stored on the server in `server/uploads/` and served with HTTP range support, so seeking and scrubbing work properly.
* For **YouTube/Vimeo URLs**, videos are embedded via iframe and synced using platform APIs.
* For **direct video URLs** (MP4, WebM, etc.), videos are downloaded to the server using yt-dlp and served like uploaded files.
* Everyone in the room gets a `<video>` element or iframe that points to the video. Guests don't need their own copy of the file.
* **Socket.io** keeps playback synchronized. When the host plays, pauses, or seeks, everyone else receives the same event. Guests also perform a background sync check every 5 seconds to correct any playback drift.
* If the host disconnects, the next person in the room is automatically promoted to host. They can then upload videos and control playback.

## Requirements

* Node.js 18 or newer
* **yt-dlp** (optional, for downloading videos from URLs)

## Setup

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

### Installing yt-dlp (optional)

To use the URL feature for downloading videos from direct URLs, you need [yt-dlp](https://github.com/yt-dlp/yt-dlp):

```bash
# macOS
brew install yt-dlp

# Windows
pip install yt-dlp

# Linux
sudo apt install yt-dlp
# or
pip install yt-dlp
```

**Note:** YouTube and Vimeo URLs work without yt-dlp (they use iframe embeds). yt-dlp is only needed for direct video URL downloads.

## Features

### Upload Videos
Drag and drop a video file or click to browse. Supports MP4, WebM, and other common video formats.

### Load from URL
Paste a video URL in the film library:
- **YouTube**: `https://youtube.com/watch?v=...` or `https://youtu.be/...`
- **Vimeo**: `https://vimeo.com/...`
- **Direct URLs**: `https://example.com/video.mp4` (requires yt-dlp)

### Watch Together
- Share the 5-character room code with friends
- Host controls playback (play/pause/seek)
- Guests can adjust volume and fullscreen locally
- Built-in chat for commenting

## Using it with friends over the internet

Running the app on `localhost` only makes it accessible from your own machine. If you want friends outside your local network to join, the server needs to be reachable from the internet.

There are two simple options:

### 1. Deploy the server

You can deploy the app to a small VPS or a platform such as Render, Railway, or Fly.io. Share the public URL with your friends instead of `localhost`.

Keep in mind that video files use both storage and bandwidth on the server. This setup works well for a small group of friends, but it is not designed for large-scale video streaming.

### 2. Use a tunnel

For a one-off movie night, you can temporarily expose your local server using a tool such as ngrok or Cloudflare Tunnel.

For example:

```bash
ngrok http 3000
```

You can then share the generated public URL with your friends.

## Project structure

```text
server/
  index.js          Express + Socket.io backend, upload endpoint, room/sync logic
  url-handler.js    URL detection, YouTube/Vimeo ID extraction, yt-dlp download
  uploads/          Uploaded video files land here (gitignored)
public/
  index.html        App shell with landing and room screens
  style.css         Styling
  app.js            Client logic for rooms, uploads, playback sync, and chat
test/
  smoke.js          End-to-end smoke test
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload a video file (multipart/form-data) |
| GET | `/api/videos` | List all videos in the library |
| DELETE | `/api/videos/:filename` | Delete a video from the library |
| POST | `/api/url` | Load video from URL (JSON body: `{url}`) |

## Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `create-room` | Client→Server | Create a new room |
| `join-room` | Client→Server | Join an existing room |
| `set-video` | Client→Server | Host sets current video |
| `play` | Client→Server | Host plays video |
| `pause` | Client→Server | Host pauses video |
| `seek` | Client→Server | Host seeks video |
| `video-changed` | Server→Client | Video source updated |
| `member-update` | Server→Client | Room membership changed |

## Things to improve before wider use

* **No room authentication:** Anyone who knows the 5-character room code can join. This is fine for watching with friends, but it would not be suitable for private or sensitive rooms.
* **Uploaded files are never deleted automatically:** If the server will run for a long time, add a cleanup job to remove old videos.
* **File size limit:** The current limit is 8GB in `server/index.js`. You can change it if needed.
* **Host permissions:** Only the host can upload videos or control playback. Guests can watch and chat.

## Running the smoke test

Start the server in one terminal:

```bash
npm start
```

Then, in another terminal, run:

```bash
node test/smoke.js
```

The smoke test creates a simulated host and guest, uploads a small fake video, and checks the main functionality of the application.

It tests room creation, file uploads, HTTP range requests, playback synchronization, host-only permissions, chat, and automatic host promotion when the host disconnects.
