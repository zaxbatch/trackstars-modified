// TrackStars - Complete Application
let socket = null, token = null, currentUser = null, currentSong = null;
let audioCtx = null, buffers = new Map(), sources = [], gains = new Map();
let isPlaying = false, isRecording = false, currentPos = 0, startTime = 0;
let timerInterval = null, mediaRecorder = null, chunks = [], stream = null;
let bpm = 120, metronomeInterval = null, metronomeCtx = null;
let metronomeOn = true, countInOn = true, countInActive = false, currentChatUser = null;

// API
const api = {
  async request(endpoint, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(endpoint, { ...opts, headers });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error');
    return res.json();
  },
  getSongs: () => api.request('/api/songs'),
  getSong: id => api.request(`/api/songs/${id}`),
  createSong: data => api.request('/api/songs', { method: 'POST', body: JSON.stringify(data) }),
  uploadTrack: async (id, file) => {
    const fd = new FormData();
    fd.append('audio', file);
    const res = await fetch(`/api/songs/${id}/track`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },
  deleteTrack: (sid, tid) => api.request(`/api/songs/${sid}/track/${tid}`, { method: 'DELETE' }),
  voteTrack: (sid, tid, v) => api.request(`/api/songs/${sid}/track/${tid}/vote`, { method: 'POST', body: JSON.stringify({ vote: v }) }),
  followUser: u => api.request(`/api/users/${u}/follow`, { method: 'POST' }),
  updateBio: bio => api.request('/api/users/bio', { method: 'PUT', body: JSON.stringify({ bio }) }),
  uploadAvatar: async file => {
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await fetch('/api/upload-avatar', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },
  getMessages: u => api.request(`/api/messages/${u}`),
  sendMessage: (to, text) => api.request('/api/messages', { method: 'POST', body: JSON.stringify({ to, text }) }),
  getUsers: () => api.request('/api/users'),
  getUser: u => api.request(`/api/users/${u}`)
};

// Auth
async function register(u, e, p, c) {
  if (p !== c) throw new Error('Passwords do not match');
  if (p.length < 6) throw new Error('Password too short');
  const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, email: e, password: p }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(currentUser));
  return true;
}

async function login(u, p) {
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(currentUser));
  return true;
}

function logout() {
  if (isPlaying) stopPlayback();
  if (isRecording) stopRecording();
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  token = null;
  localStorage.clear();
  location.reload();
}

// Audio
function playClick(isCountIn = false) {
  if (!metronomeOn && !isCountIn) return;
  if (!metronomeCtx) metronomeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = metronomeCtx.createOscillator();
  const gain = metronomeCtx.createGain();
  osc.connect(gain);
  gain.connect(metronomeCtx.destination);
  osc.frequency.value = isCountIn ? 880 : 1000;
  gain.gain.value = 0.3;
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.00001, metronomeCtx.currentTime + 0.1);
  osc.stop(metronomeCtx.currentTime + 0.1);
}

function startMetronome() {
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (!metronomeOn || countInActive) return;
  metronomeInterval = setInterval(() => { if (isRecording && !countInActive) playClick(false); }, (60 / bpm) * 1000);
}

function stopMetronome() { if (metronomeInterval) { clearInterval(metronomeInterval); metronomeInterval = null; } }

async function startCountIn() {
  return new Promise(resolve => {
    countInActive = true;
    let count = 3;
    const div = document.getElementById('countin-display');
    const num = document.getElementById('countin-number');
    const bar = document.getElementById('countin-bar');
    div.style.display = 'block';
    num.textContent = count;
    bar.style.width = '0%';
    const interval = setInterval(() => {
      if (count > 0) {
        playClick(true);
        num.textContent = count;
        bar.style.width = `${((3 - count) / 3) * 100}%`;
        count--;
      } else {
        clearInterval(interval);
        num.textContent = 'GO!';
        bar.style.width = '100%';
        playClick(true);
        setTimeout(() => { div.style.display = 'none'; countInActive = false; resolve(); }, 500);
      }
    }, 1000);
  });
}

