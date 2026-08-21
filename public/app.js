(() => {
  const socket = io();

  // Elements 
  const landing = document.getElementById('landing');
  const roomScreen = document.getElementById('room');
  const landingError = document.getElementById('landing-error');

  const tabs = document.querySelectorAll('.tab');
  const panes = document.querySelectorAll('.entry-pane');
  const hostForm = document.getElementById('host-form');
  const joinForm = document.getElementById('join-form');

  const roomCodeDisplay = document.getElementById('room-code-display');
  const memberCountEl = document.getElementById('member-count');
  const connDot = document.getElementById('conn-dot');
  const hostBadge = document.getElementById('host-badge');
  const leaveBtn = document.getElementById('leave-btn');

  const dropzone = document.getElementById('dropzone');
  const dropzoneSub = document.getElementById('dropzone-sub');
  const fileInput = document.getElementById('file-input');
  const uploadProgress = document.getElementById('upload-progress');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const player = document.getElementById('player');
  const stageEl = document.querySelector('.stage');

  const guestControls = document.getElementById('guest-controls');
  const muteBtn = document.getElementById('mute-btn');
  const volumeSlider = document.getElementById('volume-slider');
  const fullscreenBtn = document.getElementById('fullscreen-btn');

  const chatLog = document.getElementById('chat-log');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  // State 
  let roomCode = null;
  let isHost = false;
  let myName = null;
  let suppressPlayerEvents = false; // true while we're applying a remote sync, so we don't echo it back
  const DRIFT_TOLERANCE = 0.6; // seconds

  // Screen switching 
  function showScreen(el) {
    [landing, roomScreen].forEach((s) => s.classList.remove('visible'));
    el.classList.add('visible');
  }
  showScreen(landing);

  // Landing: tabs 
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      panes.forEach((p) => p.classList.remove('active'));
      document.getElementById(`${tab.dataset.tab}-form`).classList.add('active');
      landingError.textContent = '';
    });
  });

  // Create room 
  hostForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myName = document.getElementById('host-name').value.trim() || 'Host';
    socket.emit('create-room', { name: myName }, (res) => {
      if (!res || !res.ok) {
        landingError.textContent = 'Could not create room. Try again.';
        return;
      }
      enterRoom(res);
    });
  });

  // Join room 
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myName = document.getElementById('join-name').value.trim() || 'Guest';
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    socket.emit('join-room', { roomCode: code, name: myName }, (res) => {
      if (!res || !res.ok) {
        landingError.textContent = (res && res.error) || 'Could not join room.';
        return;
      }
      enterRoom(res);
    });
  });

  // Enter room UI 
  function enterRoom(res) {
    roomCode = res.roomCode;
    isHost = !!res.isHost;

    roomCodeDisplay.textContent = roomCode;
    hostBadge.hidden = !isHost;
    updateMemberCount(res.memberCount || 1);
    player.controls = isHost; // host gets full native controls; guests don't drive playback

    dropzone.hidden = !!res.video;
    if (!isHost) {
      dropzoneSub.textContent = 'Waiting for the host to choose a film...';
      fileInput.disabled = true;
    }

    if (res.video) {
      loadVideo(res.video, res.playback);
    }

    showScreen(roomScreen);
    appendSystemMessage(`You're in as ${myName}${isHost ? ' (host)' : ''}.`);
  }

  function updateMemberCount(n) {
    memberCountEl.textContent = `${n} in the room`;
  }

  leaveBtn.addEventListener('click', () => window.location.reload());

  // Connection status 
  socket.on('connect', () => connDot.classList.add('connected'));
  socket.on('disconnect', () => connDot.classList.remove('connected'));

  socket.on('member-update', (data) => {
    updateMemberCount(data.memberCount);
    if (data.joined) appendSystemMessage(`${data.joined} joined.`);
    if (data.left) appendSystemMessage(`${data.left} left.`);
  });

  socket.on('promoted-to-host', () => {
    isHost = true;
    hostBadge.hidden = false;
    player.controls = true;
    guestControls.hidden = true;
    fileInput.disabled = false;
    dropzoneSub.textContent = 'Drag a video file here, or click to browse';
    appendSystemMessage("The host left, you're the host now.");
  });

  // Video source 
  socket.on('video-changed', (video) => {
    loadVideo(video, { playing: false, currentTime: 0 });
  });

  function loadVideo(video, playback) {
    dropzone.hidden = true;
    player.hidden = false;
    guestControls.hidden = isHost; // only guests get the local volume/fullscreen bar
    player.src = video.url;

    const applyInitialSync = () => {
      suppressPlayerEvents = true;
      player.currentTime = playback.currentTime || 0;
      if (playback.playing) {
        player.play().catch(() => {});
      }
      suppressPlayerEvents = false;
    };

    if (player.readyState >= 1) applyInitialSync();
    else player.addEventListener('loadedmetadata', applyInitialSync, { once: true });
  }

  // Upload (host only) 
  dropzone.addEventListener('click', () => { if (isHost) fileInput.click(); });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });

  ['dragover', 'dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (!isHost) return;
      dropzone.classList.toggle('dragover', evt === 'dragover');
      if (evt === 'drop' && e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
    });
  });

  function uploadFile(file) {
    if (!isHost) return;
    dropzoneSub.textContent = `Uploading ${file.name}...`;
    uploadProgress.hidden = false;

    const form = new FormData();
    form.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        uploadProgressBar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      }
    };
    xhr.onload = () => {
      uploadProgress.hidden = true;
      uploadProgressBar.style.width = '0%';
      if (xhr.status !== 200) {
        dropzoneSub.textContent = 'Upload failed. Try a different file.';
        return;
      }
      const data = JSON.parse(xhr.responseText);
      socket.emit('set-video', data);
    };
    xhr.onerror = () => {
      uploadProgress.hidden = true;
      dropzoneSub.textContent = 'Upload failed, check your connection.';
    };
    xhr.send(form);
  }

  // Host: broadcast playback actions 
  player.addEventListener('play', () => {
    if (suppressPlayerEvents || !isHost) return;
    socket.emit('play', { currentTime: player.currentTime });
  });
  player.addEventListener('pause', () => {
    if (suppressPlayerEvents || !isHost) return;
    socket.emit('pause', { currentTime: player.currentTime });
  });
  player.addEventListener('seeked', () => {
    if (suppressPlayerEvents || !isHost) return;
    socket.emit('seek', { currentTime: player.currentTime });
  });

  // Guest controls: volume + fullscreen (local only, doesn't affect sync) 
  volumeSlider.addEventListener('input', () => {
    player.volume = Number(volumeSlider.value);
    player.muted = false;
    muteBtn.innerHTML = player.volume === 0 ? '&#128263;' : '&#128266;';
  });
  muteBtn.addEventListener('click', () => {
    player.muted = !player.muted;
    muteBtn.innerHTML = player.muted ? '&#128263;' : '&#128266;';
  });
  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stageEl.requestFullscreen().catch(() => {});
  });

  // Guests: apply incoming playback events 
  socket.on('play', ({ currentTime }) => applyRemote(() => {
    if (Math.abs(player.currentTime - currentTime) > DRIFT_TOLERANCE) player.currentTime = currentTime;
    player.play().catch(() => {});
  }));
  socket.on('pause', ({ currentTime }) => applyRemote(() => {
    player.currentTime = currentTime;
    player.pause();
  }));
  socket.on('seek', ({ currentTime }) => applyRemote(() => {
    player.currentTime = currentTime;
  }));

  function applyRemote(fn) {
    suppressPlayerEvents = true;
    fn();
    // Release the guard on the next tick the video events fire synchronously-ish
    setTimeout(() => { suppressPlayerEvents = false; }, 50);
  }

  // Guests: periodic drift correction 
  setInterval(() => {
    if (isHost || !roomCode || player.hidden) return;
    socket.emit('sync-request', {}, (state) => {
      if (!state) return;
      const drift = Math.abs(player.currentTime - state.currentTime);
      if (drift > 1.5) {
        applyRemote(() => {
          player.currentTime = state.currentTime;
          if (state.playing) player.play().catch(() => {});
          else player.pause();
        });
      }
    });
  }, 5000);

  // Chat 
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', { text });
    chatInput.value = '';
  });

  socket.on('chat-message', ({ name, text }) => {
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.innerHTML = `<span class="who"></span><span class="body"></span>`;
    row.querySelector('.who').textContent = `${name}:`;
    row.querySelector('.body').textContent = text;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  function appendSystemMessage(text) {
    const row = document.createElement('div');
    row.className = 'chat-msg system';
    row.textContent = text;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
})();
