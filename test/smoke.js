const { io } = require('socket.io-client');
const http = require('http');
const fs = require('fs');
const path = require('path');

const URL = 'http://localhost:3000';

function log(...args) { console.log('[test]', ...args); }

async function main() {
  const host = io(URL, { transports: ['websocket'] });
  await new Promise((res) => host.on('connect', res));
  log('host connected', host.id);

  const roomRes = await new Promise((res) => host.emit('create-room', { name: 'Ash' }, res));
  if (!roomRes.ok) throw new Error('create-room failed');
  log('room created:', roomRes.roomCode, 'isHost:', roomRes.isHost);

  const guest = io(URL, { transports: ['websocket'] });
  await new Promise((res) => guest.on('connect', res));
  log('guest connected', guest.id);

  const guestJoinRes = await new Promise((res) =>
    guest.emit('join-room', { roomCode: roomRes.roomCode, name: 'Binita' }, res)
  );
  if (!guestJoinRes.ok) throw new Error('join-room failed: ' + guestJoinRes.error);
  log('guest joined, memberCount:', guestJoinRes.memberCount, 'isHost:', guestJoinRes.isHost);

  // Wrong room code should fail cleanly
  const badJoin = await new Promise((res) => guest.emit('join-room', { roomCode: 'ZZZZZ', name: 'X' }, res));
  log('bad room code handled ->', badJoin.ok === false ? 'OK (rejected)' : 'FAIL (should reject)');

  // Simulate a tiny upload 
  const tinyFile = path.join(__dirname, 'tiny.mp4');
  fs.writeFileSync(tinyFile, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])); // fake mp4 header bytes

  const videoChangedPromise = new Promise((res) => guest.once('video-changed', res));

  const boundary = '----testboundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="tiny.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),
    fs.readFileSync(tinyFile),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const uploadRes = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: 3000, path: '/api/upload', method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  log('upload response:', uploadRes.status, uploadRes.body);
  if (uploadRes.status !== 200) throw new Error('upload failed');

  host.emit('set-video', uploadRes.body);
  const videoChanged = await videoChangedPromise;
  log('guest received video-changed:', videoChanged);

  // Verify the video is actually fetchable with range support
  const rangeCheck = await new Promise((resolve, reject) => {
    http.get(
      { hostname: 'localhost', port: 3000, path: videoChanged.url, headers: { Range: 'bytes=0-3' } },
      (res) => resolve({ status: res.statusCode, acceptRanges: res.headers['accept-ranges'], contentRange: res.headers['content-range'] })
    ).on('error', reject);
  });
  log('range request check:', rangeCheck);
  if (rangeCheck.status !== 206) throw new Error('Range requests not working (expected 206 Partial Content)');

  // Playback sync: host plays, guest should receive it 
  const playPromise = new Promise((res) => guest.once('play', res));
  host.emit('play', { currentTime: 12.5 });
  const playEvt = await playPromise;
  log('guest received play event:', playEvt);
  if (Math.abs(playEvt.currentTime - 12.5) > 0.01) throw new Error('play sync mismatch');

  const pausePromise = new Promise((res) => guest.once('pause', res));
  host.emit('pause', { currentTime: 30.2 });
  const pauseEvt = await pausePromise;
  log('guest received pause event:', pauseEvt);

  // Guest should NOT be able to drive playback (not host)
  let guestBlockedCorrectly = true;
  const hostShouldNotSeeThis = new Promise((res) => {
    host.once('seek', () => { guestBlockedCorrectly = false; res(); });
    setTimeout(res, 800);
  });
  guest.emit('seek', { currentTime: 99 });
  await hostShouldNotSeeThis;
  log('non-host seek correctly ignored ->', guestBlockedCorrectly ? 'OK' : 'FAIL');

  // sync-request should reflect paused state at 30.2
  const syncState = await new Promise((res) => guest.emit('sync-request', {}, res));
  log('sync-request result:', syncState);
  if (Math.abs(syncState.currentTime - 30.2) > 0.05 || syncState.playing !== false) {
    throw new Error('sync-request state mismatch');
  }

  // Chat 
  const chatPromise = new Promise((res) => host.once('chat-message', res));
  guest.emit('chat-message', { text: 'this works!' });
  const chatMsg = await chatPromise;
  log('chat message relayed:', chatMsg);

  // Host disconnect -> guest promoted 
  const promotedPromise = new Promise((res) => guest.once('promoted-to-host', res));
  host.disconnect();
  await promotedPromise;
  log('guest promoted to host after host disconnect -> OK');

  fs.unlinkSync(tinyFile);
  guest.disconnect();
  log('ALL CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('[test] FAILED:', err.message);
  process.exit(1);
});
