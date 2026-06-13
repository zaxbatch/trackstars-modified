// TrackStars - Complete Application
let socket = null, token = null, currentUser = null, currentSong = null;
let audioCtx = null, buffers = new Map(), sources = [], gains = new Map();
let isPlaying = false, isRecording = false, currentPos = 0, startTime = 0;
let timerInterval = null, mediaRecorder = null, chunks = [], stream = null;
let bpm = 120, isOwner = false, currentChatUser = null;
let currentEditingSong = null, currentEditThumbnail = null;

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
                    localStorage.removeItem('token');
                    localStorage.removeItem('user');
                    window.location.reload();
                    throw new Error('Session expired');
                }
                const error = await res.json().catch(() => ({}));
                throw new Error(error.error || 'Request failed');
            }
            return res.json();
        } catch (error) {
            console.error(`API Error:`, error);
            throw error;
        }
    },
    getSongs: () => api.request('/api/songs'),
    getSong: id => api.request(`/api/songs/${id}`),
    createSong: data => api.request('/api/songs', { method: 'POST', body: JSON.stringify(data) }),
    editSongTitle: (id, title) => api.request(`/api/songs/${id}/title`, { method: 'PUT', body: JSON.stringify({ title }) }),
    editSongThumbnail: async (id, file) => {
        const fd = new FormData();
        fd.append('thumbnail', file);
        const currentToken = getToken();
        const res = await fetch(`/api/songs/${id}/thumbnail`, { method: 'PUT', headers: { 'Authorization': `Bearer ${currentToken}` }, body: fd });
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
    },
    editSongThumbnailUrl: (id, url) => api.request(`/api/songs/${id}/thumbnail`, { method: 'PUT', body: JSON.stringify({ thumbnail: url }) }),
    deleteSong: (id) => api.request(`/api/songs/${id}`, { method: 'DELETE' }),
    uploadTrack: async (id, file) => {
        const fd = new FormData();
        fd.append('audio', file);
        const currentToken = getToken();
        const res = await fetch(`/api/songs/${id}/track`, { method: 'POST', headers: { 'Authorization': `Bearer ${currentToken}` }, body: fd });
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
    },
    updateBpm: (id, bpmValue) => api.request(`/api/songs/${id}/bpm`, { method: 'PUT', body: JSON.stringify({ bpm: bpmValue }) }),
    deleteTrack: (sid, tid) => api.request(`/api/songs/${sid}/track/${tid}`, { method: 'DELETE' }),
    voteTrack: (sid, tid, v) => api.request(`/api/songs/${sid}/track/${tid}/vote`, { method: 'POST', body: JSON.stringify({ vote: v }) }),
    followUser: (u) => api.request(`/api/users/${u}/follow`, { method: 'POST' }),
    updateBio: (bio) => api.request('/api/users/bio', { method: 'PUT', body: JSON.stringify({ bio }) }),
    updateTutorial: async () => {
        try { return await api.request('/api/users/tutorial', { method: 'PUT' }); } 
        catch(e) { return { success: true }; }
    },
    uploadAvatar: async (file) => {
        const fd = new FormData();
        fd.append('avatar', file);
        const currentToken = getToken();
        const res = await fetch('/api/upload-avatar', { method: 'POST', headers: { 'Authorization': `Bearer ${currentToken}` }, body: fd });
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
    },
    getMessages: (u) => api.request(`/api/messages/${u}`),
    getRecentChats: () => api.request('/api/messages/recent'),
    sendMessage: (to, text) => api.request('/api/messages', { method: 'POST', body: JSON.stringify({ to, text }) }),
    getUsers: () => api.request('/api/users'),
    searchUsers: (q) => api.request(`/api/users/search?q=${encodeURIComponent(q)}`),
    getUser: (u) => api.request(`/api/users/${u}`),
    getFeed: () => api.request('/api/feed'),
    addComment: (songId, text) => api.request(`/api/songs/${songId}/comment`, { method: 'POST', body: JSON.stringify({ text }) }),
    likeComment: (commentId, songId) => api.request(`/api/comments/${commentId}/like`, { method: 'POST', body: JSON.stringify({ songId }) })
};

// Auth functions
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
    if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
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
    for (var i = 0; i < currentSong.tracks.length; i++) {
        var t = currentSong.tracks[i];
        try {
            var res = await fetch(t.audioUrl);
            var buf = await res.arrayBuffer();
            var audioBuf = await audioCtx.decodeAudioData(buf);
            buffers.set(t.id, audioBuf);
        } catch (e) { console.error(e); }
    }
}

function scheduleTrack(track, offset, when) {
    if (track.muted) return null;
    var buf = buffers.get(track.id);
    if (!buf) return null;
    var src = audioCtx.createBufferSource();
    var gain = audioCtx.createGain();
    src.buffer = buf;
    gain.gain.value = track.volume;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    var time = (when !== null && when !== undefined) ? when : audioCtx.currentTime;
    src.start(time, offset % buf.duration);
    gains.set(track.id, gain);
    sources.push(src);
    return src;
}

async function startPlayback(recordMode) {
    if (recordMode === undefined) recordMode = false;
    if (!currentSong) return false;
    await initAudio();
    if (recordMode && currentSong.tracks.some(function(t) { return t.username === currentUser.username; })) { 
        showToast('You already have a track! Fork it to add another.'); 
        return false; 
    }
    await loadTracks();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    isPlaying = true;
    startTime = audioCtx.currentTime - currentPos;
    for (var i = 0; i < currentSong.tracks.length; i++) {
        var t = currentSong.tracks[i];
        if (!t.muted) scheduleTrack(t, currentPos, null);
    }
    if (recordMode) await startRecording();
    var playBtn = document.getElementById('play-btn');
    if (playBtn) { playBtn.textContent = '⏸️ Pause'; playBtn.className = 'pause-btn'; }
    if (isOwner && socket) socket.emit('transport-control', { songId: currentSong.id, action: 'play', position: currentPos, username: currentUser.username });
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(function() { if (isPlaying) updateDisplay(audioCtx.currentTime - startTime); }, 50);
    return true;
}

