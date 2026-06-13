// TrackStars Main Application
let socket = null;
let token = null;
let currentUser = null;
let currentSong = null;
let currentAudioContext = null;
let currentBuffers = new Map();
let currentSources = [];
let currentGains = new Map();
let isPlaying = false;
let isRecording = false;
let currentPosition = 0;
let startTime = 0;
let timerInterval = null;
let mediaRecorder = null;
let audioChunks = [];
let mediaStream = null;
let bpm = 120;
let isRefreshing = false;
let currentThumbnail = null;
let metronomeInterval = null;
let metronomeContext = null;
let metronomeEnabled = true;
let countInEnabled = true;
let countInActive = false;
let countInInterval = null;
let countInResolve = null;
let currentChatUser = null;

// API wrapper
const api = {
  async request(endpoint, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const response = await fetch(endpoint, { ...options, headers });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`API Error (${endpoint}):`, error);
      throw error;
    }
  },
  async getSongs() { return this.request('/api/songs'); },
  async getSong(id) { return this.request(`/api/songs/${id}`); },
  async createSong(data) { return this.request('/api/songs', { method: 'POST', body: JSON.stringify(data) }); },
  async uploadTrack(songId, file) {
    const formData = new FormData();
    formData.append('audio', file);
    const response = await fetch(`/api/songs/${songId}/track`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData
    });
    if (!response.ok) throw new Error('Upload failed');
    return response.json();
  },
  async deleteTrack(songId, trackId) { return this.request(`/api/songs/${songId}/track/${trackId}`, { method: 'DELETE' }); },
  async voteTrack(songId, trackId, vote) { return this.request(`/api/songs/${songId}/track/${trackId}/vote`, { method: 'POST', body: JSON.stringify({ vote }) }); },
  async followUser(username) { return this.request(`/api/users/${username}/follow`, { method: 'POST' }); },
  async updateBio(bio) { return this.request('/api/users/bio', { method: 'PUT', body: JSON.stringify({ bio }) }); },
  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    const response = await fetch('/api/upload-avatar', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
    if (!response.ok) throw new Error('Upload failed');
    return response.json();
  },
  async getCommunityFeed() { return this.request('/api/feed/community'); },
  async getFollowingFeed() { return this.request('/api/feed/following'); },
  async getMessages(userId) { return this.request(`/api/messages/${userId}`); },
  async sendMessage(to, text) { return this.request('/api/messages', { method: 'POST', body: JSON.stringify({ to, text }) }); },
  async getAllUsers() { return this.request('/api/users'); },
  async getUser(username) { return this.request(`/api/users/${username}`); }
};

function generateRandomThumbnail(title) {
  const seed = encodeURIComponent(title.substring(0, 10));
  return `https://picsum.photos/seed/${seed}/200/200`;
}

// Auth functions
async function register(username, email, password, confirm) {
  if (password !== confirm) throw new Error('Passwords do not match');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const response = await fetch('/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(currentUser));
  return true;
}

async function login(username, password) {
  const response = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(currentUser));
  return true;
}

function logout() {
  if (isPlaying) stopPlayback();
  if (isRecording) stopAudioRecording();
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (countInInterval) clearInterval(countInInterval);
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
  if (currentAudioContext) currentAudioContext.close();
  token = null;
  currentUser = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.reload();
}

// Audio functions
function playMetronomeClick(isCountIn = false) {
  if (!metronomeEnabled && !isCountIn) return;
  if (!metronomeContext) metronomeContext = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = metronomeContext.createOscillator();
  const gain = metronomeContext.createGain();
  oscillator.connect(gain);
  gain.connect(metronomeContext.destination);
  if (isCountIn) {
    oscillator.frequency.value = 880;
    gain.gain.value = 0.4;
  } else {
    oscillator.frequency.value = 1000;
    gain.gain.value = 0.3;
  }
  oscillator.start();
  gain.gain.exponentialRampToValueAtTime(0.00001, metronomeContext.currentTime + 0.1);
  oscillator.stop(metronomeContext.currentTime + 0.1);
}

function startMetronome() {
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (!metronomeEnabled || countInActive) return;
  const beatInterval = (60 / bpm) * 1000;
  metronomeInterval = setInterval(() => {
    if (isRecording && !countInActive) playMetronomeClick(false);
  }, beatInterval);
}

function stopMetronome() {
  if (metronomeInterval) { clearInterval(metronomeInterval); metronomeInterval = null; }
}

