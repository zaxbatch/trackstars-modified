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

  async getSongs() {
    return this.request('/api/songs');
  },

  async getSong(id) {
    return this.request(`/api/songs/${id}`);
  },

  async createSong(data) {
    return this.request('/api/songs', { method: 'POST', body: JSON.stringify(data) });
  },

  async updateSongThumbnail(songId, thumbnail) {
    return this.request(`/api/songs/${songId}/thumbnail`, { method: 'PUT', body: JSON.stringify({ thumbnail }) });
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
  },

  async followUser(username) {
    return this.request(`/api/users/${username}/follow`, { method: 'POST' });
  },

  async updateBio(bio) {
    return this.request('/api/users/bio', { method: 'PUT', body: JSON.stringify({ bio }) });
  },

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    const response = await fetch('/api/upload-avatar', {
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

  async getCommunityFeed() {
    return this.request('/api/feed/community');
  },

  async getFollowingFeed() {
    return this.request('/api/feed/following');
  }
};

// Generate random thumbnail
function generateRandomThumbnail(title) {
  const colors = [
    '667eea', '764ba2', 'f39c12', 'e74c3c', '27ae60', '3498db', 
    '1abc9c', 'e67e22', '9b59b6', '2c3e50', '16a085', 'c0392b',
    '8e44ad', 'd35400', '7f8c8d', '2ecc71', 'e84393', '6c5ce7'
  ];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const encodedTitle = encodeURIComponent(title.substring(0, 20));
  return `https://ui-avatars.com/api/?background=${color}&color=fff&size=200&fontsize=80&length=2&name=${encodedTitle}`;
}

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
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (countInInterval) clearInterval(countInInterval);
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

// Play metronome click
function playMetronomeClick() {
  if (!metronomeEnabled && !countInActive) return;
  
  if (!metronomeContext) {
    metronomeContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  
  const oscillator = metronomeContext.createOscillator();
  const gain = metronomeContext.createGain();
  
  oscillator.connect(gain);
  gain.connect(metronomeContext.destination);
  
  if (countInActive) {
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
    if (isRecording && !countInActive) {
      playMetronomeClick();
    }
  }, beatInterval);
}

function stopMetronome() {
  if (metronomeInterval) {
    clearInterval(metronomeInterval);
    metronomeInterval = null;
  }
}

// Count-in function
async function startCountIn() {
  return new Promise((resolve) => {
    countInActive = true;
    let count = 3;
    const countinDisplay = document.getElementById('countin-display');
    const countinNumber = document.getElementById('countin-number');
    const countinProgressBar = document.getElementById('countin-progress-bar');
    
    countinDisplay.style.display = 'block';
    countinNumber.textContent = count;
    countinProgressBar.style.width = '0%';
    
    const playCountSound = (num) => {
      if (!metronomeContext) {
        metronomeContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      const oscillator = metronomeContext.createOscillator();
      const gain = metronomeContext.createGain();
      
      oscillator.connect(gain);
      gain.connect(metronomeContext.destination);
      
      if (num === 1) {
        oscillator.frequency.value = 660;
        gain.gain.value = 0.5;
      } else {
        oscillator.frequency.value = 880;
        gain.gain.value = 0.4;
      }
      
      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(0.00001, metronomeContext.currentTime + 0.15);
      oscillator.stop(metronomeContext.currentTime + 0.15);
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
        
        if (metronomeContext) {
          const oscillator = metronomeContext.createOscillator();
          const gain = metronomeContext.createGain();
          oscillator.connect(gain);
          gain.connect(metronomeContext.destination);
          oscillator.frequency.value = 523.25;
          gain.gain.value = 0.5;
          oscillator.start();
          gain.gain.exponentialRampToValueAtTime(0.00001, metronomeContext.currentTime + 0.2);
          oscillator.stop(metronomeContext.currentTime + 0.2);
        }
        
        setTimeout(() => {
          countinDisplay.style.display = 'none';
          countInActive = false;
          resolve();
        }, 500);
      }
    }, 1000);
  });
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
    startMetronome();
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
    stopMetronome();
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
      stopMetronome();
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
    
    if (countInEnabled) {
      document.getElementById('recording-status').innerHTML = '⏱️ Count-in starting...';
      document.getElementById('recording-status').style.color = '#f39c12';
      await startCountIn();
    }
    
    mediaRecorder.start(1000);
    isRecording = true;
    document.getElementById('record-btn').style.display = 'none';
    document.getElementById('stop-record-btn').style.display = 'inline-block';
    document.getElementById('recording-status').innerHTML = '🔴 RECORDING - ' + (metronomeEnabled ? 'Metronome ON' : 'Metronome OFF');
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
    stopMetronome();
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
  if (isRecording) {
    stopMetronome();
    startMetronome();
  }
  socket.emit('transport-control', {
    songId: currentSong.id,
    action: 'setBpm',
    bpm: bpm
  });
}