function pausePlayback() {
    if (!isPlaying) return;
    isPlaying = false;
    if (isRecording) stopRecording();
    for (var i = 0; i < sources.length; i++) { try { sources[i].stop(); } catch(e) {} }
    sources = [];
    gains.clear();
    currentPos = audioCtx.currentTime - startTime;
    var playBtn = document.getElementById('play-btn');
    if (playBtn) { playBtn.textContent = '▶ Play'; playBtn.className = 'play-btn'; }
    if (isOwner && socket) socket.emit('transport-control', { songId: currentSong.id, action: 'pause', position: currentPos, username: currentUser.username });
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function stopPlayback() {
    if (isPlaying) { if (isRecording) stopRecording(); pausePlayback(); }
    currentPos = 0;
    updateDisplay(0);
    if (isOwner && socket) socket.emit('transport-control', { songId: currentSong.id, action: 'stop', position: 0, username: currentUser.username });
}

async function startRecording() {
    try {
        if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mimeTypes = ['audio/webm', 'audio/mp4', 'audio/wav'];
        var mime = '';
        for (var i = 0; i < mimeTypes.length; i++) {
            if (MediaRecorder.isTypeSupported(mimeTypes[i])) { mime = mimeTypes[i]; break; }
        }
        mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
        chunks = [];
        mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
        var self = this;
        mediaRecorder.onstop = async function() {
            if (chunks.length === 0) return;
            var blob = new Blob(chunks, { type: mime || 'audio/webm' });
            var file = new File([blob], 'recording-' + Date.now() + '.' + (mime.includes('webm') ? 'webm' : 'mp4'), { type: mime || 'audio/webm' });
            var status = document.getElementById('recording-status');
            if (status) status.innerHTML = '📤 Uploading...';
            try {
                await api.uploadTrack(currentSong.id, file);
                showToast('Recording uploaded!');
                currentSong = await api.getSong(currentSong.id);
                displayTracks();
                if (status) status.innerHTML = '✅ Saved!';
                var recordBtn = document.getElementById('record-btn');
                var uploadBtn = document.getElementById('upload-btn');
                if (recordBtn) recordBtn.disabled = true;
                if (uploadBtn) uploadBtn.disabled = true;
                setTimeout(function() { if (status) status.innerHTML = ''; }, 3000);
                loadFeed(); loadSongs();
            } catch(e) { if (status) status.innerHTML = '❌ Upload failed'; showToast('Upload failed: ' + e.message); }
            if (stream) { stream.getTracks().forEach(function(t) { t.stop(); }); stream = null; }
            chunks = [];
        };
        mediaRecorder.start(1000);
        isRecording = true;
        var recordBtn = document.getElementById('record-btn');
        var stopRecordBtn = document.getElementById('stop-record-btn');
        if (recordBtn) recordBtn.style.display = 'none';
        if (stopRecordBtn) stopRecordBtn.style.display = 'inline-block';
        var status = document.getElementById('recording-status');
        if (status) status.innerHTML = '🔴 RECORDING';
        if (socket) socket.emit('recording-started', { songId: currentSong.id, username: currentUser.username });
    } catch(e) { showToast('Microphone access denied'); console.error(e); }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    isRecording = false;
    var recordBtn = document.getElementById('record-btn');
    var stopRecordBtn = document.getElementById('stop-record-btn');
    if (recordBtn) recordBtn.style.display = 'inline-block';
    if (stopRecordBtn) stopRecordBtn.style.display = 'none';
    if (socket) socket.emit('recording-stopped', { songId: currentSong.id, username: currentUser.username });
}

async function startRecordingWithPlayback() {
    if (!currentSong) return showToast('Select a song first');
    if (isRecording) return showToast('Already recording');
    if (currentSong.tracks.some(function(t) { return t.username === currentUser.username; })) return showToast('You already have a track! Fork this song to add another.');
    if (isPlaying) stopPlayback();
    currentPos = 0;
    updateDisplay(0);
    await new Promise(function(r) { setTimeout(r, 100); });
    await startPlayback(true);
}

function stopRecordingAndPlayback() {
    if (isRecording) stopRecording();
    if (isPlaying) stopPlayback();
}

function updateDisplay(pos) {
    var display = document.getElementById('position-display');
    if (!display) return;
    var m = Math.floor(pos / 60);
    var s = Math.floor(pos % 60);
    var ms = Math.floor((pos % 1) * 100);
    display.textContent = m.toString().padStart(2,'0') + ':' + s.toString().padStart(2,'0') + ':' + ms.toString().padStart(2,'0');
}

// Display Song List with Edit Button
function displaySongList(songs) {
    var container = document.getElementById('song-list');
    if (!container) return;
    if (songs.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Create one!</div>'; return; }
    
    var html = '';
    for (var i = 0; i < songs.length; i++) {
        var s = songs[i];
        var isOwnerFlag = (s.creator === currentUser.username);
        html += '<div class="song-card" onclick="selectSong(\'' + s.id + '\')">';
        html += '<img class="song-thumb" src="' + escape(s.thumbnail) + '">';
        html += '<div class="song-info">';
        html += '<div class="song-title">' + escape(s.title);
        if (s.parentId) html += '<span class="fork-badge">FORK</span>';
        if (isOwnerFlag) html += '<span class="owner-badge">OWNER</span>';
        html += '</div>';
        html += '<div class="song-creator" onclick="event.stopPropagation(); viewUser(\'' + escape(s.creator) + '\')">' + escape(s.creator) + '</div>';
        html += '<div class="song-stats">🎵 ' + s.trackCount + ' tracks | 👍 ' + s.likes + ' likes | 🔀 ' + (s.forkCount || 0) + ' forks</div>';
        html += '</div>';
        if (isOwnerFlag) {
            html += '<div class="song-actions" onclick="event.stopPropagation()">';
            html += '<button class="edit-song-btn" onclick="openEditSongModal(\'' + s.id + '\', event)">✏️ Edit</button>';
            html += '</div>';
        }
        html += '</div>';
    }
    container.innerHTML = html;
    
    var search = document.getElementById('library-search');
    if (search) {
        search.oninput = function(e) {
            var term = e.target.value.toLowerCase();
            var cards = document.querySelectorAll('#song-list .song-card');
            for (var j = 0; j < cards.length; j++) {
                var card = cards[j];
                var title = card.querySelector('.song-title') ? card.querySelector('.song-title').innerText.toLowerCase() : '';
                var creator = card.querySelector('.song-creator') ? card.querySelector('.song-creator').innerText.toLowerCase() : '';
                card.style.display = (title.indexOf(term) !== -1 || creator.indexOf(term) !== -1) ? 'flex' : 'none';
            }
        };
    }
}

// Edit Song Functions
async function openEditSongModal(songId, event) {
    if (event) event.stopPropagation();
    try {
        var song = await api.getSong(songId);
        currentEditingSong = song;
        document.getElementById('edit-song-title').value = song.title;
        document.getElementById('edit-thumb-preview').src = song.thumbnail;
        currentEditThumbnail = song.thumbnail;
        var modal = document.getElementById('edit-song-modal');
        if (modal) modal.style.display = 'flex';
    } catch(e) { showToast('Error loading song data'); }
}

function closeEditSongModal() {
    var modal = document.getElementById('edit-song-modal');
    if (modal) modal.style.display = 'none';
    currentEditingSong = null;
    currentEditThumbnail = null;
}

async function saveSongChanges() {
    if (!currentEditingSong) return;
    var newTitle = document.getElementById('edit-song-title').value.trim();
    if (!newTitle) { showToast('Title cannot be empty'); return; }
    try {
        if (newTitle !== currentEditingSong.title) {
            await api.editSongTitle(currentEditingSong.id, newTitle);
            showToast('Title updated!');
        }
        if (currentEditThumbnail && currentEditThumbnail !== currentEditingSong.thumbnail) {
            if (currentEditThumbnail.indexOf('data:') === 0 || currentEditThumbnail.indexOf('blob:') === 0) {
                var response = await fetch(currentEditThumbnail);
                var blob = await response.blob();
                var file = new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' });
                await api.editSongThumbnail(currentEditingSong.id, file);
            } else if (currentEditThumbnail !== currentEditingSong.thumbnail) {
                await api.editSongThumbnailUrl(currentEditingSong.id, currentEditThumbnail);
            }
            showToast('Thumbnail updated!');
        }
        if (currentSong && currentSong.id === currentEditingSong.id) {
            currentSong = await api.getSong(currentEditingSong.id);
            var titleEl = document.getElementById('current-song-title');
            if (titleEl) titleEl.textContent = currentSong.title;
        }
        closeEditSongModal();
        loadSongs();
        loadFeed();
        if (currentSong && currentSong.id === currentEditingSong.id) displayTracks();
        showToast('Changes saved!');
    } catch(e) { showToast('Error saving changes: ' + e.message); }
}

async function deleteSongVersion() {
    if (!currentEditingSong) return;
    var confirmed = confirm('Delete "' + currentEditingSong.title + '"? This cannot be undone.');
    if (!confirmed) return;
    try {
        await api.deleteSong(currentEditingSong.id);
        showToast('Song version deleted!');
        closeEditSongModal();
        if (currentSong && currentSong.id === currentEditingSong.id) backToLibrary();
        loadSongs();
        loadFeed();
    } catch(e) { showToast('Error deleting song: ' + e.message); }
}

function randomizeEditThumbnail() {
    var id = Math.floor(Math.random() * 100) + 1;
    var newThumb = 'https://picsum.photos/id/' + id + '/200/200';
    document.getElementById('edit-thumb-preview').src = newThumb;
    currentEditThumbnail = newThumb;
}

// Feed Functions
async function loadFeed() {
    try {
        var feed = await api.getFeed();
        var trendingContainer = document.getElementById('trending-songs');
        if (trendingContainer) {
            if (feed.trendingSongs && feed.trendingSongs.length) {
                var trendingHtml = '';
                for (var i = 0; i < feed.trendingSongs.length; i++) {
                    var song = feed.trendingSongs[i];
                    trendingHtml += '<div class="trending-card" onclick="selectSong(\'' + song.id + '\')">';
                    trendingHtml += '<img src="' + escape(song.thumbnail) + '"><div class="trending-info">';
                    trendingHtml += '<div class="trending-title">' + escape(song.title) + '</div>';
                    trendingHtml += '<div class="trending-creator" onclick="event.stopPropagation(); viewUser(\'' + escape(song.creator) + '\')">' + escape(song.creator) + '</div>';
                    trendingHtml += '<div class="trending-stats">👍 ' + song.likes + ' • 🎵 ' + song.trackCount + ' • 🔀 ' + (song.forkCount || 0) + '</div>';
                    trendingHtml += '</div></div>';
                }
                trendingContainer.innerHTML = trendingHtml;
            } else { trendingContainer.innerHTML = '<div class="loading">No trending tracks</div>'; }
        }
        
        var activityContainer = document.getElementById('activity-feed');
        if (activityContainer) {
            if (feed.activityFeed && feed.activityFeed.length) {
                var activityHtml = '';
                for (var i = 0; i < feed.activityFeed.length; i++) {
                    var item = feed.activityFeed[i];
                    activityHtml += '<div class="activity-item" onclick="selectSong(\'' + item.id + '\')">';
                    activityHtml += '<div class="activity-icon">' + (item.type === 'fork' ? '🔀' : '🆕') + '</div>';
                    activityHtml += '<div class="activity-info">';
                    activityHtml += '<div class="activity-title">' + escape(item.title) + '</div>';
                    activityHtml += '<div class="activity-detail">' + (item.type === 'fork' ? 'Forked from' : 'Created by') + ' ' + escape(item.creator) + ' • ' + item.trackCount + ' tracks</div>';
                    activityHtml += '</div>';
                    activityHtml += '<div class="activity-time">👍 ' + item.likes + '</div>';
                    activityHtml += '</div>';
                }
                activityContainer.innerHTML = activityHtml;
            } else { activityContainer.innerHTML = '<div class="loading">No recent activity</div>'; }
        }
        
        var contributorsContainer = document.getElementById('top-contributors');
        if (contributorsContainer) {
            if (feed.topContributors && feed.topContributors.length) {
                var contributorsHtml = '';
                for (var i = 0; i < feed.topContributors.length; i++) {
                    var user = feed.topContributors[i];
                    contributorsHtml += '<div class="user-card">';
                    contributorsHtml += '<img class="user-avatar" src="' + escape(user.avatar) + '" onclick="viewUser(\'' + escape(user.username) + '\')">';
                    contributorsHtml += '<div class="user-info">';
                    contributorsHtml += '<div class="user-name" onclick="viewUser(\'' + escape(user.username) + '\')">' + escape(user.username) + '</div>';
                    contributorsHtml += '<div class="user-stats">🎵 ' + user.trackCount + ' tracks • 👥 ' + user.followersCount + ' followers</div>';
                    contributorsHtml += '</div>';
                    contributorsHtml += '<button class="follow-small-btn ' + (user.isFollowing ? 'following' : '') + '" onclick="followFromFeed(\'' + escape(user.username) + '\', this)">' + (user.isFollowing ? 'Following' : 'Follow') + '</button>';
                    contributorsHtml += '</div>';
                }
                contributorsContainer.innerHTML = contributorsHtml;
            } else { contributorsContainer.innerHTML = '<div class="loading">No contributors yet</div>'; }
        }
        
        var suggestedContainer = document.getElementById('suggested-users');
        if (suggestedContainer) {
            if (feed.suggestedUsers && feed.suggestedUsers.length) {
                var suggestedHtml = '';
                for (var i = 0; i < feed.suggestedUsers.length; i++) {
                    var user = feed.suggestedUsers[i];
                    suggestedHtml += '<div class="user-card">';
                    suggestedHtml += '<img class="user-avatar" src="' + escape(user.avatar) + '" onclick="viewUser(\'' + escape(user.username) + '\')">';
                    suggestedHtml += '<div class="user-info">';
                    suggestedHtml += '<div class="user-name" onclick="viewUser(\'' + escape(user.username) + '\')">' + escape(user.username) + '</div>';
                    suggestedHtml += '<div class="user-stats">🎵 ' + user.trackCount + ' tracks • 👥 ' + user.followersCount + ' followers</div>';
                    suggestedHtml += '</div>';
                    suggestedHtml += '<button class="follow-small-btn" onclick="followFromFeed(\'' + escape(user.username) + '\', this)">Follow</button>';
                    suggestedHtml += '</div>';
                }
                suggestedContainer.innerHTML = suggestedHtml;
            } else { suggestedContainer.innerHTML = '<div class="loading">No suggestions</div>'; }
        }
    } catch(e) { console.error('Error loading feed:', e); showToast('Error loading feed'); }
}

// Library Functions
async function loadSongs() {
    try {
        var songs = await api.getSongs();
        displaySongList(songs);
    } catch(e) { console.error(e); showToast('Error loading songs'); }
}

async function selectSong(id) {
    try {
        if (isPlaying) stopPlayback();
        if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
        if (audioCtx) await audioCtx.close();
        buffers.clear(); sources = []; gains.clear();
        audioCtx = null;
        currentSong = await api.getSong(id);
        isOwner = (currentSong.creator === currentUser.username);
        
        var titleEl = document.getElementById('current-song-title');
        var creatorEl = document.getElementById('song-creator');
        var versionBadge = document.getElementById('version-badge');
        var bpmInput = document.getElementById('bpm-input');
        var bpmLock = document.getElementById('bpm-lock');
        
        if (titleEl) titleEl.textContent = currentSong.title;
        if (creatorEl) creatorEl.innerHTML = 'Created by <span style="color:#667eea;cursor:pointer" onclick="viewUser(\'' + escape(currentSong.creator) + '\')">' + escape(currentSong.creator) + '</span> • ' + currentSong.genre + ' • ' + currentSong.bpm + ' BPM';
        if (versionBadge) versionBadge.innerHTML = currentSong.parentId ? '🔀 Fork of original' : '📀 Original Version';
        if (bpmInput) { bpmInput.value = currentSong.bpm; bpmInput.disabled = !isOwner; }
        if (bpmLock) { bpmLock.className = 'bpm-lock ' + (isOwner ? 'unlocked' : ''); bpmLock.innerHTML = isOwner ? '🔓' : '🔒'; }
        bpm = currentSong.bpm;
        
        if (socket) socket.emit('join-song', id);
        displayTracks();
        displayComments();
        
        var hasTrack = currentSong.tracks.some(function(t) { return t.username === currentUser.username; });
        var recordBtn = document.getElementById('record-btn');
        var uploadBtn = document.getElementById('upload-btn');
        if (recordBtn) recordBtn.disabled = hasTrack;
        if (uploadBtn) uploadBtn.disabled = hasTrack;
        currentPos = 0;
        updateDisplay(0);
        
        var navItems = document.querySelectorAll('.nav-item');
        for (var i = 0; i < navItems.length; i++) { navItems[i].classList.remove('active'); }
        var views = document.querySelectorAll('.view');
        for (var i = 0; i < views.length; i++) { views[i].classList.remove('active'); }
        var studioView = document.getElementById('studio-view');
        if (studioView) studioView.classList.add('active');
    } catch(e) { showToast('Error loading song'); console.error(e); }
}

function displayTracks() {
    var container = document.getElementById('track-mixer');
    if (!container) return;
    var tracks = currentSong.tracks || [];
    if (tracks.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Add your sound!</div>'; return; }
    
    var html = '';
    for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        var isCurrentUserTrack = (t.username === currentUser.username);
        html += '<div class="track-card ' + (t.muted ? 'muted' : '') + '">';
        html += '<div class="track-row"><div><span class="track-name">🎧 ' + escape(t.username);
        if (isCurrentUserTrack) html += '<span class="your-track"> (Your Track)</span>';
        html += '</span><div class="track-creator" onclick="viewUser(\'' + escape(t.username) + '\')">Added ' + new Date(t.uploadedAt).toLocaleDateString() + '</div></div>';
        html += '<div class="track-votes">👍 ' + (t.votes || 0) + '</div></div>';
        html += '<div class="track-controls">';
        html += '<button class="' + (t.muted ? 'unmute-btn' : 'mute-btn') + '" onclick="toggleMute(\'' + t.id + '\')">' + (t.muted ? '🔊 Unmute' : '🔇 Mute') + '</button>';
        html += '<button class="vote-btn" onclick="voteTrack(\'' + t.id + '\', \'up\')">👍 Upvote</button>';
        html += '<button class="vote-btn" onclick="voteTrack(\'' + t.id + '\', \'down\')">👎 Downvote</button>';
        html += '<input type="range" class="volume-slider" min="0" max="1" step="0.01" value="' + (t.volume || 0.8) + '" onchange="adjustVolume(\'' + t.id + '\', this.value)">';
        if (isCurrentUserTrack) html += '<button class="delete-btn" onclick="deleteTrack(\'' + t.id + '\')">🗑️ Delete</button>';
        html += '</div></div>';
    }
    container.innerHTML = html;
}

async function displayComments() {
    var container = document.getElementById('comments-list');
    if (!container) return;
    var comments = currentSong.comments || [];
    if (comments.length === 0) { container.innerHTML = '<div style="color:#888;text-align:center">No comments yet</div>'; return; }
    
    var html = '';
    for (var i = 0; i < comments.length; i++) {
        var c = comments[i];
        html += '<div class="comment">';
        html += '<strong onclick="viewUser(\'' + escape(c.username) + '\')">' + escape(c.username) + '</strong>';
        html += '<div>' + escape(c.text) + '</div>';
        html += '<small>' + new Date(c.createdAt).toLocaleString() + '</small>';
        html += '<button class="comment-like-btn" onclick="likeComment(\'' + c.id + '\')">❤️ ' + (c.likes || 0) + '</button>';
        html += '</div>';
    }
    container.innerHTML = html;
}

async function likeComment(commentId) {
    try {
        await api.likeComment(commentId, currentSong.id);
        currentSong = await api.getSong(currentSong.id);
        displayComments();
    } catch(e) { showToast('Error liking comment'); }
}

async function postComment() {
    var input = document.getElementById('comment-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    try {
        await api.addComment(currentSong.id, text);
        input.value = '';
        currentSong = await api.getSong(currentSong.id);
        displayComments();
    } catch(e) { showToast('Error posting comment'); }
}

async function toggleMute(id) {
    var track = currentSong.tracks.find(function(t) { return t.id === id; });
    if (track) {
        track.muted = !track.muted;
        if (isPlaying) { var pos = currentPos; pausePlayback(); currentPos = pos; await startPlayback(false); }
        displayTracks();
        await fetch('/api/songs/' + currentSong.id + '/track/' + id, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ muted: track.muted }) });
        if (socket) socket.emit('track-update', { songId: currentSong.id, trackId: id, updates: { muted: track.muted } });
    }
}