async function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }

async function loadTracks() {
  if (!currentSong) return;
  buffers.clear();
  for (const t of currentSong.tracks) {
    try {
      const res = await fetch(t.audioUrl);
      const buf = await res.arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(buf);
      buffers.set(t.id, audioBuf);
    } catch (e) { console.error(e); }
  }
}

function scheduleTrack(track, offset, when = null) {
  if (track.muted) return null;
  const buf = buffers.get(track.id);
  if (!buf) return null;
  const src = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  src.buffer = buf;
  gain.gain.value = track.volume;
  src.connect(gain);
  gain.connect(audioCtx.destination);
  const time = when !== null ? when : audioCtx.currentTime;
  src.start(time, offset % buf.duration);
  gains.set(track.id, gain);
  sources.push(src);
  return src;
}

async function startPlayback(recordMode = false) {
  if (!currentSong) return false;
  await initAudio();
  if (recordMode && currentSong.tracks.some(t => t.username === currentUser.username)) { alert('You already have a track!'); return false; }
  await loadTracks();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  isPlaying = true;
  startTime = audioCtx.currentTime - currentPos;
  for (const t of currentSong.tracks) if (!t.muted) scheduleTrack(t, currentPos);
  if (recordMode) {
    if (countInOn) await startCountIn();
    startMetronome();
    await startRecording();
  }
  document.getElementById('play-btn').textContent = '⏸️ Pause';
  document.getElementById('play-btn').className = 'pause-btn';
  socket.emit('transport-control', { songId: currentSong.id, action: 'play', position: currentPos, bpm });
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => { if (isPlaying) updateDisplay(audioCtx.currentTime - startTime); }, 50);
  return true;
}

function pausePlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  if (isRecording) { stopRecording(); stopMetronome(); }
  for (const s of sources) try { s.stop(); } catch(e) {}
  sources = [];
  gains.clear();
  currentPos = audioCtx.currentTime - startTime;
  document.getElementById('play-btn').textContent = '▶ Play';
  document.getElementById('play-btn').className = 'play-btn';
  socket.emit('transport-control', { songId: currentSong.id, action: 'pause', position: currentPos, bpm });
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function stopPlayback() {
  if (isPlaying) { if (isRecording) { stopRecording(); stopMetronome(); } pausePlayback(); }
  currentPos = 0;
  updateDisplay(0);
  socket.emit('transport-control', { songId: currentSong.id, action: 'stop', position: 0, bpm });
}

async function startRecording() {
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm', 'audio/mp4', 'audio/wav'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    chunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      const file = new File([blob], `recording-${Date.now()}.${mime.includes('webm') ? 'webm' : 'mp4'}`, { type: mime || 'audio/webm' });
      const status = document.getElementById('recording-status');
      status.innerHTML = '📤 Uploading...';
      try {
        await api.uploadTrack(currentSong.id, file);
        alert('Recording uploaded!');
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        status.innerHTML = '✅ Saved!';
        document.getElementById('record-btn').disabled = true;
        document.getElementById('upload-btn').disabled = true;
        setTimeout(() => status.innerHTML = '', 3000);
      } catch(e) { status.innerHTML = '❌ Upload failed'; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      chunks = [];
    };
    mediaRecorder.start(1000);
    isRecording = true;
    document.getElementById('record-btn').style.display = 'none';
    document.getElementById('stop-record-btn').style.display = 'inline-block';
    document.getElementById('recording-status').innerHTML = '🔴 RECORDING';
    socket.emit('recording-started', { songId: currentSong.id, username: currentUser.username });
  } catch(e) { alert('Microphone access denied'); }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  isRecording = false;
  document.getElementById('record-btn').style.display = 'inline-block';
  document.getElementById('stop-record-btn').style.display = 'none';
  socket.emit('recording-stopped', { songId: currentSong.id, username: currentUser.username });
}

