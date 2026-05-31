require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============================================
// Middleware
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// Database Connection Pool
// ============================================
let db;
async function initDB() {
  const dbName = process.env.MYSQLDATABASE || process.env.DB_NAME || 'chat_system';
  const dbConfig = {
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4'
  };

  try {
    // Step 1: Connect WITHOUT specifying a database to create it if needed
    const tempPool = await mysql.createPool(dbConfig);
    await tempPool.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await tempPool.end();
    console.log(`✅ قاعدة البيانات "${dbName}" جاهزة`);

    // Step 2: Now connect with the database
    db = await mysql.createPool({ ...dbConfig, database: dbName });
    console.log('✅ تم الاتصال بقاعدة البيانات MySQL');
    await createTables();
  } catch (err) {
    console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
    console.log('⚠️  سيعمل الخادم بدون قاعدة بيانات (الرسائل في الذاكرة فقط)');
    db = null;
  }
}

async function createTables() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS rooms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      type ENUM('public', 'private') DEFAULT 'public',
      password VARCHAR(255) NULL,
      max_users INT DEFAULT 100,
      created_by VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      room_id INT NOT NULL,
      username VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      message_type ENUM('text', 'emoji', 'system') DEFAULT 'text',
      is_pinned BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_room (room_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS room_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      room_id INT NOT NULL,
      username VARCHAR(50) NOT NULL,
      assigned_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_admin (room_id, username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS banned_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      room_id INT,
      username VARCHAR(50),
      ip_address VARCHAR(45),
      reason TEXT,
      banned_by VARCHAR(50),
      expires_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const query of queries) {
    try {
      await db.query(query);
    } catch (e) {
      // ignore if table exists
    }
  }

  // Insert default rooms
  const defaultRooms = [
    ['عام', 'الغرفة العامة للجميع', 'public'],
    ['تقنية', 'نقاشات تقنية وبرمجية', 'public'],
    ['ترفيه', 'موسيقى وأفلام وترفيه', 'public'],
    ['رياضة', 'أخبار ونقاشات رياضية', 'public'],
  ];

  for (const [name, desc, type] of defaultRooms) {
    try {
      await db.query(
        'INSERT IGNORE INTO rooms (name, description, type, created_by) VALUES (?, ?, ?, ?)',
        [name, desc, type, 'system']
      );
    } catch (e) {}
  }
  console.log('✅ تم إنشاء جداول قاعدة البيانات');
}

// ============================================
// In-Memory Fallback Storage
// ============================================
const inMemoryRooms = {
  'عام': { id: 1, name: 'عام', description: 'الغرفة العامة للجميع', type: 'public' },
  'تقنية': { id: 2, name: 'تقنية', description: 'نقاشات تقنية', type: 'public' },
  'ترفيه': { id: 3, name: 'ترفيه', description: 'ترفيه وفن', type: 'public' },
  'رياضة': { id: 4, name: 'رياضة', description: 'أخبار رياضية', type: 'public' },
};
const inMemoryMessages = {};
const inMemoryAdmins = {};

// ============================================
// Online Users Tracking
// ============================================
const onlineUsers = new Map(); // socketId -> { username, room, color, id }
const roomUsers = new Map();   // roomName -> Set of socketIds
const voiceRooms = new Map();  // roomName -> Map<socketId, {username, color, muted}>

