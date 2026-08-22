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
  const uploadProgress = document.getElementById('upload-progress');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const player = document.getElementById('player');
  const stageEl = document.querySelector('.stage');

  const libraryBtn = document.getElementById('library-btn');
  const libraryModal = document.getElementById('library-modal');
  const libraryClose = document.getElementById('library-close');
  const libraryList = document.getElementById('library-list');
  const libraryDropzone = document.getElementById('library-dropzone');
  const libraryFileInput = document.getElementById('library-file-input');
  const libraryDropzoneSub = document.getElementById('library-dropzone-sub');
  const libraryUploadProgress = document.getElementById('library-upload-progress');
  const libraryUploadProgressBar = document.getElementById('library-upload-progress-bar');

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
  let currentVideo = null; // { filename, originalName, url } of whatever's loaded, so the library can mark it
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
    libraryBtn.hidden = !isHost;
    updateMemberCount(res.memberCount || 1);
    player.controls = isHost; // host gets full native controls; guests don't drive playback

    dropzone.hidden = !!res.video;
    if (!isHost) {
      dropzoneSub.textContent = 'Waiting for the host to choose a film...';
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
    libraryBtn.hidden = false;
    player.controls = true;
    guestControls.hidden = true;
    dropzoneSub.textContent = 'Drag a video file here, or click to choose one';
    appendSystemMessage("The host left, you're the host now.");
  });

  // Video source 
  socket.on('video-changed', (video) => {
    loadVideo(video, { playing: false, currentTime: 0 });
  });

  function loadVideo(video, playback) {
    currentVideo = video;
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
  // Clicking the big "no film loaded" zone opens the library so the host can
  // either upload something new or reuse a film that's already on the
  // server; dropping a file directly onto it still uploads immediately.
  dropzone.addEventListener('click', () => { if (isHost) openLibrary(); });

  ['dragover', 'dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (!isHost) return;
      dropzone.classList.toggle('dragover', evt === 'dragover');
      if (evt === 'drop' && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0], { subEl: dropzoneSub, progressEl: uploadProgress, barEl: uploadProgressBar });
      }
    });
  });

  // Shared upload routine, parameterized so both the main dropzone and the
  // library modal's dropzone can drive it with their own status elements.
  function uploadFile(file, { subEl, progressEl, barEl, onSuccess } = {}) {
    if (!isHost) return;
    if (subEl) subEl.textContent = `Uploading ${file.name}...`;
    if (progressEl) progressEl.hidden = false;

    const form = new FormData();
    form.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && barEl) {
        barEl.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      }
    };
    xhr.onload = () => {
      if (progressEl) progressEl.hidden = true;
      if (barEl) barEl.style.width = '0%';
      if (xhr.status !== 200) {
        if (subEl) subEl.textContent = 'Upload failed. Try a different file.';
        return;
      }
      const data = JSON.parse(xhr.responseText);
      socket.emit('set-video', data);
      if (onSuccess) onSuccess(data);
    };
    xhr.onerror = () => {
      if (progressEl) progressEl.hidden = true;
      if (subEl) subEl.textContent = 'Upload failed, check your connection.';
    };
    xhr.send(form);
  }

  // Film library (host only): browse everything already uploaded to the
  // server and switch to it, upload a new film, or delete an old one.
  function openLibrary() {
    if (!isHost) return;
    libraryModal.hidden = false;
    refreshLibrary();
  }
  function closeLibrary() { libraryModal.hidden = true; }

  libraryBtn.addEventListener('click', openLibrary);
  libraryClose.addEventListener('click', closeLibrary);
  libraryModal.addEventListener('click', (e) => { if (e.target === libraryModal) closeLibrary(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !libraryModal.hidden) closeLibrary();
  });

  libraryDropzone.addEventListener('click', () => { if (isHost) libraryFileInput.click(); });
  libraryFileInput.addEventListener('change', () => {
    if (libraryFileInput.files[0]) uploadToLibrary(libraryFileInput.files[0]);
    libraryFileInput.value = '';
  });
  ['dragover', 'dragleave', 'drop'].forEach((evt) => {
    libraryDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (!isHost) return;
      libraryDropzone.classList.toggle('dragover', evt === 'dragover');
      if (evt === 'drop' && e.dataTransfer.files[0]) uploadToLibrary(e.dataTransfer.files[0]);
    });
  });

  function uploadToLibrary(file) {
    uploadFile(file, {
      subEl: libraryDropzoneSub,
      progressEl: libraryUploadProgress,
      barEl: libraryUploadProgressBar,
      onSuccess: () => {
        libraryDropzoneSub.textContent = 'Drag a video file here, or click to browse';
        closeLibrary();
      }
    });
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  async function refreshLibrary() {
    libraryList.innerHTML = '<p class="library-empty">Loading...</p>';
    let videos;
    try {
      const res = await fetch('/api/videos');
      videos = await res.json();
    } catch (_) {
      libraryList.innerHTML = '<p class="library-empty">Could not load the library.</p>';
      return;
    }

    if (!videos.length) {
      libraryList.innerHTML = '<p class="library-empty">No films uploaded yet. Add one above.</p>';
      return;
    }

    libraryList.innerHTML = '';
    videos.forEach((v) => {
      const isActive = currentVideo && currentVideo.filename === v.filename;

      const row = document.createElement('div');
      row.className = 'library-item';
      row.innerHTML = `
        <div class="library-item-info">
          <p class="library-item-name"></p>
          <p class="library-item-meta"></p>
        </div>
        <button type="button" class="btn btn-small library-play-btn"></button>
        <button type="button" class="ctrl-btn library-delete-btn" title="Remove from server">&#128465;</button>
      `;

      const nameEl = row.querySelector('.library-item-name');
      nameEl.textContent = v.originalName || v.filename;
      nameEl.title = v.originalName || v.filename;
      row.querySelector('.library-item-meta').textContent = formatSize(v.size);

      const playBtn = row.querySelector('.library-play-btn');
      playBtn.textContent = isActive ? 'Playing' : 'Play';
      playBtn.disabled = isActive;
      playBtn.addEventListener('click', () => {
        socket.emit('set-video', { filename: v.filename, originalName: v.originalName, url: v.url });
        closeLibrary();
      });

      row.querySelector('.library-delete-btn').addEventListener('click', async () => {
        row.style.opacity = '0.5';
        try {
          await fetch(`/api/videos/${encodeURIComponent(v.filename)}`, { method: 'DELETE' });
          refreshLibrary();
        } catch (_) {
          row.style.opacity = '1';
        }
      });

      libraryList.appendChild(row);
    });
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
