# Marquee: A watch-party web app

Pick a video from your device, upload it once as the host, share a room code, and watch together in sync. The video is streamed directly from your server, so your friends don't need to have the file themselves.

## How it works

* The **host** uploads a video file. It is stored on the server in `server/uploads/` and served with HTTP range support, so seeking and scrubbing work properly.
* Everyone in the room gets a `<video>` element that points to the video stored on the server. Guests don't need their own copy of the file.
* **Socket.io** keeps playback synchronized. When the host plays, pauses, or seeks, everyone else receives the same event. Guests also perform a background sync check every 5 seconds to correct any playback drift.
* If the host disconnects, the next person in the room is automatically promoted to host. They can then upload videos and control playback.

## Requirements

* Node.js 18 or newer

## Setup

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

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
  index.js        Express + Socket.io backend, upload endpoint, room/sync logic
  uploads/         Uploaded video files land here (gitignored)
public/
  index.html       App shell with landing and room screens
  style.css        Styling
  app.js           Client logic for rooms, uploads, playback sync, and chat
test/
  smoke.js         End-to-end smoke test
```

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
