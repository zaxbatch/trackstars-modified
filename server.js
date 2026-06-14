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

['data', 'uploads', 'uploads/tracks', 'uploads/thumbnails'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const dataFiles = {
  users: './data/users.json',
  songs: './data/songs.json',
  messages: './data/messages.json'
};

if (!fs.existsSync(dataFiles.users)) fs.writeFileSync(dataFiles.users, JSON.stringify({}));
if (!fs.existsSync(dataFiles.songs)) fs.writeFileSync(dataFiles.songs, JSON.stringify({}));
if (!fs.existsSync(dataFiles.messages)) fs.writeFileSync(dataFiles.messages, JSON.stringify([]));

const readData = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch (e) {
    return {};
  }
};

const writeData = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const trackStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/tracks/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});

const thumbnailStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/thumbnails/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});

const uploadTrack = multer({ storage: trackStorage, limits: { fileSize: 100 * 1024 * 1024 } });
const uploadThumbnail = multer({ storage: thumbnailStorage, limits: { fileSize: 5 * 1024 * 1024 } });

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, process.env.JWT_SECRET || 'trackstars-secret-key', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const getRandomThumbnail = () => {
  const thumbnails = [
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
  return thumbnails[Math.floor(Math.random() * thumbnails.length)];
};

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  
  const users = readData(dataFiles.users);
  if (users[username]) return res.status(400).json({ error: 'Username already exists' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  
  users[username] = {
    username,
    email,
    password: await bcrypt.hash(password, 10),
    followers: [],
    following: [],
    contributedTo: [],
    createdAt: Date.now(),
    tutorialCompleted: false,
    avatar: getRandomThumbnail()
  };
  
  writeData(dataFiles.users, users);
  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'trackstars-secret-key');
  res.json({ token, user: { username, email, followers: [], following: [], tutorialCompleted: false, avatar: getRandomThumbnail() } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = readData(dataFiles.users);
  const user = users[username];
  
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid password' });
  
  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'trackstars-secret-key');
  res.json({ token, user: { 
    username, 
    email: user.email, 
    followers: user.followers || [],
    following: user.following || [],
    tutorialCompleted: user.tutorialCompleted || false,
    avatar: user.avatar || getRandomThumbnail()
  } });
});

app.post('/api/users/tutorial', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  if (users[req.user.username]) {
    users[req.user.username].tutorialCompleted = true;
    writeData(dataFiles.users, users);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.get('/api/songs', (req, res) => {
  const songs = readData(dataFiles.songs);
  const songList = Object.values(songs).map(song => ({
    id: song.id,
    title: song.title,
    creator: song.creator,
    bpm: song.bpm || 120,
    version: song.version || 1,
    parentVersion: song.parentVersion || null,
    trackCount: (song.tracks || []).length,
    upvotes: song.upvotes || 0,
    createdAt: song.createdAt,
    thumbnail: song.thumbnail || getRandomThumbnail(),
    genre: song.genre || 'Electronic'
  }));
  
  songList.sort((a, b) => b.createdAt - a.createdAt);
  res.json(songList);
});

app.get('/api/songs/:id', (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  if (!song) return res.status(404).json({ error: 'Song not found' });
  
  if (!song.tracks) song.tracks = [];
  if (!song.comments) song.comments = [];
  if (!song.voters) song.voters = {};
  if (song.upvotes === undefined) song.upvotes = 0;
  if (!song.versions) song.versions = [];
  if (!song.thumbnail) song.thumbnail = getRandomThumbnail();
  
  res.json(song);
});

app.get('/api/songs/:id/versions', (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  if (!song) return res.status(404).json({ error: 'Song not found' });
  
  const versions = (song.versions || []).map(versionId => songs[versionId]).filter(v => v);
  res.json(versions);
});

app.post('/api/songs', authenticateToken, (req, res) => {
  const { title, bpm = 120, genre = 'Electronic', parentVersion = null, thumbnail = null } = req.body;
  
  if (!title) return res.status(400).json({ error: 'Title required' });
  
  const songs = readData(dataFiles.songs);
  const songId = uuidv4();
  
  let version = 1;
  if (parentVersion) {
    const parentSong = songs[parentVersion];
    if (parentSong) {
      version = (parentSong.version || 1) + 1;
    }
  }
  
  const newSong = {
    id: songId,
    title,
    creator: req.user.username,
    bpm: parseInt(bpm),
    genre: genre,
    version: version,
    parentVersion: parentVersion,
    createdAt: Date.now(),
    tracks: [],
    upvotes: 0,
    voters: {},
    comments: [],
    thumbnail: thumbnail || getRandomThumbnail(),
    isPlaying: false,
    currentPosition: 0,
    duration: 0,
    bpmLockedBy: parentVersion ? songs[parentVersion]?.creator : req.user.username
  };
  
  songs[songId] = newSong;
  
  if (parentVersion && songs[parentVersion]) {
    if (!songs[parentVersion].versions) songs[parentVersion].versions = [];
    songs[parentVersion].versions.push(songId);
  }
  
  writeData(dataFiles.songs, songs);
  
  const users = readData(dataFiles.users);
  if (users[req.user.username]) {
    if (!users[req.user.username].contributedTo) users[req.user.username].contributedTo = [];
    users[req.user.username].contributedTo.push(songId);
    writeData(dataFiles.users, users);
  }
  
  io.emit('song-created', newSong);
  res.json(newSong);
});

app.post('/api/songs/:id/thumbnail', authenticateToken, uploadThumbnail.single('thumbnail'), (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (song.creator !== req.user.username) return res.status(403).json({ error: 'Only song creator can change thumbnail' });
  
  if (req.file) {
    song.thumbnail = `/uploads/thumbnails/${req.file.filename}`;
  } else if (req.body.thumbnailUrl) {
    song.thumbnail = req.body.thumbnailUrl;
  }
  
  writeData(dataFiles.songs, songs);
  res.json({ thumbnail: song.thumbnail });
});

app.post('/api/songs/:id/track', authenticateToken, uploadTrack.single('audio'), (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (!song.tracks) song.tracks = [];
  
  const userAlreadyContributed = song.tracks.some(track => track.username === req.user.username);
  if (userAlreadyContributed) return res.status(400).json({ error: 'You already added a track to this version!' });
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
  
  const newTrack = {
    id: uuidv4(),
    username: req.user.username,
    audioUrl: `/uploads/tracks/${req.file.filename}`,
    uploadedAt: Date.now(),
    volume: 0.8,
    muted: false,
    votes: 0,
    voters: {}
  };
  
  song.tracks.push(newTrack);
  writeData(dataFiles.songs, songs);
  
  const users = readData(dataFiles.users);
  if (users[req.user.username]) {
    if (!users[req.user.username].contributedTo) users[req.user.username].contributedTo = [];
    if (!users[req.user.username].contributedTo.includes(song.id)) {
      users[req.user.username].contributedTo.push(song.id);
      writeData(dataFiles.users, users);
    }
  }
  
  io.to(song.id).emit('track-added', { songId: song.id, track: newTrack });
  res.json(newTrack);
});

app.delete('/api/songs/:songId/track/:trackId', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (!song.tracks) song.tracks = [];
  
  const trackIndex = song.tracks.findIndex(t => t.id === req.params.trackId);
  if (trackIndex === -1) return res.status(404).json({ error: 'Track not found' });
  
  const track = song.tracks[trackIndex];
  if (track.username !== req.user.username) return res.status(403).json({ error: 'You can only delete your own tracks' });
  
  song.tracks.splice(trackIndex, 1);
  writeData(dataFiles.songs, songs);
  
  io.to(song.id).emit('track-deleted', { songId: song.id, trackId: req.params.trackId, username: req.user.username });
  res.json({ success: true });
});

app.put('/api/songs/:songId/track/:trackId', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (!song.tracks) song.tracks = [];
  
  const trackIndex = song.tracks.findIndex(t => t.id === req.params.trackId);
  if (trackIndex === -1) return res.status(404).json({ error: 'Track not found' });
  
  const { volume, muted } = req.body;
  if (volume !== undefined) song.tracks[trackIndex].volume = volume;
  if (muted !== undefined) song.tracks[trackIndex].muted = muted;
  
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('track-updated', { songId: song.id, trackId: req.params.trackId, updates: { volume, muted } });
  res.json(song.tracks[trackIndex]);
});

app.post('/api/songs/:songId/track/:trackId/vote', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (!song.tracks) song.tracks = [];
  
  const trackIndex = song.tracks.findIndex(t => t.id === req.params.trackId);
  if (trackIndex === -1) return res.status(404).json({ error: 'Track not found' });
  
  const { vote } = req.body;
  const voter = req.user.username;
  const track = song.tracks[trackIndex];
  if (!track.voters) track.voters = {};
  
  if (track.voters[voter]) {
    if (track.voters[voter] === 'up') track.votes--;
    else track.votes++;
  }
  
  if (vote === 'up') {
    track.votes++;
    track.voters[voter] = 'up';
  } else if (vote === 'down') {
    track.votes--;
    track.voters[voter] = 'down';
  }
  
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('track-voted', { songId: song.id, trackId: req.params.trackId, votes: track.votes });
  res.json({ votes: track.votes });
});