// Feed Functions
async function loadCommunityFeed() {
  try {
    const songs = await api.getCommunityFeed();
    const container = document.getElementById('community-songs');
    
    if (songs.length === 0) {
      container.innerHTML = '<div class="loading">No tracks yet. Create the first one!</div>';
      return;
    }
    
    container.innerHTML = songs.map(song => `
      <div class="song-card" onclick="selectSong('${song.id}')">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title">
            ${escapeHtml(song.title)}
            ${song.isNew ? '<span class="new-badge">NEW</span>' : ''}
          </div>
          <div class="song-creator">
            <img class="creator-avatar-small" src="${song.creatorAvatar}" alt="">
            ${escapeHtml(song.creator)}
          </div>
          <div class="song-stats">
            <span>🎵 ${song.trackCount} tracks</span>
            <span>👍 ${song.likes || 0} likes</span>
            <span>🎧 ${song.totalContributors} contributors</span>
            <span>🎚️ ${song.bpm} BPM</span>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading community feed:', error);
    document.getElementById('community-songs').innerHTML = '<div class="loading">Error loading feed</div>';
  }
}

async function loadFollowingFeed() {
  try {
    const songs = await api.getFollowingFeed();
    const container = document.getElementById('following-songs');
    
    if (songs.length === 0) {
      container.innerHTML = '<div class="loading">No tracks from people you follow yet. Follow some creators!</div>';
      return;
    }
    
    container.innerHTML = songs.map(song => `
      <div class="song-card" onclick="selectSong('${song.id}')">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title">${escapeHtml(song.title)}</div>
          <div class="song-creator">
            <img class="creator-avatar-small" src="${song.creatorAvatar}" alt="">
            ${escapeHtml(song.creator)}
          </div>
          <div class="song-stats">
            <span>🎵 ${song.trackCount} tracks</span>
            <span>👍 ${song.likes || 0} likes</span>
            <span>🎧 ${song.totalContributors} contributors</span>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading following feed:', error);
    document.getElementById('following-songs').innerHTML = '<div class="loading">Error loading feed</div>';
  }
}

async function loadSongs() {
  if (isRefreshing) return;
  try {
    const songs = await api.getSongs();
    const container = document.getElementById('song-list');
    
    const userSongs = songs.filter(s => s.creator === currentUser.username);
    
    if (userSongs.length === 0) {
      container.innerHTML = '<div class="loading">No tracks yet. Create your first track!</div>';
      return;
    }
    
    container.innerHTML = userSongs.map(song => `
      <div class="song-card" onclick="selectSong('${song.id}')">
        <img class="song-thumbnail" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
        <div class="song-info-card">
          <div class="song-title">${escapeHtml(song.title)}</div>
          <div class="song-creator">by you</div>
          <div class="song-stats">
            <span>🎵 ${song.trackCount} tracks</span>
            <span>👍 ${song.likes || 0} likes</span>
            <span>🎧 ${song.totalContributors} contributors</span>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading songs:', error);
    setTimeout(() => loadSongs(), 2000);
  }
}

async function selectSong(songId) {
  if (isRefreshing) return;
  try {
    isRefreshing = true;
    
    if (isPlaying) stopPlayback();
    if (isRecording) stopAudioRecording();
    if (metronomeInterval) clearInterval(metronomeInterval);
    if (countInInterval) clearInterval(countInInterval);
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
    
    document.querySelectorAll('.feed-view').forEach(view => view.classList.remove('active'));
    document.querySelector('.studio-view').classList.add('active');
    document.querySelector('.feed-tabs').style.display = 'none';
    
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
  let bpmVal = parseInt(document.getElementById('new-song-bpm').value);
  const genre = document.getElementById('new-song-genre').value;
  
  if (!title) {
    showToast('Please enter a song title');
    return;
  }
  if (isNaN(bpmVal)) bpmVal = 120;
  if (bpmVal < 40) bpmVal = 40;
  if (bpmVal > 300) bpmVal = 300;
  
  const thumbnail = currentThumbnail || generateRandomThumbnail(title);
  
  try {
    const newSong = await api.createSong({ title, bpm: bpmVal, genre, thumbnail });
    showToast('Song created successfully!');
    document.getElementById('create-modal').style.display = 'none';
    document.getElementById('new-song-title').value = '';
    document.getElementById('new-song-bpm').value = '120';
    currentThumbnail = null;
    await loadCommunityFeed();
    await loadSongs();
    await selectSong(newSong.id);
  } catch (error) {
    console.error('Create song error:', error);
    showToast('Error creating song: ' + error.message);
  }
}

function randomizeThumbnail() {
  const title = document.getElementById('new-song-title').value || 'track';
  currentThumbnail = generateRandomThumbnail(title);
  document.getElementById('preview-thumb').src = currentThumbnail;
}

async function openProfileModal() {
  const modal = document.getElementById('profile-modal');
  const avatar = document.getElementById('profile-modal-avatar');
  const bio = document.getElementById('profile-bio');
  
  const response = await fetch(`/api/users/${currentUser.username}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const user = await response.json();
  
  currentUser.followers = user.followers;
  currentUser.following = user.following;
  currentUser.contributedTo = user.contributedTo;
  
  avatar.src = user.avatar;
  bio.value = user.bio || '';
  
  document.getElementById('profile-followers').textContent = user.followers?.length || 0;
  document.getElementById('profile-following').textContent = user.following?.length || 0;
  document.getElementById('profile-tracks').textContent = user.contributedTo?.length || 0;
  
  modal.style.display = 'flex';
}

async function saveProfile() {
  const bio = document.getElementById('profile-bio').value;
  
  try {
    await api.updateBio(bio);
    currentUser.bio = bio;
    showToast('Profile updated!');
    document.getElementById('profile-modal').style.display = 'none';
  } catch (error) {
    showToast('Error updating profile: ' + error.message);
  }
}

async function uploadAvatar(file) {
  try {
    const result = await api.uploadAvatar(file);
    currentUser.avatar = result.avatar;
    document.getElementById('header-avatar').src = result.avatar;
    document.getElementById('profile-modal-avatar').src = result.avatar;
    showToast('Avatar updated!');
  } catch (error) {
    showToast('Error uploading avatar: ' + error.message);
  }
}

function backToLibrary() {
  if (isPlaying) stopPlayback();
  if (isRecording) stopAudioRecording();
  if (metronomeInterval) clearInterval(metronomeInterval);
  if (countInInterval) clearInterval(countInInterval);
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
  
  document.querySelector('.studio-view').classList.remove('active');
  document.querySelector('.feed-tabs').style.display = 'flex';
  
  const activeFeed = document.querySelector('.feed-tab.active').dataset.feed;
  document.getElementById(`${activeFeed}-feed`).classList.add('active');
  
  loadCommunityFeed();
  loadFollowingFeed();
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
    loadCommunityFeed();
    loadFollowingFeed();
  });
  
  socket.on('track-deleted', async (data) => {
    if (currentSong && currentSong.id === data.songId) {
      currentSong = await api.getSong(currentSong.id);
      displayTracks();
      showToast(`${data.username} deleted their track`);
    }
    loadCommunityFeed();
    loadFollowingFeed();
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
  
  socket.on('song-created', () => {
    loadCommunityFeed();
    loadFollowingFeed();
  });
}

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

// ============ SEARCH FUNCTIONS ============

let currentSearchTerm = '';
let currentSearchTab = 'all';

async function performSearch(query, tab = 'all') {
  if (!query || query.trim() === '') {
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '<div class="search-placeholder">🔍 Search for songs, artists, or genres...</div>';
    return;
  }
  
  try {
    if (tab === 'all') {
      const response = await fetch(`/api/search/all?q=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      displaySearchResults(data.songs, data.users);
    } else if (tab === 'songs') {
      const response = await fetch(`/api/search/songs?q=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const songs = await response.json();
      displaySearchResults(songs, []);
    } else if (tab === 'users') {
      const response = await fetch(`/api/search/users?q=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const users = await response.json();
      displaySearchResults([], users);
    }
  } catch (error) {
    console.error('Search error:', error);
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '<div class="search-placeholder">❌ Error searching. Please try again.</div>';
  }
}

function displaySearchResults(songs, users) {
  const resultsContainer = document.getElementById('search-results');
  
  if ((!songs || songs.length === 0) && (!users || users.length === 0)) {
    resultsContainer.innerHTML = '<div class="search-placeholder">😔 No results found. Try a different search term.</div>';
    return;
  }
  
  let html = '';
  
  if (songs && songs.length > 0) {
    html += `
      <div class="search-result-section">
        <div class="search-section-title">🎵 Songs (${songs.length})</div>
        ${songs.map(song => `
          <div class="search-song-item" onclick="selectSong('${song.id}'); closeSearchModal();">
            <img class="search-song-thumb" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
            <div class="search-song-info">
              <div class="search-song-title">${escapeHtml(song.title)}</div>
              <div class="search-song-creator">
                <img class="creator-avatar-small" src="${song.creatorAvatar}" alt="">
                ${escapeHtml(song.creator)}
              </div>
              <div class="search-song-stats">
                <span>🎵 ${song.trackCount} tracks</span>
                <span>👍 ${song.likes} likes</span>
                <span>🎚️ ${song.bpm} BPM</span>
                <span>🎸 ${song.genre}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  if (users && users.length > 0) {
    html += `
      <div class="search-result-section">
        <div class="search-section-title">👥 Users (${users.length})</div>
        ${users.map(user => `
          <div class="search-user-item">
            <img class="search-user-avatar" src="${user.avatar}" alt="${escapeHtml(user.username)}">
            <div class="search-user-info">
              <div class="search-user-name">${escapeHtml(user.username)}</div>
              <div class="search-user-bio">${escapeHtml(user.bio.substring(0, 60))}</div>
              <div class="search-user-stats">
                <span>👥 ${user.followersCount} followers</span>
                <span>🎵 ${user.tracksCount} tracks</span>
              </div>
            </div>
            <button class="search-follow-btn ${user.isFollowing ? 'following' : ''}" onclick="followFromSearch('${user.username}', this)">
              ${user.isFollowing ? 'Following' : 'Follow'}
            </button>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  resultsContainer.innerHTML = html;
}

async function followFromSearch(username, buttonElement) {
  try {
    const result = await api.followUser(username);
    if (result.following) {
      buttonElement.textContent = 'Following';
      buttonElement.classList.add('following');
      showToast(`Now following ${username}`);
    } else {
      buttonElement.textContent = 'Follow';
      buttonElement.classList.remove('following');
      showToast(`Unfollowed ${username}`);
    }
    loadFollowingFeed();
    performSearch(currentSearchTerm, currentSearchTab);
    if (result.following) {
      currentUser.following.push(username);
    } else {
      currentUser.following = currentUser.following.filter(u => u !== username);
    }
  } catch (error) {
    showToast('Error: ' + error.message);
  }
}

async function viewUserProfile(username) {
  try {
    const response = await fetch(`/api/users/${username}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const user = await response.json();
    const isFollowing = currentUser.following?.includes(username) || false;
    
    const modal = document.getElementById('user-profile-modal');
    const detailsContainer = document.getElementById('user-profile-details');
    
    detailsContainer.innerHTML = `
      <div class="user-profile-detail">
        <img class="view-profile-avatar" src="${user.avatar}" alt="${escapeHtml(user.username)}">
        <div class="view-profile-name">${escapeHtml(user.username)}</div>
        <div class="view-profile-bio">${escapeHtml(user.bio || 'Music creator on TrackStars')}</div>
        <button class="view-profile-follow-btn ${isFollowing ? 'following' : ''}" onclick="followFromProfile('${user.username}', this)">
          ${isFollowing ? 'Following' : 'Follow'}
        </button>
        <div class="view-profile-stats">
          <div>
            <div style="font-weight: bold; font-size: 20px;">${user.followers?.length || 0}</div>
            <div style="font-size: 11px; color: #888;">Followers</div>
          </div>
          <div>
            <div style="font-weight: bold; font-size: 20px;">${user.following?.length || 0}</div>
            <div style="font-size: 11px; color: #888;">Following</div>
          </div>
          <div>
            <div style="font-weight: bold; font-size: 20px;">${user.contributedTo?.length || 0}</div>
            <div style="font-size: 11px; color: #888;">Tracks</div>
          </div>
        </div>
        <div class="view-profile-tracks">
          <h4>🎵 Contributed Tracks</h4>
          <div id="profile-user-tracks"></div>
        </div>
      </div>
    `;
    
    const songs = await api.getSongs();
    const userSongs = songs.filter(s => user.contributedTo?.includes(s.id) || s.creator === username);
    const tracksContainer = document.getElementById('profile-user-tracks');
    
    if (userSongs.length === 0) {
      tracksContainer.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">No tracks yet</div>';
    } else {
      tracksContainer.innerHTML = userSongs.map(song => `
        <div class="search-song-item" onclick="selectSong('${song.id}'); document.getElementById('user-profile-modal').style.display = 'none';">
          <img class="search-song-thumb" src="${song.thumbnail}" alt="${escapeHtml(song.title)}">
          <div class="search-song-info">
            <div class="search-song-title">${escapeHtml(song.title)}</div>
            <div class="search-song-stats">
              <span>🎵 ${song.trackCount} tracks</span>
              <span>👍 ${song.likes || 0} likes</span>
            </div>
          </div>
        </div>
      `).join('');
    }
    
    modal.style.display = 'flex';
  } catch (error) {
    console.error('Error loading user profile:', error);
    showToast('Error loading profile');
  }
}

async function followFromProfile(username, buttonElement) {
  try {
    const result = await api.followUser(username);
    if (result.following) {
      buttonElement.textContent = 'Following';
      buttonElement.classList.add('following');
      showToast(`Now following ${username}`);
    } else {
      buttonElement.textContent = 'Follow';
      buttonElement.classList.remove('following');
      showToast(`Unfollowed ${username}`);
    }
    loadFollowingFeed();
    if (result.following) {
      currentUser.following.push(username);
    } else {
      currentUser.following = currentUser.following.filter(u => u !== username);
    }
  } catch (error) {
    showToast('Error: ' + error.message);
  }
}

function openSearchModal() {
  const modal = document.getElementById('search-modal');
  modal.style.display = 'flex';
  document.getElementById('search-input').focus();
  currentSearchTerm = '';
  currentSearchTab = 'all';
  document.getElementById('search-results').innerHTML = '<div class="search-placeholder">🔍 Search for songs, artists, or genres...</div>';
}

function closeSearchModal() {
  document.getElementById('search-modal').style.display = 'none';
  document.getElementById('search-input').value = '';
}

function initSearch() {
  const searchInput = document.getElementById('search-input');
  let debounceTimer;
  
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    currentSearchTerm = e.target.value;
    debounceTimer = setTimeout(() => {
      performSearch(currentSearchTerm, currentSearchTab);
    }, 300);
  });
  
  document.querySelectorAll('.search-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.search-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSearchTab = tab.dataset.searchTab;
      performSearch(currentSearchTerm, currentSearchTab);
    });
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('search-modal').style.display === 'flex') {
      closeSearchModal();
    }
  });
}

function initFeedNavigation() {
  const feedTabs = document.querySelectorAll('.feed-tab');
  
  feedTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const feedName = tab.dataset.feed;
      
      feedTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      document.querySelectorAll('.feed-view').forEach(view => view.classList.remove('active'));
      document.getElementById(`${feedName}-feed`).classList.add('active');
      
      if (feedName === 'community') loadCommunityFeed();
      if (feedName === 'following') loadFollowingFeed();
      if (feedName === 'library') loadSongs();
    });
  });
}