async function startCountIn() {
  return new Promise((resolve) => {
    countInActive = true;
    let count = 3;
    const countinDisplay = document.getElementById('countin-display');
    const countinNumber = document.getElementById('countin-number');
    const countinProgressBar = document.getElementById('countin-progress-bar');
    const countinBeat = document.getElementById('countin-beat');
    
    countinDisplay.style.display = 'block';
    countinNumber.textContent = count;
    countinProgressBar.style.width = '0%';
    
    const playCountSound = (num) => {
      playMetronomeClick(true);
      if (countinBeat) {
        countinBeat.innerHTML = num === 1 ? '🎵 GO!' : '🎵';
        setTimeout(() => { if (countinBeat) countinBeat.innerHTML = ''; }, 200);
      }
    };
    
    countInInterval = setInterval(() => {
      if (count > 0) {
        playCountSound(count);
        countinNumber.textContent = count;
        countinProgressBar.style.width = `${((3 - count) / 3) * 100}%`;
        count--;
      } else {
        clearInterval(countInInterval);
        countinNumber.textContent = 'GO!';
        countinProgressBar.style.width = '100%';
        playMetronomeClick(true);
        
        setTimeout(() => {
          countinDisplay.style.display = 'none';
          countInActive = false;
          resolve();
        }, 500);
      }
    }, 1000);
  });
}

async function initAudioContext() {
  if (currentAudioContext) return currentAudioContext;
  currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  return currentAudioContext;
}

async function loadAllTracks() {
  if (!currentSong) return;
  currentBuffers.clear();
  for (const track of currentSong.tracks) {
    try {
      const response = await fetch(track.audioUrl);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await currentAudioContext.decodeAudioData(arrayBuffer);
      currentBuffers.set(track.id, audioBuffer);
    } catch (error) { console.error(`Failed to load track:`, error); }
  }
}

function scheduleTrack(track, startOffset, scheduledTime = null) {
  if (track.muted) return null;
  const buffer = currentBuffers.get(track.id);
  if (!buffer) return null;
  const source = currentAudioContext.createBufferSource();
  const gain = currentAudioContext.createGain();
  source.buffer = buffer;
  gain.gain.value = track.volume;
  source.connect(gain);
  gain.connect(currentAudioContext.destination);
  const when = scheduledTime !== null ? scheduledTime : currentAudioContext.currentTime;
  const offset = startOffset % buffer.duration;
  source.start(when, offset);
  currentGains.set(track.id, gain);
  currentSources.push(source);
  return source;
}

async function startPlayback(recordMode = false) {
  if (!currentSong) return false;
  await initAudioContext();
  const userHasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
  if (recordMode && userHasTrack) { showToast('You already have a track in this song!'); return false; }
  await loadAllTracks();
  if (currentAudioContext.state === 'suspended') await currentAudioContext.resume();
  
  isPlaying = true;
  startTime = currentAudioContext.currentTime - currentPosition;
  for (const track of currentSong.tracks) {
    if (!track.muted) scheduleTrack(track, currentPosition);
  }
  
  if (recordMode) {
    if (countInEnabled) {
      await startCountIn();
    }
    startMetronome();
    await startAudioRecording();
  }
  
  updateTransportUI('play');
  socket.emit('transport-control', { songId: currentSong.id, action: 'play', position: currentPosition, bpm: bpm });
  startPositionTimer();
  return true;
}

function pausePlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  if (isRecording) { stopAudioRecording(); stopMetronome(); }
  for (const source of currentSources) { try { source.stop(); } catch(e) {} }
  currentSources = [];
  currentGains.clear();
  currentPosition = currentAudioContext.currentTime - startTime;
  updateTransportUI('pause');
  socket.emit('transport-control', { songId: currentSong.id, action: 'pause', position: currentPosition, bpm: bpm });
  stopPositionTimer();
}

function stopPlayback() {
  if (isPlaying) {
    if (isRecording) { stopAudioRecording(); stopMetronome(); }
    pausePlayback();
  }
  currentPosition = 0;
  updatePositionDisplay(0);
  socket.emit('transport-control', { songId: currentSong.id, action: 'stop', position: 0, bpm: bpm });
}

