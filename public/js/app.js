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

  async getSongs() {
    return this.request('/api/songs');
  },

  async getSong(id) {
    return this.request(`/api/songs/${id}`);
  },

  async createSong(data) {
    return this.request('/api/songs', { method: 'POST', body: JSON.stringify(data) });
  },

  async uploadTrack(songId, file) {
    const formData = new FormData();
    formData.append('audio', file);
    const response = await fetch(`/api/songs/${songId}/track`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }
    return response.json();
  },

  async deleteTrack(songId, trackId) {
    return this.request(`/api/songs/${songId}/track/${trackId}`, { method: 'DELETE' });
  },

  async voteTrack(songId, trackId, vote) {
    return this.request(`/api/songs/${songId}/track/${trackId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ vote })
    });
  },

  async addComment(songId, text) {
    return this.request(`/api/songs/${songId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  }
};

// Auth functions
async function register(username, email, password, confirm) {
  if (password !== confirm) {
    throw new Error('Passwords do not match');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
  
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
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (currentAudioContext) {
    currentAudioContext.close();
    currentAudioContext = null;
  }
  token = null;
  currentUser = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.reload();
}

// Audio functions
async function initAudioContext() {
  if (currentAudioContext) return currentAudioContext;
  currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  return currentAudioContext;
}

async function loadTrackAudio(audioUrl) {
  const response = await fetch(audioUrl);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await currentAudioContext.decodeAudioData(arrayBuffer);
  return audioBuffer;
}

async function loadAllTracks() {
  if (!currentSong) return;
  currentBuffers.clear();
  for (const track of currentSong.tracks) {
    try {
      const buffer = await loadTrackAudio(track.audioUrl);
      currentBuffers.set(track.id, buffer);
    } catch (error) {
      console.error(`Failed to load track ${track.id}:`, error);
    }
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
  if (recordMode && userHasTrack) {
    showToast('You already have a track in this song!');
    return false;
  }
  
  await loadAllTracks();
  if (currentAudioContext.state === 'suspended') {
    await currentAudioContext.resume();
  }
  
  isPlaying = true;
  startTime = currentAudioContext.currentTime - currentPosition;
  
  for (const track of currentSong.tracks) {
    if (!track.muted) {
      scheduleTrack(track, currentPosition);
    }
  }
  
  if (recordMode) {
    await startAudioRecording();
  }
  
  updateTransportUI('play');
  socket.emit('transport-control', {
    songId: currentSong.id,
    action: 'play',
    position: currentPosition,
    bpm: bpm
  });
  startPositionTimer();
  return true;
}

function pausePlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  
  if (isRecording) {
    stopAudioRecording();
  }
  
  for (const source of currentSources) {
    try { source.stop(); } catch(e) {}
  }
  currentSources = [];
  currentGains.clear();
  
  currentPosition = currentAudioContext.currentTime - startTime;
  updateTransportUI('pause');
  socket.emit('transport-control', {
    songId: currentSong.id,
    action: 'pause',
    position: currentPosition,
    bpm: bpm
  });
  stopPositionTimer();
}

function stopPlayback() {
  if (isPlaying) {
    if (isRecording) {
      stopAudioRecording();
    }
    pausePlayback();
  }
  currentPosition = 0;
  updatePositionDisplay(0);
  socket.emit('transport-control', {
    songId: currentSong.id,
    action: 'stop',
    position: 0,
    bpm: bpm
  });
}

async function startAudioRecording() {
  try {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStream = stream;
    
    const mimeTypes = ['audio/webm', 'audio/mp4', 'audio/wav'];
    let mimeType = '';
    for (const type of mimeTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        break;
      }
    }
    
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      if (audioChunks.length === 0) {
        document.getElementById('recording-status').innerHTML = '❌ No audio was recorded';
        return;
      }
      
      const audioBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
      const timestamp = Date.now();
      const fileName = `recording-${timestamp}.${mimeType.includes('webm') ? 'webm' : 'mp4'}`;
      const file = new File([audioBlob], fileName, { type: mimeType || 'audio/webm' });
      
      document.getElementById('recording-status').innerHTML = '📤 Uploading recording...';
      document.getElementById('recording-status').style.color = '#3498db';
      
      try {
        let uploadSuccess = false;
        let retries = 3;
        
        while (!uploadSuccess && retries > 0) {
          try {
            await api.uploadTrack(currentSong.id, file);
            uploadSuccess = true;
            showToast('Recording uploaded successfully!');
            await new Promise(resolve => setTimeout(resolve, 500));
            currentSong = await api.getSong(currentSong.id);
            displayTracks();
            document.getElementById('recording-status').innerHTML = '✅ Recording saved!';
            document.getElementById('recording-status').style.color = '#27ae60';
            document.getElementById('record-btn').disabled = true;
            document.getElementById('upload-btn').disabled = true;
            setTimeout(() => {
              if (document.getElementById('recording-status').innerHTML === '✅ Recording saved!') {
                document.getElementById('recording-status').innerHTML = '';
              }
            }, 3000);
          } catch (error) {
            retries--;
            console.error(`Upload failed, ${retries} retries left:`, error);
            if (retries === 0) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } catch (error) {
        console.error('Upload error:', error);
        document.getElementById('recording-status').innerHTML = '❌ Failed to upload: ' + error.message;
        document.getElementById('recording-status').style.color = '#e74c3c';
      }
      
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }
      audioChunks = [];
    };
    
    mediaRecorder.start(1000);
    isRecording = true;
    document.getElementById('record-btn').style.display = 'none';
    document.getElementById('stop-record-btn').style.display = 'inline-block';
    document.getElementById('recording-status').innerHTML = '🔴 RECORDING - Playing all tracks while you record...';
    document.getElementById('recording-status').style.color = '#e74c3c';
    socket.emit('recording-started', { songId: currentSong.id, username: currentUser.username });
  } catch (error) {
    console.error('Microphone error:', error);
    let errorMsg = 'Could not access microphone. ';
    if (error.name === 'NotAllowedError') {
      errorMsg += 'Please allow microphone access.';
    } else if (error.name === 'NotFoundError') {
      errorMsg += 'No microphone found.';
    } else {
      errorMsg += 'Please check microphone permissions.';
    }
    showToast(errorMsg);
    document.getElementById('recording-status').innerHTML = '❌ ' + errorMsg;
    document.getElementById('recording-status').style.color = '#e74c3c';
    document.getElementById('record-btn').style.display = 'inline-block';
    document.getElementById('stop-record-btn').style.display = 'none';
    if (isPlaying) {
      pausePlayback();
    }
  }
}

function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    isRecording = false;
  }
  document.getElementById('record-btn').style.display = 'inline-block';
  document.getElementById('stop-record-btn').style.display = 'none';
  socket.emit('recording-stopped', { songId: currentSong.id, username: currentUser.username });
}