async function startRecordingWithPlayback() {
  if (!currentSong) return alert('Select a song first');
  if (isRecording) return alert('Already recording');
  if (currentSong.tracks.some(t => t.username === currentUser.username)) return alert('You already have a track');
  if (isPlaying) stopPlayback();
  currentPos = 0;
  updateDisplay(0);
  await new Promise(r => setTimeout(r, 100));
  await startPlayback(true);
}

function stopRecordingAndPlayback() {
  if (isRecording) { stopRecording(); stopMetronome(); }
  if (isPlaying) stopPlayback();
}

function updateDisplay(pos) {
  const m = Math.floor(pos / 60), s = Math.floor(pos % 60), ms = Math.floor((pos % 1) * 100);
  document.getElementById('position-display').textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}:${ms.toString().padStart(2,'0')}`;
}

// UI Functions
async function loadSongs() {
  try {
    const songs = await api.getSongs();
    const container = document.getElementById('song-list');
    if (!songs.length) { container.innerHTML = '<div class="loading">No tracks yet. Create one!</div>'; return; }
    container.innerHTML = songs.map(s => `
      <div class="song-card" onclick="selectSong('${s.id}')">
        <img class="song-thumb" src="${s.thumbnail}">
        <div class="song-info">
          <div class="song-title">${escape(s.title)}</div>
          <div class="song-creator" onclick="event.stopPropagation(); viewUser('${s.creator}')">${escape(s.creator)}</div>
          <div class="song-stats">🎵 ${s.trackCount} tracks | 👍 ${s.likes} likes | 🎚️ ${s.bpm} BPM</div>
        </div>
      </div>
    `).join('');
    const search = document.getElementById('library-search');
    if (search) search.oninput = (e) => {
      const term = e.target.value.toLowerCase();
      document.querySelectorAll('#song-list .song-card').forEach(card => {
        const title = card.querySelector('.song-title')?.innerText.toLowerCase() || '';
        const creator = card.querySelector('.song-creator')?.innerText.toLowerCase() || '';
        card.style.display = (title.includes(term) || creator.includes(term)) ? 'flex' : 'none';
      });
    };
  } catch(e) { console.error(e); }
}

async function selectSong(id) {
  try {
    if (isPlaying) stopPlayback();
    if (isRecording) stopRecording();
    if (metronomeInterval) clearInterval(metronomeInterval);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) await audioCtx.close();
    buffers.clear(); sources = []; gains.clear();
    audioCtx = null;
    currentSong = await api.getSong(id);
    document.getElementById('current-song-title').textContent = currentSong.title;
    document.getElementById('song-creator').innerHTML = `Created by <span style="color:#667eea;cursor:pointer" onclick="viewUser('${currentSong.creator}')">${escape(currentSong.creator)}</span> • ${currentSong.genre} • ${currentSong.bpm} BPM`;
    document.getElementById('bpm-input').value = currentSong.bpm;
    bpm = currentSong.bpm;
    socket.emit('join-song', id);
    displayTracks();
    const hasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
    document.getElementById('record-btn').disabled = hasTrack;
    document.getElementById('upload-btn').disabled = hasTrack;
    currentPos = 0;
    updateDisplay(0);
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-view="studio"]').classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('studio-view').classList.add('active');
  } catch(e) { alert('Error loading song'); }
}

function displayTracks() {
  const container = document.getElementById('track-mixer');
  const tracks = currentSong.tracks || [];
  if (!tracks.length) { container.innerHTML = '<div class="loading">No tracks yet. Add your sound!</div>'; return; }
  container.innerHTML = tracks.map((t, i) => `
    <div class="track-card ${t.muted ? 'muted' : ''}">
      <div class="track-row">
        <div><span class="track-name">🎧 ${escape(t.username)}${t.username === currentUser.username ? '<span class="your-track"> (Your Track)</span>' : ''}</span>
        <div class="track-creator" onclick="viewUser('${t.username}')">Added ${new Date(t.uploadedAt).toLocaleDateString()}</div></div>
        <div class="track-votes">👍 ${t.votes || 0}</div>
      </div>
      <div class="track-controls">
        <button class="${t.muted ? 'unmute-btn' : 'mute-btn'}" onclick="toggleMute('${t.id}')">${t.muted ? '🔊 Unmute' : '🔇 Mute'}</button>
        <button class="vote-btn" onclick="voteTrack('${t.id}', 'up')">👍 Upvote</button>
        <button class="vote-btn" onclick="voteTrack('${t.id}', 'down')">👎 Downvote</button>
        <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${t.volume || 0.8}" onchange="adjustVolume('${t.id}', this.value)">
        ${t.username === currentUser.username ? `<button class="delete-btn" onclick="deleteTrack('${t.id}')">🗑️ Delete</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function toggleMute(id) {
  const track = currentSong.tracks.find(t => t.id === id);
  if (track) {
    track.muted = !track.muted;
    if (isPlaying) { const pos = currentPos; pausePlayback(); currentPos = pos; await startPlayback(false); }
    displayTracks();
    await fetch(`/api/songs/${currentSong.id}/track/${id}`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ muted: track.muted }) });
    socket.emit('track-update', { songId: currentSong.id, trackId: id, updates: { muted: track.muted } });
  }
}

async function adjustVolume(id, vol) {
  const track = currentSong.tracks.find(t => t.id === id);
  if (track) {
    track.volume = parseFloat(vol);
    const gain = gains.get(id);
    if (gain) gain.gain.value = track.volume;
    await fetch(`/api/songs/${currentSong.id}/track/${id}`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: track.volume }) });
  }
}

async function voteTrack(id, vote) {
  try {
    const res = await api.voteTrack(currentSong.id, id, vote);
    const track = currentSong.tracks.find(t => t.id === id);
    if (track) track.votes = res.votes;
    displayTracks();
  } catch(e) { alert('Error voting'); }
}

async function deleteTrack(id) {
  if (!confirm('Delete your track? Cannot undo.')) return;
  await api.deleteTrack(currentSong.id, id);
  currentSong = await api.getSong(currentSong.id);
  displayTracks();
  document.getElementById('record-btn').disabled = false;
  document.getElementById('upload-btn').disabled = false;
}

async function createSong() {
  const title = document.getElementById('new-title').value;
  let b = parseInt(document.getElementById('new-bpm').value);
  const genre = document.getElementById('new-genre').value;
  if (!title) return alert('Enter a title');
  b = Math.min(300, Math.max(40, b || 120));
  const song = await api.createSong({ title, bpm: b, genre });
  alert('Song created!');
  document.getElementById('create-modal').style.display = 'none';
  document.getElementById('new-title').value = '';
  loadSongs();
  selectSong(song.id);
}

async function uploadTrackFile() {
  const file = document.getElementById('audio-file').files[0];
  if (!file) return alert('Select a file');
  if (currentSong.tracks.some(t => t.username === currentUser.username)) return alert('You already have a track');
  await api.uploadTrack(currentSong.id, file);
  alert('Track uploaded!');
  currentSong = await api.getSong(currentSong.id);
  displayTracks();
  document.getElementById('record-btn').disabled = true;
  document.getElementById('upload-btn').disabled = true;
}

function backToLibrary() {
  if (isPlaying) stopPlayback();
  if (isRecording) stopRecording();
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  if (socket && currentSong) socket.emit('leave-song', currentSong.id);
  currentSong = null;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('.nav-item[data-view="library"]').classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('library-view').classList.add('active');
  loadSongs();
}

// Profile
async function loadProfile() {
  const container = document.getElementById('profile-content');
  try {
    const user = await api.getUser(currentUser.username);
    container.innerHTML = `
      <div class="profile-header">
        <img class="profile-avatar" src="${user.avatar}"><h2>${escape(user.username)}</h2>
        <p class="profile-bio">${escape(user.bio || 'Music creator on TrackStars')}</p>
        <button class="edit-profile-btn" id="edit-profile-btn">✏️ Edit Profile</button>
        <div class="stats-row"><div><span>${user.followers?.length || 0}</span><label>Followers</label></div><div><span>${user.following?.length || 0}</span><label>Following</label></div><div><span>${user.contributedTo?.length || 0}</span><label>Tracks</label></div></div>
      </div>
      <div><h3>My Tracks</h3><div id="my-tracks-list"></div></div>
    `;
    const songs = await api.getSongs();
    const mySongs = songs.filter(s => s.creator === currentUser.username);
    const tracksDiv = document.getElementById('my-tracks-list');
    if (!mySongs.length) tracksDiv.innerHTML = '<div class="loading">No tracks yet</div>';
    else tracksDiv.innerHTML = mySongs.map(s => `<div class="song-card" onclick="selectSong('${s.id}')"><img class="song-thumb" src="${s.thumbnail}"><div class="song-info"><div class="song-title">${escape(s.title)}</div><div class="song-stats">🎵 ${s.trackCount} tracks | 👍 ${s.likes}</div></div></div>`).join('');
    document.getElementById('edit-profile-btn').onclick = openProfileModal;
  } catch(e) { container.innerHTML = '<div class="loading">Error</div>'; }
}

async function openProfileModal() {
  const user = await api.getUser(currentUser.username);
  document.getElementById('edit-avatar').src = user.avatar;
  document.getElementById('edit-bio').value = user.bio || '';
  document.getElementById('edit-followers').textContent = user.followers?.length || 0;
  document.getElementById('edit-following').textContent = user.following?.length || 0;
  document.getElementById('edit-tracks').textContent = user.contributedTo?.length || 0;
  document.getElementById('profile-modal').style.display = 'flex';
}

async function saveProfile() {
  const bio = document.getElementById('edit-bio').value;
  await api.updateBio(bio);
  alert('Profile updated');
  document.getElementById('profile-modal').style.display = 'none';
  loadProfile();
}

async function uploadAvatar(file) {
  const res = await api.uploadAvatar(file);
  currentUser.avatar = res.avatar;
  document.getElementById('header-avatar').src = res.avatar;
  alert('Avatar updated');
}

// Chat
async function loadChatUsers() {
  const container = document.getElementById('chat-users');
  try {
    const users = await api.getUsers();
    const others = users.filter(u => u.username !== currentUser.username);
    if (!others.length) { container.innerHTML = '<div class="loading">No other users</div>'; return; }
    container.innerHTML = others.map(u => `<div class="chat-user" onclick="startChat('${u.username}')"><img src="${u.avatar}"><div><strong>${escape(u.username)}</strong><div style="font-size:11px;color:#888">${u.followersCount} followers</div></div></div>`).join('');
    document.getElementById('chat-conversation').style.display = 'none';
  } catch(e) { container.innerHTML = '<div class="loading">Error</div>'; }
}

async function startChat(username) {
  currentChatUser = username;
  document.getElementById('chat-users').style.display = 'none';
  document.getElementById('chat-conversation').style.display = 'flex';
  document.getElementById('chat-with').textContent = username;
  await loadConversation(username);
}

async function loadConversation(username) {
  const msgs = await api.getMessages(username);
  const container = document.getElementById('chat-messages');
  container.innerHTML = msgs.map(m => `<div class="message ${m.from === currentUser.username ? 'sent' : 'received'}"><div>${escape(m.text)}</div><div class="message-time">${new Date(m.timestamp).toLocaleTimeString()}</div></div>`).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;
  await api.sendMessage(currentChatUser, text);
  input.value = '';
  await loadConversation(currentChatUser);
}

function backToUsers() {
  document.getElementById('chat-conversation').style.display = 'none';
  document.getElementById('chat-users').style.display = 'block';
  currentChatUser = null;
}

// View other user profile
async function viewUser(username) {
  try {
    const user = await api.getUser(username);
    const isFollowing = currentUser.following?.includes(username);
    const modal = document.getElementById('user-modal');
    document.getElementById('user-modal-content').innerHTML = `
      <div class="user-profile-detail">
        <img class="view-avatar" src="${user.avatar}">
        <h2>${escape(user.username)}</h2>
        <p class="view-bio">${escape(user.bio || 'Music creator')}</p>
        <div><button class="follow-btn ${isFollowing ? 'following' : ''}" onclick="followUser('${username}', this)">${isFollowing ? 'Following' : 'Follow'}</button>
        <button class="message-btn" onclick="startChat('${username}'); document.getElementById('user-modal').style.display = 'none';">💬 Message</button></div>
        <div class="stats-row"><div><span>${user.followers?.length || 0}</span><label>Followers</label></div><div><span>${user.following?.length || 0}</span><label>Following</label></div><div><span>${user.contributedTo?.length || 0}</span><label>Tracks</label></div></div>
        <div><h4>🎵 Tracks</h4><div id="user-tracks-list"></div></div>
      </div>
    `;
    const songs = await api.getSongs();
    const userSongs = songs.filter(s => user.contributedTo?.includes(s.id) || s.creator === username);
    const tracksDiv = document.getElementById('user-tracks-list');
    if (!userSongs.length) tracksDiv.innerHTML = '<div style="color:#888;text-align:center">No tracks yet</div>';
    else tracksDiv.innerHTML = userSongs.map(s => `<div class="song-card" onclick="selectSong('${s.id}'); document.getElementById('user-modal').style.display = 'none';"><img class="song-thumb" src="${s.thumbnail}"><div class="song-info"><div class="song-title">${escape(s.title)}</div><div class="song-stats">🎵 ${s.trackCount} tracks</div></div></div>`).join('');
    modal.style.display = 'flex';
  } catch(e) { alert('Error loading profile'); }
}

async function followUser(username, btn) {
  const res = await api.followUser(username);
  if (res.following) { btn.textContent = 'Following'; btn.classList.add('following'); }
  else { btn.textContent = 'Follow'; btn.classList.remove('following'); }
  if (res.following && !currentUser.following.includes(username)) currentUser.following.push(username);
  else if (!res.following) currentUser.following = currentUser.following.filter(u => u !== username);
}

// Socket
function initSocket() {
  socket = io();
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('track-added', async data => { if (currentSong?.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); });
  socket.on('track-deleted', async data => { if (currentSong?.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); });
  socket.on('track-updated', data => { if (currentSong) { const t = currentSong.tracks.find(tr => tr.id === data.trackId); if (t && data.updates) { if (data.updates.muted !== undefined) t.muted = data.updates.muted; if (data.updates.volume !== undefined) t.volume = data.updates.volume; displayTracks(); } } });
  socket.on('transport-state', state => { if (state.bpm && state.bpm !== bpm && currentSong) { bpm = state.bpm; document.getElementById('bpm-input').value = bpm; } });
  socket.on('user-recording', data => alert(`${data.username} is recording...`));
  socket.on('new-message', msg => { if (currentChatUser === msg.from) loadConversation(msg.from); alert(`New message from ${msg.from}`); });
  socket.emit('join-chat', currentUser.username);
}

// Navigation
function initNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(`${view}-view`).classList.add('active');
      if (view === 'profile') loadProfile();
      if (view === 'social') loadChatUsers();
      if (view === 'library') loadSongs();
    };
  });
}

// Event Listeners
function setupListeners() {
  document.querySelectorAll('.auth-tab').forEach(t => t.onclick = () => {
    const tab = t.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(tt => tt.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(`${tab}-form`).classList.add('active');
  });
  document.getElementById('login-form').onsubmit = async e => {
    e.preventDefault();
    try { await login(document.getElementById('login-username').value, document.getElementById('login-password').value);
      document.getElementById('auth-modal').style.display = 'none';
      document.getElementById('main-app').style.display = 'block';
      document.getElementById('current-user').textContent = currentUser.username;
      document.getElementById('header-avatar').src = currentUser.avatar;
      initSocket(); loadSongs(); initNav();
    } catch(err) { document.getElementById('login-error').textContent = err.message; }
  };
  document.getElementById('register-form').onsubmit = async e => {
    e.preventDefault();
    try { await register(document.getElementById('reg-username').value, document.getElementById('reg-email').value, document.getElementById('reg-password').value, document.getElementById('reg-confirm').value);
      document.getElementById('auth-modal').style.display = 'none';
      document.getElementById('main-app').style.display = 'block';
      document.getElementById('current-user').textContent = currentUser.username;
      document.getElementById('header-avatar').src = currentUser.avatar;
      initSocket(); loadSongs(); initNav();
    } catch(err) { document.getElementById('register-error').textContent = err.message; }
  };
  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('header-avatar').onclick = openProfileModal;
  document.querySelector('.username').onclick = openProfileModal;
  document.querySelector('.close-modal').onclick = () => document.getElementById('profile-modal').style.display = 'none';
  document.getElementById('save-profile').onclick = saveProfile;
  document.getElementById('change-avatar').onclick = () => document.getElementById('avatar-file').click();
  document.getElementById('avatar-file').onchange = e => { if (e.target.files[0]) uploadAvatar(e.target.files[0]); };
  document.getElementById('open-create-modal').onclick = () => document.getElementById('create-modal').style.display = 'flex';
  document.getElementById('confirm-create').onclick = createSong;
  document.getElementById('cancel-create').onclick = () => document.getElementById('create-modal').style.display = 'none';
  document.getElementById('random-thumb').onclick = () => { const title = document.getElementById('new-title').value || 'track'; document.getElementById('thumb-preview').src = `https://ui-avatars.com/api/?background=${Math.floor(Math.random()*16777215).toString(16)}&color=fff&size=200&name=${encodeURIComponent(title.substring(0,2))}`; };
  document.getElementById('play-btn').onclick = () => isPlaying ? pausePlayback() : startPlayback(false);
  document.getElementById('stop-btn').onclick = stopPlayback;
  document.getElementById('bpm-input').onchange = e => setBpm(parseInt(e.target.value));
  document.getElementById('record-btn').onclick = startRecordingWithPlayback;
  document.getElementById('stop-record-btn').onclick = stopRecordingAndPlayback;
  document.getElementById('upload-btn').onclick = () => document.getElementById('audio-file').click();
  document.getElementById('audio-file').onchange = uploadTrackFile;
  document.getElementById('back-btn').onclick = backToLibrary;
  document.getElementById('metronome-toggle').onchange = e => { metronomeOn = e.target.checked; if (isRecording && !countInActive) metronomeOn ? startMetronome() : stopMetronome(); };
  document.getElementById('countin-toggle').onchange = e => countInOn = e.target.checked;
  document.getElementById('back-to-users').onclick = backToUsers;
  document.getElementById('send-chat').onclick = sendChatMessage;
  document.getElementById('chat-input').onkeypress = e => { if (e.key === 'Enter') sendChatMessage(); };
  document.querySelector('.close-user-modal').onclick = () => document.getElementById('user-modal').style.display = 'none';
  document.getElementById('user-modal').onclick = e => { if (e.target === document.getElementById('user-modal')) document.getElementById('user-modal').style.display = 'none'; };
  document.getElementById('profile-modal').onclick = e => { if (e.target === document.getElementById('profile-modal')) document.getElementById('profile-modal').style.display = 'none'; };
  document.getElementById('create-modal').onclick = e => { if (e.target === document.getElementById('create-modal')) document.getElementById('create-modal').style.display = 'none'; };
}

function setBpm(newBpm) {
  bpm = Math.min(300, Math.max(40, newBpm));
  if (isRecording && !countInActive) { stopMetronome(); startMetronome(); }
  socket.emit('transport-control', { songId: currentSong?.id, action: 'setBpm', bpm });
}

function escape(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

// Initialize
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
    initNav();
    setupListeners();
  } else {
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
    setupListeners();
  }
});

// Global functions
window.selectSong = selectSong;
window.toggleMute = toggleMute;
window.adjustVolume = adjustVolume;
window.voteTrack = voteTrack;
window.deleteTrack = deleteTrack;
window.viewUser = viewUser;
window.followUser = followUser;
window.startChat = startChat;