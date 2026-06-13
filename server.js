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

// Create necessary directories
['data', 'uploads', 'uploads/tracks', 'uploads/avatars', 'uploads/thumbnails'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const dataFiles = {
  users: './data/users.json',
  songs: './data/songs.json',
  messages: './data/messages.json'
};

if (!fs.existsSync(dataFiles.users)) {
  fs.writeFileSync(dataFiles.users, JSON.stringify({}));
}
if (!fs.existsSync(dataFiles.songs)) {
  fs.writeFileSync(dataFiles.songs, JSON.stringify({}));
}
if (!fs.existsSync(dataFiles.messages)) {
  fs.writeFileSync(dataFiles.messages, JSON.stringify({}));
}

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

// Generate random image thumbnail based on song title (using Lorem Picsum + seed)
function generateRandomThumbnail(title) {
  const seed = encodeURIComponent(title.substring(0, 10));
  // Use Lorem Picsum with seed for consistent but random images
  return `https://picsum.photos/seed/${seed}/200/200`;
}

// Generate random image for user avatars
function generateRandomAvatar(username) {
  const seed = encodeURIComponent(username.substring(0, 10));
  return `https://picsum.photos/seed/${seed}/200/200`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'avatar') {
      cb(null, 'uploads/avatars/');
    } else {
      cb(null, 'uploads/tracks/');
    }
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'avatar') {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid image format'));
      }
    } else {
      const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/mp3', 'audio/x-m4a'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid audio format'));
      }
    }
  }
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  jwt.verify(token, process.env.JWT_SECRET || 'trackstars-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// ============ AUTH ROUTES ============
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const users = readData(dataFiles.users);

  if (users[username]) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  users[username] = {
    username,
    email,
    password: await bcrypt.hash(password, 10),
    followers: [],
    following: [],
    contributedTo: [],
    likedSongs: [],
    savedSongs: [],
    createdAt: Date.now(),
    bio: '',
    avatar: generateRandomAvatar(username)
  };

  writeData(dataFiles.users, users);

  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'trackstars-secret-key');

  res.json({
    token,
    user: {
      username,
      email,
      followers: [],
      following: [],
      contributedTo: [],
      likedSongs: [],
      savedSongs: [],
      bio: '',
      avatar: users[username].avatar
    }
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = readData(dataFiles.users);
  const user = users[username];

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (!await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'trackstars-secret-key');

  res.json({
    token,
    user: {
      username,
      email: user.email,
      followers: user.followers || [],
      following: user.following || [],
      contributedTo: user.contributedTo || [],
      likedSongs: user.likedSongs || [],
      savedSongs: user.savedSongs || [],
      bio: user.bio || '',
      avatar: user.avatar || generateRandomAvatar(username)
    }
  });
});

app.post('/api/upload-avatar', authenticateToken, upload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const users = readData(dataFiles.users);
  const user = users[req.user.username];
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const avatarUrl = '/uploads/avatars/' + req.file.filename;
  user.avatar = avatarUrl;
  
  writeData(dataFiles.users, users);
  
  res.json({ avatar: avatarUrl });
});

app.get('/api/users', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  const userList = Object.keys(users).map(username => ({
    username,
    avatar: users[username].avatar,
    followersCount: users[username].followers?.length || 0,
    followingCount: users[username].following?.length || 0
  }));
  res.json(userList);
});

app.get('/api/users/:username', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  const user = users[req.params.username];
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    username: user.username,
    email: user.email,
    followers: user.followers || [],
    following: user.following || [],
    contributedTo: user.contributedTo || [],
    likedSongs: user.likedSongs || [],
    savedSongs: user.savedSongs || [],
    bio: user.bio || '',
    avatar: user.avatar,
    createdAt: user.createdAt
  });
});

app.post('/api/users/:username/follow', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  const targetUser = users[req.params.username];
  const currentUser = users[req.user.username];
  
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: 'Cannot follow yourself' });
  }
  
  if (!targetUser.followers) targetUser.followers = [];
  if (!currentUser.following) currentUser.following = [];
  
  let isFollowing = false;
  
  if (targetUser.followers.includes(req.user.username)) {
    targetUser.followers = targetUser.followers.filter(f => f !== req.user.username);
    currentUser.following = currentUser.following.filter(f => f !== req.params.username);
    isFollowing = false;
  } else {
    targetUser.followers.push(req.user.username);
    currentUser.following.push(req.params.username);
    isFollowing = true;
  }
  
  writeData(dataFiles.users, users);
  
  io.emit('user-updated', {
    username: req.params.username,
    followersCount: targetUser.followers.length
  });
  
  res.json({ 
    following: isFollowing,
    followersCount: targetUser.followers.length
  });
});