async function startRecordingWithPlayback() {
  if (!currentSong) {
    showToast('Please select a song first');
    return;
  }
  if (isRecording) {
    showToast('Already recording!');
    return;
  }
  const userHasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
  if (userHasTrack) {
    showToast('You already have a track in this song!');
    return;
  }
  if (isPlaying) {
    stopPlayback();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  currentPosition = 0;
  updatePositionDisplay(0);
  await new Promise(resolve => setTimeout(resolve, 100));
  await startPlayback(true);
}

function stopRecordingAndPlayback() {
  if (isRecording) {
    stopAudioRecording();
  }
  if (isPlaying) {
    stopPlayback();
  }
}

async function deleteTrack(trackId) {
  if (!currentSong) return;
  const track = currentSong.tracks.find(t => t.id === trackId);
  if (!track) return;
  if (track.username !== currentUser.username) {
    showToast('You can only delete your own tracks!');
    return;
  }
  const confirmed = confirm('Are you sure you want to delete your track? This cannot be undone.');
  if (!confirmed) return;
  
  try {
    await api.deleteTrack(currentSong.id, trackId);
    showToast('Your track has been deleted!');
    await new Promise(resolve => setTimeout(resolve, 500));
    currentSong = await api.getSong(currentSong.id);
    displayTracks();
    document.getElementById('record-btn').disabled = false;
    document.getElementById('upload-btn').disabled = false;
    document.getElementById('recording-status').innerHTML = 'Your track was deleted. You can now add a new one!';
    document.getElementById('recording-status').style.color = '#f39c12';
    setTimeout(() => {
      if (document.getElementById('recording-status').innerHTML.includes('deleted')) {
        document.getElementById('recording-status').innerHTML = '';
      }
    }, 3000);
  } catch (error) {
    console.error('Delete error:', error);
    showToast('Error deleting track: ' + error.message);
  }
}

function startPositionTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isPlaying) {
      const position = currentAudioContext.currentTime - startTime;
      updatePositionDisplay(position);
    }
  }, 50);
}

function stopPositionTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updatePositionDisplay(position) {
  const minutes = Math.floor(position / 60);
  const seconds = Math.floor(position % 60);
  const milliseconds = Math.floor((position % 1) * 100);
  document.getElementById('position-display').textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${milliseconds.toString().padStart(2, '0')}`;
}

function updateTransportUI(action) {
  const playBtn = document.getElementById('play-btn');
  if (action === 'play') {
    playBtn.textContent = '⏸️ Pause';
    playBtn.className = 'pause-btn';
  } else {
    playBtn.textContent = '▶ Play';
    playBtn.className = 'play-btn';
  }
}

function setBpm(newBpm) {
  if (newBpm < 40) newBpm = 40;
  if (newBpm > 300) newBpm = 300;
  bpm = newBpm;
  socket.emit('transport-control', {
    songId: currentSong.id,
    action: 'setBpm',
    bpm: bpm
  });
}

async function loadSongs() {
  if (isRefreshing) return;
  try {
    const songs = await api.getSongs();
    displaySongList(songs);
  } catch (error) {
    console.error('Error loading songs:', error);
    setTimeout(() => loadSongs(), 2000);
  }
}

function displaySongList(songs) {
  const container = document.getElementById('song-list');
  if (songs.length === 0) {
    container.innerHTML = '<div class="loading">No tracks yet. Create the first one!</div>';
    return;
  }
  
  container.innerHTML = songs.map(song => `
    <div class="song-card ${song.isFeatured ? 'featured' : ''}" onclick="selectSong('${song.id}')">
      <div class="song-title">${escapeHtml(song.title)} ${song.isFeatured ? '⭐' : ''}</div>
      <div class="song-creator">by ${escapeHtml(song.creator)}</div>
      <div class="song-stats">
        <span>🎵 ${song.trackCount} tracks</span>
        <span>👍 ${song.likes || 0} likes</span>
        <span>🎧 ${song.totalContributors} contributors</span>
      </div>
    </div>
  `).join('');
}

async function selectSong(songId) {
  if (isRefreshing) return;
  try {
    isRefreshing = true;
    
    if (isPlaying) stopPlayback();
    if (isRecording) stopAudioRecording();
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    if (currentAudioContext) {
      await currentAudioContext.close();
      currentAudioContext = null;
    }
    currentBuffers.clear();
    currentSources = [];
    currentGains.clear();
    
    currentSong = await api.getSong(songId);
    
    document.getElementById('current-song-title').textContent = currentSong.title;
    document.getElementById('song-creator').textContent = `Created by ${currentSong.creator} • ${currentSong.genre} • ${currentSong.bpm} BPM`;
    document.getElementById('bpm-input').value = currentSong.bpm;
    bpm = currentSong.bpm;
    
    socket.emit('join-song', songId);
    displayTracks();
    
    const userTrack = currentSong.tracks.find(t => t.username === currentUser.username);
    if (userTrack) {
      document.getElementById('record-btn').disabled = true;
      document.getElementById('upload-btn').disabled = true;
      document.getElementById('recording-status').innerHTML = '✅ You have already contributed to this song!';
      document.getElementById('recording-status').style.color = '#27ae60';
    } else {
      document.getElementById('record-btn').disabled = false;
      document.getElementById('upload-btn').disabled = false;
      document.getElementById('recording-status').innerHTML = '';
    }
    
    isPlaying = false;
    currentPosition = 0;
    updatePositionDisplay(0);
    
    // Switch to studio view
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.querySelector('.nav-item[data-view="studio"]').classList.add('active');
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('studio-view').classList.add('active');
    
  } catch (error) {
    console.error('Error loading song:', error);
    showToast('Error loading song: ' + error.message);
  } finally {
    isRefreshing = false;
  }
}

function displayTracks() {
  const container = document.getElementById('track-mixer');
  const tracks = currentSong.tracks;
  
  if (tracks.length === 0) {
    container.innerHTML = '<div class="loading">No tracks yet. Be the first to add your sound!</div>';
    return;
  }
  
  container.innerHTML = tracks.map((track, index) => {
    const isCurrentUserTrack = track.username === currentUser?.username;
    return `
      <div class="track-card ${track.muted ? 'muted' : ''}" data-track-id="${track.id}">
        <div class="track-info">
          <div>
            <span class="track-name">🎧 ${escapeHtml(track.username)}${isCurrentUserTrack ? '<span class="your-track"> (Your Track)</span>' : ''}</span>
            <div class="track-creator">Added ${new Date(track.uploadedAt).toLocaleDateString()}</div>
          </div>
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
    if (isPlaying) {
      const currentPos = currentPosition;
      pausePlayback();
      currentPosition = currentPos;
      startPlayback(false);
    }
    socket.emit('track-update', {
      songId: currentSong.id,
      trackId: trackId,
      updates: { muted: track.muted }
    });
  }
}