async function startAudioRecording() {
  try {
    if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStream = stream;
    const mimeTypes = ['audio/webm', 'audio/mp4', 'audio/wav'];
    let mimeType = '';
    for (const type of mimeTypes) { if (MediaRecorder.isTypeSupported(type)) { mimeType = type; break; } }
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];
    mediaRecorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) audioChunks.push(event.data); };
    mediaRecorder.onstop = async () => {
      if (audioChunks.length === 0) return;
      const audioBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
      const file = new File([audioBlob], `recording-${Date.now()}.${mimeType.includes('webm') ? 'webm' : 'mp4'}`, { type: mimeType || 'audio/webm' });
      document.getElementById('recording-status').innerHTML = '📤 Uploading recording...';
      try {
        await api.uploadTrack(currentSong.id, file);
        showToast('Recording uploaded successfully!');
        await new Promise(resolve => setTimeout(resolve, 500));
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        document.getElementById('recording-status').innerHTML = '✅ Recording saved!';
        document.getElementById('record-btn').disabled = true;
        document.getElementById('upload-btn').disabled = true;
        setTimeout(() => { if (document.getElementById('recording-status').innerHTML === '✅ Recording saved!') document.getElementById('recording-status').innerHTML = ''; }, 3000);
      } catch (error) { console.error('Upload error:', error); document.getElementById('recording-status').innerHTML = '❌ Failed to upload'; }
      if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
      audioChunks = [];
    };
    mediaRecorder.start(1000);
    isRecording = true;
    document.getElementById('record-btn').style.display = 'none';
    document.getElementById('stop-record-btn').style.display = 'inline-block';
    document.getElementById('recording-status').innerHTML = '🔴 RECORDING';
    socket.emit('recording-started', { songId: currentSong.id, username: currentUser.username });
  } catch (error) {
    showToast('Could not access microphone');
    document.getElementById('recording-status').innerHTML = '❌ Microphone error';
    document.getElementById('record-btn').style.display = 'inline-block';
    document.getElementById('stop-record-btn').style.display = 'none';
    if (isPlaying) pausePlayback();
  }
}

function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); isRecording = false; }
  document.getElementById('record-btn').style.display = 'inline-block';
  document.getElementById('stop-record-btn').style.display = 'none';
  socket.emit('recording-stopped', { songId: currentSong.id, username: currentUser.username });
}

async function startRecordingWithPlayback() {
  if (!currentSong) { showToast('Please select a song first'); return; }
  if (isRecording) { showToast('Already recording!'); return; }
  const userHasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
  if (userHasTrack) { showToast('You already have a track in this song!'); return; }
  if (isPlaying) { stopPlayback(); await new Promise(resolve => setTimeout(resolve, 200)); }
  currentPosition = 0;
  updatePositionDisplay(0);
  await new Promise(resolve => setTimeout(resolve, 100));
  await startPlayback(true);
}

function stopRecordingAndPlayback() {
  if (isRecording) { stopAudioRecording(); stopMetronome(); }
  if (isPlaying) stopPlayback();
}

async function deleteTrack(trackId) {
  if (!currentSong) return;
  const track = currentSong.tracks.find(t => t.id === trackId);
  if (!track || track.username !== currentUser.username) { showToast('You can only delete your own tracks!'); return; }
  if (!confirm('Delete your track? This cannot be undone.')) return;
  try {
    await api.deleteTrack(currentSong.id, trackId);
    showToast('Track deleted!');
    currentSong = await api.getSong(currentSong.id);
    displayTracks();
    document.getElementById('record-btn').disabled = false;
    document.getElementById('upload-btn').disabled = false;
  } catch (error) { showToast('Error deleting track'); }
}

function startPositionTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isPlaying) updatePositionDisplay(currentAudioContext.currentTime - startTime);
  }, 50);
}

function stopPositionTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

function updatePositionDisplay(position) {
  const minutes = Math.floor(position / 60);
  const seconds = Math.floor(position % 60);
  const ms = Math.floor((position % 1) * 100);
  document.getElementById('position-display').textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
}

function updateTransportUI(action) {
  const playBtn = document.getElementById('play-btn');
  if (action === 'play') { playBtn.textContent = '⏸️ Pause'; playBtn.className = 'pause-btn'; }
  else { playBtn.textContent = '▶ Play'; playBtn.className = 'play-btn'; }
}

function setBpm(newBpm) {
  if (newBpm < 40) newBpm = 40;
  if (newBpm > 300) newBpm = 300;
  bpm = newBpm;
  if (isRecording && !countInActive) { stopMetronome(); startMetronome(); }
  socket.emit('transport-control', { songId: currentSong.id, action: 'setBpm', bpm: bpm });
}

