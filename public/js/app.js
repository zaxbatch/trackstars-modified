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
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
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
  async getFollowingFeed() { return this.request('/api/feed/following'); }
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  if (!metronomeEnabled) return;
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
    
    if (countInEnabled) {
      document.getElementById('recording-status').innerHTML = '⏱️ Count-in starting...';
      await startCountIn();
    }
    
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
  if (isRecording) { stopMetronome(); startMetronome(); }
  socket.emit('transport-control', { songId: currentSong.id, action: 'setBpm', bpm: bpm });
}

// Feed Functions
async function loadCommunityFeed() {
  try {
    const songs = await api.getCommunityFeed();
    const container = document.getElementById('community-songs');
    if (songs.length === 0) { container.innerHTML = '<div class="loading">No tracks yet</div>'; return; }
    container.innerHTML = songs.map(song => `
      <div class="song-card">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title" onclick="selectSong('${song.id}')">${escapeHtml(song.title)} ${song.isNew ? '<span class="new-badge">NEW</span>' : ''}</div>
          <div class="song-creator" onclick="viewUserProfile('${song.creator}')">
            <img class="creator-avatar-small" src="${song.creatorAvatar}" alt=""> ${escapeHtml(song.creator)}
          </div>
          <div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes} likes | 🎧 ${song.totalContributors} contributors | 🎚️ ${song.bpm} BPM</div>
        </div>
      </div>
    `).join('');
  } catch (error) { console.error(error); }
}

async function loadFollowingFeed() {
  try {
    const songs = await api.getFollowingFeed();
    const container = document.getElementById('following-songs');
    if (songs.length === 0) { container.innerHTML = '<div class="loading">No tracks from followed creators. Follow someone!</div>'; return; }
    container.innerHTML = songs.map(song => `
      <div class="song-card">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title" onclick="selectSong('${song.id}')">${escapeHtml(song.title)}</div>
          <div class="song-creator" onclick="viewUserProfile('${song.creator}')">
            <img class="creator-avatar-small" src="${song.creatorAvatar}" alt=""> ${escapeHtml(song.creator)}
          </div>
          <div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes} likes</div>
        </div>
      </div>
    `).join('');
  } catch (error) { console.error(error); }
}

async function loadSongs() {
  if (isRefreshing) return;
  try {
    const songs = await api.getSongs();
    const container = document.getElementById('song-list');
    const userSongs = songs.filter(s => s.creator === currentUser.username);
    if (userSongs.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Create your first!</div>'; return; }
    container.innerHTML = userSongs.map(song => `
      <div class="song-card">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title" onclick="selectSong('${song.id}')">${escapeHtml(song.title)}</div>
          <div class="song-creator">by you</div>
          <div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes} likes</div>
        </div>
      </div>
    `).join('');
  } catch (error) { console.error(error); }
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
    document.getElementById('song-creator').innerHTML = `Created by <span style="color:#667eea;cursor:pointer" onclick="viewUserProfile('${currentSong.creator}')">${escapeHtml(currentSong.creator)}</span> • ${currentSong.genre} • ${currentSong.bpm} BPM`;
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
    
    document.querySelectorAll('.feed-view').forEach(view => view.classList.remove('active'));
    document.querySelector('.studio-view').classList.add('active');
    document.querySelector('.feed-tabs').style.display = 'none';
  } catch (error) { console.error(error); showToast('Error loading song'); }
  finally { isRefreshing = false; }
}

function displayTracks() {
  const container = document.getElementById('track-mixer');
  const tracks = currentSong.tracks;
  if (tracks.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Be the first!</div>'; return; }
  
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
    await loadCommunityFeed();
    await loadSongs();
    await selectSong(newSong.id);
  } catch (error) { showToast('Error creating song'); }
}

function randomizeThumbnail() {
  const title = document.getElementById('new-song-title').value || 'track';
  currentThumbnail = generateRandomThumbnail(title);
  document.getElementById('preview-thumb').src = currentThumbnail;
}

async function openProfileModal() {
  const modal = document.getElementById('profile-modal');
  const response = await fetch(`/api/users/${currentUser.username}`, { headers: { 'Authorization': `Bearer ${token}` } });
  const user = await response.json();
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
}

