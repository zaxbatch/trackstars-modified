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
let activeChat = null;

const thumbnailOptions = [
    'https://picsum.photos/id/29/400/400',
    'https://picsum.photos/id/30/400/400',
    'https://picsum.photos/id/42/400/400',
    'https://picsum.photos/id/96/400/400',
    'https://picsum.photos/id/155/400/400',
    'https://picsum.photos/id/169/400/400',
    'https://picsum.photos/id/176/400/400',
    'https://picsum.photos/id/20/400/400',
    'https://picsum.photos/id/26/400/400',
    'https://picsum.photos/id/28/400/400'
];

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
            console.error(`API Error:`, error);
            throw error;
        }
    },
    getSongs() { return this.request('/api/songs'); },
    getSong(id) { return this.request(`/api/songs/${id}`); },
    getSongVersions(id) { return this.request(`/api/songs/${id}/versions`); },
    createSong(data) { return this.request('/api/songs', { method: 'POST', body: JSON.stringify(data) }); },
    updateBpm(songId, bpm) { return this.request(`/api/songs/${songId}/bpm`, { method: 'PUT', body: JSON.stringify({ bpm }) }); },
    updateThumbnail(songId, file) {
        const formData = new FormData();
        formData.append('thumbnail', file);
        return fetch(`/api/songs/${songId}/thumbnail`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData }).then(r => r.json());
    },
    updateThumbnailUrl(songId, url) {
        return this.request(`/api/songs/${songId}/thumbnail`, { method: 'POST', body: JSON.stringify({ thumbnailUrl: url }) });
    },
    uploadTrack(songId, file) {
        const formData = new FormData();
        formData.append('audio', file);
        return fetch(`/api/songs/${songId}/track`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData }).then(r => r.json());
    },
    deleteTrack(songId, trackId) { return this.request(`/api/songs/${songId}/track/${trackId}`, { method: 'DELETE' }); },
    voteTrack(songId, trackId, vote) { return this.request(`/api/songs/${songId}/track/${trackId}/vote`, { method: 'POST', body: JSON.stringify({ vote }) }); },
    addComment(songId, text) { return this.request(`/api/songs/${songId}/comment`, { method: 'POST', body: JSON.stringify({ text }) }); },
    getConversations() { return this.request('/api/conversations'); },
    getMessages(username) { return this.request(`/api/messages/${username}`); },
    sendMessage(to, text) { return this.request('/api/messages', { method: 'POST', body: JSON.stringify({ to, text }) }); },
    markMessagesRead(from) { return this.request('/api/messages/read', { method: 'POST', body: JSON.stringify({ from }) }); },
    searchUsers(q) { return this.request(`/api/users/search?q=${encodeURIComponent(q)}`); },
    followUser(username) { return this.request(`/api/users/${username}/follow`, { method: 'POST' }); },
    unfollowUser(username) { return this.request(`/api/users/${username}/unfollow`, { method: 'POST' }); },
    completeTutorial() { return this.request('/api/users/tutorial', { method: 'POST' }); }
};

async function register(username, email, password, confirm) {
    if (password !== confirm) throw new Error('Passwords do not match');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, email, password }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    return true;
}

async function login(username, password) {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
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
    if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
    if (currentAudioContext) { currentAudioContext.close(); currentAudioContext = null; }
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.reload();
}

async function initAudioContext() {
    if (currentAudioContext) return currentAudioContext;
    currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    return currentAudioContext;
}

async function loadTrackAudio(audioUrl) {
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    return await currentAudioContext.decodeAudioData(arrayBuffer);
}