app.post('/api/songs/:id/comment', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (!song.comments) song.comments = [];
  
  const comment = {
    id: uuidv4(),
    username: req.user.username,
    text: req.body.text,
    createdAt: Date.now()
  };
  
  song.comments.push(comment);
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('new-comment', comment);
  res.json(comment);
});

app.put('/api/songs/:id/bpm', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (song.creator !== req.user.username) return res.status(403).json({ error: 'Only the version owner can change BPM' });
  
  const { bpm } = req.body;
  song.bpm = Math.min(300, Math.max(40, parseInt(bpm)));
  writeData(dataFiles.songs, songs);
  
  io.to(song.id).emit('bpm-updated', { songId: song.id, bpm: song.bpm });
  res.json({ bpm: song.bpm });
});

app.get('/api/messages/:username', authenticateToken, (req, res) => {
  const messages = readData(dataFiles.messages);
  const username = req.params.username;
  const currentUser = req.user.username;
  
  const userMessages = messages.filter(m => 
    (m.from === currentUser && m.to === username) || 
    (m.from === username && m.to === currentUser)
  );
  
  res.json(userMessages);
});

app.get('/api/conversations', authenticateToken, (req, res) => {
  const messages = readData(dataFiles.messages);
  const currentUser = req.user.username;
  
  const conversations = new Map();
  messages.forEach(msg => {
    if (msg.from === currentUser || msg.to === currentUser) {
      const otherUser = msg.from === currentUser ? msg.to : msg.from;
      if (!conversations.has(otherUser) || conversations.get(otherUser).timestamp < msg.timestamp) {
        conversations.set(otherUser, {
          username: otherUser,
          lastMessage: msg.text,
          timestamp: msg.timestamp,
          unread: !msg.read && msg.to === currentUser
        });
      }
    }
  });
  
  const result = Array.from(conversations.values()).sort((a, b) => b.timestamp - a.timestamp);
  res.json(result);
});