async function uploadAvatar(file) {
  const result = await api.uploadAvatar(file);
  currentUser.avatar = result.avatar;
  document.getElementById('header-avatar').src = result.avatar;
  showToast('Avatar updated');
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
  document.querySelector('.studio-view').classList.remove('active');
  document.querySelector('.feed-tabs').style.display = 'flex';
  const activeFeed = document.querySelector('.feed-tab.active').dataset.feed;
  document.getElementById(`${activeFeed}-feed`).classList.add('active');
  loadCommunityFeed(); loadFollowingFeed(); loadSongs();
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

// Socket functions
function initSocket() {
  socket = io();
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('track-added', async (data) => { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadCommunityFeed(); loadFollowingFeed(); });
  socket.on('track-deleted', async (data) => { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadCommunityFeed(); loadFollowingFeed(); });
  socket.on('track-updated', (data) => { if (currentSong) { const track = currentSong.tracks.find(t => t.id === data.trackId); if (track && data.updates) { if (data.updates.muted !== undefined) track.muted = data.updates.muted; if (data.updates.volume !== undefined) track.volume = data.updates.volume; displayTracks(); } } });
  socket.on('transport-state', (state) => { if (state.bpm && state.bpm !== bpm && currentSong) { bpm = state.bpm; document.getElementById('bpm-input').value = bpm; } });
  socket.on('user-recording', (data) => showToast(`${data.username} is recording...`));
  
  // Chat socket events
  socket.on('new-message', (message) => { if (document.getElementById('chat-modal').style.display === 'flex') loadConversation(message.from); showToast(`New message from ${message.from}`); });
}

// Chat functions
let currentChatUser = null;

async function openChatModal() {
  const modal = document.getElementById('chat-modal');
  const usersList = document.getElementById('chat-users-list');
  modal.style.display = 'flex';
  document.getElementById('chat-conversation').style.display = 'none';
  
  const response = await fetch('/api/users', { headers: { 'Authorization': `Bearer ${token}` } });
  const users = await response.json();
  const otherUsers = users.filter(u => u.username !== currentUser.username);
  
  usersList.innerHTML = otherUsers.map(user => `
    <div class="chat-user-item" onclick="startChat('${user.username}')">
      <img class="chat-user-avatar" src="${user.avatar}" alt="">
      <div class="chat-user-name">${escapeHtml(user.username)}</div>
    </div>
  `).join('') || '<div class="loading">No other users</div>';
  
  socket.emit('join-chat', currentUser.username);
}

async function startChat(username) {
  currentChatUser = username;
  document.getElementById('chat-users-list').style.display = 'none';
  document.getElementById('chat-conversation').style.display = 'flex';
  document.getElementById('chat-with-user').textContent = username;
  await loadConversation(username);
}

async function loadConversation(username) {
  const response = await fetch(`/api/messages/${username}`, { headers: { 'Authorization': `Bearer ${token}` } });
  const messages = await response.json();
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
  
  await fetch('/api/messages', {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: currentChatUser, text })
  });
  input.value = '';
  await loadConversation(currentChatUser);
}

function closeChatModal() {
  document.getElementById('chat-modal').style.display = 'none';
  document.getElementById('chat-users-list').style.display = 'block';
  document.getElementById('chat-conversation').style.display = 'none';
  currentChatUser = null;
}

// Search functions
let currentSearchTerm = '', currentSearchTab = 'all';

async function performSearch(query, tab = 'all') {
  if (!query.trim()) { document.getElementById('search-results').innerHTML = '<div class="search-placeholder">🔍 Search for songs, artists, or genres...</div>'; return; }
  try {
    let songs = [], users = [];
    if (tab === 'all') { const data = await (await fetch(`/api/search/all?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${token}` } })).json(); songs = data.songs; users = data.users; }
    else if (tab === 'songs') songs = await (await fetch(`/api/search/songs?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
    else users = await (await fetch(`/api/search/users?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
    displaySearchResults(songs, users);
  } catch (error) { console.error(error); }
}