app.put('/api/users/bio', authenticateToken, (req, res) => {
  const { bio } = req.body;
  const users = readData(dataFiles.users);
  const user = users[req.user.username];
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  user.bio = bio;
  writeData(dataFiles.users, users);
  
  res.json({ bio });
});

// ============ SEARCH ROUTES ============
app.get('/api/search/songs', authenticateToken, (req, res) => {
  const { q } = req.query;
  if (!q || q.trim() === '') {
    return res.json([]);
  }
  
  const songs = readData(dataFiles.songs);
  const users = readData(dataFiles.users);
  const searchTerm = q.toLowerCase().trim();
  
  const results = Object.values(songs)
    .filter(song => 
      song.title.toLowerCase().includes(searchTerm) ||
      song.creator.toLowerCase().includes(searchTerm) ||
      (song.genre && song.genre.toLowerCase().includes(searchTerm))
    )
    .map(song => ({
      id: song.id,
      title: song.title,
      creator: song.creator,
      creatorAvatar: users[song.creator]?.avatar || generateRandomAvatar(song.creator),
      thumbnail: song.thumbnail || generateRandomThumbnail(song.title),
      bpm: song.bpm || 120,
      trackCount: (song.tracks || []).length,
      likes: song.likes || 0,
      createdAt: song.createdAt,
      genre: song.genre || 'Electronic',
      type: 'song'
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  
  res.json(results);
});

app.get('/api/search/users', authenticateToken, (req, res) => {
  const { q } = req.query;
  if (!q || q.trim() === '') {
    return res.json([]);
  }
  
  const users = readData(dataFiles.users);
  const currentUsername = req.user.username;
  const searchTerm = q.toLowerCase().trim();
  
  const results = Object.values(users)
    .filter(user => 
      user.username.toLowerCase().includes(searchTerm) &&
      user.username !== currentUsername
    )
    .map(user => ({
      username: user.username,
      avatar: user.avatar,
      bio: user.bio || 'Music creator on TrackStars',
      followersCount: user.followers?.length || 0,
      tracksCount: user.contributedTo?.length || 0,
      isFollowing: (currentUser?.following || []).includes(user.username),
      type: 'user'
    }))
    .sort((a, b) => b.followersCount - a.followersCount);
  
  res.json(results);
});

app.get('/api/search/all', authenticateToken, (req, res) => {
  const { q } = req.query;
  if (!q || q.trim() === '') {
    return res.json({ songs: [], users: [] });
  }
  
  const songs = readData(dataFiles.songs);
  const users = readData(dataFiles.users);
  const currentUsername = req.user.username;
  const searchTerm = q.toLowerCase().trim();
  
  const songResults = Object.values(songs)
    .filter(song => 
      song.title.toLowerCase().includes(searchTerm) ||
      song.creator.toLowerCase().includes(searchTerm) ||
      (song.genre && song.genre.toLowerCase().includes(searchTerm))
    )
    .map(song => ({
      id: song.id,
      title: song.title,
      creator: song.creator,
      creatorAvatar: users[song.creator]?.avatar || generateRandomAvatar(song.creator),
      thumbnail: song.thumbnail || generateRandomThumbnail(song.title),
      bpm: song.bpm || 120,
      trackCount: (song.tracks || []).length,
      likes: song.likes || 0,
      createdAt: song.createdAt,
      genre: song.genre || 'Electronic',
      type: 'song'
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
  
  const userResults = Object.values(users)
    .filter(user => 
      user.username.toLowerCase().includes(searchTerm) &&
      user.username !== currentUsername
    )
    .map(user => ({
      username: user.username,
      avatar: user.avatar,
      bio: user.bio || 'Music creator on TrackStars',
      followersCount: user.followers?.length || 0,
      tracksCount: user.contributedTo?.length || 0,
      isFollowing: (users[currentUsername]?.following || []).includes(user.username),
      type: 'user'
    }))
    .sort((a, b) => b.followersCount - a.followersCount)
    .slice(0, 10);
  
  res.json({ songs: songResults, users: userResults });
});

// ============ FEED ROUTES ============
app.get('/api/feed/community', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const songList = Object.values(songs).map(song => ({
    id: song.id,
    title: song.title,
    creator: song.creator,
    creatorAvatar: (readData(dataFiles.users)[song.creator]?.avatar) || generateRandomAvatar(song.creator),
    thumbnail: song.thumbnail || generateRandomThumbnail(song.title),
    bpm: song.bpm || 120,
    trackCount: (song.tracks || []).length,
    totalContributors: new Set((song.tracks || []).map(t => t.username)).size,
    likes: song.likes || 0,
    createdAt: song.createdAt,
    genre: song.genre || 'Electronic',
    isNew: (Date.now() - song.createdAt) < 7 * 24 * 60 * 60 * 1000
  }));

  songList.sort((a, b) => b.createdAt - a.createdAt);
  res.json(songList.slice(0, 20));
});

app.get('/api/feed/following', authenticateToken, (req, res) => {
  const users = readData(dataFiles.users);
  const currentUser = users[req.user.username];
  const following = currentUser.following || [];
  const songs = readData(dataFiles.songs);
  
  const followingSongs = Object.values(songs).filter(song => 
    following.includes(song.creator)
  ).map(song => ({
    id: song.id,
    title: song.title,
    creator: song.creator,
    creatorAvatar: (readData(dataFiles.users)[song.creator]?.avatar) || generateRandomAvatar(song.creator),
    thumbnail: song.thumbnail || generateRandomThumbnail(song.title),
    bpm: song.bpm || 120,
    trackCount: (song.tracks || []).length,
    totalContributors: new Set((song.tracks || []).map(t => t.username)).size,
    likes: song.likes || 0,
    createdAt: song.createdAt,
    genre: song.genre || 'Electronic'
  }));
  
  followingSongs.sort((a, b) => b.createdAt - a.createdAt);
  res.json(followingSongs);
});

// ============ MESSAGING ROUTES ============
app.get('/api/messages/:userId', authenticateToken, (req, res) => {
  const messages = readData(dataFiles.messages);
  const conversationId = [req.user.username, req.params.userId].sort().join('-');
  res.json(messages[conversationId] || []);
});

app.post('/api/messages', authenticateToken, (req, res) => {
  const { to, text } = req.body;
  const messages = readData(dataFiles.messages);
  const conversationId = [req.user.username, to].sort().join('-');
  
  if (!messages[conversationId]) messages[conversationId] = [];
  
  const message = {
    id: uuidv4(),
    from: req.user.username,
    to: to,
    text: text,
    timestamp: Date.now(),
    read: false
  };
  
  messages[conversationId].push(message);
  writeData(dataFiles.messages, messages);
  
  io.to(to).emit('new-message', message);
  
  res.json(message);
});

// ============ SONG ROUTES ============
app.get('/api/songs', (req, res) => {
  const songs = readData(dataFiles.songs);
  const songList = Object.values(songs).map(song => ({
    id: song.id,
    title: song.title,
    creator: song.creator,
    thumbnail: song.thumbnail || generateRandomThumbnail(song.title),
    bpm: song.bpm || 120,
    trackCount: (song.tracks || []).length,
    totalContributors: new Set((song.tracks || []).map(t => t.username)).size,
    upvotes: song.upvotes || 0,
    likes: song.likes || 0,
    createdAt: song.createdAt,
    isFeatured: song.isFeatured || false,
    genre: song.genre || 'Electronic'
  }));

  songList.sort((a, b) => {
    if (a.isFeatured && !b.isFeatured) return -1;
    if (!a.isFeatured && b.isFeatured) return 1;
    return b.createdAt - a.createdAt;
  });

  res.json(songList);
});

app.get('/api/songs/:id', (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];
  if (!song) {
    return res.status(404).json({ error: 'Song not found' });
  }
  if (!song.thumbnail) song.thumbnail = generateRandomThumbnail(song.title);
  res.json(song);
});

app.post('/api/songs', authenticateToken, (req, res) => {
  const { title, bpm = 120, genre = 'Electronic', thumbnail } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title required' });
  }

  const songs = readData(dataFiles.songs);
  const songId = uuidv4();
  const songThumbnail = thumbnail || generateRandomThumbnail(title);
  
  const newSong = {
    id: songId,
    title,
    creator: req.user.username,
    bpm: parseInt(bpm),
    genre: genre,
    thumbnail: songThumbnail,
    createdAt: Date.now(),
    tracks: [],
    upvotes: 0,
    likes: 0,
    voters: [],
    comments: [],
    isPlaying: false,
    currentPosition: 0,
    duration: 0,
    isFeatured: false,
    fx: { reverb: false, delay: false, distortion: false, lowpass: false }
  };

  songs[songId] = newSong;
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

app.post('/api/songs/:id/track', authenticateToken, upload.single('audio'), (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.id];

  if (!song) {
    return res.status(404).json({ error: 'Song not found' });
  }

  if (!song.tracks) song.tracks = [];

  const userAlreadyContributed = song.tracks.some(track => track.username === req.user.username);
  if (userAlreadyContributed) {
    return res.status(400).json({ error: 'You already added a track to this song!' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  const newTrack = {
    id: uuidv4(),
    username: req.user.username,
    audioUrl: '/uploads/tracks/' + req.file.filename,
    uploadedAt: Date.now(),
    volume: 0.8,
    muted: false,
    solo: false,
    votes: 0,
    voters: {},
    fx: {
      reverb: false,
      delay: false,
      distortion: false,
      lowpass: false,
      reverbAmount: 0.3,
      delayAmount: 0.3,
      distortionAmount: 0.3,
      lowpassFreq: 1000
    }
  };

  song.tracks.push(newTrack);
  writeData(dataFiles.songs, songs);
  io.to(song.id).emit('track-added', { songId: song.id, track: newTrack });
  res.json(newTrack);
});

app.delete('/api/songs/:songId/track/:trackId', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];

  if (!song) {
    return res.status(404).json({ error: 'Song not found' });
  }

  if (!song.tracks) song.tracks = [];

  const trackIndex = song.tracks.findIndex(t => t.id === req.params.trackId);
  if (trackIndex === -1) {
    return res.status(404).json({ error: 'Track not found' });
  }

  const track = song.tracks[trackIndex];

  if (track.username !== req.user.username) {
    return res.status(403).json({ error: 'You can only delete your own tracks' });
  }

  song.tracks.splice(trackIndex, 1);
  writeData(dataFiles.songs, songs);
  
  io.to(song.id).emit('track-deleted', {
    songId: song.id,
    trackId: req.params.trackId,
    username: req.user.username
  });
  
  res.json({ success: true, message: 'Track deleted successfully' });
});

app.post('/api/songs/:songId/track/:trackId/vote', authenticateToken, (req, res) => {
  const songs = readData(dataFiles.songs);
  const song = songs[req.params.songId];
  
  if (!song) {
    return res.status(404).json({ error: 'Song not found' });
  }

  if (!song.tracks) song.tracks = [];

  const trackIndex = song.tracks.findIndex(t => t.id === req.params.trackId);
  if (trackIndex === -1) {
    return res.status(404).json({ error: 'Track not found' });
  }

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

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-song', (songId) => {
    socket.join(songId);
    socket.songRoom = songId;
    console.log(`Socket ${socket.id} joined song ${songId}`);
    
    const songs = readData(dataFiles.songs);
    const song = songs[songId];
    if (song) {
      socket.emit('transport-state', {
        isPlaying: song.isPlaying || false,
        position: song.currentPosition || 0,
        bpm: song.bpm || 120
      });
    }
  });

  socket.on('leave-song', () => {
    if (socket.songRoom) {
      socket.leave(socket.songRoom);
      delete socket.songRoom;
    }
  });

  socket.on('transport-control', (data) => {
    const { songId, action, position, bpm } = data;
    const songs = readData(dataFiles.songs);
    const song = songs[songId];
    
    if (song) {
      if (action === 'play') {
        song.isPlaying = true;
        song.currentPosition = position || 0;
      } else if (action === 'pause') {
        song.isPlaying = false;
        song.currentPosition = position || 0;
      } else if (action === 'stop') {
        song.isPlaying = false;
        song.currentPosition = 0;
      } else if (action === 'setPosition') {
        song.currentPosition = position || 0;
      } else if (action === 'setBpm') {
        song.bpm = bpm || 120;
      }
      
      writeData(dataFiles.songs, songs);
      
      socket.to(songId).emit('transport-state', {
        isPlaying: song.isPlaying,
        position: song.currentPosition,
        bpm: song.bpm
      });
    }
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
  
  socket.on('join-chat', (userId) => {
    socket.join(`chat-${userId}`);
    console.log(`User ${userId} joined chat room`);
  });
  
  socket.on('send-chat-message', (data) => {
    const { to, message, from } = data;
    io.to(`chat-${to}`).emit('chat-message', { from, message, timestamp: Date.now() });
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
  console.log(`⭐ TrackStars DAW running on http://localhost:${PORT}`);
});