async function loadAllTracks() {
    if (!currentSong) return;
    currentBuffers.clear();
    for (const track of currentSong.tracks) {
        try {
            const buffer = await loadTrackAudio(track.audioUrl);
            currentBuffers.set(track.id, buffer);
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
    if (recordMode && userHasTrack) { alert('You already have a track in this version!'); return false; }
    await loadAllTracks();
    if (currentAudioContext.state === 'suspended') await currentAudioContext.resume();
    isPlaying = true;
    startTime = currentAudioContext.currentTime - currentPosition;
    for (const track of currentSong.tracks) { if (!track.muted) scheduleTrack(track, currentPosition); }
    if (recordMode) await startAudioRecording();
    updateTransportUI('play');
    startPositionTimer();
    return true;
}

function pausePlayback() {
    if (!isPlaying) return;
    isPlaying = false;
    if (isRecording) stopAudioRecording();
    for (const source of currentSources) { try { source.stop(); } catch(e) {} }
    currentSources = [];
    currentGains.clear();
    currentPosition = currentAudioContext.currentTime - startTime;
    updateTransportUI('pause');
    stopPositionTimer();
}

function stopPlayback() {
    if (isPlaying) { if (isRecording) stopAudioRecording(); pausePlayback(); }
    currentPosition = 0;
    updatePositionDisplay(0);
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
            if (audioChunks.length === 0) { document.getElementById('recording-status').innerHTML = '❌ No audio was recorded'; return; }
            const audioBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
            const file = new File([audioBlob], `recording-${Date.now()}.webm`, { type: 'audio/webm' });
            document.getElementById('recording-status').innerHTML = '⏳ Uploading...';
            try {
                await api.uploadTrack(currentSong.id, file);
                alert('Track added successfully!');
                await new Promise(r => setTimeout(r, 500));
                currentSong = await api.getSong(currentSong.id);
                displayTracks();
                document.getElementById('recording-status').innerHTML = '✅ Track added!';
                document.getElementById('record-btn').disabled = true;
                document.getElementById('upload-btn').disabled = true;
                setTimeout(() => { document.getElementById('recording-status').innerHTML = ''; }, 3000);
            } catch (error) {
                document.getElementById('recording-status').innerHTML = '❌ Upload failed';
            }
            if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
            audioChunks = [];
        };
        mediaRecorder.start(1000);
        isRecording = true;
        document.getElementById('record-btn').style.display = 'none';
        document.getElementById('stop-record-btn').style.display = 'inline-block';
        document.getElementById('recording-status').innerHTML = '🔴 RECORDING...';
    } catch (error) {
        alert('Could not access microphone. Please check permissions.');
        document.getElementById('record-btn').style.display = 'inline-block';
        document.getElementById('stop-record-btn').style.display = 'none';
        if (isPlaying) pausePlayback();
    }
}

function stopAudioRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        isRecording = false;
        document.getElementById('record-btn').style.display = 'inline-block';
        document.getElementById('stop-record-btn').style.display = 'none';
    }
}

async function startRecordingWithPlayback() {
    if (!currentSong) { alert('Select a song first'); return; }
    if (isRecording) { alert('Already recording!'); return; }
    const userHasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
    if (userHasTrack) { alert('You already have a track in this version!'); return; }
    if (isPlaying) { stopPlayback(); await new Promise(r => setTimeout(r, 200)); }
    currentPosition = 0;
    updatePositionDisplay(0);
    await new Promise(r => setTimeout(r, 100));
    await startPlayback(true);
}

async function deleteTrack(trackId) {
    const track = currentSong.tracks.find(t => t.id === trackId);
    if (!track || track.username !== currentUser.username) { alert('You can only delete your own tracks!'); return; }
    if (!confirm('Delete your track? This cannot be undone.')) return;
    try {
        await api.deleteTrack(currentSong.id, trackId);
        alert('Track deleted!');
        await new Promise(r => setTimeout(r, 500));
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        document.getElementById('record-btn').disabled = false;
        document.getElementById('upload-btn').disabled = false;
    } catch (error) { alert('Error deleting track'); }
}

async function uploadTrack() {
    const fileInput = document.getElementById('audio-file');
    const file = fileInput.files[0];
    if (!file) { alert('Select an audio file'); return; }
    if (currentSong.tracks.some(t => t.username === currentUser.username)) { alert('You already have a track in this version!'); return; }
    document.getElementById('recording-status').innerHTML = '⏳ Uploading...';
    try {
        await api.uploadTrack(currentSong.id, file);
        alert('Track uploaded!');
        fileInput.value = '';
        await new Promise(r => setTimeout(r, 500));
        currentSong = await api.getSong(currentSong.id);
        displayTracks();
        document.getElementById('recording-status').innerHTML = '✅ Uploaded!';
        document.getElementById('record-btn').disabled = true;
        document.getElementById('upload-btn').disabled = true;
        setTimeout(() => { document.getElementById('recording-status').innerHTML = ''; }, 3000);
    } catch (error) { document.getElementById('recording-status').innerHTML = '❌ Upload failed'; }
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
    if (action === 'play') { playBtn.textContent = '⏸ Pause'; playBtn.className = 'pause-btn'; }
    else { playBtn.textContent = '▶ Play'; playBtn.className = 'play-btn'; }
}