function adjustVolume(trackId, volume) {
  const track = currentSong.tracks.find(t => t.id === trackId);
  if (track) {
    track.volume = parseFloat(volume);
    const gain = currentGains.get(trackId);
    if (gain) {
      gain.gain.value = track.volume;
    }
    socket.emit('track-update', {
      songId: currentSong.id,
      trackId: trackId,
      updates: { volume: track.volume }
    });
  }
}

async function voteTrack(trackId, vote) {
  try {
    const result = await api.voteTrack(currentSong.id, trackId, vote);
    const track = currentSong.tracks.find(t => t.id === trackId);
    if (track) track.votes = result.votes;
    displayTracks();
  } catch (error) {
    console.error('Vote error:', error);
    showToast('Error voting: ' + error.message);
  }
}

async function toggleTrackFX(trackId, fxName) {
  const track = currentSong?.tracks.find(t => t.id === trackId);
  if (!track) return;
  
  if (!track.fx) track.fx = {};
  track.fx[fxName] = !track.fx[fxName];
  
  displayTracks();
  
  try {
    await fetch(`/api/songs/${currentSong.id}/fx`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId, fx: { [fxName]: track.fx[fxName] } })
    });
  } catch (error) {
    console.error('FX error:', error);
  }
}

async function createSong() {
  const title = document.getElementById('new-song-title').value;
  let bpm = parseInt(document.getElementById('new-song-bpm').value);
  const genre = document.getElementById('new-song-genre').value;
  
  if (!title) {
    showToast('Please enter a song title');
    return;
  }
  if (isNaN(bpm)) bpm = 120;
  if (bpm < 40) bpm = 40;
  if (bpm > 300) bpm = 300;
  
  try {
    const newSong = await api.createSong({ title, bpm, genre });
    showToast('Song created successfully!');
    document.getElementById('create-modal').style.display = 'none';
    document.getElementById('new-song-title').value = '';
    document.getElementById('new-song-bpm').value = '120';
    await new Promise(resolve => setTimeout(resolve, 500));
    await selectSong(newSong.id);
    loadSongs();
  } catch (error) {
    console.error('Create song error:', error);
    showToast('Error creating song: ' + error.message);
  }
}