async function adjustVolume(id, vol) {
    var track = currentSong.tracks.find(function(t) { return t.id === id; });
    if (track) {
        track.volume = parseFloat(vol);
        var gain = gains.get(id);
        if (gain) gain.gain.value = track.volume;
        await fetch('/api/songs/' + currentSong.id + '/track/' + id, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: track.volume }) });
    }
}

async function voteTrack(id, vote) {
    try {
        var res = await api.voteTrack(currentSong.id, id, vote);
        var track = currentSong.tracks.find(function(t) { return t.id === id; });
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
        var recordBtn = document.getElementById('record-btn');
        var uploadBtn = document.getElementById('upload-btn');
        if (recordBtn) recordBtn.disabled = false;
        if (uploadBtn) uploadBtn.disabled = false;
        loadFeed(); loadSongs();
    } catch(e) { showToast('Error deleting track'); }
}

async function createSong() {
    var title = document.getElementById('new-title').value;
    var b = parseInt(document.getElementById('new-bpm').value);
    var genre = document.getElementById('new-genre').value;
    var thumbPreview = document.getElementById('thumb-preview');
    if (!title) return showToast('Enter a title');
    if (isNaN(b)) b = 120;
    b = Math.min(300, Math.max(40, b));
    var thumbnail = thumbPreview ? thumbPreview.src : null;
    try {
        var song = await api.createSong({ title: title, bpm: b, genre: genre, thumbnail: (thumbnail && thumbnail.indexOf('picsum') !== -1) ? thumbnail : null });
        showToast('Song created!');
        document.getElementById('create-modal').style.display = 'none';
        document.getElementById('new-title').value = '';
        loadSongs(); loadFeed(); selectSong(song.id);
    } catch(e) { showToast('Error creating song'); }
}