// Navigation
function initMobileNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewName = item.dataset.view;
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
      document.getElementById(`${viewName}-view`).classList.add('active');
      if (viewName === 'profile') loadProfile();
      if (viewName === 'social') loadChatUsers();
      if (viewName === 'library') loadSongs();
    });
  });
}

// Load Songs
async function loadSongs() {
  if (isRefreshing) return;
  try {
    const songs = await api.getSongs();
    const container = document.getElementById('song-list');
    if (songs.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Create the first one!</div>'; return; }
    container.innerHTML = songs.map(song => `
      <div class="song-card" onclick="selectSong('${song.id}')">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title">${escapeHtml(song.title)} ${song.isNew ? '<span class="new-badge">NEW</span>' : ''}</div>
          <div class="song-creator" onclick="event.stopPropagation(); viewUserProfile('${song.creator}')">
            <img class="creator-avatar-small" src="${song.creatorAvatar}" alt=""> ${escapeHtml(song.creator)}
          </div>
          <div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes} likes</div>
        </div>
      </div>
    `).join('');
    
    // Add library search
    const searchInput = document.getElementById('library-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const cards = document.querySelectorAll('#song-list .song-card');
        cards.forEach(card => {
          const title = card.querySelector('.song-title')?.innerText.toLowerCase() || '';
          const creator = card.querySelector('.song-creator')?.innerText.toLowerCase() || '';
          card.style.display = (title.includes(term) || creator.includes(term)) ? 'flex' : 'none';
        });
      });
    }
  } catch (error) { console.error('Error loading songs:', error); }
}

async function selectSong(songId) {
  if (isRefreshing) return;
  try {
    isRefreshing = true;
    if (isPlaying) stopPlayback();
    if (isRecording) stopAudioRecording();
    if (metronomeInterval) clearInterval(metronomeInterval);
    if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
    if (currentAudioContext) await currentAudioContext.close();
    currentBuffers.clear();
    currentSources = [];
    currentGains.clear();
    currentSong = await api.getSong(songId);
    document.getElementById('current-song-title').textContent = currentSong.title;
    document.getElementById('song-creator').innerHTML = `Created by <span onclick="viewUserProfile('${currentSong.creator}')">${escapeHtml(currentSong.creator)}</span> • ${currentSong.genre} • ${currentSong.bpm} BPM`;
    document.getElementById('bpm-input').value = currentSong.bpm;
    bpm = currentSong.bpm;
    socket.emit('join-song', songId);
    displayTracks();
    const userTrack = currentSong.tracks.find(t => t.username === currentUser.username);
    document.getElementById('record-btn').disabled = !!userTrack;
    document.getElementById('upload-btn').disabled = !!userTrack;
    isPlaying = false;
    currentPosition = 0;
    updatePositionDisplay(0);
    // Switch to studio view
    document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
    document.querySelector('.nav-item[data-view="studio"]').classList.add('active');
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('studio-view').classList.add('active');
  } catch (error) { console.error('Error loading song:', error); showToast('Error loading song'); }
  finally { isRefreshing = false; }
}

