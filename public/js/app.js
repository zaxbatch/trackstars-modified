// TrackStars - Complete Application
(function() {
    let socket = null, token = null, currentUser = null, currentSong = null;
    let audioCtx = null, buffers = new Map(), sources = [], gains = new Map();
    let isPlaying = false, isRecording = false, currentPos = 0, startTime = 0;
    let timerInterval = null, mediaRecorder = null, chunks = [], stream = null;
    let bpm = 120, isOwner = false, currentChatUser = null;
    let currentEditingSong = null, currentEditThumbnail = null;
    let initialized = false;

    function getToken() { return localStorage.getItem('token'); }

    // API
    const api = {
        async request(endpoint, opts = {}) {
            const headers = { 'Content-Type': 'application/json' };
            const tk = getToken();
            if (tk) headers['Authorization'] = 'Bearer ' + tk;
            const res = await fetch(endpoint, { ...opts, headers });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    localStorage.clear();
                    window.location.reload();
                    throw new Error('Session expired');
                }
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Request failed');
            }
            return res.json();
        },
        getSongs: () => api.request('/api/songs'),
        getSong: (id) => api.request('/api/songs/' + id),
        createSong: (data) => api.request('/api/songs', { method: 'POST', body: JSON.stringify(data) }),
        createVersion: (id, data) => api.request('/api/songs/' + id + '/version', { method: 'POST', body: JSON.stringify(data) }),
        getVersionTree: (id) => api.request('/api/songs/' + id + '/version-tree'),
        getAllVersions: (id) => api.request('/api/songs/' + id + '/all-versions'),
        editSongTitle: (id, title) => api.request('/api/songs/' + id + '/title', { method: 'PUT', body: JSON.stringify({ title }) }),
        editSongThumbnail: async (id, file) => {
            const fd = new FormData();
            fd.append('thumbnail', file);
            const tk = getToken();
            const res = await fetch('/api/songs/' + id + '/thumbnail', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tk }, body: fd });
            if (!res.ok) throw new Error('Upload failed');
            return res.json();
        },
        editSongThumbnailUrl: (id, url) => api.request('/api/songs/' + id + '/thumbnail-url', { method: 'PUT', body: JSON.stringify({ thumbnail: url }) }),
        deleteSong: (id) => api.request('/api/songs/' + id, { method: 'DELETE' }),
        uploadTrack: async (id, file) => {
            const fd = new FormData();
            fd.append('audio', file);
            const tk = getToken();
            const res = await fetch('/api/songs/' + id + '/track', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tk }, body: fd });
            if (!res.ok) throw new Error('Upload failed');
            return res.json();
        },
        updateBpm: (id, bpmVal) => api.request('/api/songs/' + id + '/bpm', { method: 'PUT', body: JSON.stringify({ bpm: bpmVal }) }),
        deleteTrack: (sid, tid) => api.request('/api/songs/' + sid + '/track/' + tid, { method: 'DELETE' }),
        voteTrack: (sid, tid, v) => api.request('/api/songs/' + sid + '/track/' + tid + '/vote', { method: 'POST', body: JSON.stringify({ vote: v }) }),
        updateTrackFx: (sid, tid, fx) => api.request('/api/songs/' + sid + '/track/' + tid + '/fx', { method: 'POST', body: JSON.stringify({ fx }) }),
        followUser: (u) => api.request('/api/users/' + u + '/follow', { method: 'POST' }),
        updateBio: (bio) => api.request('/api/users/bio', { method: 'PUT', body: JSON.stringify({ bio }) }),
        updateTutorial: (completed) => api.request('/api/users/tutorial', { method: 'PUT', body: JSON.stringify({ completed }) }),
        uploadAvatar: async (file) => {
            const fd = new FormData();
            fd.append('avatar', file);
            const tk = getToken();
            const res = await fetch('/api/upload-avatar', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tk }, body: fd });
            if (!res.ok) throw new Error('Upload failed');
            return res.json();
        },
        getMessages: (u) => api.request('/api/messages/' + u),
        getRecentChats: () => api.request('/api/messages/recent'),
        sendMessage: (to, text) => api.request('/api/messages', { method: 'POST', body: JSON.stringify({ to, text }) }),
        searchUsers: (q) => api.request('/api/users/search?q=' + encodeURIComponent(q)),
        getUser: (u) => api.request('/api/users/' + u),
        getFeed: () => api.request('/api/feed'),
        addComment: (sid, text) => api.request('/api/songs/' + sid + '/comment', { method: 'POST', body: JSON.stringify({ text }) }),
        likeComment: (cid, sid) => api.request('/api/comments/' + cid + '/like', { method: 'POST', body: JSON.stringify({ songId: sid }) })
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
        if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (audioCtx) audioCtx.close();
        localStorage.clear();
        window.location.reload();
    }

    // Audio Functions
    async function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }

    async function loadTracks() {
        if (!currentSong) return;
        buffers.clear();
        for (let t of currentSong.tracks) {
            try {
                const res = await fetch(t.audioUrl);
                const buf = await res.arrayBuffer();
                const audioBuf = await audioCtx.decodeAudioData(buf);
                buffers.set(t.id, audioBuf);
            } catch(e) { console.error(e); }
        }
    }

    function scheduleTrack(track, offset, when) {
        if (track.muted) return null;
        const buf = buffers.get(track.id);
        if (!buf) return null;
        const src = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        src.buffer = buf;
        gain.gain.value = track.volume;
        src.connect(gain);
        gain.connect(audioCtx.destination);
        const time = when !== undefined ? when : audioCtx.currentTime;
        src.start(time, offset % buf.duration);
        gains.set(track.id, gain);
        sources.push(src);
        return src;
    }

    async function startPlayback(recordMode) {
        if (recordMode === undefined) recordMode = false;
        if (!currentSong) return false;
        await initAudio();
        if (recordMode) {
            const userTrack = currentSong.tracks.some(t => t.username === currentUser.username);
            if (userTrack) {
                showToast('You already have a track in this version! Click "Create Version" to make your own version.');
                return false;
            }
        }
        await loadTracks();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        isPlaying = true;
        startTime = audioCtx.currentTime - currentPos;
        for (let t of currentSong.tracks) if (!t.muted) scheduleTrack(t, currentPos);
        if (recordMode) await startRecording();
        const playBtn = document.getElementById('play-btn');
        if (playBtn) { playBtn.textContent = '⏸️ Pause'; playBtn.className = 'pause-btn'; }
        if (isOwner && socket) socket.emit('transport-control', { songId: currentSong.id, action: 'play', position: currentPos, username: currentUser.username });
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => { if (isPlaying) updateDisplay(audioCtx.currentTime - startTime); }, 50);
        return true;
    }

    function pausePlayback() {
        if (!isPlaying) return;
        isPlaying = false;
        if (isRecording) stopRecording();
        for (let s of sources) try { s.stop(); } catch(e) {}
        sources = [];
        gains.clear();
        currentPos = audioCtx.currentTime - startTime;
        const playBtn = document.getElementById('play-btn');
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
            if (stream) stream.getTracks().forEach(t => t.stop());
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeTypes = ['audio/webm', 'audio/mp4', 'audio/wav'];
            let mime = '';
            for (let t of mimeTypes) if (MediaRecorder.isTypeSupported(t)) { mime = t; break; }
            mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
            chunks = [];
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
            mediaRecorder.onstop = async () => {
                if (chunks.length === 0) return;
                const blob = new Blob(chunks, { type: mime || 'audio/webm' });
                const file = new File([blob], 'recording-' + Date.now() + '.' + (mime.includes('webm') ? 'webm' : 'mp4'), { type: mime || 'audio/webm' });
                const statusDiv = document.getElementById('recording-status');
                if (statusDiv) statusDiv.innerHTML = '📤 Uploading...';
                try {
                    await api.uploadTrack(currentSong.id, file);
                    showToast('Track added to version!');
                    currentSong = await api.getSong(currentSong.id);
                    displayTracks();
                    if (statusDiv) statusDiv.innerHTML = '✅ Added!';
                    const recBtn = document.getElementById('record-btn');
                    const upBtn = document.getElementById('upload-btn');
                    if (recBtn) recBtn.disabled = true;
                    if (upBtn) upBtn.disabled = true;
                    setTimeout(() => { if (statusDiv) statusDiv.innerHTML = ''; }, 3000);
                    loadFeed(); loadSongs();
                } catch(e) { if (statusDiv) statusDiv.innerHTML = '❌ Upload failed'; showToast('Upload failed'); }
                if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
                chunks = [];
            };
            mediaRecorder.start(1000);
            isRecording = true;
            const recBtn = document.getElementById('record-btn');
            const stopRecBtn = document.getElementById('stop-record-btn');
            if (recBtn) recBtn.style.display = 'none';
            if (stopRecBtn) stopRecBtn.style.display = 'inline-block';
            const statusDiv = document.getElementById('recording-status');
            if (statusDiv) statusDiv.innerHTML = '🔴 RECORDING';
            if (socket) socket.emit('recording-started', { songId: currentSong.id, username: currentUser.username });
        } catch(e) { showToast('Microphone access denied'); console.error(e); }
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        isRecording = false;
        const recBtn = document.getElementById('record-btn');
        const stopRecBtn = document.getElementById('stop-record-btn');
        if (recBtn) recBtn.style.display = 'inline-block';
        if (stopRecBtn) stopRecBtn.style.display = 'none';
        if (socket) socket.emit('recording-stopped', { songId: currentSong.id, username: currentUser.username });
    }

    async function startRecordingWithPlayback() {
        if (!currentSong) return showToast('Select a song first');
        if (isRecording) return showToast('Already recording');
        const userTrack = currentSong.tracks.some(t => t.username === currentUser.username);
        if (userTrack) {
            const createVersion = confirm('You already have a track in this version. Create a new version with your track?');
            if (createVersion) {
                await createNewVersion();
            }
            return;
        }
        if (isPlaying) stopPlayback();
        currentPos = 0;
        updateDisplay(0);
        await new Promise(r => setTimeout(r, 100));
        await startPlayback(true);
    }

    async function createNewVersion() {
        try {
            const newTitle = prompt('Enter a title for your version:', currentSong.title + ' (' + currentUser.username + '\'s version)');
            if (!newTitle) return;
            const newVersion = await api.createVersion(currentSong.id, { title: newTitle });
            showToast('New version created! Select it to add your track.');
            await selectSong(newVersion.id);
        } catch(e) { showToast('Error creating version'); }
    }

    async function uploadTrackFile() {
        const file = document.getElementById('audio-file').files[0];
        if (!file) return showToast('Select a file');
        const userTrack = currentSong.tracks.some(t => t.username === currentUser.username);
        if (userTrack) {
            const createVersion = confirm('You already have a track in this version. Create a new version with your track?');
            if (createVersion) {
                await createNewVersion();
            }
            return;
        }
        try {
            await api.uploadTrack(currentSong.id, file);
            showToast('Track added to version!');
            currentSong = await api.getSong(currentSong.id);
            displayTracks();
            const recBtn = document.getElementById('record-btn');
            const upBtn = document.getElementById('upload-btn');
            if (recBtn) recBtn.disabled = true;
            if (upBtn) upBtn.disabled = true;
            loadFeed();
        } catch(e) { showToast('Error uploading track'); }
    }

    function stopRecordingAndPlayback() {
        if (isRecording) stopRecording();
        if (isPlaying) stopPlayback();
    }

    function updateDisplay(pos) {
        const display = document.getElementById('position-display');
        if (!display) return;
        const m = Math.floor(pos / 60), s = Math.floor(pos % 60), ms = Math.floor((pos % 1) * 100);
        display.textContent = m.toString().padStart(2,'0') + ':' + s.toString().padStart(2,'0') + ':' + ms.toString().padStart(2,'0');
    }

    // Version Tree Display
    async function showVersionTree() {
        if (!currentSong) return;
        try {
            const tree = await api.getVersionTree(currentSong.id);
            const modal = document.getElementById('versions-modal');
            const container = document.getElementById('version-tree');
            container.innerHTML = renderVersionTree(tree);
            modal.style.display = 'flex';
        } catch(e) { showToast('Error loading version tree'); }
    }

    function renderVersionTree(node, level = 0) {
        if (!node) return '';
        const isCurrent = currentSong && currentSong.id === node.id;
        let html = `<div class="version-node ${node.parentId === null ? 'original' : ''}" style="margin-left: ${level * 20}px">
            <div class="version-item ${isCurrent ? 'current' : ''}" onclick="window.selectSong('${node.id}'); document.getElementById('versions-modal').style.display = 'none'">
                <img class="version-thumb" src="${node.thumbnail}">
                <div class="version-info">
                    <div class="version-title">${escape(node.title)}${node.isOwner ? '<span class="version-badge-icon">OWNER</span>' : ''}</div>
                    <div class="version-creator">by ${escape(node.creator)}</div>
                    <div class="version-stats">🎵 ${node.trackCount} tracks | 👍 ${node.likes}</div>
                </div>
                ${isCurrent ? '<div style="font-size:10px;color:#667eea">▼ CURRENT</div>' : ''}
            </div>`;
        if (node.children && node.children.length) {
            html += `<div class="children-container">`;
            for (let child of node.children) {
                html += renderVersionTree(child, level + 1);
            }
            html += `</div>`;
        }
        html += `</div>`;
        return html;
    }

    // Display Functions
    function displaySongList(songs) {
        const container = document.getElementById('song-list');
        if (!container) return;
        if (songs.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Create one!</div>'; return; }
        let html = '';
        for (let s of songs) {
            const isOwnerFlag = (s.creator === currentUser.username);
            html += '<div class="song-card" onclick="window.selectSong(\'' + s.id + '\')">';
            html += '<img class="song-thumb" src="' + escape(s.thumbnail) + '">';
            html += '<div class="song-info">';
            html += '<div class="song-title">' + escape(s.title);
            if (s.parentId) html += '<span class="version-badge">VERSION</span>';
            if (isOwnerFlag) html += '<span class="owner-badge">OWNER</span>';
            html += '</div>';
            html += '<div class="song-creator" onclick="event.stopPropagation(); window.viewUser(\'' + escape(s.creator) + '\')">' + escape(s.creator) + '</div>';
            html += '<div class="song-stats">🎵 ' + s.trackCount + ' tracks | 👍 ' + s.likes + ' likes | 🌳 ' + (s.childCount || 0) + ' versions</div>';
            html += '</div>';
            if (isOwnerFlag) {
                html += '<div class="song-actions" onclick="event.stopPropagation()">';
                html += '<button class="edit-song-btn" onclick="window.openEditSongModal(\'' + s.id + '\', event)">✏️ Edit</button>';
                html += '</div>';
            }
            html += '</div>';
        }
        container.innerHTML = html;
        const search = document.getElementById('library-search');
        if (search) {
            search.oninput = (e) => {
                const term = e.target.value.toLowerCase();
                const cards = document.querySelectorAll('#song-list .song-card');
                for (let card of cards) {
                    const title = card.querySelector('.song-title') ? card.querySelector('.song-title').innerText.toLowerCase() : '';
                    const creator = card.querySelector('.song-creator') ? card.querySelector('.song-creator').innerText.toLowerCase() : '';
                    card.style.display = (title.indexOf(term) !== -1 || creator.indexOf(term) !== -1) ? 'flex' : 'none';
                }
            };
        }
    }

    async function loadSongs() {
        try {
            const songs = await api.getSongs();
            displaySongList(songs);
        } catch(e) { console.error(e); showToast('Error loading songs'); }
    }

    window.selectSong = async function(id) {
        try {
            if (isPlaying) stopPlayback();
            if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
            if (stream) stream.getTracks().forEach(t => t.stop());
            if (audioCtx) await audioCtx.close();
            buffers.clear(); sources = []; gains.clear();
            audioCtx = null;
            currentSong = await api.getSong(id);
            isOwner = (currentSong.creator === currentUser.username);
            
            const titleEl = document.getElementById('current-song-title');
            const creatorEl = document.getElementById('song-creator');
            const versionInfo = document.getElementById('version-info');
            const bpmInput = document.getElementById('bpm-input');
            const bpmLock = document.getElementById('bpm-lock');
            const versionsBtn = document.getElementById('view-versions-btn');
            
            if (titleEl) titleEl.textContent = currentSong.title;
            if (creatorEl) creatorEl.innerHTML = 'Created by <span style="color:#667eea;cursor:pointer" onclick="window.viewUser(\'' + escape(currentSong.creator) + '\')">' + escape(currentSong.creator) + '</span> • ' + currentSong.genre + ' • ' + currentSong.bpm + ' BPM';
            if (versionInfo) versionInfo.innerHTML = currentSong.parentId ? `<span style="color:#f39c12">🔀 Version of <span style="cursor:pointer" onclick="window.viewOriginal('${currentSong.parentId}')">original</span></span>` : `📀 Original Track • ${currentSong.children?.length || 0} versions`;
            if (bpmInput) { bpmInput.value = currentSong.bpm; bpmInput.disabled = !isOwner; }
            if (bpmLock) { bpmLock.className = 'bpm-lock ' + (isOwner ? 'unlocked' : ''); bpmLock.innerHTML = isOwner ? '🔓' : '🔒'; }
            if (versionsBtn) versionsBtn.style.display = 'inline-block';
            bpm = currentSong.bpm;
            
            if (socket) socket.emit('join-song', id);
            displayTracks();
            displayComments();
            
            const hasTrack = currentSong.tracks.some(t => t.username === currentUser.username);
            const recBtn = document.getElementById('record-btn');
            const upBtn = document.getElementById('upload-btn');
            if (recBtn) recBtn.disabled = hasTrack;
            if (upBtn) upBtn.disabled = hasTrack;
            currentPos = 0;
            updateDisplay(0);
            
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('studio-view').classList.add('active');
        } catch(e) { showToast('Error loading song'); console.error(e); }
    };

    window.viewOriginal = async function(parentId) {
        await selectSong(parentId);
    };

    function displayTracks() {
        const container = document.getElementById('track-mixer');
        if (!container) return;
        const tracks = currentSong.tracks || [];
        if (tracks.length === 0) { container.innerHTML = '<div class="loading">No tracks yet. Add your sound!</div>'; return; }
        let html = '';
        for (let t of tracks) {
            const isCurrentUserTrack = (t.username === currentUser.username);
            html += '<div class="track-card ' + (t.muted ? 'muted' : '') + '">';
            html += '<div class="track-row"><div><span class="track-name">🎧 ' + escape(t.username);
            if (isCurrentUserTrack) html += '<span class="your-track"> (Your Track)</span>';
            html += '</span><div class="track-creator" onclick="window.viewUser(\'' + escape(t.username) + '\')">Added ' + new Date(t.uploadedAt).toLocaleDateString() + '</div></div>';
            html += '<div class="track-votes">👍 ' + (t.votes || 0) + '</div></div>';
            html += '<div class="track-controls">';
            html += '<button class="' + (t.muted ? 'unmute-btn' : 'mute-btn') + '" onclick="window.toggleMute(\'' + t.id + '\')">' + (t.muted ? '🔊 Unmute' : '🔇 Mute') + '</button>';
            html += '<button class="vote-btn" onclick="window.voteTrack(\'' + t.id + '\', \'up\')">👍 Upvote</button>';
            html += '<button class="vote-btn" onclick="window.voteTrack(\'' + t.id + '\', \'down\')">👎 Downvote</button>';
            html += '<input type="range" class="volume-slider" min="0" max="1" step="0.01" value="' + (t.volume || 0.8) + '" onchange="window.adjustVolume(\'' + t.id + '\', this.value)">';
            if (isCurrentUserTrack) {
                html += '<button class="delete-btn" onclick="window.deleteTrack(\'' + t.id + '\')">🗑️ Delete</button>';
                html += '<div class="fx-section" id="fx-section-' + t.id + '">';
                html += '<button class="fx-btn ' + (t.fx?.reverb ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'reverb\')">🎛️ Reverb</button>';
                html += '<button class="fx-btn ' + (t.fx?.delay ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'delay\')">⏱️ Delay</button>';
                html += '<button class="fx-btn ' + (t.fx?.distortion ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'distortion\')">🎸 Distortion</button>';
                html += '<button class="fx-btn ' + (t.fx?.lowpass ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'lowpass\')">🔽 Low Pass</button>';
                html += '</div>';
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    }

    window.toggleTrackFX = async function(trackId, fxName) {
        const track = currentSong.tracks.find(t => t.id === trackId);
        if (!track) return;
        if (!track.fx) track.fx = {};
        track.fx[fxName] = !track.fx[fxName];
        displayTracks();
        try {
            await api.updateTrackFx(currentSong.id, trackId, { [fxName]: track.fx[fxName] });
        } catch(e) { console.error(e); }
    };

    async function displayComments() {
        const container = document.getElementById('comments-list');
        if (!container) return;
        const comments = currentSong.comments || [];
        if (comments.length === 0) { container.innerHTML = '<div style="color:#888;text-align:center">No comments yet</div>'; return; }
        let html = '';
        for (let c of comments) {
            html += '<div class="comment">';
            html += '<strong onclick="window.viewUser(\'' + escape(c.username) + '\')">' + escape(c.username) + '</strong>';
            html += '<div>' + escape(c.text) + '</div>';
            html += '<small>' + new Date(c.createdAt).toLocaleString() + '</small>';
            html += '<button class="comment-like-btn" onclick="window.likeComment(\'' + c.id + '\')">❤️ ' + (c.likes || 0) + '</button>';
            html += '</div>';
        }
        container.innerHTML = html;
    }

    window.likeComment = async function(commentId) {
        try {
            await api.likeComment(commentId, currentSong.id);
            currentSong = await api.getSong(currentSong.id);
            displayComments();
        } catch(e) { showToast('Error liking comment'); }
    };

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

    window.toggleMute = async function(id) {
        const track = currentSong.tracks.find(t => t.id === id);
        if (track) {
            track.muted = !track.muted;
            if (isPlaying) { const pos = currentPos; pausePlayback(); currentPos = pos; await startPlayback(false); }
            displayTracks();
            await fetch('/api/songs/' + currentSong.id + '/track/' + id, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ muted: track.muted }) });
            if (socket) socket.emit('track-update', { songId: currentSong.id, trackId: id, updates: { muted: track.muted } });
        }
    };

    window.adjustVolume = async function(id, vol) {
        const track = currentSong.tracks.find(t => t.id === id);
        if (track) {
            track.volume = parseFloat(vol);
            const gain = gains.get(id);
            if (gain) gain.gain.value = track.volume;
            await fetch('/api/songs/' + currentSong.id + '/track/' + id, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: track.volume }) });
        }
    };

    window.voteTrack = async function(id, vote) {
        try {
            const res = await api.voteTrack(currentSong.id, id, vote);
            const track = currentSong.tracks.find(t => t.id === id);
            if (track) track.votes = res.votes;
            displayTracks();
            loadFeed();
        } catch(e) { showToast('Error voting'); }
    };

    window.deleteTrack = async function(id) {
        if (!confirm('Delete your track? Cannot undo.')) return;
        try {
            await api.deleteTrack(currentSong.id, id);
            currentSong = await api.getSong(currentSong.id);
            displayTracks();
            const recBtn = document.getElementById('record-btn');
            const upBtn = document.getElementById('upload-btn');
            if (recBtn) recBtn.disabled = false;
            if (upBtn) upBtn.disabled = false;
            loadFeed(); loadSongs();
        } catch(e) { showToast('Error deleting track'); }
    };

    // Feed Functions
    async function loadFeed() {
        try {
            const feed = await api.getFeed();
            const trendingContainer = document.getElementById('trending-songs');
            if (trendingContainer) {
                if (feed.trendingSongs && feed.trendingSongs.length) {
                    let html = '';
                    for (let s of feed.trendingSongs) {
                        html += '<div class="trending-card" onclick="window.selectSong(\'' + s.id + '\')">';
                        html += '<img src="' + escape(s.thumbnail) + '"><div class="trending-info">';
                        html += '<div class="trending-title">' + escape(s.title) + '</div>';
                        html += '<div class="trending-creator" onclick="event.stopPropagation(); window.viewUser(\'' + escape(s.creator) + '\')">' + escape(s.creator) + '</div>';
                        html += '<div class="trending-stats">👍 ' + s.likes + ' • 🎵 ' + s.trackCount + ' • 🌳 ' + (s.childCount || 0) + '</div>';
                        html += '</div></div>';
                    }
                    trendingContainer.innerHTML = html;
                } else { trendingContainer.innerHTML = '<div class="loading">No trending tracks</div>'; }
            }
            
            const activityContainer = document.getElementById('activity-feed');
            if (activityContainer) {
                if (feed.activityFeed && feed.activityFeed.length) {
                    let html = '';
                    for (let item of feed.activityFeed) {
                        html += '<div class="activity-item" onclick="window.selectSong(\'' + item.id + '\')">';
                        html += '<div class="activity-icon">' + (item.type === 'version' ? '🔀' : '🆕') + '</div>';
                        html += '<div class="activity-info">';
                        html += '<div class="activity-title">' + escape(item.title) + '</div>';
                        html += '<div class="activity-detail">' + (item.type === 'version' ? 'Version of' : 'Created by') + ' ' + escape(item.creator) + '</div>';
                        html += '</div>';
                        html += '<div class="activity-time">👍 ' + item.likes + '</div>';
                        html += '</div>';
                    }
                    activityContainer.innerHTML = html;
                } else { activityContainer.innerHTML = '<div class="loading">No recent activity</div>'; }
            }
            
            const contributorsContainer = document.getElementById('top-contributors');
            if (contributorsContainer) {
                if (feed.topContributors && feed.topContributors.length) {
                    let html = '';
                    for (let u of feed.topContributors) {
                        html += '<div class="user-card">';
                        html += '<img class="user-avatar" src="' + escape(u.avatar) + '" onclick="window.viewUser(\'' + escape(u.username) + '\')">';
                        html += '<div class="user-info">';
                        html += '<div class="user-name" onclick="window.viewUser(\'' + escape(u.username) + '\')">' + escape(u.username) + '</div>';
                        html += '<div class="user-stats">🎵 ' + u.trackCount + ' tracks • 👥 ' + u.followersCount + ' followers</div>';
                        html += '</div>';
                        html += '<button class="follow-small-btn ' + (u.isFollowing ? 'following' : '') + '" onclick="window.followFromFeed(\'' + escape(u.username) + '\', this)">' + (u.isFollowing ? 'Following' : 'Follow') + '</button>';
                        html += '</div>';
                    }
                    contributorsContainer.innerHTML = html;
                } else { contributorsContainer.innerHTML = '<div class="loading">No contributors yet</div>'; }
            }
        } catch(e) { console.error('Error loading feed:', e); showToast('Error loading feed'); }
    }

    window.followFromFeed = async function(username, btn) {
        try {
            const res = await api.followUser(username);
            if (res.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast('Following ' + username); }
            else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast('Unfollowed ' + username); }
            loadFeed();
        } catch(e) { showToast('Error following user'); }
    };

    // Edit Song Functions
    window.openEditSongModal = async function(songId, event) {
        if (event) event.stopPropagation();
        try {
            const song = await api.getSong(songId);
            currentEditingSong = song;
            document.getElementById('edit-song-title').value = song.title;
            document.getElementById('edit-thumb-preview').src = song.thumbnail;
            currentEditThumbnail = song.thumbnail;
            document.getElementById('edit-song-modal').style.display = 'flex';
        } catch(e) { showToast('Error loading song data'); }
    };

    function closeEditSongModal() {
        document.getElementById('edit-song-modal').style.display = 'none';
        currentEditingSong = null;
        currentEditThumbnail = null;
    }

    async function saveSongChanges() {
        if (!currentEditingSong) return;
        const newTitle = document.getElementById('edit-song-title').value.trim();
        if (!newTitle) { showToast('Title cannot be empty'); return; }
        try {
            if (newTitle !== currentEditingSong.title) {
                await api.editSongTitle(currentEditingSong.id, newTitle);
                showToast('Title updated!');
            }
            if (currentEditThumbnail && currentEditThumbnail !== currentEditingSong.thumbnail) {
                if (currentEditThumbnail.indexOf('data:') === 0 || currentEditThumbnail.indexOf('blob:') === 0) {
                    const response = await fetch(currentEditThumbnail);
                    const blob = await response.blob();
                    const file = new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' });
                    await api.editSongThumbnail(currentEditingSong.id, file);
                } else if (currentEditThumbnail !== currentEditingSong.thumbnail) {
                    await api.editSongThumbnailUrl(currentEditingSong.id, currentEditThumbnail);
                }
                showToast('Thumbnail updated!');
            }
            if (currentSong && currentSong.id === currentEditingSong.id) {
                currentSong = await api.getSong(currentEditingSong.id);
                const titleEl = document.getElementById('current-song-title');
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
        if (!confirm('Delete "' + currentEditingSong.title + '"? This cannot be undone.')) return;
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
        const id = Math.floor(Math.random() * 100) + 1;
        const newThumb = 'https://picsum.photos/id/' + id + '/200/200';
        document.getElementById('edit-thumb-preview').src = newThumb;
        currentEditThumbnail = newThumb;
    }

    async function createSong() {
        const title = document.getElementById('new-title').value;
        let b = parseInt(document.getElementById('new-bpm').value);
        const genre = document.getElementById('new-genre').value;
        const thumbPreview = document.getElementById('thumb-preview');
        if (!title) return showToast('Enter a title');
        if (isNaN(b)) b = 120;
        b = Math.min(300, Math.max(40, b));
        const thumbnail = thumbPreview ? thumbPreview.src : null;
        try {
            const song = await api.createSong({ title, bpm: b, genre, thumbnail: (thumbnail && thumbnail.indexOf('picsum') !== -1) ? thumbnail : null });
            showToast('Song created!');
            document.getElementById('create-modal').style.display = 'none';
            document.getElementById('new-title').value = '';
            loadSongs(); loadFeed(); window.selectSong(song.id);
        } catch(e) { showToast('Error creating song'); }
    }

    async function updateBpm() {
        const input = document.getElementById('bpm-input');
        if (!input) return;
        const newBpm = parseInt(input.value);
        if (isNaN(newBpm)) return;
        if (!isOwner) { showToast('Only the version owner can change BPM'); input.value = bpm; return; }
        const clampedBpm = Math.min(300, Math.max(40, newBpm));
        try {
            await api.updateBpm(currentSong.id, clampedBpm);
            bpm = clampedBpm;
            showToast('BPM updated');
        } catch(e) { showToast('Error updating BPM'); }
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
        document.getElementById('library-view').classList.add('active');
        loadSongs();
    }

    // Profile Functions
    async function loadProfile() {
        const container = document.getElementById('profile-content');
        if (!container) return;
        try {
            const user = await api.getUser(currentUser.username);
            container.innerHTML = '<div class="profile-header"><img class="profile-avatar" src="' + escape(user.avatar) + '"><h2>' + escape(user.username) + '</h2>';
            container.innerHTML += '<p class="profile-bio">' + escape(user.bio || 'Music creator on TrackStars') + '</p>';
            container.innerHTML += '<button class="edit-profile-btn" id="edit-profile-btn">✏️ Edit Profile</button>';
            container.innerHTML += '<div class="stats-row"><div><span>' + (user.followers?.length || 0) + '</span><label>Followers</label></div>';
            container.innerHTML += '<div><span>' + (user.following?.length || 0) + '</span><label>Following</label></div>';
            container.innerHTML += '<div><span>' + (user.contributedTo?.length || 0) + '</span><label>Tracks</label></div></div></div>';
            container.innerHTML += '<div><h3>My Tracks</h3><div id="my-tracks-list"></div></div>';
            
            const songs = await api.getSongs();
            const mySongs = songs.filter(s => s.creator === currentUser.username);
            const tracksDiv = document.getElementById('my-tracks-list');
            if (tracksDiv) {
                if (mySongs.length === 0) tracksDiv.innerHTML = '<div class="loading">No tracks yet</div>';
                else {
                    let html = '';
                    for (let s of mySongs) {
                        html += '<div class="song-card" onclick="window.selectSong(\'' + s.id + '\')"><img class="song-thumb" src="' + s.thumbnail + '"><div class="song-info"><div class="song-title">' + escape(s.title) + (s.parentId ? '<span class="version-badge">VERSION</span>' : '') + '</div><div class="song-stats">🎵 ' + s.trackCount + ' tracks | 👍 ' + s.likes + '</div></div></div>';
                    }
                    tracksDiv.innerHTML = html;
                }
            }
            document.getElementById('edit-profile-btn').onclick = openProfileModal;
        } catch(e) { container.innerHTML = '<div class="loading">Error loading profile</div>'; }
    }

    async function openProfileModal() {
        try {
            const user = await api.getUser(currentUser.username);
            document.getElementById('edit-avatar').src = user.avatar;
            document.getElementById('edit-bio').value = user.bio || '';
            document.getElementById('edit-followers').textContent = user.followers?.length || 0;
            document.getElementById('edit-following').textContent = user.following?.length || 0;
            document.getElementById('edit-tracks').textContent = user.contributedTo?.length || 0;
            const disableTutorial = document.getElementById('disable-tutorial');
            if (disableTutorial) disableTutorial.checked = user.tutorialCompleted;
            document.getElementById('profile-modal').style.display = 'flex';
        } catch(e) { showToast('Error loading profile'); }
    }

    async function saveProfile() {
        const bio = document.getElementById('edit-bio').value;
        const disableTutorial = document.getElementById('disable-tutorial');
        try {
            await api.updateBio(bio);
            if (disableTutorial) {
                await api.updateTutorial(disableTutorial.checked);
                currentUser.tutorialCompleted = disableTutorial.checked;
            }
            showToast('Profile updated');
            document.getElementById('profile-modal').style.display = 'none';
            loadProfile();
        } catch(e) { showToast('Error saving profile'); }
    }

    async function uploadAvatar(file) {
        try {
            const res = await api.uploadAvatar(file);
            currentUser.avatar = res.avatar;
            document.getElementById('header-avatar').src = res.avatar;
            showToast('Avatar updated');
        } catch(e) { showToast('Error uploading avatar'); }
    }

    // Chat Functions
    async function loadRecentChats() {
        const container = document.getElementById('chat-recent');
        if (!container) return;
        try {
            const chats = await api.getRecentChats();
            if (chats.length === 0) { container.innerHTML = '<div class="loading">No recent chats. Search for users above!</div>'; return; }
            let html = '';
            for (let c of chats) {
                html += '<div class="chat-user-item" onclick="window.startChat(\'' + escape(c.otherUser) + '\')">';
                html += '<img src="' + escape(c.avatar) + '">';
                html += '<div class="chat-user-info"><div class="chat-user-name">' + escape(c.otherUser) + '</div>';
                html += '<div class="chat-preview">' + escape(c.text.substring(0, 30)) + '</div></div>';
                html += '<div class="chat-time">' + new Date(c.timestamp).toLocaleTimeString() + '</div></div>';
            }
            container.innerHTML = html;
        } catch(e) { container.innerHTML = '<div class="loading">Error loading chats</div>'; }
        
        const searchInput = document.getElementById('chat-search-input');
        if (searchInput) {
            searchInput.oninput = async () => {
                const term = searchInput.value;
                if (!term) { loadRecentChats(); return; }
                try {
                    const users = await api.searchUsers(term);
                    if (users.length === 0) { container.innerHTML = '<div class="loading">No users found</div>'; return; }
                    let html = '';
                    for (let u of users) {
                        html += '<div class="chat-user-item" onclick="window.startChat(\'' + escape(u.username) + '\')">';
                        html += '<img src="' + escape(u.avatar) + '">';
                        html += '<div class="chat-user-info"><div class="chat-user-name">' + escape(u.username) + '</div>';
                        html += '<div class="chat-preview">' + u.followersCount + ' followers</div></div></div>';
                    }
                    container.innerHTML = html;
                } catch(e) { container.innerHTML = '<div class="loading">Error searching</div>'; }
            };
        }
    }

    window.startChat = async function(username) {
        currentChatUser = username;
        document.getElementById('chat-recent').style.display = 'none';
        document.getElementById('chat-conversation').style.display = 'flex';
        document.getElementById('chat-with').textContent = username;
        await loadConversation(username);
    };

    async function loadConversation(username) {
        try {
            const msgs = await api.getMessages(username);
            const container = document.getElementById('chat-messages');
            if (!container) return;
            let html = '';
            for (let m of msgs) {
                html += '<div class="message ' + (m.from === currentUser.username ? 'sent' : 'received') + '">';
                html += '<div>' + escape(m.text) + '</div>';
                html += '<div class="message-time">' + new Date(m.timestamp).toLocaleTimeString() + '</div></div>';
            }
            container.innerHTML = html;
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
        document.getElementById('chat-conversation').style.display = 'none';
        document.getElementById('chat-recent').style.display = 'block';
        currentChatUser = null;
        loadRecentChats();
    }

    window.viewUser = async function(username) {
        try {
            const user = await api.getUser(username);
            const isFollowing = currentUser.following ? currentUser.following.indexOf(username) !== -1 : false;
            const modal = document.getElementById('user-modal');
            const modalContent = document.getElementById('user-modal-content');
            if (!modal || !modalContent) return;
            modalContent.innerHTML = '<div class="user-profile-detail"><img class="view-avatar" src="' + escape(user.avatar) + '"><h2>' + escape(user.username) + '</h2>';
            modalContent.innerHTML += '<p class="view-bio">' + escape(user.bio || 'Music creator') + '</p>';
            modalContent.innerHTML += '<div><button class="follow-btn ' + (isFollowing ? 'following' : '') + '" onclick="window.followUser(\'' + escape(username) + '\', this)">' + (isFollowing ? 'Following' : 'Follow') + '</button>';
            modalContent.innerHTML += '<button class="message-btn" onclick="window.startChat(\'' + escape(username) + '\'); document.getElementById(\'user-modal\').style.display = \'none\';">💬 Message</button></div>';
            modalContent.innerHTML += '<div class="stats-row"><div><span>' + (user.followers?.length || 0) + '</span><label>Followers</label></div>';
            modalContent.innerHTML += '<div><span>' + (user.following?.length || 0) + '</span><label>Following</label></div>';
            modalContent.innerHTML += '<div><span>' + (user.contributedTo?.length || 0) + '</span><label>Tracks</label></div></div>';
            modalContent.innerHTML += '<div><h4>🎵 Tracks</h4><div id="user-tracks-list"></div></div></div>';
            
            const songs = await api.getSongs();
            const userSongs = songs.filter(s => (user.contributedTo && user.contributedTo.indexOf(s.id) !== -1) || s.creator === username);
            const tracksDiv = document.getElementById('user-tracks-list');
            if (tracksDiv) {
                if (userSongs.length === 0) tracksDiv.innerHTML = '<div style="color:#888;text-align:center">No tracks yet</div>';
                else {
                    let html = '';
                    for (let s of userSongs) {
                        html += '<div class="song-card" onclick="window.selectSong(\'' + s.id + '\'); document.getElementById(\'user-modal\').style.display = \'none\';">';
                        html += '<img class="song-thumb" src="' + s.thumbnail + '"><div class="song-info"><div class="song-title">' + escape(s.title) + '</div>';
                        html += '<div class="song-stats">🎵 ' + s.trackCount + ' tracks</div></div></div>';
                    }
                    tracksDiv.innerHTML = html;
                }
            }
            modal.style.display = 'flex';
        } catch(e) { showToast('Error loading profile'); }
    };

    window.followUser = async function(username, btn) {
        try {
            const res = await api.followUser(username);
            if (res.following) { btn.textContent = 'Following'; btn.classList.add('following'); showToast('Following ' + username); }
            else { btn.textContent = 'Follow'; btn.classList.remove('following'); showToast('Unfollowed ' + username); }
            loadFeed();
        } catch(e) { showToast('Error following user'); }
    };

    async function showTutorial() {
        if (currentUser.tutorialCompleted) return;
        const tutorialOverlay = document.getElementById('tutorial-overlay');
        if (!tutorialOverlay) return;
        tutorialOverlay.style.display = 'flex';
        const dontShow = document.getElementById('tutorial-dont-show');
        const finishBtn = document.getElementById('tutorial-finish');
        if (finishBtn) {
            finishBtn.onclick = async () => {
                if (dontShow && dontShow.checked) {
                    await api.updateTutorial(true);
                    currentUser.tutorialCompleted = true;
                }
                tutorialOverlay.style.display = 'none';
            };
        }
    }

    function initSocket() {
        socket = io();
        socket.on('connect', () => console.log('Socket connected'));
        socket.on('track-added', async (data) => { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); loadFeed(); });
        socket.on('track-deleted', async (data) => { if (currentSong && currentSong.id === data.songId) { currentSong = await api.getSong(currentSong.id); displayTracks(); } loadSongs(); loadFeed(); });
        socket.on('track-updated', (data) => { if (currentSong) { const t = currentSong.tracks.find(tr => tr.id === data.trackId); if (t && data.updates) { if (data.updates.muted !== undefined) t.muted = data.updates.muted; if (data.updates.volume !== undefined) t.volume = data.updates.volume; if (data.updates.fx !== undefined) t.fx = data.updates.fx; displayTracks(); } } });
        socket.on('transport-state', (state) => { if (state.bpm && state.bpm !== bpm && currentSong && !isOwner) { bpm = state.bpm; const bpmInput = document.getElementById('bpm-input'); if (bpmInput) bpmInput.value = bpm; } });
        socket.on('bpm-changed', (data) => { if (currentSong && !isOwner) { bpm = data.bpm; const bpmInput = document.getElementById('bpm-input'); if (bpmInput) bpmInput.value = bpm; } });
        socket.on('new-message', (msg) => { if (currentChatUser === msg.from) loadConversation(msg.from); showToast('New message from ' + msg.from); loadRecentChats(); });
        socket.on('new-comment', () => { if (currentSong) displayComments(); });
        socket.on('song-updated', () => { loadSongs(); loadFeed(); });
        socket.on('song-deleted', () => { if (currentSong) backToLibrary(); loadSongs(); loadFeed(); });
        socket.emit('join-chat', currentUser.username);
    }

    function initNav() {
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.onclick = () => {
                const view = btn.dataset.view;
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                const targetView = document.getElementById(view + '-view');
                if (targetView) targetView.classList.add('active');
                if (view === 'profile') loadProfile();
                if (view === 'social') { loadRecentChats(); document.getElementById('chat-recent').style.display = 'block'; document.getElementById('chat-conversation').style.display = 'none'; }
                if (view === 'library') loadSongs();
                if (view === 'feed') loadFeed();
            };
        });
    }

    function randomizeThumbPreview() {
        const id = Math.floor(Math.random() * 100) + 1;
        const thumbPreview = document.getElementById('thumb-preview');
        if (thumbPreview) thumbPreview.src = 'https://picsum.photos/id/' + id + '/200/200';
    }

    function escape(str) { if (!str) return ''; const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    function showToast(msg, duration = 3000) { let toast = document.querySelector('.toast'); if (toast) toast.remove(); toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = msg; document.body.appendChild(toast); setTimeout(() => toast.remove(), duration); }

    function setupEventListeners() {
        // Auth tabs
        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.onclick = () => {
                const tabName = tab.dataset.tab;
                document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
                tab.classList.add('active');
                const form = document.getElementById(tabName + '-form');
                if (form) form.classList.add('active');
            };
        });
        
        // Login form
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.onsubmit = async (e) => {
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
        
        // Register form
        const registerForm = document.getElementById('register-form');
        if (registerForm) {
            registerForm.onsubmit = async (e) => {
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
        
        // Logout
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) logoutBtn.onclick = logout;
        
        // Profile click
        const headerAvatar = document.getElementById('header-avatar');
        if (headerAvatar) headerAvatar.onclick = openProfileModal;
        const usernameSpan = document.querySelector('.username');
        if (usernameSpan) usernameSpan.onclick = openProfileModal;
        
        // Close modals
        const closeModal = document.querySelector('.close-modal');
        if (closeModal) closeModal.onclick = () => document.getElementById('profile-modal').style.display = 'none';
        const closeUserModal = document.querySelector('.close-user-modal');
        if (closeUserModal) closeUserModal.onclick = () => document.getElementById('user-modal').style.display = 'none';
        const closeEditModal = document.querySelector('.close-edit-modal');
        if (closeEditModal) closeEditModal.onclick = closeEditSongModal;
        const closeVersionsModal = document.querySelector('.close-versions-modal');
        if (closeVersionsModal) closeVersionsModal.onclick = () => document.getElementById('versions-modal').style.display = 'none';
        const closeVersions = document.getElementById('close-versions');
        if (closeVersions) closeVersions.onclick = () => document.getElementById('versions-modal').style.display = 'none';
        
        // Save profile
        const saveProfileBtn = document.getElementById('save-profile');
        if (saveProfileBtn) saveProfileBtn.onclick = saveProfile;
        
        // Change avatar
        const changeAvatarBtn = document.getElementById('change-avatar');
        if (changeAvatarBtn) {
            changeAvatarBtn.onclick = () => document.getElementById('avatar-file').click();
        }
        const avatarFile = document.getElementById('avatar-file');
        if (avatarFile) avatarFile.onchange = (e) => { if (e.target.files[0]) uploadAvatar(e.target.files[0]); };
        
        // Create modal
        const openCreateModal = document.getElementById('open-create-modal');
        if (openCreateModal) openCreateModal.onclick = () => { randomizeThumbPreview(); document.getElementById('create-modal').style.display = 'flex'; };
        const confirmCreate = document.getElementById('confirm-create');
        if (confirmCreate) confirmCreate.onclick = createSong;
        const cancelCreate = document.getElementById('cancel-create');
        if (cancelCreate) cancelCreate.onclick = () => document.getElementById('create-modal').style.display = 'none';
        
        // Random thumb
        const randomThumb = document.getElementById('random-thumb');
        if (randomThumb) randomThumb.onclick = randomizeThumbPreview;
        
        // Upload thumb
        const uploadThumbBtn = document.getElementById('upload-thumb-btn');
        if (uploadThumbBtn) {
            uploadThumbBtn.onclick = () => document.getElementById('thumb-file').click();
        }
        const thumbFile = document.getElementById('thumb-file');
        if (thumbFile) {
            thumbFile.onchange = (e) => {
                if (e.target.files[0]) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
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
        if (uploadBtn) uploadBtn.onclick = () => document.getElementById('audio-file').click();
        const audioFile = document.getElementById('audio-file');
        if (audioFile) audioFile.onchange = uploadTrackFile;
        
        // Back button
        const backBtn = document.getElementById('back-btn');
        if (backBtn) backBtn.onclick = backToLibrary;
        
        // Versions button
        const versionsBtn = document.getElementById('view-versions-btn');
        if (versionsBtn) versionsBtn.onclick = showVersionTree;
        
        // Comments
        const postCommentBtn = document.getElementById('post-comment');
        if (postCommentBtn) postCommentBtn.onclick = postComment;
        const commentInput = document.getElementById('comment-input');
        if (commentInput) commentInput.onkeypress = (e) => { if (e.key === 'Enter') postComment(); };
        
        // Chat
        const backToRecentBtn = document.getElementById('back-to-recent');
        if (backToRecentBtn) backToRecentBtn.onclick = backToRecent;
        const sendChatBtn = document.getElementById('send-chat');
        if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
        const chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendChatMessage(); };
        
        // Edit song modal
        const saveSongChangesBtn = document.getElementById('save-song-changes');
        if (saveSongChangesBtn) saveSongChangesBtn.onclick = saveSongChanges;
        const deleteSongVersionBtn = document.getElementById('delete-song-version');
        if (deleteSongVersionBtn) deleteSongVersionBtn.onclick = deleteSongVersion;
        const editRandomThumb = document.getElementById('edit-random-thumb');
        if (editRandomThumb) editRandomThumb.onclick = randomizeEditThumbnail;
        const editUploadThumb = document.getElementById('edit-upload-thumb');
        if (editUploadThumb) {
            editUploadThumb.onclick = () => document.getElementById('edit-thumb-file').click();
        }
        const editThumbFile = document.getElementById('edit-thumb-file');
        if (editThumbFile) {
            editThumbFile.onchange = (e) => {
                if (e.target.files[0]) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        document.getElementById('edit-thumb-preview').src = ev.target.result;
                        currentEditThumbnail = ev.target.result;
                    };
                    reader.readAsDataURL(e.target.files[0]);
                }
            };
        }
        
        // Close modals on outside click
        const modals = ['create-modal', 'edit-song-modal', 'profile-modal', 'user-modal', 'versions-modal'];
        for (let id of modals) {
            const modal = document.getElementById(id);
            if (modal) {
                modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
            }
        }
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        if (initialized) return;
        initialized = true;
        
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
            loadFeed();
            initNav();
            setupEventListeners();
            showTutorial();
        } else {
            document.getElementById('auth-modal').style.display = 'flex';
            setupEventListeners();
        }
    });
})();

// Make functions global
window.selectSong = window.selectSong;
window.toggleMute = window.toggleMute;
window.adjustVolume = window.adjustVolume;
window.voteTrack = window.voteTrack;
window.deleteTrack = window.deleteTrack;
window.viewUser = window.viewUser;
window.followUser = window.followUser;
window.startChat = window.startChat;
window.followFromFeed = window.followFromFeed;
window.likeComment = window.likeComment;
window.openEditSongModal = window.openEditSongModal;
window.toggleTrackFX = window.toggleTrackFX;
window.viewOriginal = window.viewOriginal;