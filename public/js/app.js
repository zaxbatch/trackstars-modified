// TrackStars - Complete Application
let socket = null, token = null, currentUser = null, currentSong = null;
let audioCtx = null, buffers = new Map(), sources = [], gains = new Map();
let isPlaying = false, isRecording = false, currentPos = 0, startTime = 0;
let timerInterval = null, mediaRecorder = null, chunks = [], stream = null;
let bpm = 120, isOwner = false, currentChatUser = null;

// Helper function to get token
function getToken() {
    const t = localStorage.getItem('token');
    if (t) token = t;
    return token;
}

// API
const api = {
    async request(endpoint, opts = {}) {
        const headers = { 'Content-Type': 'application/json', ...opts.headers };
        const currentToken = getToken();
        if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;
        
        try {
            const res = await fetch(endpoint, { ...opts, headers });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    // Token invalid, redirect to login
                    localStorage.removeItem('token');
                    localStorage.removeItem('user');
                    window.location.reload();
                    throw new Error('Session expired. Please login again.');
                }
                const error = await res.json().catch(() => ({}));
                throw new Error(error.error || 'Request failed');
            }
            return res.json();
        } catch (error) {
            console.error(`API Error (${endpoint}):`, error);
            throw error;
        }
    },
    getSongs: () => api.request('/api/songs'),
    getSong: id => api.request(`/api/songs/${id}`),
    createSong: data => api.request('/api/songs', { method: 'POST', body: JSON.stringify(data) }),
    uploadTrack: async (id, file) => {
        const fd = new FormData();
        fd.append('audio', file);
        const currentToken = getToken();
        const res = await fetch(`/api/songs/${id}/track`, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${currentToken}` }, 
            body: fd 
        });
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
    },
    uploadThumbnail: async (id, file) => {
        const fd = new FormData();
        fd.append('thumbnail', file);
        const currentToken = getToken();
        const res = await fetch(`/api/songs/${id}/thumbnail`, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${currentToken}` }, 
            body: fd 
        });
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
    },
    updateBpm: (id, bpm) => api.request(`/api/songs/${id}/bpm`, { method: 'PUT', body: JSON.stringify({ bpm }) }),
    deleteTrack: (sid, tid) => api.request(`/api/songs/${sid}/track/${tid}`, { method: 'DELETE' }),
    voteTrack: (sid, tid, v) => api.request(`/api/songs/${sid}/track/${tid}/vote`, { method: 'POST', body: JSON.stringify({ vote: v }) }),
    followUser: u => api.request(`/api/users/${u}/follow`, { method: 'POST' }),
    updateBio: bio => api.request('/api/users/bio', { method: 'PUT', body: JSON.stringify({ bio }) }),
    updateTutorial: async () => {
        try {
            return await api.request('/api/users/tutorial', { method: 'PUT' });
        } catch (error) {
            console.log('Tutorial error:', error.message);
            return { success: true };
        }
    },
    uploadAvatar: async file => {
        const fd = new FormData();
        fd.append('avatar', file);
        const currentToken = getToken();
        const res = await fetch('/api/upload-avatar', { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${currentToken}` }, 
            body: fd 
        });
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
    },
    getMessages: u => api.request(`/api/messages/${u}`),
    getRecentChats: () => api.request('/api/messages/recent'),
    sendMessage: (to, text) => api.request('/api/messages', { method: 'POST', body: JSON.stringify({ to, text }) }),
    getUsers: () => api.request('/api/users'),
    searchUsers: q => api.request(`/api/users/search?q=${encodeURIComponent(q)}`),
    getUser: u => api.request(`/api/users/${u}`),
    getFeed: () => api.request('/api/feed'),
    addComment: (songId, text) => api.request(`/api/songs/${songId}/comment`, { method: 'POST', body: JSON.stringify({ text }) }),
    likeComment: (commentId, songId) => api.request(`/api/comments/${commentId}/like`, { method: 'POST', body: JSON.stringify({ songId }) })
};

// Auth
async function register(u, e, p, c) {
    if (p !== c) throw new Error('Passwords do not match');
    if (p.length < 6) throw new Error('Password too short');
    const res = await fetch('/api/register', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ username: u, email: e, password: p }) 
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    return true;
}

async function login(u, p) {
    const res = await fetch('/api/login', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ username: u, password: p }) 
    });
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
    if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    token = null;
    localStorage.clear();
    location.reload();
}

// Audio Functions
async function initAudio() { 
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
    return audioCtx; 
}

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
    if (recordMode && currentSong.tracks.some(t => t.username === currentUser.username)) { 
        showToast('You already have a track! Fork it to add another.'); 
        return false; 
    }
    await loadTracks();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    isPlaying = true;
    startTime = audioCtx.currentTime - currentPos;
    for (const t of currentSong.tracks) if (!t.muted) scheduleTrack(t, currentPos);
    if (recordMode) await startRecording();
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.textContent = '⏸️ Pause';
        playBtn.className = 'pause-btn';
    }
    if (isOwner && socket) {
        socket.emit('transport-control', { songId: currentSong.id, action: 'play', position: currentPos, username: currentUser.username });
    }
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => { if (isPlaying) updateDisplay(audioCtx.currentTime - startTime); }, 50);
    return true;
}

function pausePlayback() {
    if (!isPlaying) return;
    isPlaying = false;
    if (isRecording) { stopRecording(); }
    for (const s of sources) try { s.stop(); } catch(e) {}
    sources = [];
    gains.clear();
    currentPos = audioCtx.currentTime - startTime;
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.textContent = '▶ Play';
        playBtn.className = 'play-btn';
    }
    if (isOwner && socket) {
        socket.emit('transport-control', { songId: currentSong.id, action: 'pause', position: currentPos, username: currentUser.username });
    }
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function stopPlayback() {
    if (isPlaying) { if (isRecording) stopRecording(); pausePlayback(); }
    currentPos = 0;
    updateDisplay(0);
    if (isOwner && socket) {
        socket.emit('transport-control', { songId: currentSong.id, action: 'stop', position: 0, username: currentUser.username });
    }
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
            if (status) status.innerHTML = '📤 Uploading...';
            try {
                await api.uploadTrack(currentSong.id, file);
                showToast('Recording uploaded!');
                currentSong = await api.getSong(currentSong.id);
                displayTracks();
                if (status) status.innerHTML = '✅ Saved!';
                const recordBtn = document.getElementById('record-btn');
                const uploadBtn = document.getElementById('upload-btn');
                if (recordBtn) recordBtn.disabled = true;
                if (uploadBtn) uploadBtn.disabled = true;
                setTimeout(() => { if (status) status.innerHTML = ''; }, 3000);
                loadFeed();
                loadSongs();
            } catch(e) { 
                if (status) status.innerHTML = '❌ Upload failed';
                showToast('Upload failed: ' + e.message);
            }
            if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
            chunks = [];
        };
        mediaRecorder.start(1000);
        isRecording = true;
        const recordBtn = document.getElementById('record-btn');
        const stopRecordBtn = document.getElementById('stop-record-btn');
        if (recordBtn) recordBtn.style.display = 'none';
        if (stopRecordBtn) stopRecordBtn.style.display = 'inline-block';
        const status = document.getElementById('recording-status');
        if (status) status.innerHTML = '🔴 RECORDING';
        if (socket) socket.emit('recording-started', { songId: currentSong.id, username: currentUser.username });
    } catch(e) { 
        showToast('Microphone access denied'); 
        console.error(e);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    isRecording = false;
    const recordBtn = document.getElementById('record-btn');
    const stopRecordBtn = document.getElementById('stop-record-btn');
    if (recordBtn) recordBtn.style.display = 'inline-block';
    if (stopRecordBtn) stopRecordBtn.style.display = 'none';
    if (socket) socket.emit('recording-stopped', { songId: currentSong.id, username: currentUser.username });
}

async function startRecordingWithPlayback() {
    if (!currentSong) return showToast('Select a song first');
    if (isRecording) return showToast('Already recording');
    if (currentSong.tracks.some(t => t.username === currentUser.username)) return showToast('You already have a track! Fork this song to add another.');
    if (isPlaying) stopPlayback();
    currentPos = 0;
    updateDisplay(0);
    await new Promise(r => setTimeout(r, 100));
    await startPlayback(true);
}

function stopRecordingAndPlayback() {
    if (isRecording) stopRecording();
    if (isPlaying) stopPlayback();
}

function updateDisplay(pos) {
    const display = document.getElementById('position-display');
    if (!display) return;
    const m = Math.floor(pos / 60), s = Math.floor(pos % 60), ms = Math.floor((pos % 1) * 100);
    display.textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}:${ms.toString().padStart(2,'0')}`;
}

// Feed Functions
async function loadFeed() {
    try {
        const feed = await api.getFeed();
        
        const trendingContainer = document.getElementById('trending-songs');
        if (trendingContainer) {
            if (feed.trendingSongs && feed.trendingSongs.length) {
                trendingContainer.innerHTML = feed.trendingSongs.map(song => `
                    <div class="trending-card" onclick="selectSong('${song.id}')">
                        <img src="${song.thumbnail}" alt="${escape(song.title)}">
                        <div class="trending-info">
                            <div class="trending-title">${escape(song.title)}</div>
                            <div class="trending-creator" onclick="event.stopPropagation(); viewUser('${song.creator}')">${escape(song.creator)}</div>
                            <div class="trending-stats">👍 ${song.likes} • 🎵 ${song.trackCount} • 🔀 ${song.forkCount || 0}</div>
                        </div>
                    </div>
                `).join('');
            } else { trendingContainer.innerHTML = '<div class="loading">No trending tracks</div>'; }
        }
        
        const activityContainer = document.getElementById('activity-feed');
        if (activityContainer) {
            if (feed.activityFeed && feed.activityFeed.length) {
                activityContainer.innerHTML = feed.activityFeed.map(item => `
                    <div class="activity-item" onclick="selectSong('${item.id}')">
                        <div class="activity-icon">${item.type === 'fork' ? '🔀' : '🆕'}</div>
                        <div class="activity-info">
                            <div class="activity-title">${escape(item.title)}</div>
                            <div class="activity-detail">${item.type === 'fork' ? 'Forked from' : 'Created by'} ${escape(item.creator)} • ${item.trackCount} tracks</div>
                        </div>
                        <div class="activity-time">👍 ${item.likes}</div>
                    </div>
                `).join('');
            } else { activityContainer.innerHTML = '<div class="loading">No recent activity</div>'; }
        }
        
        const contributorsContainer = document.getElementById('top-contributors');
        if (contributorsContainer) {
            if (feed.topContributors && feed.topContributors.length) {
                contributorsContainer.innerHTML = feed.topContributors.map(user => `
                    <div class="user-card">
                        <img class="user-avatar" src="${user.avatar}" onclick="viewUser('${user.username}')">
                        <div class="user-info">
                            <div class="user-name" onclick="viewUser('${user.username}')">${escape(user.username)}</div>
                            <div class="user-stats">🎵 ${user.trackCount} tracks • 👥 ${user.followersCount} followers</div>
                        </div>
                        <button class="follow-small-btn ${user.isFollowing ? 'following' : ''}" onclick="followFromFeed('${user.username}', this)">${user.isFollowing ? 'Following' : 'Follow'}</button>
                    </div>
                `).join('');
            } else { contributorsContainer.innerHTML = '<div class="loading">No contributors yet</div>'; }
        }
        
        const suggestedContainer = document.getElementById('suggested-users');
        if (suggestedContainer) {
            if (feed.suggestedUsers && feed.suggestedUsers.length) {
                suggestedContainer.innerHTML = feed.suggestedUsers.map(user => `
                    <div class="user-card">
                        <img class="user-avatar" src="${user.avatar}" onclick="viewUser('${user.username}')">
                        <div class="user-info">
                            <div class="user-name" onclick="viewUser('${user.username}')">${escape(user.username)}</div>
                            <div class="user-stats">🎵 ${user.trackCount} tracks • 👥 ${user.followersCount} followers</div>
                        </div>
                        <button class="follow-small-btn" onclick="followFromFeed('${user.username}', this)">Follow</button>
                    </div>
                `).join('');
            } else { suggestedContainer.innerHTML = '<div class="loading">No suggestions</div>'; }
        }
    } catch(e) { 
        console.error('Error loading feed:', e);
        showToast('Error loading feed. Please refresh the page.');
    }
}

// Library Functions
async function loadSongs() {
    try {
        const songs = await api.getSongs();
        const container = document.getElementById('song-list');
        if (!container) return;
        if (!songs.length) { container.innerHTML = '<div class="loading">No tracks yet. Create one!</div>'; return; }
        container.innerHTML = songs.map(s => `
            <div class="song-card" onclick="selectSong('${s.id}')">
                <img class="song-thumb" src="${s.thumbnail}">
                <div class="song-info">
                    <div class="song-title">${escape(s.title)}${s.parentId ? '<span class="fork-badge">FORK</span>' : ''}</div>
                    <div class="song-creator" onclick="event.stopPropagation(); viewUser('${s.creator}')">${escape(s.creator)}</div>
                    <div class="song-stats">🎵 ${s.trackCount} tracks | 👍 ${s.likes} likes | 🔀 ${s.forkCount || 0} forks</div>
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
    } catch(e) { 
        console.error(e);
        showToast('Error loading songs');
    }
}

async function selectSong(id) {
    try {
        if (isPlaying) stopPlayback();
        if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (audioCtx) await audioCtx.close();
        buffers.clear(); sources = []; gains.clear();
        audioCtx = null;
        currentSong = await api.getSong(id);
        isOwner = currentSong.creator === currentUser.username;
        
        const titleEl = document.getElementById('current-song-title');
        const creatorEl = document.getElementById('song-creator');
        const versionBadge = document.getElementById('version-badge');
        const bpmInput = document.getElementById('bpm-input');
        const bpmLock = document.getElementById('bpm-lock');
        const forkBtn = document.getElementById('fork-song-btn');
        
        if (titleEl) titleEl.textContent = currentSong.title;
        if (creatorEl) creatorEl.innerHTML = `Created by <span style="color:#667eea;cursor:pointer" onclick="viewUser('${currentSong.creator}')">${escape(currentSong.creator)}</span> • ${currentSong.genre} • ${currentSong.bpm} BPM`;
        if (versionBadge) versionBadge.innerHTML = currentSong.parentId ? `🔀 Fork of original` : `📀 Original Version`;
        if (bpmInput) {
            bpmInput.value = currentSong.bpm;
            bpmInput.disabled = !isOwner;
        }
        if (bpmLock) {
            bpmLock.className = `bpm-lock ${isOwner ? 'unlocked' : ''}`;
            bpmLock.innerHTML = isOwner ? '🔓' : '🔒';
        }
        if (forkBtn) forkBtn.style.display = 'inline-block';
        bpm = currentSong.bpm;
        
        if (socket) socket.emit('join-song', id);
        displayTracks();
        displayComments();
        
        const hasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
        const recordBtn = document.getElementById('record-btn');
        const uploadBtn = document.getElementById('upload-btn');
        if (recordBtn) recordBtn.disabled = hasTrack;
        if (uploadBtn) uploadBtn.disabled = hasTrack;
        currentPos = 0;
        updateDisplay(0);
        
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const studioView = document.getElementById('studio-view');
        if (studioView) studioView.classList.add('active');
    } catch(e) { 
        showToast('Error loading song'); 
        console.error(e);
    }
}

function displayTracks() {
    const container = document.getElementById('track-mixer');
    if (!container) return;
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

async function displayComments() {
    const container = document.getElementById('comments-list');
    if (!container) return;
    const comments = currentSong.comments || [];
    if (!comments.length) { container.innerHTML = '<div style="color:#888;text-align:center">No comments yet</div>'; return; }
    container.innerHTML = comments.map(c => `
        <div class="comment">
            <strong onclick="viewUser('${c.username}')">${escape(c.username)}</strong>
            <div>${escape(c.text)}</div>
            <small>${new Date(c.createdAt).toLocaleString()}</small>
            <button class="comment-like-btn" onclick="likeComment('${c.id}')">❤️ ${c.likes || 0}</button>
        </div>
    `).join('');
}

async function likeComment(commentId) {
    try {
        await api.likeComment(commentId, currentSong.id);
        currentSong = await api.getSong(currentSong.id);
        displayComments();
    } catch(e) { showToast('Error liking comment'); }
}

async function postComment() {
    const input = document.getElementById('comment-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
        await api.addComment(currentSong.id, text);
        input.value = '';
        currentSong = await api.getSong(currentSong.id);
        displayComments();
    } catch(e) { showToast('Error posting comment'); }
}

async function toggleMute(id) {
    const track = currentSong.tracks.find(t => t.id === id);
    if (track) {
        track.muted = !track.muted;
        if (isPlaying) { const pos = currentPos; pausePlayback(); currentPos = pos; await startPlayback(false); }
        displayTracks();
        await fetch(`/api/songs/${currentSong.id}/track/${id}`, { 
            method: 'PUT', 
            headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ muted: track.muted }) 
        });
        if (socket) socket.emit('track-update', { songId: currentSong.id, trackId: id, updates: { muted: track.muted } });
    }
}

async function adjustVolume(id, vol) {
    const track = currentSong.tracks.find(t => t.id === id);
    if (track) {
        track.volume = parseFloat(vol);
        const gain = gains.get(id);
        if (gain) gain.gain.value = track.volume;
        await fetch(`/api/songs/${currentSong.id}/track/${id}`, { 
            method: 'PUT', 
            headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ volume: track.volume }) 
        });
    }
}

async function voteTrack(id, vote) {
    try {
        const res = await api.voteTrack(currentSong.id, id, vote);
        const track = currentSong.tracks.find(t => t.id === id);
        if (track) track.votes = res.votes;
        displayTracks();
        loadFeed();
    } catch(e) { showToast('Error voting'); }
}

async function deleteTrack(id) {
    if (!confirm('Delete your track? Cannot undo.')) return;
    try {
        await api.deleteTrack(currentSong.id, id);
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        const recordBtn = document.getElementById('record-btn');
        const uploadBtn = document.getElementById('upload-btn');
        if (recordBtn) recordBtn.disabled = false;
        if (uploadBtn) uploadBtn.disabled = false;
        loadFeed();
        loadSongs();
    } catch(e) { showToast('Error deleting track'); }
}

async function createSong() {
    const titleInput = document.getElementById('new-title');
    const bpmInput = document.getElementById('new-bpm');
    const genreSelect = document.getElementById('new-genre');
    const thumbPreview = document.getElementById('thumb-preview');
    
    if (!titleInput) return;
    const title = titleInput.value;
    let b = bpmInput ? parseInt(bpmInput.value) : 120;
    const genre = genreSelect ? genreSelect.value : 'Electronic';
    if (!title) return showToast('Enter a title');
    b = Math.min(300, Math.max(40, b || 120));
    const thumbnail = thumbPreview ? thumbPreview.src : null;
    try {
        const song = await api.createSong({ title, bpm: b, genre, thumbnail: thumbnail && thumbnail.includes('picsum') ? thumbnail : null });
        showToast('Song created!');
        const createModal = document.getElementById('create-modal');
        if (createModal) createModal.style.display = 'none';
        if (titleInput) titleInput.value = '';
        loadSongs();
        loadFeed();
        selectSong(song.id);
    } catch(e) { showToast('Error creating song'); }
}

async function forkSong() {
    const forkInput = document.getElementById('fork-new-title');
    if (!forkInput) return;
    const newTitle = forkInput.value;
    if (!newTitle) return showToast('Enter a title for your fork');
    try {
        const song = await api.createSong({ title: newTitle, bpm: currentSong.bpm, genre: currentSong.genre, parentId: currentSong.id });
        showToast('Fork created! You can now add your track.');
        const forkModal = document.getElementById('fork-modal');
        if (forkModal) forkModal.style.display = 'none';
        if (forkInput) forkInput.value = '';
        loadSongs();
        loadFeed();
        selectSong(song.id);
    } catch(e) { showToast('Error creating fork'); }
}

async function uploadTrackFile() {
    const fileInput = document.getElementById('audio-file');
    if (!fileInput || !fileInput.files[0]) return showToast('Select a file');
    const file = fileInput.files[0];
    if (currentSong.tracks.some(t => t.username === currentUser.username)) return showToast('You already have a track! Fork this song to add another.');
    try {
        await api.uploadTrack(currentSong.id, file);
        showToast('Track uploaded!');
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        const recordBtn = document.getElementById('record-btn');
        const uploadBtn = document.getElementById('upload-btn');
        if (recordBtn) recordBtn.disabled = true;
        if (uploadBtn) uploadBtn.disabled = true;
        loadFeed();
    } catch(e) { showToast('Error uploading track'); }
}

async function updateBpm() {
    const input = document.getElementById('bpm-input');
    if (!input) return;
    const newBpm = parseInt(input.value);
    if (isNaN(newBpm)) return;
    if (!isOwner) { 
        showToast('Only the version owner can change BPM'); 
        input.value = bpm; 
        return; 
    }
    const clampedBpm = Math.min(300, Math.max(40, newBpm));
    try {
        await api.updateBpm(currentSong.id, clampedBpm);
        bpm = clampedBpm;
        showToast('BPM updated');
    } catch(e) { showToast('Error updating BPM'); }
}

async function uploadSongThumbnail(file) {
    try {
        const res = await api.uploadThumbnail(currentSong.id, file);
        currentSong.thumbnail = res.thumbnail;
        const thumbPreview = document.getElementById('thumb-preview');
        if (thumbPreview) thumbPreview.src = res.thumbnail;
        showToast('Thumbnail updated');
    } catch(e) { showToast('Error uploading thumbnail'); }
}

function backToLibrary() {
    if (isPlaying) stopPlayback();
    if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    if (socket && currentSong) socket.emit('leave-song', currentSong.id);
    currentSong = null;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const libraryNav = document.querySelector('.nav-item[data-view="library"]');
    if (libraryNav) libraryNav.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const libraryView = document.getElementById('library-view');
    if (libraryView) libraryView.classList.add('active');
    loadSongs();
}

// Profile Functions
async function loadProfile() {
    const container = document.getElementById('profile-content');
    if (!container) return;
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
        if (tracksDiv) {
            if (!mySongs.length) tracksDiv.innerHTML = '<div class="loading">No tracks yet</div>';
            else tracksDiv.innerHTML = mySongs.map(s => `<div class="song-card" onclick="selectSong('${s.id}')"><img class="song-thumb" src="${s.thumbnail}"><div class="song-info"><div class="song-title">${escape(s.title)}</div><div class="song-stats">🎵 ${s.trackCount} tracks | 👍 ${s.likes}</div></div></div>`).join('');
        }
        const editBtn = document.getElementById('edit-profile-btn');
        if (editBtn) editBtn.onclick = openProfileModal;
    } catch(e) { 
        container.innerHTML = '<div class="loading">Error loading profile</div>';
        console.error(e);
    }
}

async function openProfileModal() {
    try {
        const user = await api.getUser(currentUser.username);
        const editAvatar = document.getElementById('edit-avatar');
        const editBio = document.getElementById('edit-bio');
        const editFollowers = document.getElementById('edit-followers');
        const editFollowing = document.getElementById('edit-following');
        const editTracks = document.getElementById('edit-tracks');
        if (editAvatar) editAvatar.src = user.avatar;
        if (editBio) editBio.value = user.bio || '';
        if (editFollowers) editFollowers.textContent = user.followers?.length || 0;
        if (editFollowing) editFollowing.textContent = user.following?.length || 0;
        if (editTracks) editTracks.textContent = user.contributedTo?.length || 0;
        const profileModal = document.getElementById('profile-modal');
        if (profileModal) profileModal.style.display = 'flex';
    } catch(e) { showToast('Error loading profile'); }
}

async function saveProfile() {
    const bioInput = document.getElementById('edit-bio');
    if (!bioInput) return;
    const bio = bioInput.value;
    try {
        await api.updateBio(bio);
        showToast('Profile updated');
        const profileModal = document.getElementById('profile-modal');
        if (profileModal) profileModal.style.display = 'none';
        loadProfile();
    } catch(e) { showToast('Error saving profile'); }
}

async function uploadAvatar(file) {
    try {
        const res = await api.uploadAvatar(file);
        currentUser.avatar = res.avatar;
        const headerAvatar = document.getElementById('header-avatar');
        if (headerAvatar) headerAvatar.src = res.avatar;
        showToast('Avatar updated');
    } catch(e) { showToast('Error uploading avatar'); }
}

// Chat Functions
async function loadRecentChats() {
    const container = document.getElementById('chat-recent');
    const searchInput = document.getElementById('chat-search-input');
    if (!container) return;
    
    const loadChats = async (searchTerm = '') => {
        try {
            let users = [];
            if (searchTerm) {
                users = await api.searchUsers(searchTerm);
                container.innerHTML = users.map(u => `
                    <div class="chat-user-item" onclick="startChat('${u.username}')">
                        <img src="${u.avatar}"><div class="chat-user-info"><div class="chat-user-name">${escape(u.username)}</div><div class="chat-preview">${u.followersCount} followers</div></div>
                    </div>
                `).join('');
                if (!users.length) container.innerHTML = '<div class="loading">No users found</div>';
            } else {
                const chats = await api.getRecentChats();
                if (!chats.length) { container.innerHTML = '<div class="loading">No recent chats. Search for users above!</div>'; return; }
                container.innerHTML = chats.map(c => `
                    <div class="chat-user-item" onclick="startChat('${c.otherUser}')">
                        <img src="${c.avatar}"><div class="chat-user-info"><div class="chat-user-name">${escape(c.otherUser)}</div><div class="chat-preview">${escape(c.text.substring(0, 30))}</div></div>
                        <div class="chat-time">${new Date(c.timestamp).toLocaleTimeString()}</div>
                    </div>
                `).join('');
            }
        } catch(e) { 
            container.innerHTML = '<div class="loading">Error loading chats</div>';
            console.error(e);
        }
    };
    
    await loadChats();
    if (searchInput) searchInput.oninput = () => loadChats(searchInput.value);
}

async function startChat(username) {
    currentChatUser = username;
    const chatRecent = document.getElementById('chat-recent');
    const chatConversation = document.getElementById('chat-conversation');
    const chatWith = document.getElementById('chat-with');
    if (chatRecent) chatRecent.style.display = 'none';
    if (chatConversation) chatConversation.style.display = 'flex';
    if (chatWith) chatWith.textContent = username;
    await loadConversation(username);
}

async function loadConversation(username) {
    try {
        const msgs = await api.getMessages(username);
        const container = document.getElementById('chat-messages');
        if (!container) return;
        container.innerHTML = msgs.map(m => `<div class="message ${m.from === currentUser.username ? 'sent' : 'received'}"><div>${escape(m.text)}</div><div class="message-time">${new Date(m.timestamp).toLocaleTimeString()}</div></div>`).join('');
        container.scrollTop = container.scrollHeight;
    } catch(e) { console.error(e); }
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !currentChatUser) return;
    try {
        await api.sendMessage(currentChatUser, text);
        input.value = '';
        await loadConversation(currentChatUser);
        loadRecentChats();
    } catch(e) { showToast('Error sending message'); }
}

function backToRecent() {
    const chatConversation = document.getElementById('chat-conversation');
    const chatRecent = document.getElementById('chat-recent');
    if (chatConversation) chatConversation.style.display = 'none';
    if (chatRecent) chatRecent.style.display = 'block';
    currentChatUser = null;
    loadRecentChats();
}

// View other user profile
async function viewUser(username) {
    try {
        const user = await api.getUser(username);
        const isFollowing = currentUser.following?.includes(username);
        const modal = document.getElementById('user-modal');
        const modalContent = document.getElementById('user-modal-content');
        if (!modal || !modalContent) return;
        modalContent.innerHTML = `
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
        if (tracksDiv) {
            if (!userSongs.length) tracksDiv.innerHTML = '<div style="color:#888;text-align:center">No tracks yet</div>';
            else tracksDiv.innerHTML = userSongs.map(s => `<div class="song-card" onclick="selectSong('${s.id}'); document.getElementById('user-modal').style.display = 'none';"><img class="song-thumb" src="${s.thumbnail}"><div class="song-info"><div class="song-title">${escape(s.title)}</div><div class="song-stats">🎵 ${s.trackCount} tracks</div></div></div>`).join('');
        }
        modal.style.display = 'flex';
    } catch(e) { 
        showToast('Error loading profile'); 
        console.error(e);
    }
}

async function followUser(username, btn) {
    try {
        const res = await api.followUser(username);
        if (res.following) { 
            btn.textContent = 'Following'; 
            btn.classList.add('following'); 
            showToast(`Following ${username}`); 
        } else { 
            btn.textContent = 'Follow'; 
            btn.classList.remove('following'); 
            showToast(`Unfollowed ${username}`); 
        }
        if (res.following && !currentUser.following.includes(username)) currentUser.following.push(username);
        else if (!res.following) currentUser.following = currentUser.following.filter(u => u !== username);
        loadFeed();
    } catch(e) { showToast('Error following user'); }
}

async function followFromFeed(username, btn) {
    try {
        const res = await api.followUser(username);
        if (res.following) { 
            btn.textContent = 'Following'; 
            btn.classList.add('following'); 
            showToast(`Following ${username}`); 
        } else { 
            btn.textContent = 'Follow'; 
            btn.classList.remove('following'); 
            showToast(`Unfollowed ${username}`); 
        }
        loadFeed();
    } catch(e) { showToast('Error following user'); }
}

// Tutorial
async function showTutorial() {
    if (currentUser.tutorialCompleted) return;
    const tutorialOverlay = document.getElementById('tutorial-overlay');
    if (!tutorialOverlay) return;
    tutorialOverlay.style.display = 'flex';
    const finishBtn = document.getElementById('tutorial-finish');
    if (finishBtn) {
        finishBtn.onclick = async () => {
            try {
                await api.updateTutorial();
                currentUser.tutorialCompleted = true;
                tutorialOverlay.style.display = 'none';
            } catch(e) {
                tutorialOverlay.style.display = 'none';
            }
        };
    }
}

// Socket
function initSocket() {
    socket = io();
    socket.on('connect', () => console.log('Socket connected'));
    socket.on('track-added', async data => { if (currentSong?.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); loadFeed(); });
    socket.on('track-deleted', async data => { if (currentSong?.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); loadFeed(); });
    socket.on('track-updated', data => { if (currentSong) { const t = currentSong.tracks.find(tr => tr.id === data.trackId); if (t && data.updates) { if (data.updates.muted !== undefined) t.muted = data.updates.muted; if (data.updates.volume !== undefined) t.volume = data.updates.volume; displayTracks(); } } });
    socket.on('transport-state', state => { if (state.bpm && state.bpm !== bpm && currentSong && !isOwner) { bpm = state.bpm; const bpmInput = document.getElementById('bpm-input'); if (bpmInput) bpmInput.value = bpm; } });
    socket.on('bpm-changed', data => { if (currentSong && !isOwner) { bpm = data.bpm; const bpmInput = document.getElementById('bpm-input'); if (bpmInput) bpmInput.value = bpm; } });
    socket.on('new-message', msg => { if (currentChatUser === msg.from) loadConversation(msg.from); showToast(`New message from ${msg.from}`); loadRecentChats(); });
    socket.on('new-comment', () => { if (currentSong) displayComments(); });
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
            const targetView = document.getElementById(`${view}-view`);
            if (targetView) targetView.classList.add('active');
            if (view === 'profile') loadProfile();
            if (view === 'social') { loadRecentChats(); const chatRecent = document.getElementById('chat-recent'); const chatConversation = document.getElementById('chat-conversation'); if (chatRecent) chatRecent.style.display = 'block'; if (chatConversation) chatConversation.style.display = 'none'; }
            if (view === 'library') loadSongs();
            if (view === 'feed') loadFeed();
        };
    });
}