function displayTracks() {
  const container = document.getElementById('track-mixer');
  const tracks = currentSong.tracks;
  if (tracks.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Be the first to add your sound!</div>'; return; }
  container.innerHTML = tracks.map((track, index) => {
    const isCurrentUserTrack = track.username === currentUser?.username;
    return `
      <div class="track-card ${track.muted ? 'muted' : ''}">
        <div class="track-info">
          <div><span class="track-name">🎧 ${escapeHtml(track.username)}${isCurrentUserTrack ? '<span class="your-track"> (Your Track)</span>' : ''}</span>
          <div class="track-creator" onclick="viewUserProfile('${track.username}')">Added ${new Date(track.uploadedAt).toLocaleDateString()}</div></div>
          <div class="track-votes">👍 ${track.votes || 0}</div>
        </div>
        <div class="track-controls">
          <button class="${track.muted ? 'unmute-btn' : 'mute-btn'}" onclick="toggleMute('${track.id}')">${track.muted ? '🔊 Unmute' : '🔇 Mute'}</button>
          <button class="vote-btn" onclick="voteTrack('${track.id}', 'up')">👍 Upvote</button>
          <button class="vote-btn" onclick="voteTrack('${track.id}', 'down')">👎 Downvote</button>
          <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${track.volume || 0.8}" onchange="adjustVolume('${track.id}', this.value)">
          ${isCurrentUserTrack ? `<button class="delete-btn" onclick="deleteTrack('${track.id}')">🗑️ Delete</button>` : ''}
        </div>
        <div class="fx-section">
          <button class="fx-btn ${track.fx?.reverb ? 'active' : ''}" onclick="toggleTrackFX('${track.id}', 'reverb')">🎛️ Reverb</button>
          <button class="fx-btn ${track.fx?.delay ? 'active' : ''}" onclick="toggleTrackFX('${track.id}', 'delay')">⏱️ Delay</button>
          <button class="fx-btn ${track.fx?.distortion ? 'active' : ''}" onclick="toggleTrackFX('${track.id}', 'distortion')">🎸 Distortion</button>
          <button class="fx-btn ${track.fx?.lowpass ? 'active' : ''}" onclick="toggleTrackFX('${track.id}', 'lowpass')">🔽 Low Pass</button>
        </div>
      </div>
    `;
  }).join('');
}

function toggleMute(trackId) {
  const track = currentSong.tracks.find(t => t.id === trackId);
  if (track) {
    track.muted = !track.muted;
    displayTracks();
    if (isPlaying) { const pos = currentPosition; pausePlayback(); currentPosition = pos; startPlayback(false); }
    socket.emit('track-update', { songId: currentSong.id, trackId, updates: { muted: track.muted } });
  }
}

function adjustVolume(trackId, volume) {
  const track = currentSong.tracks.find(t => t.id === trackId);
  if (track) {
    track.volume = parseFloat(volume);
    const gain = currentGains.get(trackId);
    if (gain) gain.gain.value = track.volume;
    socket.emit('track-update', { songId: currentSong.id, trackId, updates: { volume: track.volume } });
  }
}

async function voteTrack(trackId, vote) {
  try {
    const result = await api.voteTrack(currentSong.id, trackId, vote);
    const track = currentSong.tracks.find(t => t.id === trackId);
    if (track) track.votes = result.votes;
    displayTracks();
  } catch (error) { showToast('Error voting'); }
}

async function toggleTrackFX(trackId, fxName) {
  const track = currentSong?.tracks.find(t => t.id === trackId);
  if (!track) return;
  if (!track.fx) track.fx = {};
  track.fx[fxName] = !track.fx[fxName];
  displayTracks();
  try {
    await fetch(`/api/songs/${currentSong.id}/fx`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId, fx: { [fxName]: track.fx[fxName] } })
    });
  } catch (error) { console.error(error); }
}

function backToLibrary() {
  if (isPlaying) stopPlayback();
  if (isRecording) stopAudioRecording();
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
  if (currentAudioContext) currentAudioContext.close();
  currentBuffers.clear();
  if (socket && currentSong) socket.emit('leave-song', currentSong.id);
  currentSong = null;
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
  document.querySelector('.nav-item[data-view="library"]').classList.add('active');
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.getElementById('library-view').classList.add('active');
  loadSongs();
}

async function createSong() {
  const title = document.getElementById('new-song-title').value;
  let bpmVal = parseInt(document.getElementById('new-song-bpm').value);
  const genre = document.getElementById('new-song-genre').value;
  if (!title) { showToast('Please enter a title'); return; }
  if (isNaN(bpmVal)) bpmVal = 120;
  bpmVal = Math.min(300, Math.max(40, bpmVal));
  const thumbnail = currentThumbnail || generateRandomThumbnail(title);
  try {
    const newSong = await api.createSong({ title, bpm: bpmVal, genre, thumbnail });
    showToast('Song created!');
    document.getElementById('create-modal').style.display = 'none';
    document.getElementById('new-song-title').value = '';
    currentThumbnail = null;
    loadSongs();
    selectSong(newSong.id);
  } catch (error) { showToast('Error creating song'); }
}

function randomizeThumbnail() {
  const title = document.getElementById('new-song-title').value || 'track';
  currentThumbnail = generateRandomThumbnail(title);
  document.getElementById('preview-thumb').src = currentThumbnail;
}