async function forkSong() {
    var newTitle = document.getElementById('fork-new-title').value;
    if (!newTitle) return showToast('Enter a title for your fork');
    try {
        var song = await api.createSong({ title: newTitle, bpm: currentSong.bpm, genre: currentSong.genre, parentId: currentSong.id });
        showToast('Fork created! You can now add your track.');
        document.getElementById('fork-modal').style.display = 'none';
        document.getElementById('fork-new-title').value = '';
        loadSongs(); loadFeed(); selectSong(song.id);
    } catch(e) { showToast('Error creating fork'); }
}

async function uploadTrackFile() {
    var fileInput = document.getElementById('audio-file');
    if (!fileInput || !fileInput.files[0]) return showToast('Select a file');
    var file = fileInput.files[0];
    if (currentSong.tracks.some(function(t) { return t.username === currentUser.username; })) return showToast('You already have a track! Fork this song to add another.');
    try {
        await api.uploadTrack(currentSong.id, file);
        showToast('Track uploaded!');
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        var recordBtn = document.getElementById('record-btn');
        var uploadBtn = document.getElementById('upload-btn');
        if (recordBtn) recordBtn.disabled = true;
        if (uploadBtn) uploadBtn.disabled = true;
        loadFeed();
    } catch(e) { showToast('Error uploading track'); }
}