// Utility
function escape(str) { 
    if (!str) return '';
    const d = document.createElement('div'); 
    d.textContent = str; 
    return d.innerHTML; 
}

function showToast(msg, duration = 3000) { 
    let toast = document.querySelector('.toast'); 
    if (toast) toast.remove(); 
    toast = document.createElement('div'); 
    toast.className = 'toast'; 
    toast.textContent = msg; 
    document.body.appendChild(toast); 
    setTimeout(() => toast.remove(), duration); 
}

// Random thumbnail preview
function randomizeThumbPreview() {
    const id = Math.floor(Math.random() * 100) + 1;
    const thumbPreview = document.getElementById('thumb-preview');
    if (thumbPreview) thumbPreview.src = `https://picsum.photos/id/${id}/200/200`;
}

// Event Listeners
function setupEventListeners() {
    // Auth tabs
    document.querySelectorAll('.auth-tab').forEach(t => t.onclick = () => {
        const tab = t.dataset.tab;
        document.querySelectorAll('.auth-tab').forEach(tt => tt.classList.remove('active'));
        document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
        t.classList.add('active');
        const form = document.getElementById(`${tab}-form`);
        if (form) form.classList.add('active');
    });
    
    // Login form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.onsubmit = async e => {
            e.preventDefault();
            try { 
                await login(document.getElementById('login-username').value, document.getElementById('login-password').value);
                const authModal = document.getElementById('auth-modal');
                const mainApp = document.getElementById('main-app');
                const currentUserSpan = document.getElementById('current-user');
                const headerAvatar = document.getElementById('header-avatar');
                if (authModal) authModal.style.display = 'none';
                if (mainApp) mainApp.style.display = 'block';
                if (currentUserSpan) currentUserSpan.textContent = currentUser.username;
                if (headerAvatar) headerAvatar.src = currentUser.avatar;
                initSocket(); 
                loadSongs(); 
                loadFeed(); 
                initNav(); 
                showTutorial();
            } catch(err) { 
                const errorDiv = document.getElementById('login-error');
                if (errorDiv) errorDiv.textContent = err.message;
            }
        };
    }
    
    // Register form
    const registerForm = document.getElementById('register-form');
    if (registerForm) {
        registerForm.onsubmit = async e => {
            e.preventDefault();
            try { 
                await register(document.getElementById('reg-username').value, document.getElementById('reg-email').value, document.getElementById('reg-password').value, document.getElementById('reg-confirm').value);
                const authModal = document.getElementById('auth-modal');
                const mainApp = document.getElementById('main-app');
                const currentUserSpan = document.getElementById('current-user');
                const headerAvatar = document.getElementById('header-avatar');
                if (authModal) authModal.style.display = 'none';
                if (mainApp) mainApp.style.display = 'block';
                if (currentUserSpan) currentUserSpan.textContent = currentUser.username;
                if (headerAvatar) headerAvatar.src = currentUser.avatar;
                initSocket(); 
                loadSongs(); 
                loadFeed(); 
                initNav(); 
                showTutorial();
            } catch(err) { 
                const errorDiv = document.getElementById('register-error');
                if (errorDiv) errorDiv.textContent = err.message;
            }
        };
    }
    
    // Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.onclick = logout;
    
    // Profile click
    const headerAvatar = document.getElementById('header-avatar');
    if (headerAvatar) headerAvatar.onclick = openProfileModal;
    const usernameSpan = document.querySelector('.username');
    if (usernameSpan) usernameSpan.onclick = openProfileModal;
    
    // Close modal
    const closeModal = document.querySelector('.close-modal');
    if (closeModal) closeModal.onclick = () => { const modal = document.getElementById('profile-modal'); if (modal) modal.style.display = 'none'; };
    
    // Save profile
    const saveProfileBtn = document.getElementById('save-profile');
    if (saveProfileBtn) saveProfileBtn.onclick = saveProfile;
    
    // Change avatar
    const changeAvatarBtn = document.getElementById('change-avatar');
    if (changeAvatarBtn) {
        changeAvatarBtn.onclick = () => {
            const avatarFile = document.getElementById('avatar-file');
            if (avatarFile) avatarFile.click();
        };
    }
    const avatarFile = document.getElementById('avatar-file');
    if (avatarFile) avatarFile.onchange = e => { if (e.target.files[0]) uploadAvatar(e.target.files[0]); };
    
    // Create modal
    const openCreateModal = document.getElementById('open-create-modal');
    if (openCreateModal) openCreateModal.onclick = () => { randomizeThumbPreview(); const modal = document.getElementById('create-modal'); if (modal) modal.style.display = 'flex'; };
    const confirmCreate = document.getElementById('confirm-create');
    if (confirmCreate) confirmCreate.onclick = createSong;
    const cancelCreate = document.getElementById('cancel-create');
    if (cancelCreate) cancelCreate.onclick = () => { const modal = document.getElementById('create-modal'); if (modal) modal.style.display = 'none'; };
    
    // Random thumb
    const randomThumb = document.getElementById('random-thumb');
    if (randomThumb) randomThumb.onclick = randomizeThumbPreview;
    
    // Upload thumb
    const uploadThumbBtn = document.getElementById('upload-thumb-btn');
    if (uploadThumbBtn) {
        uploadThumbBtn.onclick = () => {
            const thumbFile = document.getElementById('thumb-file');
            if (thumbFile) thumbFile.click();
        };
    }
    const thumbFile = document.getElementById('thumb-file');
    if (thumbFile) {
        thumbFile.onchange = e => {
            if (e.target.files[0]) {
                const reader = new FileReader();
                reader.onload = ev => {
                    const thumbPreview = document.getElementById('thumb-preview');
                    if (thumbPreview) thumbPreview.src = ev.target.result;
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        };
    }
    
    // Transport controls
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.onclick = () => isPlaying ? pausePlayback() : startPlayback(false);
    const stopBtn = document.getElementById('stop-btn');
    if (stopBtn) stopBtn.onclick = stopPlayback;
    const bpmInput = document.getElementById('bpm-input');
    if (bpmInput) bpmInput.onchange = updateBpm;
    
    // Recording
    const recordBtn = document.getElementById('record-btn');
    if (recordBtn) recordBtn.onclick = startRecordingWithPlayback;
    const stopRecordBtn = document.getElementById('stop-record-btn');
    if (stopRecordBtn) stopRecordBtn.onclick = stopRecordingAndPlayback;
    const uploadBtn = document.getElementById('upload-btn');
    if (uploadBtn) uploadBtn.onclick = () => { const audioFile = document.getElementById('audio-file'); if (audioFile) audioFile.click(); };
    const audioFile = document.getElementById('audio-file');
    if (audioFile) audioFile.onchange = uploadTrackFile;
    
    // Back button
    const backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.onclick = backToLibrary;
    
    // Fork button
    const forkBtn = document.getElementById('fork-song-btn');
    if (forkBtn) {
        forkBtn.onclick = () => {
            const forkTitle = document.getElementById('fork-title');
            if (forkTitle && currentSong) forkTitle.textContent = currentSong.title;
            const forkModal = document.getElementById('fork-modal');
            if (forkModal) forkModal.style.display = 'flex';
        };
    }
    const confirmFork = document.getElementById('confirm-fork');
    if (confirmFork) confirmFork.onclick = forkSong;
    const cancelFork = document.getElementById('cancel-fork');
    if (cancelFork) cancelFork.onclick = () => { const modal = document.getElementById('fork-modal'); if (modal) modal.style.display = 'none'; };
    
    // Comments
    const postCommentBtn = document.getElementById('post-comment');
    if (postCommentBtn) postCommentBtn.onclick = postComment;
    const commentInput = document.getElementById('comment-input');
    if (commentInput) commentInput.onkeypress = e => { if (e.key === 'Enter') postComment(); };
    
    // Chat
    const backToRecentBtn = document.getElementById('back-to-recent');
    if (backToRecentBtn) backToRecentBtn.onclick = backToRecent;
    const sendChatBtn = document.getElementById('send-chat');
    if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
    const chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.onkeypress = e => { if (e.key === 'Enter') sendChatMessage(); };
    
    // Close modals on outside click
    const closeUserModal = document.querySelector('.close-user-modal');
    if (closeUserModal) closeUserModal.onclick = () => { const modal = document.getElementById('user-modal'); if (modal) modal.style.display = 'none'; };
    const userModal = document.getElementById('user-modal');
    if (userModal) userModal.onclick = e => { if (e.target === userModal) userModal.style.display = 'none'; };
    const profileModal = document.getElementById('profile-modal');
    if (profileModal) profileModal.onclick = e => { if (e.target === profileModal) profileModal.style.display = 'none'; };
    const createModal = document.getElementById('create-modal');
    if (createModal) createModal.onclick = e => { if (e.target === createModal) createModal.style.display = 'none'; };
    const forkModal = document.getElementById('fork-modal');
    if (forkModal) forkModal.onclick = e => { if (e.target === forkModal) forkModal.style.display = 'none'; };
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
        token = savedToken;
        currentUser = JSON.parse(savedUser);
        const authModal = document.getElementById('auth-modal');
        const mainApp = document.getElementById('main-app');
        const currentUserSpan = document.getElementById('current-user');
        const headerAvatar = document.getElementById('header-avatar');
        if (authModal) authModal.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        if (currentUserSpan) currentUserSpan.textContent = currentUser.username;
        if (headerAvatar) headerAvatar.src = currentUser.avatar;
        initSocket();
        loadSongs();
        loadFeed();
        initNav();
        setupEventListeners();
        showTutorial();
    } else {
        const authModal = document.getElementById('auth-modal');
        if (authModal) authModal.style.display = 'flex';
        setupEventListeners();
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
window.followFromFeed = followFromFeed;
window.likeComment = likeComment;