async function updateBpm(newBpm) {
    if (!currentSong) return;
    const isOwner = currentSong.creator === currentUser.username;
    if (!isOwner) { alert('Only the version owner can change BPM'); document.getElementById('bpm-input').value = currentSong.bpm; return; }
    newBpm = Math.min(300, Math.max(40, parseInt(newBpm)));
    try {
        await api.updateBpm(currentSong.id, newBpm);
        currentSong.bpm = newBpm;
        bpm = newBpm;
    } catch (error) { alert('Failed to update BPM'); document.getElementById('bpm-input').value = currentSong.bpm; }
}

async function loadSongs() {
    if (isRefreshing) return;
    try {
        const songs = await api.getSongs();
        displaySongList(songs);
    } catch (error) { setTimeout(() => loadSongs(), 2000); }
}

function displaySongList(songs) {
    const container = document.getElementById('song-list');
    if (songs.length === 0) { container.innerHTML = '<div style="text-align: center; padding: 20px;">No songs yet. Create the first one!</div>'; return; }
    container.innerHTML = songs.map(song => `
        <div class="song-item" onclick="selectSong('${song.id}')">
            <img class="song-thumbnail" src="${song.thumbnail}" onerror="this.src='https://picsum.photos/id/20/50/50'">
            <div class="song-info">
                <div class="song-title">${escapeHtml(song.title)} <span class="version-badge">v${song.version}</span></div>
                <div class="song-creator">by ${escapeHtml(song.creator)}</div>
                <div class="song-stats">🎵 ${song.trackCount} tracks | 👍 ${song.upvotes} votes</div>
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
        if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
        if (currentAudioContext) { await currentAudioContext.close(); currentAudioContext = null; }
        currentBuffers.clear();
        currentSources = [];
        currentGains.clear();
        currentSong = await api.getSong(songId);
        document.getElementById('daw-area').style.display = 'flex';
        document.getElementById('current-song-title').innerHTML = `${escapeHtml(currentSong.title)} <span class="version-badge">v${currentSong.version}</span>`;
        document.getElementById('song-creator').textContent = `Created by ${currentSong.creator} • ${currentSong.genre} • ${currentSong.bpm} BPM`;
        const bpmInput = document.getElementById('bpm-input');
        bpmInput.value = currentSong.bpm;
        bpmInput.disabled = currentSong.creator !== currentUser.username;
        bpm = currentSong.bpm;
        socket.emit('join-song', songId);
        displayTracks();
        displayComments();
        const userTrack = currentSong.tracks.find(t => t.username === currentUser.username);
        document.getElementById('record-btn').disabled = !!userTrack;
        document.getElementById('upload-btn').disabled = !!userTrack;
        document.getElementById('record-btn').style.display = 'inline-block';
        document.getElementById('stop-record-btn').style.display = 'none';
        isPlaying = false;
        currentPosition = 0;
        updatePositionDisplay(0);
    } catch (error) { console.error(error); alert('Error loading song'); }
    finally { isRefreshing = false; }
}

function displayTracks() {
    const container = document.getElementById('track-mixer');
    const tracks = currentSong.tracks;
    if (tracks.length === 0) { container.innerHTML = '<div style="text-align: center; padding: 40px; color: #888;">✨ No tracks yet. Be the first to add your sound! ✨</div>'; return; }
    container.innerHTML = tracks.map((track, index) => {
        const isCurrentUserTrack = track.username === currentUser?.username;
        return `
            <div class="track ${track.muted ? 'muted' : ''}" id="track-${track.id}">
                <div style="width: 40px; text-align: center; font-size: 20px;">${isCurrentUserTrack ? '⭐' : '🎵'}</div>
                <div class="track-info">
                    <div class="track-name">Track ${index + 1}: ${escapeHtml(track.username)} ${isCurrentUserTrack ? '<span style="color: #f39c12;"> (Your Track)</span>' : ''}</div>
                    <div class="track-creator">Added ${new Date(track.uploadedAt).toLocaleDateString()}</div>
                </div>
                <div class="track-controls">
                    <button class="mute-btn" onclick="toggleMute('${track.id}')">${track.muted ? 'Unmute' : 'Mute'}</button>
                    <button class="vote-btn" onclick="voteTrack('${track.id}', 'up')">👍</button>
                    <span class="track-votes">${track.votes || 0}</span>
                    <button class="vote-btn" onclick="voteTrack('${track.id}', 'down')">👎</button>
                    <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${track.volume || 0.8}" onchange="adjustVolume('${track.id}', this.value)">
                    ${isCurrentUserTrack ? `<button class="delete-btn" onclick="deleteTrack('${track.id}')">🗑️ Delete</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function displayComments() {
    const container = document.getElementById('comments-list');
    const comments = currentSong.comments || [];
    if (comments.length === 0) { container.innerHTML = '<div style="text-align: center; color: #888;">No comments yet</div>'; return; }
    container.innerHTML = comments.map(comment => `
        <div class="comment">
            <strong>${escapeHtml(comment.username)}</strong>: ${escapeHtml(comment.text)}
            <br><small>${new Date(comment.createdAt).toLocaleString()}</small>
        </div>
    `).join('');
}

async function voteTrack(trackId, vote) {
    try {
        const result = await api.voteTrack(currentSong.id, trackId, vote);
        const track = currentSong.tracks.find(t => t.id === trackId);
        if (track) track.votes = result.votes;
        displayTracks();
    } catch (error) { alert('Error voting'); }
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

async function postComment() {
    const text = document.getElementById('comment-text').value;
    if (!text.trim()) return;
    try {
        await api.addComment(currentSong.id, text);
        document.getElementById('comment-text').value = '';
        currentSong = await api.getSong(currentSong.id);
        displayComments();
    } catch (error) { alert('Error posting comment'); }
}

async function createSong() {
    const title = document.getElementById('new-song-title').value;
    let bpm = parseInt(document.getElementById('new-song-bpm').value);
    const genre = document.getElementById('new-song-genre').value;
    if (!title) { alert('Enter a song title'); return; }
    if (isNaN(bpm)) bpm = 120;
    bpm = Math.min(300, Math.max(40, bpm));
    try {
        const newSong = await api.createSong({ title, bpm, genre });
        alert('Song created!');
        document.getElementById('create-modal').style.display = 'none';
        document.getElementById('new-song-title').value = '';
        await selectSong(newSong.id);
        loadSongs();
    } catch (error) { alert('Error creating song'); }
}

async function forkSong() {
    if (!currentSong) return;
    const title = prompt('New version title:', `${currentSong.title} (Fork)`);
    if (!title) return;
    try {
        const newSong = await api.createSong({ title, bpm: currentSong.bpm, genre: currentSong.genre, parentVersion: currentSong.id });
        alert('Version forked! You are now the owner of this new version.');
        await selectSong(newSong.id);
        loadSongs();
    } catch (error) { alert('Error forking song'); }
}

async function changeThumbnail() {
    const modal = document.getElementById('thumbnail-modal');
    const grid = document.getElementById('thumbnail-grid');
    grid.innerHTML = thumbnailOptions.map(url => `<img class="thumbnail-option" src="${url}" onclick="document.getElementById('thumbnail-url').value='${url}'">`).join('');
    modal.style.display = 'flex';
}

async function applyThumbnail() {
    const url = document.getElementById('thumbnail-url').value;
    if (!url) { alert('Select or enter a thumbnail URL'); return; }
    try {
        await api.updateThumbnailUrl(currentSong.id, url);
        currentSong.thumbnail = url;
        document.getElementById('thumbnail-modal').style.display = 'none';
        document.getElementById('thumbnail-url').value = '';
        loadSongs();
        alert('Thumbnail updated!');
    } catch (error) { alert('Error updating thumbnail'); }
}

function backToLibrary() {
    if (isPlaying) stopPlayback();
    if (isRecording) stopAudioRecording();
    if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
    if (currentAudioContext) { currentAudioContext.close(); currentAudioContext = null; }
    document.getElementById('daw-area').style.display = 'none';
    if (socket && currentSong) socket.emit('leave-song', currentSong.id);
    currentSong = null;
    loadSongs();
}

// Chat Functions
async function loadConversations() {
    try {
        const conversations = await api.getConversations();
        const container = document.getElementById('conversations-list');
        if (conversations.length === 0) { container.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">No messages yet</div>'; return; }
        container.innerHTML = conversations.map(conv => `
            <div class="conversation-item" onclick="openChat('${conv.username}')">
                <img class="conversation-avatar" src="https://picsum.photos/id/20/40/40">
                <div class="conversation-info">
                    <div class="conversation-name">${escapeHtml(conv.username)}</div>
                    <div class="conversation-last">${escapeHtml(conv.lastMessage.substring(0, 50))}</div>
                </div>
                ${conv.unread ? '<div class="unread-badge"></div>' : ''}
            </div>
        `).join('');
    } catch (error) { console.error(error); }
}

async function openChat(username) {
    activeChat = username;
    document.getElementById('conversations-list').style.display = 'none';
    document.getElementById('chat-messages').style.display = 'flex';
    document.getElementById('chat-input-area').style.display = 'flex';
    document.querySelector('.chat-header h3').textContent = `Chat with ${username}`;
    await api.markMessagesRead(username);
    await loadMessages(username);
}

async function loadMessages(username) {
    try {
        const messages = await api.getMessages(username);
        const container = document.getElementById('chat-messages');
        container.innerHTML = messages.map(msg => `
            <div class="message ${msg.from === currentUser.username ? 'sent' : 'received'}">
                ${msg.text}<br><small>${new Date(msg.timestamp).toLocaleTimeString()}</small>
            </div>
        `).join('');
        container.scrollTop = container.scrollHeight;
    } catch (error) { console.error(error); }
}

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !activeChat) return;
    try {
        await api.sendMessage(activeChat, text);
        input.value = '';
        await loadMessages(activeChat);
    } catch (error) { alert('Error sending message'); }
}

async function searchUsers() {
    const query = document.getElementById('search-users').value;
    if (query.length < 2) { document.getElementById('search-results').style.display = 'none'; return; }
    try {
        const results = await api.searchUsers(query);
        const container = document.getElementById('search-results');
        if (results.length === 0) { container.innerHTML = '<div class="search-result-item">No users found</div>'; }
        else {
            container.innerHTML = results.map(user => `
                <div class="search-result-item">
                    <span>${escapeHtml(user.username)}</span>
                    <button class="follow-btn" onclick="followUser('${user.username}')">${user.following ? 'Unfollow' : 'Follow'}</button>
                </div>
            `).join('');
        }
        container.style.display = 'block';
    } catch (error) { console.error(error); }
}

async function followUser(username) {
    try {
        const user = (await api.searchUsers(username)).find(u => u.username === username);
        if (user && user.following) await api.unfollowUser(username);
        else await api.followUser(username);
        document.getElementById('search-users').value = '';
        document.getElementById('search-results').style.display = 'none';
    } catch (error) { alert('Error'); }
}

function closeChat() {
    activeChat = null;
    document.getElementById('conversations-list').style.display = 'block';
    document.getElementById('chat-messages').style.display = 'none';
    document.getElementById('chat-input-area').style.display = 'none';
    document.querySelector('.chat-header h3').textContent = 'Messages';
    loadConversations();
}

function toggleChat() {
    const panel = document.getElementById('chat-panel');
    panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
    if (panel.style.display === 'flex') loadConversations();
}

// Tutorial
function showTutorial() {
    if (currentUser && currentUser.tutorialCompleted) return;
    const tutorialDiv = document.createElement('div');
    tutorialDiv.className = 'tutorial-overlay';
    tutorialDiv.innerHTML = `
        <div class="tutorial-content">
            <h2>🎵 Welcome to TrackStars!</h2>
            <div class="tutorial-step">
                <h3>1. Create or Select a Song</h3>
                <p>Browse the song library or create your own song to get started.</p>
            </div>
            <div class="tutorial-step">
                <h3>2. Add Your Track</h3>
                <p>Click Record to hear all existing tracks while you record your part. Each user gets ONE track per version!</p>
            </div>
            <div class="tutorial-step">
                <h3>3. Create Forks</h3>
                <p>Want to take a song in a new direction? Click "Fork This Version" to create your own version.</p>
            </div>
            <div class="tutorial-step">
                <h3>4. Collaborate</h3>
                <p>Vote on tracks, comment, and message other users to collaborate!</p>
            </div>
            <button class="tutorial-button" id="close-tutorial">Got it! Let's make music ⭐</button>
        </div>
    `;
    document.body.appendChild(tutorialDiv);
    document.getElementById('close-tutorial').onclick = async () => {
        tutorialDiv.remove();
        if (currentUser && !currentUser.tutorialCompleted) {
            await api.completeTutorial();
            currentUser.tutorialCompleted = true;
        }
    };
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function initSocket() {
    socket = io();
    socket.on('connect', () => console.log('Socket connected'));
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
        }
    });
    socket.on('track-updated', (data) => {
        if (currentSong) {
            const track = currentSong.tracks.find(t => t.id === data.trackId);
            if (track && data.updates) {
                if (data.updates.muted !== undefined) track.muted = data.updates.muted;
                if (data.updates.volume !== undefined) track.volume = data.updates.volume;
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
    socket.on('new-comment', async (comment) => {
        if (currentSong) {
            if (!currentSong.comments) currentSong.comments = [];
            currentSong.comments.push(comment);
            displayComments();
        }
    });
    socket.on('new-message', (message) => {
        if (activeChat === message.from) loadMessages(activeChat);
        else loadConversations();
    });
    socket.on('user-recording', (data) => {
        document.getElementById('recording-status').innerHTML = `🎙️ ${data.username} is recording...`;
        setTimeout(() => {
            if (document.getElementById('recording-status').innerHTML.includes('recording'))
                document.getElementById('recording-status').innerHTML = '';
        }, 3000);
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
        try {
            await login(username, password);
            document.getElementById('auth-modal').style.display = 'none';
            document.getElementById('main-app').style.display = 'flex';
            document.getElementById('current-user').textContent = currentUser.username;
            initSocket();
            loadSongs();
            showTutorial();
        } catch (error) {
            document.getElementById('login-error').textContent = error.message;
        }
    });
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('reg-username').value;
        const email = document.getElementById('reg-email').value;
        const password = document.getElementById('reg-password').value;
        const confirm = document.getElementById('reg-confirm').value;
        try {
            await register(username, email, password, confirm);
            document.getElementById('auth-modal').style.display = 'none';
            document.getElementById('main-app').style.display = 'flex';
            document.getElementById('current-user').textContent = currentUser.username;
            initSocket();
            loadSongs();
            showTutorial();
        } catch (error) {
            document.getElementById('register-error').textContent = error.message;
        }
    });
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('open-create-modal').addEventListener('click', () => document.getElementById('create-modal').style.display = 'flex');
    document.getElementById('confirm-create').addEventListener('click', createSong);
    document.getElementById('cancel-create').addEventListener('click', () => document.getElementById('create-modal').style.display = 'none');
    document.getElementById('play-btn').addEventListener('click', () => { if (isPlaying) pausePlayback(); else startPlayback(false); });
    document.getElementById('stop-btn').addEventListener('click', stopPlayback);
    document.getElementById('bpm-input').addEventListener('change', (e) => updateBpm(e.target.value));
    document.getElementById('record-btn').addEventListener('click', startRecordingWithPlayback);
    document.getElementById('stop-record-btn').addEventListener('click', stopAudioRecording);
    document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('audio-file').click());
    document.getElementById('audio-file').addEventListener('change', uploadTrack);
    document.getElementById('back-btn').addEventListener('click', backToLibrary);
    document.getElementById('post-comment-btn').addEventListener('click', postComment);
    document.getElementById('change-thumbnail-btn').addEventListener('click', changeThumbnail);
    document.getElementById('fork-version-btn').addEventListener('click', forkSong);
    document.getElementById('confirm-thumbnail').addEventListener('click', applyThumbnail);
    document.getElementById('cancel-thumbnail').addEventListener('click', () => document.getElementById('thumbnail-modal').style.display = 'none');
    document.getElementById('chat-icon').addEventListener('click', toggleChat);
    document.getElementById('close-chat').addEventListener('click', closeChat);
    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    document.getElementById('search-users').addEventListener('input', searchUsers);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.chat-search')) document.getElementById('search-results').style.display = 'none';
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
        token = savedToken;
        currentUser = JSON.parse(savedUser);
        document.getElementById('auth-modal').style.display = 'none';
        document.getElementById('main-app').style.display = 'flex';
        document.getElementById('current-user').textContent = currentUser.username;
        initSocket();
        loadSongs();
        showTutorial();
    } else {
        document.getElementById('auth-modal').style.display = 'flex';
        document.getElementById('main-app').style.display = 'none';
    }
    setupEventListeners();
});

window.selectSong = selectSong;
window.toggleMute = toggleMute;
window.adjustVolume = adjustVolume;
window.voteTrack = voteTrack;
window.deleteTrack = deleteTrack;
window.openChat = openChat;
window.followUser = followUser;