function displaySearchResults(songs, users) {
  const container = document.getElementById('search-results');
  if ((!songs || !songs.length) && (!users || !users.length)) { container.innerHTML = '<div class="search-placeholder">😔 No results found</div>'; return; }
  let html = '';
  if (songs && songs.length) html += `<div class="search-result-section"><div class="search-section-title">🎵 Songs (${songs.length})</div>${songs.map(song => `<div class="search-song-item" onclick="selectSong('${song.id}'); closeSearchModal();"><img class="search-song-thumb" src="${song.thumbnail}"><div class="search-song-info"><div class="search-song-title">${escapeHtml(song.title)}</div><div class="search-song-creator" onclick="event.stopPropagation(); viewUserProfile('${song.creator}')"><img class="creator-avatar-small" src="${song.creatorAvatar}"> ${escapeHtml(song.creator)}</div><div class="search-song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes}</div></div></div>`).join('')}</div>`;
  if (users && users.length) html += `<div class="search-result-section"><div class="search-section-title">👥 Users (${users.length})</div>${users.map(user => `<div class="search-user-item"><img class="search-user-avatar" src="${user.avatar}" onclick="viewUserProfile('${user.username}')"><div class="search-user-info"><div class="search-user-name" onclick="viewUserProfile('${user.username}')">${escapeHtml(user.username)}</div><div class="search-user-bio">${escapeHtml(user.bio.substring(0, 60))}</div><div class="search-user-stats">👥 ${user.followersCount} followers | 🎵 ${user.tracksCount} tracks</div></div><button class="search-follow-btn ${user.isFollowing ? 'following' : ''}" onclick="followFromSearch('${user.username}', this)">${user.isFollowing ? 'Following' : 'Follow'}</button><button class="search-chat-btn" onclick="startChat('${user.username}'); closeSearchModal(); openChatModal();">💬</button></div>`).join('')}</div>`;
  container.innerHTML = html;
}

async function followFromSearch(username, btn) {
  const result = await api.followUser(username);
  if (result.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast(`Following ${username}`); }
  else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast(`Unfollowed ${username}`); }
  loadFollowingFeed();
  if (result.following) currentUser.following.push(username);
  else currentUser.following = currentUser.following.filter(u => u !== username);
}

async function viewUserProfile(username) {
  const response = await fetch(`/api/users/${username}`, { headers: { 'Authorization': `Bearer ${token}` } });
  const user = await response.json();
  const isFollowing = currentUser.following?.includes(username);
  const modal = document.getElementById('user-profile-modal');
  document.getElementById('user-profile-details').innerHTML = `
    <div class="user-profile-detail">
      <img class="view-profile-avatar" src="${user.avatar}">
      <div class="view-profile-name">${escapeHtml(user.username)}</div>
      <div class="view-profile-bio">${escapeHtml(user.bio || 'Music creator')}</div>
      <button class="view-profile-follow-btn ${isFollowing ? 'following' : ''}" onclick="followFromProfile('${user.username}', this)">${isFollowing ? 'Following' : 'Follow'}</button>
      <button class="view-profile-follow-btn" style="background:#3498db" onclick="startChat('${user.username}'); document.getElementById('user-profile-modal').style.display = 'none'; openChatModal();">💬 Message</button>
      <div class="view-profile-stats"><div><div style="font-size:20px;font-weight:bold">${user.followers?.length || 0}</div><div style="font-size:11px">Followers</div></div><div><div style="font-size:20px;font-weight:bold">${user.following?.length || 0}</div><div style="font-size:11px">Following</div></div><div><div style="font-size:20px;font-weight:bold">${user.contributedTo?.length || 0}</div><div style="font-size:11px">Tracks</div></div></div>
      <div class="view-profile-tracks"><h4>🎵 Tracks</h4><div id="profile-user-tracks"></div></div>
    </div>`;
  const songs = await api.getSongs();
  const userSongs = songs.filter(s => user.contributedTo?.includes(s.id) || s.creator === username);
  document.getElementById('profile-user-tracks').innerHTML = userSongs.map(song => `<div class="search-song-item" onclick="selectSong('${song.id}'); document.getElementById('user-profile-modal').style.display = 'none';"><img class="search-song-thumb" src="${song.thumbnail}"><div class="search-song-info"><div class="search-song-title">${escapeHtml(song.title)}</div><div class="search-song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes || 0}</div></div></div>`).join('') || '<div style="color:#888;text-align:center">No tracks yet</div>';
  modal.style.display = 'flex';
}

async function followFromProfile(username, btn) {
  const result = await api.followUser(username);
  if (result.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast(`Following ${username}`); }
  else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast(`Unfollowed ${username}`); }
  loadFollowingFeed();
}

function openSearchModal() { document.getElementById('search-modal').style.display = 'flex'; document.getElementById('search-input').focus(); }
function closeSearchModal() { document.getElementById('search-modal').style.display = 'none'; document.getElementById('search-input').value = ''; }