async function updateBpm() {
    var input = document.getElementById('bpm-input');
    if (!input) return;
    var newBpm = parseInt(input.value);
    if (isNaN(newBpm)) return;
    if (!isOwner) { showToast('Only the version owner can change BPM'); input.value = bpm; return; }
    var clampedBpm = Math.min(300, Math.max(40, newBpm));
    try {
        await api.updateBpm(currentSong.id, clampedBpm);
        bpm = clampedBpm;
        showToast('BPM updated');
    } catch(e) { showToast('Error updating BPM'); }
}

function backToLibrary() {
    if (isPlaying) stopPlayback();
    if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
    if (audioCtx) audioCtx.close();
    if (socket && currentSong) socket.emit('leave-song', currentSong.id);
    currentSong = null;
    var navItems = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navItems.length; i++) { navItems[i].classList.remove('active'); }
    var libraryNav = document.querySelector('.nav-item[data-view="library"]');
    if (libraryNav) libraryNav.classList.add('active');
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) { views[i].classList.remove('active'); }
    var libraryView = document.getElementById('library-view');
    if (libraryView) libraryView.classList.add('active');
    loadSongs();
}

// Profile Functions
async function loadProfile() {
    var container = document.getElementById('profile-content');
    if (!container) return;
    try {
        var user = await api.getUser(currentUser.username);
        container.innerHTML = '<div class="profile-header"><img class="profile-avatar" src="' + escape(user.avatar) + '"><h2>' + escape(user.username) + '</h2>';
        container.innerHTML += '<p class="profile-bio">' + escape(user.bio || 'Music creator on TrackStars') + '</p>';
        container.innerHTML += '<button class="edit-profile-btn" id="edit-profile-btn">✏️ Edit Profile</button>';
        container.innerHTML += '<div class="stats-row"><div><span>' + (user.followers?.length || 0) + '</span><label>Followers</label></div>';
        container.innerHTML += '<div><span>' + (user.following?.length || 0) + '</span><label>Following</label></div>';
        container.innerHTML += '<div><span>' + (user.contributedTo?.length || 0) + '</span><label>Tracks</label></div></div></div>';
        container.innerHTML += '<div><h3>My Tracks</h3><div id="my-tracks-list"></div></div>';
        
        var songs = await api.getSongs();
        var mySongs = songs.filter(function(s) { return s.creator === currentUser.username; });
        var tracksDiv = document.getElementById('my-tracks-list');
        if (tracksDiv) {
            if (mySongs.length === 0) tracksDiv.innerHTML = '<div class="loading">No tracks yet</div>';
            else {
                var tracksHtml = '';
                for (var i = 0; i < mySongs.length; i++) {
                    var s = mySongs[i];
                    tracksHtml += '<div class="song-card" onclick="selectSong(\'' + s.id + '\')"><img class="song-thumb" src="' + s.thumbnail + '"><div class="song-info"><div class="song-title">' + escape(s.title) + '</div><div class="song-stats">🎵 ' + s.trackCount + ' tracks | 👍 ' + s.likes + '</div></div></div>';
                }
                tracksDiv.innerHTML = tracksHtml;
            }
        }
        document.getElementById('edit-profile-btn').onclick = openProfileModal;
    } catch(e) { container.innerHTML = '<div class="loading">Error loading profile</div>'; }
}

async function openProfileModal() {
    try {
        var user = await api.getUser(currentUser.username);
        document.getElementById('edit-avatar').src = user.avatar;
        document.getElementById('edit-bio').value = user.bio || '';
        document.getElementById('edit-followers').textContent = user.followers?.length || 0;
        document.getElementById('edit-following').textContent = user.following?.length || 0;
        document.getElementById('edit-tracks').textContent = user.contributedTo?.length || 0;
        document.getElementById('profile-modal').style.display = 'flex';
    } catch(e) { showToast('Error loading profile'); }
}