async function uploadTrackFile() {
  const fileInput = document.getElementById('audio-file');
  const file = fileInput.files[0];
  if (!file) { showToast('Select an audio file'); return; }
  if (file.size > 50 * 1024 * 1024) { showToast('File too large (max 50MB)'); return; }
  if (currentSong.tracks.some(t => t.username === currentUser.username)) { showToast('You already have a track'); return; }
  try {
    await api.uploadTrack(currentSong.id, file);
    showToast('Track uploaded!');
    currentSong = await api.getSong(currentSong.id);
    displayTracks();
    document.getElementById('record-btn').disabled = true;
    document.getElementById('upload-btn').disabled = true;
  } catch (error) { showToast('Upload failed'); }
}

// Profile functions
async function loadProfile() {
  const container = document.getElementById('profile-content');
  try {
    const user = await api.getUser(currentUser.username);
    container.innerHTML = `
      <div class="profile-header">
        <img class="profile-avatar" src="${user.avatar}" alt="${escapeHtml(user.username)}">
        <h2>${escapeHtml(user.username)}</h2>
        <p class="profile-bio">${escapeHtml(user.bio || 'Music creator on TrackStars')}</p>
        <button class="edit-profile-btn" id="edit-profile-btn">✏️ Edit Profile</button>
        <div class="stats">
          <div class="stat"><div class="stat-number">${user.followers?.length || 0}</div><div class="stat-label">Followers</div></div>
          <div class="stat"><div class="stat-number">${user.following?.length || 0}</div><div class="stat-label">Following</div></div>
          <div class="stat"><div class="stat-number">${user.contributedTo?.length || 0}</div><div class="stat-label">Tracks</div></div>
        </div>
      </div>
      <div class="profile-tracks"><h3>My Tracks</h3><div id="profile-tracks-list"></div></div>
    `;
    const songs = await api.getSongs();
    const userSongs = songs.filter(s => s.creator === user.username);
    const tracksList = document.getElementById('profile-tracks-list');
    if (userSongs.length === 0) tracksList.innerHTML = '<div class="loading">No tracks yet</div>';
    else tracksList.innerHTML = userSongs.map(song => `<div class="song-card" onclick="selectSong('${song.id}')"><img class="song-thumbnail" src="${song.thumbnail}"><div class="song-info-card"><div class="song-title">${escapeHtml(song.title)}</div><div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes}</div></div></div>`).join('');
    document.getElementById('edit-profile-btn').addEventListener('click', openProfileModal);
  } catch (error) { container.innerHTML = '<div class="loading">Error loading profile</div>'; }
}

async function openProfileModal() {
  const modal = document.getElementById('profile-modal');
  const user = await api.getUser(currentUser.username);
  document.getElementById('profile-modal-avatar').src = user.avatar;
  document.getElementById('profile-bio').value = user.bio || '';
  document.getElementById('profile-followers').textContent = user.followers?.length || 0;
  document.getElementById('profile-following').textContent = user.following?.length || 0;
  document.getElementById('profile-tracks').textContent = user.contributedTo?.length || 0;
  modal.style.display = 'flex';
}

async function saveProfile() {
  const bio = document.getElementById('profile-bio').value;
  await api.updateBio(bio);
  showToast('Profile updated');
  document.getElementById('profile-modal').style.display = 'none';
  loadProfile();
}

async function uploadAvatar(file) {
  const result = await api.uploadAvatar(file);
  currentUser.avatar = result.avatar;
  document.getElementById('header-avatar').src = result.avatar;
  showToast('Avatar updated');
}

// Chat functions
async function loadChatUsers() {
  const usersList = document.getElementById('chat-users-list');
  try {
    const users = await api.getAllUsers();
    const otherUsers = users.filter(u => u.username !== currentUser.username);
    if (otherUsers.length === 0) { usersList.innerHTML = '<div class="loading">No other users yet</div>'; return; }
    usersList.innerHTML = otherUsers.map(user => `
      <div class="chat-user-item" onclick="startChat('${user.username}')">
        <img class="chat-user-avatar" src="${user.avatar}" alt="">
        <div class="chat-user-name">${escapeHtml(user.username)}</div>
      </div>
    `).join('');
    document.getElementById('chat-conversation').style.display = 'none';
  } catch (error) { usersList.innerHTML = '<div class="loading">Error loading users</div>'; }
}

async function startChat(username) {
  currentChatUser = username;
  document.getElementById('chat-users-list').style.display = 'none';
  document.getElementById('chat-conversation').style.display = 'flex';
  document.getElementById('chat-with-user').textContent = username;
  await loadConversation(username);
}