function setupEventListeners() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tabName}-form`).classList.add('active');
    });
  });
  
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
      document.getElementById('header-avatar').src = currentUser.avatar;
      initSocket();
      loadCommunityFeed();
      loadFollowingFeed();
      loadSongs();
      initFeedNavigation();
    } catch (error) {
      errorDiv.textContent = error.message;
    }
  });
  
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
      document.getElementById('header-avatar').src = currentUser.avatar;
      initSocket();
      loadCommunityFeed();
      loadFollowingFeed();
      loadSongs();
      initFeedNavigation();
    } catch (error) {
      errorDiv.textContent = error.message;
    }
  });
  
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('header-avatar').addEventListener('click', openProfileModal);
  document.querySelector('.username').addEventListener('click', openProfileModal);
  
  document.querySelector('.close-modal').addEventListener('click', () => {
    document.getElementById('profile-modal').style.display = 'none';
  });
  document.getElementById('save-profile-btn').addEventListener('click', saveProfile);
  document.getElementById('change-avatar-btn').addEventListener('click', () => {
    document.getElementById('avatar-upload').click();
  });
  document.getElementById('avatar-upload').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadAvatar(e.target.files[0]);
  });
  
  document.getElementById('open-create-modal').addEventListener('click', () => {
    currentThumbnail = null;
    document.getElementById('preview-thumb').src = '';
    document.getElementById('create-modal').style.display = 'flex';
  });
  document.getElementById('confirm-create').addEventListener('click', createSong);
  document.getElementById('cancel-create').addEventListener('click', () => {
    document.getElementById('create-modal').style.display = 'none';
  });
  document.getElementById('randomize-thumb-btn').addEventListener('click', randomizeThumbnail);
  
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
  
  document.getElementById('record-btn').addEventListener('click', startRecordingWithPlayback);
  document.getElementById('stop-record-btn').addEventListener('click', stopRecordingAndPlayback);
  document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('audio-file').click();
  });
  document.getElementById('audio-file').addEventListener('change', uploadTrack);
  document.getElementById('back-btn').addEventListener('click', backToLibrary);
  
  // Recording settings
  document.getElementById('metronome-toggle').addEventListener('change', (e) => {
    metronomeEnabled = e.target.checked;
    if (isRecording) {
      if (metronomeEnabled) {
        startMetronome();
      } else {
        stopMetronome();
      }
    }
    showToast(metronomeEnabled ? 'Metronome ON' : 'Metronome OFF');
  });
  
  document.getElementById('countin-toggle').addEventListener('change', (e) => {
    countInEnabled = e.target.checked;
    showToast(countInEnabled ? 'Count-in ON' : 'Count-in OFF');
  });
  
  document.getElementById('search-btn').addEventListener('click', openSearchModal);
  document.getElementById('close-search').addEventListener('click', closeSearchModal);
  document.querySelector('.close-user-profile').addEventListener('click', () => {
    document.getElementById('user-profile-modal').style.display = 'none';
  });
  
  const userProfileModal = document.getElementById('user-profile-modal');
  userProfileModal.addEventListener('click', (e) => {
    if (e.target === userProfileModal) {
      userProfileModal.style.display = 'none';
    }
  });
  
  initSearch();
  
  const modal = document.getElementById('create-modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });
  
  const profileModal = document.getElementById('profile-modal');
  profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) {
      profileModal.style.display = 'none';
    }
  });
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