async function saveProfile() {
    var bio = document.getElementById('edit-bio').value;
    try {
        await api.updateBio(bio);
        showToast('Profile updated');
        document.getElementById('profile-modal').style.display = 'none';
        loadProfile();
    } catch(e) { showToast('Error saving profile'); }
}

async function uploadAvatar(file) {
    try {
        var res = await api.uploadAvatar(file);
        currentUser.avatar = res.avatar;
        document.getElementById('header-avatar').src = res.avatar;
        showToast('Avatar updated');
    } catch(e) { showToast('Error uploading avatar'); }
}

// Chat Functions
async function loadRecentChats() {
    var container = document.getElementById('chat-recent');
    var searchInput = document.getElementById('chat-search-input');
    if (!container) return;
    
    var loadChats = async function(searchTerm) {
        if (searchTerm === undefined) searchTerm = '';
        try {
            var users = [];
            if (searchTerm) {
                users = await api.searchUsers(searchTerm);
                if (users.length === 0) { container.innerHTML = '<div class="loading">No users found</div>'; return; }
                var html = '';
                for (var i = 0; i < users.length; i++) {
                    var u = users[i];
                    html += '<div class="chat-user-item" onclick="startChat(\'' + escape(u.username) + '\')"><img src="' + escape(u.avatar) + '"><div class="chat-user-info"><div class="chat-user-name">' + escape(u.username) + '</div><div class="chat-preview">' + u.followersCount + ' followers</div></div></div>';
                }
                container.innerHTML = html;
            } else {
                var chats = await api.getRecentChats();
                if (chats.length === 0) { container.innerHTML = '<div class="loading">No recent chats. Search for users above!</div>'; return; }
                var html = '';
                for (var i = 0; i < chats.length; i++) {
                    var c = chats[i];
                    html += '<div class="chat-user-item" onclick="startChat(\'' + escape(c.otherUser) + '\')"><img src="' + escape(c.avatar) + '"><div class="chat-user-info"><div class="chat-user-name">' + escape(c.otherUser) + '</div><div class="chat-preview">' + escape(c.text.substring(0, 30)) + '</div></div><div class="chat-time">' + new Date(c.timestamp).toLocaleTimeString() + '</div></div>';
                }
                container.innerHTML = html;
            }
        } catch(e) { container.innerHTML = '<div class="loading">Error loading chats</div>'; }
    };
    
    await loadChats('');
    if (searchInput) searchInput.oninput = function() { loadChats(searchInput.value); };
}

async function startChat(username) {
    currentChatUser = username;
    document.getElementById('chat-recent').style.display = 'none';
    document.getElementById('chat-conversation').style.display = 'flex';
    document.getElementById('chat-with').textContent = username;
    await loadConversation(username);
}

async function loadConversation(username) {
    try {
        var msgs = await api.getMessages(username);
        var container = document.getElementById('chat-messages');
        if (!container) return;
        var html = '';
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            html += '<div class="message ' + (m.from === currentUser.username ? 'sent' : 'received') + '"><div>' + escape(m.text) + '</div><div class="message-time">' + new Date(m.timestamp).toLocaleTimeString() + '</div></div>';
        }
        container.innerHTML = html;
        container.scrollTop = container.scrollHeight;
    } catch(e) { console.error(e); }
}

async function sendChatMessage() {
    var input = document.getElementById('chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !currentChatUser) return;
    try {
        await api.sendMessage(currentChatUser, text);
        input.value = '';
        await loadConversation(currentChatUser);
        loadRecentChats();
    } catch(e) { showToast('Error sending message'); }
}

function backToRecent() {
    document.getElementById('chat-conversation').style.display = 'none';
    document.getElementById('chat-recent').style.display = 'block';
    currentChatUser = null;
    loadRecentChats();
}

async function viewUser(username) {
    try {
        var user = await api.getUser(username);
        var isFollowing = currentUser.following ? currentUser.following.indexOf(username) !== -1 : false;
        var modal = document.getElementById('user-modal');
        var modalContent = document.getElementById('user-modal-content');
        if (!modal || !modalContent) return;
        modalContent.innerHTML = '<div class="user-profile-detail"><img class="view-avatar" src="' + escape(user.avatar) + '"><h2>' + escape(user.username) + '</h2>';
        modalContent.innerHTML += '<p class="view-bio">' + escape(user.bio || 'Music creator') + '</p>';
        modalContent.innerHTML += '<div><button class="follow-btn ' + (isFollowing ? 'following' : '') + '" onclick="followUser(\'' + escape(username) + '\', this)">' + (isFollowing ? 'Following' : 'Follow') + '</button>';
        modalContent.innerHTML += '<button class="message-btn" onclick="startChat(\'' + escape(username) + '\'); document.getElementById(\'user-modal\').style.display = \'none\';">💬 Message</button></div>';
        modalContent.innerHTML += '<div class="stats-row"><div><span>' + (user.followers?.length || 0) + '</span><label>Followers</label></div>';
        modalContent.innerHTML += '<div><span>' + (user.following?.length || 0) + '</span><label>Following</label></div>';
        modalContent.innerHTML += '<div><span>' + (user.contributedTo?.length || 0) + '</span><label>Tracks</label></div></div>';
        modalContent.innerHTML += '<div><h4>🎵 Tracks</h4><div id="user-tracks-list"></div></div></div>';
        
        var songs = await api.getSongs();
        var userSongs = songs.filter(function(s) { return (user.contributedTo && user.contributedTo.indexOf(s.id) !== -1) || s.creator === username; });
        var tracksDiv = document.getElementById('user-tracks-list');
        if (tracksDiv) {
            if (userSongs.length === 0) tracksDiv.innerHTML = '<div style="color:#888;text-align:center">No tracks yet</div>';
            else {
                var tracksHtml = '';
                for (var i = 0; i < userSongs.length; i++) {
                    var s = userSongs[i];
                    tracksHtml += '<div class="song-card" onclick="selectSong(\'' + s.id + '\'); document.getElementById(\'user-modal\').style.display = \'none\';"><img class="song-thumb" src="' + s.thumbnail + '"><div class="song-info"><div class="song-title">' + escape(s.title) + '</div><div class="song-stats">🎵 ' + s.trackCount + ' tracks</div></div></div>';
                }
                tracksDiv.innerHTML = tracksHtml;
            }
        }
        modal.style.display = 'flex';
    } catch(e) { showToast('Error loading profile'); }
}

async function followUser(username, btn) {
    try {
        var res = await api.followUser(username);
        if (res.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast('Following ' + username); }
        else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast('Unfollowed ' + username); }
        loadFeed();
    } catch(e) { showToast('Error following user'); }
}

async function followFromFeed(username, btn) {
    try {
        var res = await api.followUser(username);
        if (res.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast('Following ' + username); }
        else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast('Unfollowed ' + username); }
        loadFeed();
    } catch(e) { showToast('Error following user'); }
}