function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
function showToast(msg, duration = 3000) { let toast = document.querySelector('.toast'); if (toast) toast.remove(); toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = msg; document.body.appendChild(toast); setTimeout(() => toast.remove(), duration); }

// Event Listeners
function setupEventListeners() {
  document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => { const tabName = tab.dataset.tab; document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active')); tab.classList.add('active'); document.getElementById(`${tabName}-form`).classList.add('active'); }));
  document.getElementById('login-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await login(document.getElementById('login-username').value, document.getElementById('login-password').value); document.getElementById('auth-modal').style.display = 'none'; document.getElementById('main-app').style.display = 'block'; document.getElementById('current-user').textContent = currentUser.username; document.getElementById('header-avatar').src = currentUser.avatar; initSocket(); loadCommunityFeed(); loadFollowingFeed(); loadSongs(); initFeedNavigation(); } catch (err) { document.getElementById('login-error').textContent = err.message; } });
  document.getElementById('register-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await register(document.getElementById('reg-username').value, document.getElementById('reg-email').value, document.getElementById('reg-password').value, document.getElementById('reg-confirm').value); document.getElementById('auth-modal').style.display = 'none'; document.getElementById('main-app').style.display = 'block'; document.getElementById('current-user').textContent = currentUser.username; document.getElementById('header-avatar').src = currentUser.avatar; initSocket(); loadCommunityFeed(); loadFollowingFeed(); loadSongs(); initFeedNavigation(); } catch (err) { document.getElementById('register-error').textContent = err.message; } });
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
  document.getElementById('metronome-toggle').addEventListener('change', e => { metronomeEnabled = e.target.checked; if (isRecording) metronomeEnabled ? startMetronome() : stopMetronome(); });
  document.getElementById('countin-toggle').addEventListener('change', e => countInEnabled = e.target.checked);
  document.getElementById('search-btn').addEventListener('click', openSearchModal);
  document.getElementById('close-search').addEventListener('click', closeSearchModal);
  document.querySelector('.close-user-profile').addEventListener('click', () => document.getElementById('user-profile-modal').style.display = 'none');
  document.querySelector('.close-chat').addEventListener('click', closeChatModal);
  document.getElementById('back-to-users').addEventListener('click', () => { document.getElementById('chat-conversation').style.display = 'none'; document.getElementById('chat-users-list').style.display = 'block'; currentChatUser = null; });
  document.getElementById('send-chat-btn').addEventListener('click', sendChatMessage);
  document.getElementById('chat-message-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendChatMessage(); });
  document.getElementById('chat-btn')?.addEventListener('click', openChatModal);
  const searchInput = document.getElementById('search-input');
  let debounce;
  searchInput.addEventListener('input', e => { clearTimeout(debounce); currentSearchTerm = e.target.value; debounce = setTimeout(() => performSearch(currentSearchTerm, currentSearchTab), 300); });
  document.querySelectorAll('.search-tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.search-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); currentSearchTab = tab.dataset.searchTab; performSearch(currentSearchTerm, currentSearchTab); }));
}

function initFeedNavigation() {
  document.querySelectorAll('.feed-tab').forEach(tab => tab.addEventListener('click', () => { const feed = tab.dataset.feed; document.querySelectorAll('.feed-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); document.querySelectorAll('.feed-view').forEach(v => v.classList.remove('active')); document.getElementById(`${feed}-feed`).classList.add('active'); if (feed === 'community') loadCommunityFeed(); if (feed === 'following') loadFollowingFeed(); if (feed === 'library') loadSongs(); }));
}

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
    loadCommunityFeed();
    loadFollowingFeed();
    loadSongs();
    initFeedNavigation();
    setupEventListeners();
  } else {
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
    setupEventListeners();
  }
});

window.selectSong = selectSong;
window.toggleMute = toggleMute;
window.adjustVolume = adjustVolume;
window.voteTrack = voteTrack;
window.deleteTrack = deleteTrack;
window.toggleTrackFX = toggleTrackFX;
window.viewUserProfile = viewUserProfile;
window.followFromProfile = followFromProfile;
window.followFromSearch = followFromSearch;
window.closeSearchModal = closeSearchModal;
window.startChat = startChat;
window.openChatModal = openChatModal;