// ============================================
// Helper: Get Color from Username
// ============================================
const colors = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
  '#ff5722', '#00bcd4', '#8bc34a', '#ff9800'
];
function getUserColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// ============================================
// Helper: Format Timestamp
// ============================================
function formatTime(date = new Date()) {
  return date.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ============================================
// REST API Routes
// ============================================

// Get all rooms
app.get('/api/rooms', async (req, res) => {
  try {
    if (db) {
      const [rows] = await db.query(
        'SELECT id, name, description, type FROM rooms WHERE is_active = 1 ORDER BY id ASC'
      );
      const roomsWithCount = rows.map(r => ({
        ...r,
        online: roomUsers.get(r.name) ? roomUsers.get(r.name).size : 0
      }));
      res.json({ success: true, rooms: roomsWithCount });
    } else {
      const rooms = Object.values(inMemoryRooms).map(r => ({
        ...r,
        online: roomUsers.get(r.name) ? roomUsers.get(r.name).size : 0
      }));
      res.json({ success: true, rooms });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create new room
app.post('/api/rooms', async (req, res) => {
  const { name, description, type, password, username } = req.body;
  if (!name || !username) {
    return res.status(400).json({ success: false, error: 'اسم الغرفة والمستخدم مطلوبان' });
  }
  const cleanName = name.trim().substring(0, 50);
  try {
    if (db) {
      const [existing] = await db.query('SELECT id FROM rooms WHERE name = ?', [cleanName]);
      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: 'اسم الغرفة موجود مسبقاً' });
      }
      const [result] = await db.query(
        'INSERT INTO rooms (name, description, type, password, created_by) VALUES (?, ?, ?, ?, ?)',
        [cleanName, description || '', type || 'public', password || null, username]
      );
      // Make creator an admin
      await db.query(
        'INSERT INTO room_admins (room_id, username, assigned_by) VALUES (?, ?, ?)',
        [result.insertId, username, 'system']
      );
      res.json({ success: true, room: { id: result.insertId, name: cleanName } });
    } else {
      if (inMemoryRooms[cleanName]) {
        return res.status(409).json({ success: false, error: 'اسم الغرفة موجود مسبقاً' });
      }
      const id = Object.keys(inMemoryRooms).length + 1;
      inMemoryRooms[cleanName] = { id, name: cleanName, description, type: type || 'public' };
      inMemoryAdmins[cleanName] = [username];
      res.json({ success: true, room: inMemoryRooms[cleanName] });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get recent messages for a room
app.get('/api/messages/:room', async (req, res) => {
  const roomName = decodeURIComponent(req.params.room);
  try {
    if (db) {
      const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [roomName]);
      if (roomRow.length === 0) return res.json({ success: true, messages: [] });
      const [messages] = await db.query(
        `SELECT username, message, message_type, is_pinned, created_at 
         FROM messages WHERE room_id = ? AND is_deleted = 0 
         ORDER BY created_at DESC LIMIT 50`,
        [roomRow[0].id]
      );
      res.json({ success: true, messages: messages.reverse() });
    } else {
      const msgs = inMemoryMessages[roomName] || [];
      res.json({ success: true, messages: msgs.slice(-50) });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Get stats
app.get('/api/admin/stats', async (req, res) => {
  const { password } = req.query;
  if (password !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }
  const totalOnline = onlineUsers.size;
  const roomStats = [];
  for (const [name, users] of roomUsers.entries()) {
    roomStats.push({ room: name, count: users.size });
  }
  try {
    let totalMessages = 0;
    let totalRooms = Object.keys(inMemoryRooms).length;
    if (db) {
      const [[{ count }]] = await db.query('SELECT COUNT(*) as count FROM messages WHERE is_deleted = 0');
      totalMessages = count;
      const [[{ rcount }]] = await db.query('SELECT COUNT(*) as rcount FROM rooms WHERE is_active = 1');
      totalRooms = rcount;
    } else {
      totalMessages = Object.values(inMemoryMessages).reduce((s, m) => s + m.length, 0);
    }
    res.json({ success: true, stats: { totalOnline, totalRooms, totalMessages, roomStats } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ============================================
// Socket.io Events
// ============================================
io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`🔌 اتصال جديد: ${socket.id} من ${clientIp}`);

  // -----------------------------------------------
  // JOIN ROOM
  // -----------------------------------------------
  socket.on('join_room', async ({ username, room, color }) => {
    if (!username || !room) return;

    const cleanUser = username.trim().substring(0, 30);
    const cleanRoom = room.trim().substring(0, 50);
    const userColor = color || getUserColor(cleanUser);

    // Check if banned
    if (db) {
      try {
        const [banned] = await db.query(
          `SELECT id FROM banned_users WHERE 
           (username = ? OR ip_address = ?) AND 
           (room_id = (SELECT id FROM rooms WHERE name = ?) OR room_id IS NULL) AND
           (expires_at IS NULL OR expires_at > NOW())`,
          [cleanUser, clientIp, cleanRoom]
        );
        if (banned.length > 0) {
          socket.emit('banned', { message: 'تم حظرك من هذه الغرفة' });
          return;
        }
      } catch (e) {}
    }

    // Leave previous room if any
    const prevUser = onlineUsers.get(socket.id);
    if (prevUser && prevUser.room) {
      socket.leave(prevUser.room);
      if (roomUsers.has(prevUser.room)) {
        roomUsers.get(prevUser.room).delete(socket.id);
      }
      socket.to(prevUser.room).emit('user_left', {
        username: prevUser.username,
        usersCount: roomUsers.get(prevUser.room)?.size || 0
      });
    }

    // Join new room
    socket.join(cleanRoom);
    
    const userData = { username: cleanUser, room: cleanRoom, color: userColor, id: socket.id, ip: clientIp };
    onlineUsers.set(socket.id, userData);

    if (!roomUsers.has(cleanRoom)) roomUsers.set(cleanRoom, new Set());
    roomUsers.get(cleanRoom).add(socket.id);

    // Get users in room
    const usersInRoom = getRoomUsers(cleanRoom);

    // Notify user joined
    socket.to(cleanRoom).emit('user_joined', {
      username: cleanUser,
      color: userColor,
      time: formatTime(),
      usersCount: usersInRoom.length,
      users: usersInRoom
    });

    socket.emit('joined_room', {
      room: cleanRoom,
      username: cleanUser,
      color: userColor,
      users: usersInRoom,
      time: formatTime()
    });

    // Save to DB
    if (db) {
      try {
        const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [cleanRoom]);
        if (roomRow.length > 0) {
          await db.query(
            'INSERT INTO messages (room_id, username, message, message_type) VALUES (?, ?, ?, ?)',
            [roomRow[0].id, 'النظام', `${cleanUser} انضم إلى الغرفة`, 'system']
          );
        }
      } catch (e) {}
    }

    console.log(`👤 ${cleanUser} انضم إلى غرفة: ${cleanRoom}`);
  });

  // -----------------------------------------------
  // SEND MESSAGE
  // -----------------------------------------------
  socket.on('send_message', async ({ message }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !message) return;

    const cleanMsg = message.trim().substring(0, 1000);
    if (!cleanMsg) return;

    const msgData = {
      id: uuidv4(),
      username: user.username,
      color: user.color,
      message: cleanMsg,
      time: formatTime(),
      type: 'text'
    };

    io.to(user.room).emit('new_message', msgData);

    // Store message
    if (db) {
      try {
        const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [user.room]);
        if (roomRow.length > 0) {
          await db.query(
            'INSERT INTO messages (room_id, username, message) VALUES (?, ?, ?)',
            [roomRow[0].id, user.username, cleanMsg]
          );
        }
      } catch (e) {}
    } else {
      if (!inMemoryMessages[user.room]) inMemoryMessages[user.room] = [];
      inMemoryMessages[user.room].push({ ...msgData, created_at: new Date() });
      if (inMemoryMessages[user.room].length > 200) {
        inMemoryMessages[user.room] = inMemoryMessages[user.room].slice(-200);
      }
    }
  });

  // -----------------------------------------------
  // TYPING INDICATOR
  // -----------------------------------------------
  socket.on('typing', ({ isTyping }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit('user_typing', { username: user.username, isTyping });
  });

  // -----------------------------------------------
  // KICK USER (Admin only)
  // -----------------------------------------------
  socket.on('kick_user', async ({ targetUsername }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) {
      socket.emit('error_msg', { message: 'ليس لديك صلاحية لطرد المستخدمين' });
      return;
    }

    // Find target socket
    for (const [sid, u] of onlineUsers.entries()) {
      if (u.username === targetUsername && u.room === user.room) {
        io.to(sid).emit('kicked', { message: `تم طردك من الغرفة بواسطة ${user.username}`, by: user.username });
        io.sockets.sockets.get(sid)?.leave(user.room);
        onlineUsers.delete(sid);
        roomUsers.get(user.room)?.delete(sid);
        break;
      }
    }

    const usersInRoom = getRoomUsers(user.room);
    io.to(user.room).emit('user_left', {
      username: targetUsername,
      kickedBy: user.username,
      users: usersInRoom,
      usersCount: usersInRoom.length
    });
    io.to(user.room).emit('new_message', {
      id: uuidv4(),
      username: 'النظام',
      color: '#ff6b6b',
      message: `تم طرد ${targetUsername} من الغرفة بواسطة ${user.username}`,
      time: formatTime(),
      type: 'system'
    });
  });

  // -----------------------------------------------
  // BAN USER (Admin only)
  // -----------------------------------------------
  socket.on('ban_user', async ({ targetUsername, reason }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) {
      socket.emit('error_msg', { message: 'ليس لديك صلاحية لحظر المستخدمين' });
      return;
    }

    // Find target IP and ban
    for (const [sid, u] of onlineUsers.entries()) {
      if (u.username === targetUsername && u.room === user.room) {
        if (db) {
          try {
            const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [user.room]);
            if (roomRow.length > 0) {
              await db.query(
                'INSERT INTO banned_users (room_id, username, ip_address, reason, banned_by) VALUES (?, ?, ?, ?, ?)',
                [roomRow[0].id, targetUsername, u.ip, reason || 'لا يوجد سبب', user.username]
              );
            }
          } catch (e) {}
        }
        io.to(sid).emit('banned', { message: `تم حظرك من الغرفة. السبب: ${reason || 'لا يوجد سبب'}` });
        io.sockets.sockets.get(sid)?.leave(user.room);
        onlineUsers.delete(sid);
        roomUsers.get(user.room)?.delete(sid);
        break;
      }
    }

    io.to(user.room).emit('new_message', {
      id: uuidv4(),
      username: 'النظام',
      color: '#ff6b6b',
      message: `تم حظر ${targetUsername} من الغرفة بواسطة ${user.username}`,
      time: formatTime(),
      type: 'system'
    });
  });

  // -----------------------------------------------
  // MAKE ADMIN
  // -----------------------------------------------
  socket.on('make_admin', async ({ targetUsername }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) return;

    if (db) {
      try {
        const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [user.room]);
        if (roomRow.length > 0) {
          await db.query(
            'INSERT IGNORE INTO room_admins (room_id, username, assigned_by) VALUES (?, ?, ?)',
            [roomRow[0].id, targetUsername, user.username]
          );
        }
      } catch (e) {}
    } else {
      if (!inMemoryAdmins[user.room]) inMemoryAdmins[user.room] = [];
      if (!inMemoryAdmins[user.room].includes(targetUsername)) {
        inMemoryAdmins[user.room].push(targetUsername);
      }
    }

    io.to(user.room).emit('new_message', {
      id: uuidv4(),
      username: 'النظام',
      color: '#ffd700',
      message: `تم تعيين ${targetUsername} مشرفاً للغرفة`,
      time: formatTime(),
      type: 'system'
    });
  });

  // -----------------------------------------------
  // CLEAR CHAT (Admin only)
  // -----------------------------------------------
  socket.on('clear_chat', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) return;

    if (db) {
      try {
        const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [user.room]);
        if (roomRow.length > 0) {
          await db.query('UPDATE messages SET is_deleted = 1 WHERE room_id = ?', [roomRow[0].id]);
        }
      } catch (e) {}
    } else {
      inMemoryMessages[user.room] = [];
    }

    io.to(user.room).emit('chat_cleared', { by: user.username });
    io.to(user.room).emit('new_message', {
      id: uuidv4(),
      username: 'النظام',
      color: '#ffd700',
      message: `تم مسح المحادثة بواسطة المشرف ${user.username}`,
      time: formatTime(),
      type: 'system'
    });
  });

  // -----------------------------------------------
  // GET USERS IN ROOM
  // -----------------------------------------------
  socket.on('get_users', () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.emit('users_list', { users: getRoomUsers(user.room) });
  });

  // -----------------------------------------------
  // DISCONNECT
  // -----------------------------------------------
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      roomUsers.get(user.room)?.delete(socket.id);
      onlineUsers.delete(socket.id);

      const usersInRoom = getRoomUsers(user.room);
      socket.to(user.room).emit('user_left', {
        username: user.username,
        users: usersInRoom,
        usersCount: usersInRoom.length
      });

      // Leave voice room if in one
      if (voiceRooms.has(user.room)) {
        voiceRooms.get(user.room).delete(socket.id);
        socket.to(user.room).emit('voice_user_left', { username: user.username });
      }

      console.log(`👋 ${user.username} غادر الغرفة: ${user.room}`);
    }
  });

  // -----------------------------------------------
  // VOICE ROOM EVENTS
  // -----------------------------------------------

  socket.on('join_voice', ({ room: voiceRoom, color }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    if (!voiceRooms.has(voiceRoom)) voiceRooms.set(voiceRoom, new Map());
    voiceRooms.get(voiceRoom).set(socket.id, { username: user.username, color, muted: false });

    // Tell others I joined
    socket.to(voiceRoom).emit('voice_user_joined', { username: user.username, color });

    // Send me current voice users
    const currentVoiceUsers = [];
    for (const [sid, u] of voiceRooms.get(voiceRoom).entries()) {
      if (sid !== socket.id) currentVoiceUsers.push(u);
    }
    socket.emit('voice_room_users', { users: currentVoiceUsers });

    console.log(`🎤 ${user.username} انضم للغرفة الصوتية: ${voiceRoom}`);
  });

  socket.on('leave_voice', ({ room: voiceRoom }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    if (voiceRooms.has(voiceRoom)) {
      voiceRooms.get(voiceRoom).delete(socket.id);
    }
    socket.to(voiceRoom).emit('voice_user_left', { username: user.username });
    console.log(`🔇 ${user.username} غادر الغرفة الصوتية`);
  });

  // WebRTC Signaling
  socket.on('voice_offer', ({ to, offer }) => {
    const targetSocket = findSocketByUsername(to);
    if (targetSocket) {
      const user = onlineUsers.get(socket.id);
      io.to(targetSocket).emit('voice_offer', { from: user?.username, offer });
    }
  });

  socket.on('voice_answer', ({ to, answer }) => {
    const targetSocket = findSocketByUsername(to);
    if (targetSocket) {
      const user = onlineUsers.get(socket.id);
      io.to(targetSocket).emit('voice_answer', { from: user?.username, answer });
    }
  });

  socket.on('voice_ice', ({ to, candidate }) => {
    const targetSocket = findSocketByUsername(to);
    if (targetSocket) {
      const user = onlineUsers.get(socket.id);
      io.to(targetSocket).emit('voice_ice', { from: user?.username, candidate });
    }
  });

  socket.on('voice_mute', ({ room: voiceRoom, muted }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    if (voiceRooms.has(voiceRoom) && voiceRooms.get(voiceRoom).has(socket.id)) {
      voiceRooms.get(voiceRoom).get(socket.id).muted = muted;
    }
    socket.to(voiceRoom).emit('voice_mute_update', { username: user.username, muted });
  });

  socket.on('voice_speaking', ({ room: voiceRoom, speaking }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(voiceRoom).emit('voice_speaking', { username: user.username, speaking });
  });

});