async function showTutorial() {
    if (currentUser.tutorialCompleted) return;
    var tutorialOverlay = document.getElementById('tutorial-overlay');
    if (!tutorialOverlay) return;
    tutorialOverlay.style.display = 'flex';
    var finishBtn = document.getElementById('tutorial-finish');
    if (finishBtn) {
        finishBtn.onclick = async function() { 
            await api.updateTutorial(); 
            currentUser.tutorialCompleted = true; 
            tutorialOverlay.style.display = 'none'; 
        };
    }
}

function initSocket() {
    socket = io();
    socket.on('connect', function() { console.log('Socket connected'); });
    socket.on('track-added', async function(data) { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); loadFeed(); });
    socket.on('track-deleted', async function(data) { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); loadFeed(); });
    socket.on('track-updated', function(data) { if (currentSong) { var t = currentSong.tracks.find(function(tr) { return tr.id === data.trackId; }); if (t && data.updates) { if (data.updates.muted !== undefined) t.muted = data.updates.muted; if (data.updates.volume !== undefined) t.volume = data.updates.volume; displayTracks(); } } });
    socket.on('transport-state', function(state) { if (state.bpm && state.bpm !== bpm && currentSong && !isOwner) { bpm = state.bpm; var bpmInput = document.getElementById('bpm-input'); if (bpmInput) bpmInput.value = bpm; } });
    socket.on('bpm-changed', function(data) { if (currentSong && !isOwner) { bpm = data.bpm; var bpmInput = document.getElementById('bpm-input'); if (bpmInput) bpmInput.value = bpm; } });
    socket.on('new-message', function(msg) { if (currentChatUser === msg.from) loadConversation(msg.from); showToast('New message from ' + msg.from); loadRecentChats(); });
    socket.on('new-comment', function() { if (currentSong) displayComments(); });
    socket.on('song-updated', function() { if (currentSong) { loadSongs(); loadFeed(); } });
    socket.on('song-deleted', function() { if (currentSong) backToLibrary(); loadSongs(); loadFeed(); });
    socket.emit('join-chat', currentUser.username);
}

function initNav() {
    var navItems = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navItems.length; i++) {
        var btn = navItems[i];
        btn.onclick = function() {
            var view = this.dataset.view;
            var navs = document.querySelectorAll('.nav-item');
            for (var j = 0; j < navs.length; j++) { navs[j].classList.remove('active'); }
            this.classList.add('active');
            var views = document.querySelectorAll('.view');
            for (var j = 0; j < views.length; j++) { views[j].classList.remove('active'); }
            var targetView = document.getElementById(view + '-view');
            if (targetView) targetView.classList.add('active');
            if (view === 'profile') loadProfile();
            if (view === 'social') { loadRecentChats(); var chatRecent = document.getElementById('chat-recent'); var chatConversation = document.getElementById('chat-conversation'); if (chatRecent) chatRecent.style.display = 'block'; if (chatConversation) chatConversation.style.display = 'none'; }
            if (view === 'library') loadSongs();
            if (view === 'feed') loadFeed();
        };
    }
}

function randomizeThumbPreview() {
    var id = Math.floor(Math.random() * 100) + 1;
    var thumbPreview = document.getElementById('thumb-preview');
    if (thumbPreview) thumbPreview.src = 'https://picsum.photos/id/' + id + '/200/200';
}

function escape(str) { 
    if (!str) return ''; 
    var d = document.createElement('div'); 
    d.textContent = str; 
    return d.innerHTML; 
}

function showToast(msg, duration) {
    if (duration === undefined) duration = 3000;
    var toast = document.querySelector('.toast'); 
    if (toast) toast.remove(); 
    toast = document.createElement('div'); 
    toast.className = 'toast'; 
    toast.textContent = msg; 
    document.body.appendChild(toast); 
    setTimeout(function() { toast.remove(); }, duration); 
}