app.post('/api/messages', authenticateToken, (req, res) => {
  const { to, text } = req.body;
  const messages = readData(dataFiles.messages);
  
  const message = {
    id: uuidv4(),
    from: req.user.username,
    to: to,
    text: text,
    timestamp: Date.now(),
    read: false
  };
  
  messages.push(message);
  writeData(dataFiles.messages, messages);
  
  io.to(to).emit('new-message', message);
  res.json(message);
});

app.post('/api/messages/read', authenticateToken, (req, res) => {
  const { from } = req.body;
  const messages = readData(dataFiles.messages);
  const currentUser = req.user.username;
  
  messages.forEach(msg => {
    if (msg.from === from && msg.to === currentUser && !msg.read) {
      msg.read = true;
    }
  });
  
  writeData(dataFiles.messages, messages);
  res.json({ success: true });
});

app.post('/api/users/:username/follow', authenticateToken, (req, res) => {
  const { username } = req.params;
  const follower = req.user.username;
  if (username === follower) return res.status(400).json({ error: 'Cannot follow yourself' });
  
  const users = readData(dataFiles.users);
  if (!users[username]) return res.status(404).json({ error: 'User not found' });
  
  if (!users[username].followers.includes(follower)) {
    users[username].followers.push(follower);
    users[follower].following.push(username);
    writeData(dataFiles.users, users);
  }
  
  res.json({ success: true });
});

app.post('/api/users/:username/unfollow', authenticateToken, (req, res) => {
  const { username } = req.params;
  const follower = req.user.username;
  
  const users = readData(dataFiles.users);
  users[username].followers = users[username].followers.filter(f => f !== follower);
  users[follower].following = users[follower].following.filter(f => f !== username);
  writeData(dataFiles.users, users);
  
  res.json({ success: true });
});

app.get('/api/users/search', authenticateToken, (req, res) => {
  const { q } = req.query;
  const users = readData(dataFiles.users);
  const currentUser = req.user.username;
  
  const results = Object.keys(users)
    .filter(u => u !== currentUser && u.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 20)
    .map(u => ({
      username: u,
      avatar: users[u].avatar || getRandomThumbnail(),
      following: users[currentUser].following.includes(u),
      followerCount: users[u].followers.length
    }));
  
  res.json(results);
});

app.get('/api/users/:username', (req, res) => {
  const users = readData(dataFiles.users);
  const user = users[req.params.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  res.json({
    username: user.username,
    followers: user.followers.length,
    following: user.following.length,
    songsContributed: user.songsContributed,
    createdAt: user.createdAt,
    avatar: user.avatar || getRandomThumbnail()
  });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-song', (songId) => {
    socket.join(songId);
    socket.songRoom = songId;
    console.log(`Socket ${socket.id} joined song ${songId}`);
  });
  
  socket.on('join-user', (username) => {
    socket.join(`user-${username}`);
    socket.userRoom = username;
  });
  
  socket.on('leave-song', () => {
    if (socket.songRoom) {
      socket.leave(socket.songRoom);
      delete socket.songRoom;
    }
  });
  
  socket.on('transport-control', (data) => {
    const { songId, action, position } = data;
    socket.to(songId).emit('transport-state', { action, position });
  });
  
  socket.on('track-update', (data) => {
    const { songId, trackId, updates } = data;
    socket.to(songId).emit('track-updated', { trackId, updates });
  });
  
  socket.on('recording-started', (data) => {
    const { songId, username } = data;
    socket.to(songId).emit('user-recording', { username });
  });
  
  socket.on('recording-stopped', (data) => {
    const { songId, username } = data;
    socket.to(songId).emit('recording-complete', { username });
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
  console.log(`🎵 TrackStars DAW running on http://localhost:${PORT}`);
});