async function loadConversation(username) {
  const messages = await api.getMessages(username);
  const container = document.getElementById('chat-messages');
  container.innerHTML = messages.map(msg => `
    <div class="chat-message ${msg.from === currentUser.username ? 'sent' : 'received'}">
      <div>${escapeHtml(msg.text)}</div>
      <div class="chat-message-time">${new Date(msg.timestamp).toLocaleTimeString()}</div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-message-input');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;
  await api.sendMessage(currentChatUser, text);
  input.value = '';
  await loadConversation(currentChatUser);
}

function closeChatModal() {
  document.getElementById('chat-conversation').style.display = 'none';
  document.getElementById('chat-users-list').style.display = 'block';
  currentChatUser = null;
}

// View User Profile (for other users)
async function viewUserProfile(username) {
  try {
    const user = await api.getUser(username);
    const isFollowing = currentUser.following?.includes(username) || false;
    const modal = document.getElementById('user-profile-modal');
    document.getElementById('user-profile-details').innerHTML = `
      <div class="user-profile-detail">
        <img class="view-profile-avatar" src="${user.avatar}">
        <div class="view-profile-name">${escapeHtml(user.username)}</div>
        <div class="view-profile-bio">${escapeHtml(user.bio || 'Music creator')}</div>
        <div>
          <button class="view-profile-follow-btn ${isFollowing ? 'following' : ''}" onclick="followFromProfile('${user.username}', this)">${isFollowing ? 'Following' : 'Follow'}</button>
          <button class="view-profile-message-btn" onclick="startChat('${user.username}'); document.getElementById('user-profile-modal').style.display = 'none';">💬 Message</button>
        </div>
        <div class="view-profile-stats">
          <div><div style="font-size:20px;font-weight:bold">${user.followers?.length || 0}</div><div style="font-size:11px">Followers</div></div>
          <div><div style="font-size:20px;font-weight:bold">${user.following?.length || 0}</div><div style="font-size:11px">Following</div></div>
          <div><div style="font-size:20px;font-weight:bold">${user.contributedTo?.length || 0}</div><div style="font-size:11px">Tracks</div></div>
        </div>
        <div class="view-profile-tracks"><h4>🎵 Tracks</h4><div id="view-profile-tracks-list"></div></div>
      </div>
    `;
    const songs = await api.getSongs();
    const userSongs = songs.filter(s => user.contributedTo?.includes(s.id) || s.creator === username);
    const tracksContainer = document.getElementById('view-profile-tracks-list');
    if (userSongs.length === 0) tracksContainer.innerHTML = '<div style="color:#888;text-align:center">No tracks yet</div>';
    else tracksContainer.innerHTML = userSongs.map(song => `<div class="search-song-item" onclick="selectSong('${song.id}'); document.getElementById('user-profile-modal').style.display = 'none';"><img class="search-song-thumb" src="${song.thumbnail}"><div class="search-song-info"><div class="search-song-title">${escapeHtml(song.title)}</div><div class="search-song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes || 0}</div></div></div>`).join('');
    modal.style.display = 'flex';
  } catch (error) { showToast('Error loading profile'); }
}

async function followFromProfile(username, btn) {
  const result = await api.followUser(username);
  if (result.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast(`Following ${username}`); }
  else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast(`Unfollowed ${username}`); }
  if (result.following) currentUser.following.push(username);
  else currentUser.following = currentUser.following.filter(u => u !== username);
}

// Socket functions
function initSocket() {
  socket = io();
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('track-added', async (data) => { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); });
  socket.on('track-deleted', async (data) => { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); });
  socket.on('track-updated', (data) => { if (currentSong) { const track = currentSong.tracks.find(t => t.id === data.trackId); if (track && data.updates) { if (data.updates.muted !== undefined) track.muted = data.updates.muted; if (data.updates.volume !== undefined) track.volume = data.updates.volume; displayTracks(); } } });
  socket.on('transport-state', (state) => { if (state.bpm && state.bpm !== bpm && currentSong) { bpm = state.bpm; document.getElementById('bpm-input').value = bpm; } });
  socket.on('user-recording', (data) => showToast(`${data.username} is recording...`));
  socket.on('new-message', (message) => { if (currentChatUser === message.from) loadConversation(message.from); showToast(`New message from ${message.from}`); });
  socket.emit('join-chat', currentUser.username);
}

// Utility functions
function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
function showToast(msg, duration = 3000) { let toast = document.querySelector('.toast'); if (toast) toast.remove(); toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = msg; document.body.appendChild(toast); setTimeout(() => toast.remove(), duration); }