function setupEventListeners() {
    var authTabs = document.querySelectorAll('.auth-tab');
    for (var i = 0; i < authTabs.length; i++) {
        authTabs[i].onclick = function() {
            var tab = this.dataset.tab;
            var tabs = document.querySelectorAll('.auth-tab');
            for (var j = 0; j < tabs.length; j++) { tabs[j].classList.remove('active'); }
            var forms = document.querySelectorAll('.auth-form');
            for (var j = 0; j < forms.length; j++) { forms[j].classList.remove('active'); }
            this.classList.add('active');
            var form = document.getElementById(tab + '-form');
            if (form) form.classList.add('active');
        };
    }
    
    var loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.onsubmit = async function(e) { 
            e.preventDefault();
            try { 
                await login(document.getElementById('login-username').value, document.getElementById('login-password').value);
                document.getElementById('auth-modal').style.display = 'none';
                document.getElementById('main-app').style.display = 'block';
                document.getElementById('current-user').textContent = currentUser.username;
                document.getElementById('header-avatar').src = currentUser.avatar;
                initSocket(); 
                loadSongs(); 
                loadFeed(); 
                initNav(); 
                showTutorial();
            } catch(err) { 
                document.getElementById('login-error').textContent = err.message;
            }
        };
    }
    
    var registerForm = document.getElementById('register-form');
    if (registerForm) {
        registerForm.onsubmit = async function(e) { 
            e.preventDefault();
            try { 
                await register(document.getElementById('reg-username').value, document.getElementById('reg-email').value, document.getElementById('reg-password').value, document.getElementById('reg-confirm').value);
                document.getElementById('auth-modal').style.display = 'none';
                document.getElementById('main-app').style.display = 'block';
                document.getElementById('current-user').textContent = currentUser.username;
                document.getElementById('header-avatar').src = currentUser.avatar;
                initSocket(); 
                loadSongs(); 
                loadFeed(); 
                initNav(); 
                showTutorial();
            } catch(err) { 
                document.getElementById('register-error').textContent = err.message;
            }
        };
    }
    
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.onclick = logout;
    
    var headerAvatar = document.getElementById('header-avatar');
    if (headerAvatar) headerAvatar.onclick = openProfileModal;
    var usernameSpan = document.querySelector('.username');
    if (usernameSpan) usernameSpan.onclick = openProfileModal;
    
    var closeModal = document.querySelector('.close-modal');
    if (closeModal) closeModal.onclick = function() { var modal = document.getElementById('profile-modal'); if (modal) modal.style.display = 'none'; };
    
    var saveProfileBtn = document.getElementById('save-profile');
    if (saveProfileBtn) saveProfileBtn.onclick = saveProfile;
    
    var changeAvatarBtn = document.getElementById('change-avatar');
    if (changeAvatarBtn) {
        changeAvatarBtn.onclick = function() {
            var avatarFile = document.getElementById('avatar-file');
            if (avatarFile) avatarFile.click();
        };
    }
    var avatarFile = document.getElementById('avatar-file');
    if (avatarFile) avatarFile.onchange = function(e) { if (e.target.files[0]) uploadAvatar(e.target.files[0]); };
    
    var openCreateModal = document.getElementById('open-create-modal');
    if (openCreateModal) openCreateModal.onclick = function() { randomizeThumbPreview(); var modal = document.getElementById('create-modal'); if (modal) modal.style.display = 'flex'; };
    var confirmCreate = document.getElementById('confirm-create');
    if (confirmCreate) confirmCreate.onclick = createSong;
    var cancelCreate = document.getElementById('cancel-create');
    if (cancelCreate) cancelCreate.onclick = function() { var modal = document.getElementById('create-modal'); if (modal) modal.style.display = 'none'; };
    
    var randomThumb = document.getElementById('random-thumb');
    if (randomThumb) randomThumb.onclick = randomizeThumbPreview;
    
    var uploadThumbBtn = document.getElementById('upload-thumb-btn');
    if (uploadThumbBtn) {
        uploadThumbBtn.onclick = function() {
            var thumbFile = document.getElementById('thumb-file');
            if (thumbFile) thumbFile.click();
        };
    }
    var thumbFile = document.getElementById('thumb-file');
    if (thumbFile) {
        thumbFile.onchange = function(e) {
            if (e.target.files[0]) {
                var reader = new FileReader();
                reader.onload = function(ev) {
                    var thumbPreview = document.getElementById('thumb-preview');
                    if (thumbPreview) thumbPreview.src = ev.target.result;
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        };
    }
    
    var playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.onclick = function() { isPlaying ? pausePlayback() : startPlayback(false); };
    var stopBtn = document.getElementById('stop-btn');
    if (stopBtn) stopBtn.onclick = stopPlayback;
    var bpmInput = document.getElementById('bpm-input');
    if (bpmInput) bpmInput.onchange = updateBpm;
    
    var recordBtn = document.getElementById('record-btn');
    if (recordBtn) recordBtn.onclick = startRecordingWithPlayback;
    var stopRecordBtn = document.getElementById('stop-record-btn');
    if (stopRecordBtn) stopRecordBtn.onclick = stopRecordingAndPlayback;
    var uploadBtn = document.getElementById('upload-btn');
    if (uploadBtn) uploadBtn.onclick = function() { var audioFile = document.getElementById('audio-file'); if (audioFile) audioFile.click(); };
    var audioFile = document.getElementById('audio-file');
    if (audioFile) audioFile.onchange = uploadTrackFile;
    
    var backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.onclick = backToLibrary;
    
    var forkBtn = document.getElementById('fork-song-btn');
    if (forkBtn) {
        forkBtn.onclick = function() {
            var forkTitle = document.getElementById('fork-title');
            if (forkTitle && currentSong) forkTitle.textContent = currentSong.title;
            var forkModal = document.getElementById('fork-modal');
            if (forkModal) forkModal.style.display = 'flex';
        };
    }
    var confirmFork = document.getElementById('confirm-fork');
    if (confirmFork) confirmFork.onclick = forkSong;
    var cancelFork = document.getElementById('cancel-fork');
    if (cancelFork) cancelFork.onclick = function() { var modal = document.getElementById('fork-modal'); if (modal) modal.style.display = 'none'; };
    
    var postCommentBtn = document.getElementById('post-comment');
    if (postCommentBtn) postCommentBtn.onclick = postComment;
    var commentInput = document.getElementById('comment-input');
    if (commentInput) commentInput.onkeypress = function(e) { if (e.key === 'Enter') postComment(); };
    
    var backToRecentBtn = document.getElementById('back-to-recent');
    if (backToRecentBtn) backToRecentBtn.onclick = backToRecent;
    var sendChatBtn = document.getElementById('send-chat');
    if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
    var chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.onkeypress = function(e) { if (e.key === 'Enter') sendChatMessage(); };
    
    var closeUserModal = document.querySelector('.close-user-modal');
    if (closeUserModal) closeUserModal.onclick = function() { var modal = document.getElementById('user-modal'); if (modal) modal.style.display = 'none'; };
    var userModal = document.getElementById('user-modal');
    if (userModal) userModal.onclick = function(e) { if (e.target === userModal) userModal.style.display = 'none'; };
    var profileModal = document.getElementById('profile-modal');
    if (profileModal) profileModal.onclick = function(e) { if (e.target === profileModal) profileModal.style.display = 'none'; };
    var createModal = document.getElementById('create-modal');
    if (createModal) createModal.onclick = function(e) { if (e.target === createModal) createModal.style.display = 'none'; };
    var forkModal = document.getElementById('fork-modal');
    if (forkModal) forkModal.onclick = function(e) { if (e.target === forkModal) forkModal.style.display = 'none'; };
    
    // Edit Song Modal Listeners
    var closeEditBtn = document.querySelector('.close-edit-modal');
    if (closeEditBtn) closeEditBtn.onclick = closeEditSongModal;
    var saveSongChangesBtn = document.getElementById('save-song-changes');
    if (saveSongChangesBtn) saveSongChangesBtn.onclick = saveSongChanges;
    var deleteSongVersionBtn = document.getElementById('delete-song-version');
    if (deleteSongVersionBtn) deleteSongVersionBtn.onclick = deleteSongVersion;
    var editRandomThumb = document.getElementById('edit-random-thumb');
    if (editRandomThumb) editRandomThumb.onclick = randomizeEditThumbnail;
    var editUploadThumb = document.getElementById('edit-upload-thumb');
    if (editUploadThumb) {
        editUploadThumb.onclick = function() {
            var editThumbFile = document.getElementById('edit-thumb-file');
            if (editThumbFile) editThumbFile.click();
        };
    }
    var editThumbFile = document.getElementById('edit-thumb-file');
    if (editThumbFile) {
        editThumbFile.addEventListener('change', function(e) {
            if (e.target.files[0]) {
                var reader = new FileReader();
                reader.onload = function(ev) {
                    document.getElementById('edit-thumb-preview').src = ev.target.result;
                    currentEditThumbnail = ev.target.result;
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        });
    }
    var editModal = document.getElementById('edit-song-modal');
    if (editModal) editModal.onclick = function(e) { if (e.target === editModal) closeEditSongModal(); };
}

document.addEventListener('DOMContentLoaded', function() {
    var savedToken = localStorage.getItem('token');
    var savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
        token = savedToken;
        currentUser = JSON.parse(savedUser);
        document.getElementById('auth-modal').style.display = 'none';
        document.getElementById('main-app').style.display = 'block';
        document.getElementById('current-user').textContent = currentUser.username;
        document.getElementById('header-avatar').src = currentUser.avatar;
        initSocket();
        loadSongs();
        loadFeed();
        initNav();
        setupEventListeners();
        showTutorial();
    } else {
        document.getElementById('auth-modal').style.display = 'flex';
        setupEventListeners();
    }
});

// Make functions global
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
window.openEditSongModal = openEditSongModal;