function backToLibrary() {
  if (isPlaying) stopPlayback();
  if (isRecording) stopAudioRecording();
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (currentAudioContext) {
    currentAudioContext.close();
    currentAudioContext = null;
  }
  currentBuffers.clear();
  currentSources = [];
  currentGains.clear();
  
  if (socket && currentSong) {
    socket.emit('leave-song', currentSong.id);
  }
  currentSong = null;
  isPlaying = false;
  currentPosition = 0;
  
  // Switch to library view
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelector('.nav-item[data-view="library"]').classList.add('active');
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.getElementById('library-view').classList.add('active');
  
  loadSongs();
}

async function uploadTrack() {
  const fileInput = document.getElementById('audio-file');
  const file = fileInput.files[0];
  
  if (!file) {
    showToast('Please select an audio file');
    return;
  }
  
  if (file.size > 50 * 1024 * 1024) {
    showToast('File too large! Maximum size is 50MB.');
    return;
  }
  
  if (currentSong.tracks.some(t => t.username === currentUser.username)) {
    showToast('You already have a track in this song!');
    return;
  }
  
  document.getElementById('recording-status').innerHTML = '📤 Uploading...';
  document.getElementById('recording-status').style.color = '#3498db';
  
  try {
    let uploadSuccess = false;
    let retries = 3;
    
    while (!uploadSuccess && retries > 0) {
      try {
        await api.uploadTrack(currentSong.id, file);
        uploadSuccess = true;
        showToast('Track uploaded successfully!');
        fileInput.value = '';
        await new Promise(resolve => setTimeout(resolve, 500));
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        document.getElementById('recording-status').innerHTML = '✅ Upload complete!';
        document.getElementById('recording-status').style.color = '#27ae60';
        document.getElementById('record-btn').disabled = true;
        document.getElementById('upload-btn').disabled = true;
        setTimeout(() => {
          if (document.getElementById('recording-status').innerHTML === '✅ Upload complete!') {
            document.getElementById('recording-status').innerHTML = '';
          }
        }, 3000);
      } catch (error) {
        retries--;
        console.error(`Upload failed, ${retries} retries left:`, error);
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    console.error('Upload error:', error);
    document.getElementById('recording-status').innerHTML = '❌ Upload failed: ' + error.message;
    document.getElementById('recording-status').style.color = '#e74c3c';
    showToast('Failed to upload track: ' + error.message);
  }
}

// Profile functions
async function loadProfile() {
  const container = document.getElementById('profile-content');
  if (!container) return;
  
  try {
    const response = await fetch(`/api/users/${currentUser.username}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const user = await response.json();
    
    container.innerHTML = `
      <div class="profile-header">
        <img src="${user.avatar}" class="profile-avatar" alt="${user.username}">
        <h2>${escapeHtml(user.username)}</h2>
        <p class="profile-bio">${user.bio || 'Music creator on TrackStars'}</p>
        <div class="stats">
          <div class="stat">
            <div class="stat-number">${user.followers?.length || 0}</div>
            <div class="stat-label">Followers</div>
          </div>
          <div class="stat">
            <div class="stat-number">${user.following?.length || 0}</div>
            <div class="stat-label">Following</div>
          </div>
          <div class="stat">
            <div class="stat-number">${user.contributedTo?.length || 0}</div>
            <div class="stat-label">Tracks</div>
          </div>
        </div>
      </div>
      <h3>My Tracks</h3>
      <div class="song-grid" id="user-songs">
        <div class="loading">Loading tracks...</div>
      </div>
    `;
    
    const songs = await api.getSongs();
    const userSongs = songs.filter(s => s.creator === user.username || user.contributedTo?.includes(s.id));
    const userSongsContainer = document.getElementById('user-songs');
    if (userSongsContainer) {
      userSongsContainer.innerHTML = userSongs.map(song => `
        <div class="song-card" onclick="selectSong('${song.id}')">
          <div class="song-title">${escapeHtml(song.title)}</div>
          <div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.likes || 0}</div>
        </div>
      `).join('') || '<div class="loading">No tracks yet</div>';
    }
  } catch (error) {
    console.error('Error loading profile:', error);
    container.innerHTML = '<div class="loading">Error loading profile</div>';
  }
}

// Messages functions
async function loadMessages() {
  const messagesList = document.getElementById('messages-list');
  if (!messagesList) return;
  
  try {
    const response = await fetch('/api/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const users = await response.json();
    const otherUsers = users.filter(u => u.username !== currentUser.username);
    
    messagesList.innerHTML = `
      <h3 style="margin-bottom: 16px;">Chat with Creators</h3>
      <div class="song-grid" id="user-list">
        ${otherUsers.map(user => `
          <div class="song-card" onclick="selectUserToMessage('${user.username}')">
            <div class="song-title">${escapeHtml(user.username)}</div>
            <div class="song-creator">${user.followersCount} followers • Click to message</div>
          </div>
        `).join('') || '<div class="loading">No other users yet</div>'}
      </div>
    `;
  } catch (error) {
    console.error('Error loading users:', error);
    messagesList.innerHTML = '<div class="loading">Error loading users</div>';
  }
}

window.selectUserToMessage = async function(username) {
  const messagesList = document.getElementById('messages-list');
  if (!messagesList) return;
  
  messagesList.innerHTML = `
    <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
      <button class="back-btn" onclick="loadMessages()">← Back</button>
      <h3>Chat with ${escapeHtml(username)}</h3>
    </div>
    <div id="chat-messages" style="flex: 1; overflow-y: auto; max-height: 60vh; margin-bottom: 16px;"></div>
    <div class="message-input-area">
      <input type="text" class="message-input" id="chat-input" placeholder="Type a message...">
      <button class="send-btn" onclick="sendMessage('${username}')">Send</button>
    </div>
  `;
  
  try {
    const response = await fetch(`/api/messages/${username}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const messages = await response.json();
    
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
      chatMessages.innerHTML = messages.map(msg => `
        <div class="message ${msg.from === currentUser.username ? 'sent' : 'received'}">
          <div class="message-bubble">
            <strong>${escapeHtml(msg.from)}</strong><br>
            ${escapeHtml(msg.text)}
            <div style="font-size: 10px; color: #888; margin-top: 4px;">${new Date(msg.timestamp).toLocaleTimeString()}</div>
          </div>
        </div>
      `).join('');
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  } catch (error) {
    console.error('Error loading messages:', error);
  }
};

window.sendMessage = async function(to) {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text) return;
  
  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text })
    });
    
    if (response.ok) {
      input.value = '';
      selectUserToMessage(to);
    }
  } catch (error) {
    console.error('Error sending message:', error);
    showToast('Error sending message');
  }
};

