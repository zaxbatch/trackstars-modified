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
        if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
        if (audioCtx) audioCtx.close();
        localStorage.clear();
        window.location.reload();
    }

    // Audio Functions
    async function initAudio() { 
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
        return audioCtx; 
    }

    async function loadTracks() {
        if (!currentSong) return;
        buffers.clear();
        for (let i = 0; i < currentSong.tracks.length; i++) {
            let t = currentSong.tracks[i];
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
        const time = (when !== undefined) ? when : audioCtx.currentTime;
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
            let hasTrack = false;
            for (let i = 0; i < currentSong.tracks.length; i++) {
                if (currentSong.tracks[i].username === currentUser.username) {
                    hasTrack = true;
                    break;
                }
            }
            if (hasTrack) {
                showToast('You already have a track in this song!');
                return false;
            }
        }
        await loadTracks();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        isPlaying = true;
        startTime = audioCtx.currentTime - currentPos;
        for (let i = 0; i < currentSong.tracks.length; i++) {
            let t = currentSong.tracks[i];
            if (!t.muted) scheduleTrack(t, currentPos);
        }
        if (recordMode) await startRecording();
        const playBtn = document.getElementById('play-btn');
        if (playBtn) { 
            playBtn.textContent = '⏸️ Pause'; 
            playBtn.className = 'pause-btn'; 
        }
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(function() { 
            if (isPlaying) updateDisplay(audioCtx.currentTime - startTime); 
        }, 50);
        return true;
    }

    function pausePlayback() {
        if (!isPlaying) return;
        isPlaying = false;
        if (isRecording) stopRecording();
        for (let i = 0; i < sources.length; i++) { 
            try { sources[i].stop(); } catch(e) {} 
        }
        sources = [];
        gains.clear();
        currentPos = audioCtx.currentTime - startTime;
        const playBtn = document.getElementById('play-btn');
        if (playBtn) { 
            playBtn.textContent = '▶ Play'; 
            playBtn.className = 'play-btn'; 
        }
        if (timerInterval) { 
            clearInterval(timerInterval); 
            timerInterval = null; 
        }
    }

    function stopPlayback() {
        if (isPlaying) { 
            if (isRecording) stopRecording(); 
            pausePlayback(); 
        }
        currentPos = 0;
        updateDisplay(0);
    }

    async function startRecording() {
        try {
            if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeTypes = ['audio/webm', 'audio/mp4', 'audio/wav'];
            let mime = '';
            for (let i = 0; i < mimeTypes.length; i++) {
                if (MediaRecorder.isTypeSupported(mimeTypes[i])) { 
                    mime = mimeTypes[i]; 
                    break; 
                }
            }
            mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
            chunks = [];
            mediaRecorder.ondataavailable = function(e) { 
                if (e.data.size > 0) chunks.push(e.data); 
            };
            mediaRecorder.onstop = async function() {
                if (chunks.length === 0) return;
                const blob = new Blob(chunks, { type: mime || 'audio/webm' });
                const fileName = 'recording-' + Date.now() + '.' + (mime.includes('webm') ? 'webm' : 'mp4');
                const file = new File([blob], fileName, { type: mime || 'audio/webm' });
                const statusDiv = document.getElementById('recording-status');
                if (statusDiv) statusDiv.innerHTML = '📤 Uploading...';
                try {
                    await api.uploadTrack(currentSong.id, file);
                    showToast('Track added!');
                    currentSong = await api.getSong(currentSong.id);
                    displayTracks();
                    if (statusDiv) statusDiv.innerHTML = '✅ Added!';
                    const recBtn = document.getElementById('record-btn');
                    const upBtn = document.getElementById('upload-btn');
                    if (recBtn) recBtn.disabled = true;
                    if (upBtn) upBtn.disabled = true;
                    setTimeout(function() { 
                        if (statusDiv) statusDiv.innerHTML = ''; 
                    }, 3000);
                    loadFeed(); 
                    loadSongs();
                } catch(e) { 
                    if (statusDiv) statusDiv.innerHTML = '❌ Upload failed'; 
                    showToast('Upload failed'); 
                }
                if (stream) { 
                    stream.getTracks().forEach(function(t) { t.stop(); }); 
                    stream = null; 
                }
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
        } catch(e) { 
            showToast('Microphone access denied'); 
            console.error(e); 
        }
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        isRecording = false;
        const recBtn = document.getElementById('record-btn');
        const stopRecBtn = document.getElementById('stop-record-btn');
        if (recBtn) recBtn.style.display = 'inline-block';
        if (stopRecBtn) stopRecBtn.style.display = 'none';
    }

    async function startRecordingWithPlayback() {
        if (!currentSong) return showToast('Select a song first');
        if (isRecording) return showToast('Already recording');
        let hasTrack = false;
        for (let i = 0; i < currentSong.tracks.length; i++) {
            if (currentSong.tracks[i].username === currentUser.username) {
                hasTrack = true;
                break;
            }
        }
        if (hasTrack) {
            showToast('You already have a track in this song!');
            return;
        }
        if (isPlaying) stopPlayback();
        currentPos = 0;
        updateDisplay(0);
        await new Promise(function(r) { setTimeout(r, 100); });
        await startPlayback(true);
    }

    async function uploadTrackFile() {
        const fileInput = document.getElementById('audio-file');
        if (!fileInput || !fileInput.files[0]) return showToast('Select a file');
        const file = fileInput.files[0];
        let hasTrack = false;
        for (let i = 0; i < currentSong.tracks.length; i++) {
            if (currentSong.tracks[i].username === currentUser.username) {
                hasTrack = true;
                break;
            }
        }
        if (hasTrack) {
            showToast('You already have a track in this song!');
            return;
        }
        try {
            await api.uploadTrack(currentSong.id, file);
            showToast('Track added!');
            currentSong = await api.getSong(currentSong.id);
            displayTracks();
            const recBtn = document.getElementById('record-btn');
            const upBtn = document.getElementById('upload-btn');
            if (recBtn) recBtn.disabled = true;
            if (upBtn) upBtn.disabled = true;
            loadFeed();
        } catch(e) { 
            showToast('Error uploading track'); 
        }
    }

    function stopRecordingAndPlayback() {
        if (isRecording) stopRecording();
        if (isPlaying) stopPlayback();
    }

    function updateDisplay(pos) {
        const display = document.getElementById('position-display');
        if (!display) return;
        const m = Math.floor(pos / 60);
        const s = Math.floor(pos % 60);
        const ms = Math.floor((pos % 1) * 100);
        display.textContent = m.toString().padStart(2,'0') + ':' + s.toString().padStart(2,'0') + ':' + ms.toString().padStart(2,'0');
    }

    // Display Functions
    function displaySongList(songs) {
        const container = document.getElementById('song-list');
        if (!container) return;
        if (songs.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div><h3>No tracks yet</h3><p>Create your first track to get started!</p><button class="create-btn" id="empty-create-btn">+ Create New Track</button></div>';
            const emptyBtn = document.getElementById('empty-create-btn');
            if (emptyBtn) emptyBtn.onclick = function() { 
                document.getElementById('open-create-modal').click(); 
            };
            return;
        }
        let html = '';
        for (let i = 0; i < songs.length; i++) {
            let s = songs[i];
            let isOwnerFlag = (s.creator === currentUser.username);
            html += '<div class="song-card" onclick="window.selectSong(\'' + s.id + '\')">';
            html += '<img class="song-thumb" src="' + escape(s.thumbnail) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(s.title.substring(0,2)) + '\'">';
            html += '<div class="song-info">';
            html += '<div class="song-title">' + escape(s.title);
            if (isOwnerFlag) html += '<span class="owner-badge">OWNER</span>';
            html += '</div>';
            html += '<div class="song-creator" onclick="event.stopPropagation(); window.viewUser(\'' + escape(s.creator) + '\')">' + escape(s.creator) + '</div>';
            html += '<div class="song-stats">🎵 ' + s.trackCount + ' tracks | 👍 ' + s.likes + ' likes</div>';
            html += '</div>';
            if (isOwnerFlag) {
                html += '<div class="song-actions" onclick="event.stopPropagation()">';
                html += '<button class="edit-song-btn" onclick="window.openEditSongModal(\'' + s.id + '\', event)">✏️ Edit</button>';
                html += '</div>';
            }
            html += '</div>';
        }
        container.innerHTML = html;
    }

    async function loadSongs() {
        try {
            const songs = await api.getSongs();
            displaySongList(songs);
        } catch(e) { 
            console.error(e); 
            showToast('Error loading songs'); 
        }
    }

    window.selectSong = async function(id) {
        try {
            if (isPlaying) stopPlayback();
            if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
            if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
            if (audioCtx) await audioCtx.close();
            buffers.clear(); 
            sources = []; 
            gains.clear();
            audioCtx = null;
            currentSong = await api.getSong(id);
            isOwner = (currentSong.creator === currentUser.username);
            
            const titleEl = document.getElementById('current-song-title');
            const creatorEl = document.getElementById('song-creator');
            const bpmInput = document.getElementById('bpm-input');
            const bpmLock = document.getElementById('bpm-lock');
            
            if (titleEl) titleEl.textContent = currentSong.title;
            if (creatorEl) {
                creatorEl.innerHTML = 'Created by <span style="color:#667eea;cursor:pointer" onclick="window.viewUser(\'' + escape(currentSong.creator) + '\')">' + escape(currentSong.creator) + '</span> • ' + currentSong.genre + ' • ' + currentSong.bpm + ' BPM';
            }
            if (bpmInput) { 
                bpmInput.value = currentSong.bpm; 
                bpmInput.disabled = !isOwner; 
            }
            if (bpmLock) { 
                bpmLock.className = 'bpm-lock ' + (isOwner ? 'unlocked' : ''); 
                bpmLock.innerHTML = isOwner ? '🔓' : '🔒'; 
            }
            bpm = currentSong.bpm;
            
            if (socket) socket.emit('join-song', id);
            displayTracks();
            displayComments();
            
            let hasTrack = false;
            for (let i = 0; i < currentSong.tracks.length; i++) {
                if (currentSong.tracks[i].username === currentUser.username) {
                    hasTrack = true;
                    break;
                }
            }
            const recBtn = document.getElementById('record-btn');
            const upBtn = document.getElementById('upload-btn');
            if (recBtn) recBtn.disabled = hasTrack;
            if (upBtn) upBtn.disabled = hasTrack;
            currentPos = 0;
            updateDisplay(0);
            
            const views = document.querySelectorAll('.view');
            for (let i = 0; i < views.length; i++) {
                views[i].classList.remove('active');
            }
            const studioView = document.getElementById('studio-view');
            if (studioView) {
                studioView.classList.add('active');
                studioView.style.display = 'block';
            }
            const navItems = document.querySelectorAll('.nav-item');
            for (let i = 0; i < navItems.length; i++) {
                navItems[i].classList.remove('active');
            }
        } catch(e) { 
            showToast('Error loading song'); 
            console.error(e); 
        }
    };

    function displayTracks() {
        const container = document.getElementById('track-mixer');
        if (!container) return;
        const tracks = currentSong.tracks || [];
        if (tracks.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">🎙️</div><h3>No tracks yet</h3><p>Be the first to add your sound!</p><div class="recording-hint">🎤 Click "Record" or "Upload" above to add your track</div></div>';
            return;
        }
        let html = '';
        for (let i = 0; i < tracks.length; i++) {
            let t = tracks[i];
            let isCurrentUserTrack = (t.username === currentUser.username);
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
                html += '<div class="fx-section">';
                html += '<button class="fx-btn ' + (t.fx && t.fx.reverb ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'reverb\')">🎛️ Reverb</button>';
                html += '<button class="fx-btn ' + (t.fx && t.fx.delay ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'delay\')">⏱️ Delay</button>';
                html += '<button class="fx-btn ' + (t.fx && t.fx.distortion ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'distortion\')">🎸 Distortion</button>';
                html += '<button class="fx-btn ' + (t.fx && t.fx.lowpass ? 'active' : '') + '" onclick="window.toggleTrackFX(\'' + t.id + '\', \'lowpass\')">🔽 Low Pass</button>';
                html += '</div>';
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    }

    window.toggleTrackFX = async function(trackId, fxName) {
        let track = null;
        for (let i = 0; i < currentSong.tracks.length; i++) {
            if (currentSong.tracks[i].id === trackId) {
                track = currentSong.tracks[i];
                break;
            }
        }
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
        if (comments.length === 0) { 
            container.innerHTML = '<div style="color:#888;text-align:center">No comments yet</div>'; 
            return; 
        }
        let html = '';
        for (let i = 0; i < comments.length; i++) {
            let c = comments[i];
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
        } catch(e) { 
            showToast('Error liking comment'); 
        }
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
        } catch(e) { 
            showToast('Error posting comment'); 
        }
    }

    window.toggleMute = async function(id) {
        let track = null;
        for (let i = 0; i < currentSong.tracks.length; i++) {
            if (currentSong.tracks[i].id === id) {
                track = currentSong.tracks[i];
                break;
            }
        }
        if (track) {
            track.muted = !track.muted;
            if (isPlaying) { 
                let pos = currentPos; 
                pausePlayback(); 
                currentPos = pos; 
                await startPlayback(false); 
            }
            displayTracks();
            await fetch('/api/songs/' + currentSong.id + '/track/' + id, { 
                method: 'PUT', 
                headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ muted: track.muted }) 
            });
        }
    };

    window.adjustVolume = async function(id, vol) {
        let track = null;
        for (let i = 0; i < currentSong.tracks.length; i++) {
            if (currentSong.tracks[i].id === id) {
                track = currentSong.tracks[i];
                break;
            }
        }
        if (track) {
            track.volume = parseFloat(vol);
            const gain = gains.get(id);
            if (gain) gain.gain.value = track.volume;
            await fetch('/api/songs/' + currentSong.id + '/track/' + id, { 
                method: 'PUT', 
                headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ volume: track.volume }) 
            });
        }
    };

    window.voteTrack = async function(id, vote) {
        try {
            const res = await api.voteTrack(currentSong.id, id, vote);
            for (let i = 0; i < currentSong.tracks.length; i++) {
                if (currentSong.tracks[i].id === id) {
                    currentSong.tracks[i].votes = res.votes;
                    break;
                }
            }
            displayTracks();
            loadFeed();
        } catch(e) { 
            showToast('Error voting'); 
        }
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
            loadFeed(); 
            loadSongs();
        } catch(e) { 
            showToast('Error deleting track'); 
        }
    };

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
            const song = await api.createSong({ title, bpm: b, genre, thumbnail: (thumbnail && thumbnail.indexOf('ui-avatars') !== -1) ? thumbnail : null });
            showToast('Song created! Now add your first track!');
            document.getElementById('create-modal').style.display = 'none';
            document.getElementById('new-title').value = '';
            loadSongs(); 
            loadFeed(); 
            await window.selectSong(song.id);
            setTimeout(function() {
                const addTrack = confirm('Would you like to add a track to your new song?');
                if (addTrack) {
                    document.getElementById('record-btn').click();
                }
            }, 500);
        } catch(e) { 
            showToast('Error creating song'); 
        }
    }

    async function updateBpm() {
        const input = document.getElementById('bpm-input');
        if (!input) return;
        const newBpm = parseInt(input.value);
        if (isNaN(newBpm)) return;
        if (!isOwner) { 
            showToast('Only the creator can change BPM'); 
            input.value = bpm; 
            return; 
        }
        const clampedBpm = Math.min(300, Math.max(40, newBpm));
        try {
            await api.updateBpm(currentSong.id, clampedBpm);
            bpm = clampedBpm;
            showToast('BPM updated');
        } catch(e) { 
            showToast('Error updating BPM'); 
        }
    }

    function backToLibrary() {
        if (isPlaying) stopPlayback();
        if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
        if (audioCtx) audioCtx.close();
        if (socket && currentSong) socket.emit('leave-song', currentSong.id);
        currentSong = null;
        
        const studioView = document.getElementById('studio-view');
        if (studioView) {
            studioView.classList.remove('active');
            studioView.style.display = 'none';
        }
        
        const views = document.querySelectorAll('.view');
        for (let i = 0; i < views.length; i++) {
            views[i].classList.remove('active');
        }
        const libraryView = document.getElementById('library-view');
        if (libraryView) libraryView.classList.add('active');
        
        const navItems = document.querySelectorAll('.nav-item');
        for (let i = 0; i < navItems.length; i++) {
            navItems[i].classList.remove('active');
        }
        const libraryNav = document.querySelector('.nav-item[data-view="library"]');
        if (libraryNav) libraryNav.classList.add('active');
        
        loadSongs();
    }

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
        } catch(e) { 
            showToast('Error loading song data'); 
        }
    };

    function closeEditSongModal() {
        document.getElementById('edit-song-modal').style.display = 'none';
        currentEditingSong = null;
        currentEditThumbnail = null;
    }

    async function saveSongChanges() {
        if (!currentEditingSong) return;
        const newTitle = document.getElementById('edit-song-title').value.trim();
        if (!newTitle) { 
            showToast('Title cannot be empty'); 
            return; 
        }
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
        } catch(e) { 
            showToast('Error saving changes: ' + e.message); 
        }
    }

    async function deleteSongVersion() {
        if (!currentEditingSong) return;
        if (!confirm('Delete "' + currentEditingSong.title + '"? This cannot be undone.')) return;
        try {
            await api.deleteSong(currentEditingSong.id);
            showToast('Song deleted!');
            closeEditSongModal();
            if (currentSong && currentSong.id === currentEditingSong.id) backToLibrary();
            loadSongs();
            loadFeed();
        } catch(e) { 
            showToast('Error deleting song: ' + e.message); 
        }
    }

    function randomizeEditThumbnail() {
        const colors = ['667eea', '764ba2', 'f39c12', 'e74c3c', '27ae60', '3498db', '1abc9c', 'e67e22', '9b59b6'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        const title = document.getElementById('edit-song-title').value || 'Track';
        const newThumb = 'https://ui-avatars.com/api/?background=' + color + '&color=fff&size=200&fontsize=80&length=2&bold=true&name=' + encodeURIComponent(title.substring(0, 2));
        document.getElementById('edit-thumb-preview').src = newThumb;
        currentEditThumbnail = newThumb;
    }

    // Feed Functions
    async function loadFeed() {
        try {
            const feed = await api.getFeed();
            
            const trendingContainer = document.getElementById('trending-songs');
            if (trendingContainer) {
                if (feed.trendingSongs && feed.trendingSongs.length) {
                    let html = '';
                    for (let i = 0; i < feed.trendingSongs.length; i++) {
                        let s = feed.trendingSongs[i];
                        html += '<div class="trending-card" onclick="window.selectSong(\'' + s.id + '\')">';
                        html += '<img src="' + escape(s.thumbnail) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(s.title.substring(0,2)) + '\'"><div class="trending-info">';
                        html += '<div class="trending-title">' + escape(s.title) + '</div>';
                        html += '<div class="trending-creator" onclick="event.stopPropagation(); window.viewUser(\'' + escape(s.creator) + '\')">' + escape(s.creator) + '</div>';
                        html += '<div class="trending-stats">👍 ' + s.likes + ' • 🎵 ' + s.trackCount + '</div>';
                        html += '</div></div>';
                    }
                    trendingContainer.innerHTML = html;
                } else { 
                    trendingContainer.innerHTML = '<div class="loading">No trending tracks</div>'; 
                }
            }
            
            const activityContainer = document.getElementById('activity-feed');
            if (activityContainer) {
                if (feed.activityFeed && feed.activityFeed.length) {
                    let html = '';
                    for (let i = 0; i < feed.activityFeed.length; i++) {
                        let item = feed.activityFeed[i];
                        html += '<div class="activity-item" onclick="window.selectSong(\'' + item.id + '\')">';
                        html += '<div class="activity-icon">🆕</div>';
                        html += '<div class="activity-info">';
                        html += '<div class="activity-title">' + escape(item.title) + '</div>';
                        html += '<div class="activity-detail">Created by ' + escape(item.creator) + '</div>';
                        html += '</div>';
                        html += '<div class="activity-time">👍 ' + item.likes + '</div>';
                        html += '</div>';
                    }
                    activityContainer.innerHTML = html;
                } else { 
                    activityContainer.innerHTML = '<div class="loading">No recent activity</div>'; 
                }
            }
            
            const contributorsContainer = document.getElementById('top-contributors');
            if (contributorsContainer) {
                if (feed.topContributors && feed.topContributors.length) {
                    let html = '';
                    for (let i = 0; i < feed.topContributors.length; i++) {
                        let u = feed.topContributors[i];
                        html += '<div class="user-card">';
                        html += '<img class="user-avatar" src="' + escape(u.avatar) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(u.username) + '\'" onclick="window.viewUser(\'' + escape(u.username) + '\')">';
                        html += '<div class="user-info">';
                        html += '<div class="user-name" onclick="window.viewUser(\'' + escape(u.username) + '\')">' + escape(u.username) + '</div>';
                        html += '<div class="user-stats">🎵 ' + u.trackCount + ' tracks • 👥 ' + u.followersCount + ' followers</div>';
                        html += '</div>';
                        html += '<button class="follow-small-btn ' + (u.isFollowing ? 'following' : '') + '" onclick="window.followFromFeed(\'' + escape(u.username) + '\', this)">' + (u.isFollowing ? 'Following' : 'Follow') + '</button>';
                        html += '</div>';
                    }
                    contributorsContainer.innerHTML = html;
                } else { 
                    contributorsContainer.innerHTML = '<div class="loading">No contributors yet</div>'; 
                }
            }
        } catch(e) { 
            console.error('Error loading feed:', e); 
            showToast('Error loading feed'); 
        }
    }

    window.followFromFeed = async function(username, btn) {
        try {
            const res = await api.followUser(username);
            if (res.following) { 
                btn.textContent = 'Following'; 
                btn.classList.add('following'); 
                showToast('Following ' + username); 
            } else { 
                btn.textContent = 'Follow'; 
                btn.classList.remove('following'); 
                showToast('Unfollowed ' + username); 
            }
            loadFeed();
        } catch(e) { 
            showToast('Error following user'); 
        }
    };

    // Profile Functions
    async function loadProfile() {
        const container = document.getElementById('profile-content');
        if (!container) return;
        try {
            const user = await api.getUser(currentUser.username);
            container.innerHTML = '<div class="profile-header"><img class="profile-avatar" src="' + escape(user.avatar) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(currentUser.username) + '\'"><h2>' + escape(user.username) + '</h2>';
            container.innerHTML += '<p class="profile-bio">' + escape(user.bio || 'Music creator on TrackStars') + '</p>';
            container.innerHTML += '<button class="edit-profile-btn" id="edit-profile-btn">✏️ Edit Profile</button>';
            container.innerHTML += '<div class="stats-row"><div><span>' + (user.followers?.length || 0) + '</span><label>Followers</label></div>';
            container.innerHTML += '<div><span>' + (user.following?.length || 0) + '</span><label>Following</label></div>';
            container.innerHTML += '<div><span>' + (user.contributedTo?.length || 0) + '</span><label>Tracks</label></div></div></div>';
            container.innerHTML += '<div><h3>My Tracks</h3><div id="my-tracks-list"></div></div>';
            
            const songs = await api.getSongs();
            let mySongs = [];
            for (let i = 0; i < songs.length; i++) {
                if (songs[i].creator === currentUser.username) {
                    mySongs.push(songs[i]);
                }
            }
            const tracksDiv = document.getElementById('my-tracks-list');
            if (tracksDiv) {
                if (mySongs.length === 0) {
                    tracksDiv.innerHTML = '<div class="empty-state-small">No tracks yet. <button class="create-btn-small" id="profile-create-btn">Create one!</button></div>';
                } else {
                    let html = '';
                    for (let i = 0; i < mySongs.length; i++) {
                        let s = mySongs[i];
                        html += '<div class="song-card" onclick="window.selectSong(\'' + s.id + '\')"><img class="song-thumb" src="' + s.thumbnail + '"><div class="song-info"><div class="song-title">' + escape(s.title) + '</div><div class="song-stats">🎵 ' + s.trackCount + ' tracks | 👍 ' + s.likes + '</div></div></div>';
                    }
                    tracksDiv.innerHTML = html;
                }
            }
            const editBtn = document.getElementById('edit-profile-btn');
            if (editBtn) editBtn.onclick = openProfileModal;
            const profileCreateBtn = document.getElementById('profile-create-btn');
            if (profileCreateBtn) profileCreateBtn.onclick = function() { 
                document.getElementById('open-create-modal').click(); 
            };
        } catch(e) { 
            container.innerHTML = '<div class="loading">Error loading profile</div>'; 
        }
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
        } catch(e) { 
            showToast('Error loading profile'); 
        }
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
        } catch(e) { 
            showToast('Error saving profile'); 
        }
    }

    async function uploadAvatar(file) {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        let validType = false;
        for (let i = 0; i < allowedTypes.length; i++) {
            if (file.type === allowedTypes[i]) {
                validType = true;
                break;
            }
        }
        if (!validType) {
            showToast('Invalid file type. Use JPEG, PNG, GIF, or WEBP.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast('File too large. Max size is 5MB.');
            return;
        }
        try {
            const res = await api.uploadAvatar(file);
            currentUser.avatar = res.avatar;
            const headerAvatar = document.getElementById('header-avatar');
            if (headerAvatar) headerAvatar.src = res.avatar + '?t=' + Date.now();
            showToast('Avatar updated!');
            if (document.getElementById('profile-view').classList.contains('active')) {
                loadProfile();
            }
        } catch(e) { 
            showToast('Error uploading avatar: ' + e.message); 
        }
    }

    // Chat Functions
    async function loadRecentChats() {
        const container = document.getElementById('chat-recent');
        if (!container) return;
        try {
            const chats = await api.getRecentChats();
            if (chats.length === 0) { 
                container.innerHTML = '<div class="loading">No recent chats. Search for users above!</div>'; 
                return; 
            }
            let html = '';
            for (let i = 0; i < chats.length; i++) {
                let c = chats[i];
                html += '<div class="chat-user-item" onclick="window.startChat(\'' + escape(c.otherUser) + '\')">';
                html += '<img src="' + escape(c.avatar) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(c.otherUser) + '\'">';
                html += '<div class="chat-user-info"><div class="chat-user-name">' + escape(c.otherUser) + '</div>';
                html += '<div class="chat-preview">' + escape(c.text.substring(0, 30)) + '</div></div>';
                html += '<div class="chat-time">' + new Date(c.timestamp).toLocaleTimeString() + '</div></div>';
            }
            container.innerHTML = html;
        } catch(e) { 
            container.innerHTML = '<div class="loading">Error loading chats</div>'; 
        }
        
        const searchInput = document.getElementById('chat-search-input');
        if (searchInput) {
            searchInput.oninput = async function() {
                const term = searchInput.value;
                if (!term) { 
                    loadRecentChats(); 
                    return; 
                }
                try {
                    const users = await api.searchUsers(term);
                    if (users.length === 0) { 
                        container.innerHTML = '<div class="loading">No users found</div>'; 
                        return; 
                    }
                    let html = '';
                    for (let i = 0; i < users.length; i++) {
                        let u = users[i];
                        html += '<div class="chat-user-item" onclick="window.startChat(\'' + escape(u.username) + '\')">';
                        html += '<img src="' + escape(u.avatar) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(u.username) + '\'">';
                        html += '<div class="chat-user-info"><div class="chat-user-name">' + escape(u.username) + '</div>';
                        html += '<div class="chat-preview">' + u.followersCount + ' followers</div></div></div>';
                    }
                    container.innerHTML = html;
                } catch(e) { 
                    container.innerHTML = '<div class="loading">Error searching</div>'; 
                }
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
            for (let i = 0; i < msgs.length; i++) {
                let m = msgs[i];
                html += '<div class="message ' + (m.from === currentUser.username ? 'sent' : 'received') + '">';
                html += '<div>' + escape(m.text) + '</div>';
                html += '<div class="message-time">' + new Date(m.timestamp).toLocaleTimeString() + '</div></div>';
            }
            container.innerHTML = html;
            container.scrollTop = container.scrollHeight;
        } catch(e) { 
            console.error(e); 
        }
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
        } catch(e) { 
            showToast('Error sending message'); 
        }
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
            let isFollowing = false;
            if (currentUser.following) {
                for (let i = 0; i < currentUser.following.length; i++) {
                    if (currentUser.following[i] === username) {
                        isFollowing = true;
                        break;
                    }
                }
            }
            const modal = document.getElementById('user-modal');
            const modalContent = document.getElementById('user-modal-content');
            if (!modal || !modalContent) return;
            modalContent.innerHTML = '<div class="user-profile-detail"><img class="view-avatar" src="' + escape(user.avatar) + '" onerror="this.src=\'https://ui-avatars.com/api/?background=667eea&color=fff&size=200&name=' + encodeURIComponent(username) + '\'"><h2>' + escape(user.username) + '</h2>';
            modalContent.innerHTML += '<p class="view-bio">' + escape(user.bio || 'Music creator') + '</p>';
            modalContent.innerHTML += '<div><button class="follow-btn ' + (isFollowing ? 'following' : '') + '" onclick="window.followUser(\'' + escape(username) + '\', this)">' + (isFollowing ? 'Following' : 'Follow') + '</button>';
            modalContent.innerHTML += '<button class="message-btn" onclick="window.startChat(\'' + escape(username) + '\'); document.getElementById(\'user-modal\').style.display = \'none\';">💬 Message</button></div>';
            modalContent.innerHTML += '<div class="stats-row"><div><span>' + (user.followers?.length || 0) + '</span><label>Followers</label></div>';
            modalContent.innerHTML += '<div><span>' + (user.following?.length || 0) + '</span><label>Following</label></div>';
            modalContent.innerHTML += '<div><span>' + (user.contributedTo?.length || 0) + '</span><label>Tracks</label></div></div>';
            modalContent.innerHTML += '<div><h4>🎵 Tracks</h4><div id="user-tracks-list"></div></div></div>';
            
            const songs = await api.getSongs();
            let userSongs = [];
            for (let i = 0; i < songs.length; i++) {
                let s = songs[i];
                if ((user.contributedTo && user.contributedTo.indexOf(s.id) !== -1) || s.creator === username) {
                    userSongs.push(s);
                }
            }
            const tracksDiv = document.getElementById('user-tracks-list');
            if (tracksDiv) {
                if (userSongs.length === 0) {
                    tracksDiv.innerHTML = '<div style="color:#888;text-align:center">No tracks yet</div>';
                } else {
                    let html = '';
                    for (let i = 0; i < userSongs.length; i++) {
                        let s = userSongs[i];
                        html += '<div class="song-card" onclick="window.selectSong(\'' + s.id + '\'); document.getElementById(\'user-modal\').style.display = \'none\';">';
                        html += '<img class="song-thumb" src="' + s.thumbnail + '"><div class="song-info"><div class="song-title">' + escape(s.title) + '</div>';
                        html += '<div class="song-stats">🎵 ' + s.trackCount + ' tracks</div></div></div>';
                    }
                    tracksDiv.innerHTML = html;
                }
            }
            modal.style.display = 'flex';
        } catch(e) { 
            showToast('Error loading profile'); 
        }
    };

    window.followUser = async function(username, btn) {
        try {
            const res = await api.followUser(username);
            if (res.following) { 
                btn.textContent = 'Following'; 
                btn.classList.add('following'); 
                showToast('Following ' + username); 
            } else { 
                btn.textContent = 'Follow'; 
                btn.classList.remove('following'); 
                showToast('Unfollowed ' + username); 
            }
            loadFeed();
        } catch(e) { 
            showToast('Error following user'); 
        }
    };

    // Tutorial
    async function showTutorial() {
        if (currentUser.tutorialCompleted) return;
        const tutorialOverlay = document.getElementById('tutorial-overlay');
        if (!tutorialOverlay) return;
        tutorialOverlay.style.display = 'flex';
        const dontShow = document.getElementById('tutorial-dont-show');
        const finishBtn = document.getElementById('tutorial-finish');
        if (finishBtn) {
            finishBtn.onclick = async function() {
                if (dontShow && dontShow.checked) {
                    await api.updateTutorial(true);
                    currentUser.tutorialCompleted = true;
                }
                tutorialOverlay.style.display = 'none';
            };
        }
    }

    // Socket
    function initSocket() {
        socket = io();
        socket.on('connect', function() { console.log('Socket connected'); });
        socket.on('track-added', async function(data) { 
            if (currentSong && currentSong.id === data.songId) { 
                currentSong = await api.getSong(currentSong.id); 
                displayTracks(); 
            } 
            loadSongs(); 
            loadFeed(); 
        });
        socket.on('track-deleted', async function(data) { 
            if (currentSong && currentSong.id === data.songId) { 
                currentSong = await api.getSong(currentSong.id); 
                displayTracks(); 
            } 
            loadSongs(); 
            loadFeed(); 
        });
        socket.on('track-updated', function(data) { 
            if (currentSong) { 
                for (let i = 0; i < currentSong.tracks.length; i++) {
                    if (currentSong.tracks[i].id === data.trackId) {
                        if (data.updates.muted !== undefined) currentSong.tracks[i].muted = data.updates.muted;
                        if (data.updates.volume !== undefined) currentSong.tracks[i].volume = data.updates.volume;
                        if (data.updates.fx !== undefined) currentSong.tracks[i].fx = data.updates.fx;
                        break;
                    }
                }
                displayTracks(); 
            } 
        });
        socket.on('new-message', function(msg) { 
            if (currentChatUser === msg.from) loadConversation(msg.from); 
            showToast('New message from ' + msg.from); 
            loadRecentChats(); 
        });
        socket.on('new-comment', function() { 
            if (currentSong) displayComments(); 
        });
        socket.on('song-updated', function() { 
            loadSongs(); 
            loadFeed(); 
        });
        socket.on('song-deleted', function() { 
            if (currentSong) backToLibrary(); 
            loadSongs(); 
            loadFeed(); 
        });
        socket.emit('join-chat', currentUser.username);
    }

    // Navigation
    function initNav() {
        const navItems = document.querySelectorAll('.nav-item');
        for (let i = 0; i < navItems.length; i++) {
            let btn = navItems[i];
            btn.onclick = function() {
                if (currentSong) {
                    backToLibrary();
                }
                const view = this.dataset.view;
                for (let j = 0; j < navItems.length; j++) {
                    navItems[j].classList.remove('active');
                }
                this.classList.add('active');
                const views = document.querySelectorAll('.view');
                for (let j = 0; j < views.length; j++) {
                    views[j].classList.remove('active');
                }
                const targetView = document.getElementById(view + '-view');
                if (targetView) targetView.classList.add('active');
                if (view === 'profile') loadProfile();
                if (view === 'social') { 
                    loadRecentChats(); 
                    const chatRecent = document.getElementById('chat-recent');
                    const chatConversation = document.getElementById('chat-conversation');
                    if (chatRecent) chatRecent.style.display = 'block';
                    if (chatConversation) chatConversation.style.display = 'none';
                }
                if (view === 'library') loadSongs();
                if (view === 'feed') loadFeed();
            };
        }
    }

    function randomizeThumbPreview() {
        const colors = ['667eea', '764ba2', 'f39c12', 'e74c3c', '27ae60', '3498db', '1abc9c', 'e67e22', '9b59b6'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        const title = document.getElementById('new-title').value || 'Track';
        const thumbPreview = document.getElementById('thumb-preview');
        if (thumbPreview) {
            thumbPreview.src = 'https://ui-avatars.com/api/?background=' + color + '&color=fff&size=200&fontsize=80&length=2&bold=true&name=' + encodeURIComponent(title.substring(0, 2));
        }
    }

    function escape(str) { 
        if (!str) return ''; 
        const d = document.createElement('div'); 
        d.textContent = str; 
        return d.innerHTML; 
    }

    function showToast(msg, duration) {
        if (duration === undefined) duration = 3000;
        let toast = document.querySelector('.toast'); 
        if (toast) toast.remove(); 
        toast = document.createElement('div'); 
        toast.className = 'toast'; 
        toast.textContent = msg; 
        document.body.appendChild(toast); 
        setTimeout(function() { toast.remove(); }, duration); 
    }

    // Event Listeners
    function setupEventListeners() {
        // Auth tabs
        const authTabs = document.querySelectorAll('.auth-tab');
        for (let i = 0; i < authTabs.length; i++) {
            authTabs[i].onclick = function() {
                const tabName = this.dataset.tab;
                for (let j = 0; j < authTabs.length; j++) {
                    authTabs[j].classList.remove('active');
                }
                this.classList.add('active');
                const forms = document.querySelectorAll('.auth-form');
                for (let j = 0; j < forms.length; j++) {
                    forms[j].classList.remove('active');
                }
                const form = document.getElementById(tabName + '-form');
                if (form) form.classList.add('active');
            };
        }
        
        // Login form
        const loginForm = document.getElementById('login-form');
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
        
        // Register form
        const registerForm = document.getElementById('register-form');
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
        if (closeModal) closeModal.onclick = function() { 
            document.getElementById('profile-modal').style.display = 'none'; 
        };
        const closeUserModal = document.querySelector('.close-user-modal');
        if (closeUserModal) closeUserModal.onclick = function() { 
            document.getElementById('user-modal').style.display = 'none'; 
        };
        const closeEditModal = document.querySelector('.close-edit-modal');
        if (closeEditModal) closeEditModal.onclick = closeEditSongModal;
        
        // Save profile
        const saveProfileBtn = document.getElementById('save-profile');
        if (saveProfileBtn) saveProfileBtn.onclick = saveProfile;
        
        // Change avatar
        const changeAvatarBtn = document.getElementById('change-avatar');
        if (changeAvatarBtn) {
            changeAvatarBtn.onclick = function() { 
                document.getElementById('avatar-file').click(); 
            };
        }
        const avatarFile = document.getElementById('avatar-file');
        if (avatarFile) {
            avatarFile.onchange = function(e) { 
                if (e.target.files[0]) uploadAvatar(e.target.files[0]); 
            };
        }
        
        // Create modal
        const openCreateModal = document.getElementById('open-create-modal');
        if (openCreateModal) {
            openCreateModal.onclick = function() { 
                randomizeThumbPreview(); 
                document.getElementById('create-modal').style.display = 'flex'; 
            };
        }
        const confirmCreate = document.getElementById('confirm-create');
        if (confirmCreate) confirmCreate.onclick = createSong;
        const cancelCreate = document.getElementById('cancel-create');
        if (cancelCreate) cancelCreate.onclick = function() { 
            document.getElementById('create-modal').style.display = 'none'; 
        };
        
        // Random thumb
        const randomThumb = document.getElementById('random-thumb');
        if (randomThumb) randomThumb.onclick = randomizeThumbPreview;
        
        // Upload thumb
        const uploadThumbBtn = document.getElementById('upload-thumb-btn');
        if (uploadThumbBtn) {
            uploadThumbBtn.onclick = function() { 
                document.getElementById('thumb-file').click(); 
            };
        }
        const thumbFile = document.getElementById('thumb-file');
        if (thumbFile) {
            thumbFile.onchange = function(e) {
                if (e.target.files[0]) {
                    const reader = new FileReader();
                    reader.onload = function(ev) {
                        const thumbPreview = document.getElementById('thumb-preview');
                        if (thumbPreview) thumbPreview.src = ev.target.result;
                    };
                    reader.readAsDataURL(e.target.files[0]);
                }
            };
        }
        
        // Transport controls
        const playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.onclick = function() { 
            isPlaying ? pausePlayback() : startPlayback(false); 
        };
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
        if (uploadBtn) uploadBtn.onclick = function() { 
            document.getElementById('audio-file').click(); 
        };
        const audioFile = document.getElementById('audio-file');
        if (audioFile) audioFile.onchange = uploadTrackFile;
        
        // Back button
        const backBtn = document.getElementById('back-btn');
        if (backBtn) backBtn.onclick = backToLibrary;
        
        // Comments
        const postCommentBtn = document.getElementById('post-comment');
        if (postCommentBtn) postCommentBtn.onclick = postComment;
        const commentInput = document.getElementById('comment-input');
        if (commentInput) {
            commentInput.onkeypress = function(e) { 
                if (e.key === 'Enter') postComment(); 
            };
        }
        
        // Chat
        const backToRecentBtn = document.getElementById('back-to-recent');
        if (backToRecentBtn) backToRecentBtn.onclick = backToRecent;
        const sendChatBtn = document.getElementById('send-chat');
        if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.onkeypress = function(e) { 
                if (e.key === 'Enter') sendChatMessage(); 
            };
        }
        
        // Edit song modal
        const saveSongChangesBtn = document.getElementById('save-song-changes');
        if (saveSongChangesBtn) saveSongChangesBtn.onclick = saveSongChanges;
        const deleteSongVersionBtn = document.getElementById('delete-song-version');
        if (deleteSongVersionBtn) deleteSongVersionBtn.onclick = deleteSongVersion;
        const editRandomThumb = document.getElementById('edit-random-thumb');
        if (editRandomThumb) editRandomThumb.onclick = randomizeEditThumbnail;
        const editUploadThumb = document.getElementById('edit-upload-thumb');
        if (editUploadThumb) {
            editUploadThumb.onclick = function() { 
                document.getElementById('edit-thumb-file').click(); 
            };
        }
        const editThumbFile = document.getElementById('edit-thumb-file');
        if (editThumbFile) {
            editThumbFile.onchange = function(e) {
                if (e.target.files[0]) {
                    const reader = new FileReader();
                    reader.onload = function(ev) {
                        document.getElementById('edit-thumb-preview').src = ev.target.result;
                        currentEditThumbnail = ev.target.result;
                    };
                    reader.readAsDataURL(e.target.files[0]);
                }
            };
        }
        
        // Close modals on outside click
        const modals = ['create-modal', 'edit-song-modal', 'profile-modal', 'user-modal'];
        for (let i = 0; i < modals.length; i++) {
            const modal = document.getElementById(modals[i]);
            if (modal) {
                modal.onclick = function(e) { 
                    if (e.target === modal) modal.style.display = 'none'; 
                };
            }
        }
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', function() {
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

// Make functions globally accessible
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