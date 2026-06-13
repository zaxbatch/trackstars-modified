const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create directories
['data', 'uploads', 'uploads/tracks', 'uploads/avatars'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const dataFiles = {
  users: './data/users.json',
  songs: './data/songs.json',
  messages: './data/messages.json'
};

if (!fs.existsSync(dataFiles.users)) fs.writeFileSync(dataFiles.users, JSON.stringify({}));
if (!fs.existsSync(dataFiles.songs)) fs.writeFileSync(dataFiles.songs, JSON.stringify({}));
if (!fs.existsSync(dataFiles.messages)) fs.writeFileSync(dataFiles.messages, JSON.stringify({}));

const readData = (file) => {
  try { return JSON.parse(fs.readFileSync(file)); }
  catch (e) { return {}; }
};

const writeData = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

function generateRandomThumbnail(title) {
  const colors = ['667eea', '764ba2', 'f39c12', 'e74c3c', '27ae60', '3498db', '1abc9c', 'e67e22', '9b59b6'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  return `https://ui-avatars.com/api/?background=${color}&color=fff&size=200&fontsize=80&length=2&name=${encodeURIComponent(title.substring(0, 2))}`;
}

function generateRandomAvatar(username) {
  const colors = ['667eea', '764ba2', 'f39c12', 'e74c3c', '27ae60', '3498db'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  return `https://ui-avatars.com/api/?background=${color}&color=fff&size=200&name=${encodeURIComponent(username)}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'avatar' ? 'uploads/avatars/' : 'uploads/tracks/');
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'avatar') {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      cb(null, allowed.includes(file.mimetype));
    } else {
      const allowed = ['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/mp3'];
      cb(null, allowed.includes(file.mimetype));
    }
  }
});

const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET || 'trackstars-secret', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ============ AUTH ============
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  
  const users = readData(dataFiles.users);
  if (users[username]) return res.status(400).json({ error: 'Username exists' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
  
  users[username] = {
    username, email,
    password: await bcrypt.hash(password, 10),
    followers: [], following: [], contributedTo: [], likedSongs: [], savedSongs: [],
    createdAt: Date.now(), bio: '',
    avatar: generateRandomAvatar(username)
  };
  writeData(dataFiles.users, users);
  
  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'trackstars-secret');
  res.json({ token, user: { username, email, followers: [], following: [], contributedTo: [], likedSongs: [], savedSongs: [], bio: '', avatar: users[username].avatar } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = readData(dataFiles.users);
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Wrong password' });
  
  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'trackstars-secret');
  res.json({ token, user: { username, email: user.email, followers: user.followers || [], following: user.following || [], contributedTo: user.contributedTo || [], likedSongs: user.likedSongs || [], savedSongs: user.savedSongs || [], bio: user.bio || '', avatar: user.avatar } });
});

app.post('/api/upload-avatar', authenticateToken, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const users = readData(dataFiles.users);
  users[req.user.username].avatar = '/uploads/avatars/' + req.file.filename;
  writeData(dataFiles.users, users);
  res.json({ avatar: users[req.user.username].avatar });
});

app.put('/api/users/bio', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  users[req.user.username].bio = req.body.bio;
  writeData(dataFiles.users, users);
  res.json({ bio: req.body.bio });
});

// ============ USERS ============
app.get('/api/users', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  res.json(Object.keys(users).map(u => ({ username: u, avatar: users[u].avatar, followersCount: users[u].followers?.length || 0 })));
});

app.get('/api/users/:username', authenticateToken, (req, res) => {
  const user = readData(dataFiles.users)[req.params.username];
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ username: user.username, followers: user.followers || [], following: user.following || [], contributedTo: user.contributedTo || [], bio: user.bio || '', avatar: user.avatar, createdAt: user.createdAt });
});

app.post('/api/users/:username/follow', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  const target = users[req.params.username];
  const current = users[req.user.username];
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (req.params.username === req.user.username) return res.status(400).json({ error: 'Cannot follow self' });
  
  let following = false;
  if (target.followers?.includes(req.user.username)) {
    target.followers = target.followers.filter(f => f !== req.user.username);
    current.following = current.following.filter(f => f !== req.params.username);
  } else {
    target.followers = [...(target.followers || []), req.user.username];
    current.following = [...(current.following || []), req.params.username];
    following = true;
  }
  writeData(dataFiles.users, users);
  res.json({ following, followersCount: target.followers.length });
});

// ============ MESSAGES ============
app.get('/api/messages/:userId', authenticateToken, (req, res) => {
  const messages = readData(dataFiles.messages);
  const convId = [req.user.username, req.params.userId].sort().join('-');
  res.json(messages[convId] || []);
});

app.post('/api/messages', authenticateToken, (req, res) => {
  const { to, text } = req.body;
  const messages = readData(dataFiles.messages);
  const convId = [req.user.username, to].sort().join('-');
  if (!messages[convId]) messages[convId] = [];
  const msg = { id: uuidv4(), from: req.user.username, to, text, timestamp: Date.now() };
  messages[convId].push(msg);
  writeData(dataFiles.messages, messages);
  io.to(to).emit('new-message', msg);
  res.json(msg);
});

// ============ SONGS ============
app.get('/api/songs', (req, res) => {
  const songs = readData(dataFiles.songs);
  const list = Object.values(songs).map(s => ({
    id: s.id, title: s.title, creator: s.creator,
    thumbnail: s.thumbnail || generateRandomThumbnail(s.title),
    bpm: s.bpm || 120, trackCount: s.tracks?.length || 0,
    likes: s.likes || 0, createdAt: s.createdAt, genre: s.genre || 'Electronic'
  })).sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.get('/api/songs/:id', (req, res) => {
  const song = readData(dataFiles.songs)[req.params.id];
  if (!song) return res.status(404).json({ error: 'Not found' });
  res.json(song);
});

app.post('/api/songs', authenticateToken, (req, res) => {
  const { title, bpm = 120, genre = 'Electronic' } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  
  const songs = readData(dataFiles.songs);
  const songId = uuidv4();
  const newSong = {
    id: songId, title, creator: req.user.username, bpm: parseInt(bpm), genre,
    thumbnail: generateRandomThumbnail(title), createdAt: Date.now(),
    tracks: [], upvotes: 0, likes: 0, voters: [], comments: [],
    isPlaying: false, currentPosition: 0, duration: 0, isFeatured: false
  };
  songs[songId] = newSong;
  writeData(dataFiles.songs, songs);
  
  const users = readData(dataFiles.users);
  if (users[req.user.username]) {
    users[req.user.username].contributedTo = [...(users[req.user.username].contributedTo || []), songId];
    writeData(dataFiles.users, users);
  }
  io.emit('song-created', newSong);
  res.json(newSong);
});

app.post('/api/songs/:id/track', authenticateToken, upload.single('audio'), (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  if (!song) return res.status(404).json({ error: 'Not found' });
  if (song.tracks?.some(t => t.username === req.user.username)) {
    return res.status(400).json({ error: 'Already have a track' });
  }
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  
  const newTrack = {
    id: uuidv4(), username: req.user.username,
    audioUrl: '/uploads/tracks/' + req.file.filename,
    uploadedAt: Date.now(), volume: 0.8, muted: false, votes: 0, voters: {}
  };
  song.tracks = [...(song.tracks || []), newTrack];
  writeData(dataFiles.songs, songs);
  
  const users = readData(dataFiles.users);
  if (!users[req.user.username].contributedTo?.includes(song.id)) {
    users[req.user.username].contributedTo = [...(users[req.user.username].contributedTo || []), song.id];
    writeData(dataFiles.users, users);
  }
  io.to(song.id).emit('track-added', { songId: song.id, track: newTrack });
  res.json(newTrack);
});

app.delete('/api/songs/:songId/track/:trackId', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  if (!song) return res.status(404).json({ error: 'Not found' });
  
  const track = song.tracks?.find(t => t.id === req.params.trackId);
  if (!track || track.username !== req.user.username) {
    return res.status(403).json({ error: 'Not your track' });
  }
  song.tracks = song.tracks.filter(t => t.id !== req.params.trackId);
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('track-deleted', { songId: song.id, trackId: req.params.trackId, username: req.user.username });
  res.json({ success: true });
});

app.post('/api/songs/:songId/track/:trackId/vote', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  if (!song) return res.status(404).json({ error: 'Not found' });
  
  const track = song.tracks?.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  
  if (!track.voters) track.voters = {};
  const wasUp = track.voters[req.user.username] === 'up';
  const isUp = req.body.vote === 'up';
  
  if (wasUp && isUp) { track.votes--; delete track.voters[req.user.username]; }
  else if (!wasUp && isUp) { track.votes++; track.voters[req.user.username] = 'up'; }
  else if (wasUp && !isUp) { track.votes -= 2; track.voters[req.user.username] = 'down'; }
  else if (!wasUp && !isUp) { track.votes--; delete track.voters[req.user.username]; }
  
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('track-voted', { songId: song.id, trackId: req.params.trackId, votes: track.votes });
  res.json({ votes: track.votes });
});

app.put('/api/songs/:songId/track/:trackId', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  if (!song) return res.status(404).json({ error: 'Not found' });
  
  const track = song.tracks?.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  
  if (req.body.volume !== undefined) track.volume = req.body.volume;
  if (req.body.muted !== undefined) track.muted = req.body.muted;
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('track-updated', { trackId: req.params.trackId, updates: { volume: track.volume, muted: track.muted } });
  res.json(track);
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-song', (songId) => {
    socket.join(songId);
    socket.songRoom = songId;
    const songs = readData(dataFiles.songs);
    const song = songs[songId];
    if (song) {
      socket.emit('transport-state', { isPlaying: song.isPlaying || false, position: song.currentPosition || 0, bpm: song.bpm || 120 });
    }
  });
  
  socket.on('leave-song', () => {
    if (socket.songRoom) socket.leave(socket.songRoom);
    delete socket.songRoom;
  });
  
  socket.on('transport-control', (data) => {
    const songs = readData(dataFiles.songs);
    const song = songs[data.songId];
    if (song) {
      if (data.action === 'play') { song.isPlaying = true; song.currentPosition = data.position || 0; }
      else if (data.action === 'pause') { song.isPlaying = false; song.currentPosition = data.position || 0; }
      else if (data.action === 'stop') { song.isPlaying = false; song.currentPosition = 0; }
      else if (data.action === 'setBpm') { song.bpm = data.bpm || 120; }
      writeData(dataFiles.songs, songs);
      socket.to(data.songId).emit('transport-state', { isPlaying: song.isPlaying, position: song.currentPosition, bpm: song.bpm });
    }
  });
  
  socket.on('track-update', (data) => {
    socket.to(data.songId).emit('track-updated', { trackId: data.trackId, updates: data.updates });
  });
  
  socket.on('recording-started', (data) => {
    socket.to(data.songId).emit('user-recording', { username: data.username });
  });
  
  socket.on('recording-stopped', (data) => {
    socket.to(data.songId).emit('recording-complete', { username: data.username });
  });
  
  socket.on('join-chat', (userId) => {
    socket.join(`chat-${userId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⭐ TrackStars running on http://localhost:${PORT}`);
});