// Socket functions
function initSocket() {
  socket = io();
  
  socket.on('connect', () => {
    console.log('Socket connected');
  });
  
  socket.on('track-added', async (data) => {
    if (currentSong && currentSong.id === data.songId) {
      currentSong = await api.getSong(currentSong.id);
      displayTracks();
    }
  });
  
  socket.on('track-deleted', async (data) => {
    if (currentSong && currentSong.id === data.songId) {
      currentSong = await api.getSong(currentSong.id);
      displayTracks();
      showToast(`${data.username} deleted their track`);
    }
  });
  
  socket.on('track-updated', (data) => {
    if (currentSong) {
      const track = currentSong.tracks.find(t => t.id === data.trackId);
      if (track && data.updates) {
        if (data.updates.muted !== undefined) track.muted = data.updates.muted;
        if (data.updates.volume !== undefined) track.volume = data.updates.volume;
        if (data.updates.fx !== undefined) track.fx = data.updates.fx;
        displayTracks();
      }
    }
  });
  
  socket.on('track-voted', (data) => {
    if (currentSong) {
      const track = currentSong.tracks.find(t => t.id === data.trackId);
      if (track) track.votes = data.votes;
      displayTracks();
    }
  });
  
  socket.on('transport-state', (state) => {
    if (!currentSong) return;
    if (state.bpm && state.bpm !== bpm) {
      bpm = state.bpm;
      document.getElementById('bpm-input').value = bpm;
    }
  });
  
  socket.on('user-recording', (data) => {
    showToast(`${data.username} is recording...`);
  });
  
  socket.on('new-message', (message) => {
    if (document.getElementById('chat-messages')) {
      showToast(`New message from ${message.from}`);
    }
  });
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message, duration = 3000) {
  let toast = document.querySelector('.toast');
  if (toast) toast.remove();
  
  toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, duration);
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
      if (viewName === 'social') loadMessages();
      if (viewName === 'library') loadSongs();
    });
  });
}