// ============================================
// Helper Functions
// ============================================
function getRoomUsers(roomName) {
  const users = [];
  if (roomUsers.has(roomName)) {
    for (const sid of roomUsers.get(roomName)) {
      const u = onlineUsers.get(sid);
      if (u) users.push({ username: u.username, color: u.color, id: sid });
    }
  }
  return users;
}

function findSocketByUsername(targetUsername) {
  for (const [sid, u] of onlineUsers.entries()) {
    if (u.username === targetUsername) return sid;
  }
  return null;
}

async function checkIsAdmin(username, roomName) {
  if (username === 'admin') return true;
  if (db) {
    try {
      const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [roomName]);
      if (roomRow.length === 0) return false;
      const [adminRow] = await db.query(
        'SELECT id FROM room_admins WHERE room_id = ? AND username = ?',
        [roomRow[0].id, username]
      );
      return adminRow.length > 0;
    } catch (e) {
      return false;
    }
  } else {
    return (inMemoryAdmins[roomName] || []).includes(username);
  }
}

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('\n🚀 ============================================');
  console.log(`🌐 نظام الدردشة يعمل على: http://localhost:${PORT}`);
  console.log(`👑 لوحة الإدارة: http://localhost:${PORT}/admin`);
  console.log(`🔑 كلمة مرور الإدارة: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  console.log('🚀 ============================================\n');
  
  // Initialize database in background so it doesn't block server startup
  initDB();
});