// Event Listeners
function setupEventListeners() {
  document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => { const tabName = tab.dataset.tab; document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active')); tab.classList.add('active'); document.getElementById(`${tabName}-form`).classList.add('active'); }));
  document.getElementById('login-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await login(document.getElementById('login-username').value, document.getElementById('login-password').value); document.getElementById('auth-modal').style.display = 'none'; document.getElementById('main-app').style.display = 'block'; document.getElementById('current-user').textContent = currentUser.username; document.getElementById('header-avatar').src = currentUser.avatar; initSocket(); loadSongs(); initMobileNavigation(); } catch (err) { document.getElementById('login-error').textContent = err.message; } });
  document.getElementById('register-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await register(document.getElementById('reg-username').value, document.getElementById('reg-email').value, document.getElementById('reg-password').value, document.getElementById('reg-confirm').value); document.getElementById('auth-modal').style.display = 'none'; document.getElementById('main-app').style.display = 'block'; document.getElementById('current-user').textContent = currentUser.username; document.getElementById('header-avatar').src = currentUser.avatar; initSocket(); loadSongs(); initMobileNavigation(); } catch (err) { document.getElementById('register-error').textContent = err.message; } });
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('header-avatar').addEventListener('click', openProfileModal);
  document.querySelector('.username').addEventListener('click', openProfileModal);
  document.querySelector('.close-modal').addEventListener('click', () => document.getElementById('profile-modal').style.display = 'none');
  document.getElementById('save-profile-btn').addEventListener('click', saveProfile);
  document.getElementById('change-avatar-btn').addEventListener('click', () => document.getElementById('avatar-upload').click());
  document.getElementById('avatar-upload').addEventListener('change', e => { if (e.target.files[0]) uploadAvatar(e.target.files[0]); });
  document.getElementById('open-create-modal').addEventListener('click', () => { currentThumbnail = null; document.getElementById('create-modal').style.display = 'flex'; });
  document.getElementById('confirm-create').addEventListener('click', createSong);
  document.getElementById('cancel-create').addEventListener('click', () => document.getElementById('create-modal').style.display = 'none');
  document.getElementById('randomize-thumb-btn').addEventListener('click', randomizeThumbnail);
  document.getElementById('play-btn').addEventListener('click', () => { if (isPlaying) pausePlayback(); else startPlayback(false); });
  document.getElementById('stop-btn').addEventListener('click', stopPlayback);
  document.getElementById('bpm-input').addEventListener('change', e => setBpm(parseInt(e.target.value)));
  document.getElementById('record-btn').addEventListener('click', startRecordingWithPlayback);
  document.getElementById('stop-record-btn').addEventListener('click', stopRecordingAndPlayback);
  document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('audio-file').click());
  document.getElementById('audio-file').addEventListener('change', uploadTrackFile);
  document.getElementById('back-btn').addEventListener('click', backToLibrary);
  document.getElementById('metronome-toggle').addEventListener('change', e => { metronomeEnabled = e.target.checked; if (isRecording && !countInActive) metronomeEnabled ? startMetronome() : stopMetronome(); });
  document.getElementById('countin-toggle').addEventListener('change', e => countInEnabled = e.target.checked);
  document.querySelector('.close-user-profile').addEventListener('click', () => document.getElementById('user-profile-modal').style.display = 'none');
  document.getElementById('back-to-users').addEventListener('click', closeChatModal);
  document.getElementById('send-chat-btn').addEventListener('click', sendChatMessage);
  document.getElementById('chat-message-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendChatMessage(); });
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('token');
  const savedUser = localStorage.getItem('user');
  if (savedToken && savedUser) {
    token = savedToken;
    currentUser = JSON.parse(savedUser);
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';
    document.getElementById('current-user').textContent = currentUser.username;
    document.getElementById('header-avatar').src = currentUser.avatar;
    initSocket();
    loadSongs();
    initMobileNavigation();
    setupEventListeners();
  } else {
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
    setupEventListeners();
  }
});

// Make functions global
window.selectSong = selectSong;
window.toggleMute = toggleMute;
window.adjustVolume = adjustVolume;
window.voteTrack = voteTrack;
window.deleteTrack = deleteTrack;
window.toggleTrackFX = toggleTrackFX;
window.viewUserProfile = viewUserProfile;
window.followFromProfile = followFromProfile;
window.startChat = startChat;