// Event listeners
function setupEventListeners() {
  // Auth tabs
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tabName}-form`).classList.add('active');
    });
  });
  
  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');
    
    try {
      await login(username, password);
      document.getElementById('auth-modal').style.display = 'none';
      document.getElementById('main-app').style.display = 'block';
      document.getElementById('current-user').textContent = currentUser.username;
      initSocket();
      loadSongs();
      initMobileNavigation();
    } catch (error) {
      errorDiv.textContent = error.message;
    }
  });
  
  // Register form
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;
    const errorDiv = document.getElementById('register-error');
    
    try {
      await register(username, email, password, confirm);
      document.getElementById('auth-modal').style.display = 'none';
      document.getElementById('main-app').style.display = 'block';
      document.getElementById('current-user').textContent = currentUser.username;
      initSocket();
      loadSongs();
      initMobileNavigation();
    } catch (error) {
      errorDiv.textContent = error.message;
    }
  });
  
  // Logout
  document.getElementById('logout-btn').addEventListener('click', logout);
  
  // Create modal
  document.getElementById('open-create-modal').addEventListener('click', () => {
    document.getElementById('create-modal').style.display = 'flex';
  });
  document.getElementById('confirm-create').addEventListener('click', createSong);
  document.getElementById('cancel-create').addEventListener('click', () => {
    document.getElementById('create-modal').style.display = 'none';
  });
  
  // Transport controls
  document.getElementById('play-btn').addEventListener('click', () => {
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback(false);
    }
  });
  document.getElementById('stop-btn').addEventListener('click', stopPlayback);
  
  const bpmInput = document.getElementById('bpm-input');
  if (bpmInput) {
    bpmInput.addEventListener('change', (e) => {
      let newBpm = parseInt(e.target.value);
      if (isNaN(newBpm)) newBpm = 120;
      if (newBpm < 40) newBpm = 40;
      if (newBpm > 300) newBpm = 300;
      bpmInput.value = newBpm;
      setBpm(newBpm);
    });
  }
  
  // Recording
  document.getElementById('record-btn').addEventListener('click', startRecordingWithPlayback);
  document.getElementById('stop-record-btn').addEventListener('click', stopRecordingAndPlayback);
  document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('audio-file').click();
  });
  document.getElementById('audio-file').addEventListener('change', uploadTrack);
  document.getElementById('back-btn').addEventListener('click', backToLibrary);
  
  // Modal close on outside click
  const modal = document.getElementById('create-modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });
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

// Make functions global for onclick handlers
window.selectSong = selectSong;
window.toggleMute = toggleMute;
window.adjustVolume = adjustVolume;
window.voteTrack = voteTrack;
window.deleteTrack = deleteTrack;
window.toggleTrackFX = toggleTrackFX;
window.selectUserToMessage = selectUserToMessage;
window.sendMessage = sendMessage;
window.loadMessages = loadMessages;
window.loadProfile = loadProfile;