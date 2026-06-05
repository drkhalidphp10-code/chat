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

    `CREATE TABLE IF NOT EXISTS admin_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS private_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sender VARCHAR(50) NOT NULL,
      receiver VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      message_type ENUM('text', 'emoji') DEFAULT 'text',
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sender (sender),
      INDEX idx_receiver (receiver),
      INDEX idx_created (created_at)
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

  // Seed default admin in database
  try {
    const [rows] = await db.query('SELECT id FROM admin_users LIMIT 1');
    if (rows.length === 0) {
      await db.query(
        'INSERT IGNORE INTO admin_users (username, password) VALUES (?, ?)',
        ['admin', 'admin123']
      );
      console.log('👑 تم إدراج حساب المسؤول الافتراضي في قاعدة البيانات');
    }
  } catch (e) {}

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
const inMemoryPrivateMessages = [];

// ============================================
// Online Users Tracking
// ============================================
const onlineUsers = new Map(); // socketId -> { username, room, color, id }
const roomUsers = new Map();   // roomName -> Set of socketIds
const micQueues = new Map();    // roomName -> Array of { socketId, username, color }
const activeSpeakers = new Map(); // roomName -> { socketId, username, color, expiresAt, timer }
const micLockedRooms = new Set();  // Set of roomNames with locked mic queues

// ============================================
// Helper: Compile Stats Data
// ============================================
async function getStatsData() {
  const totalOnline = onlineUsers.size;
  const roomStats = [];
  for (const [name, users] of roomUsers.entries()) {
    roomStats.push({ room: name, count: users.size });
  }

  let totalMessages = 0;
  let totalRooms = Object.keys(inMemoryRooms).length;

  if (db) {
    try {
      const [[{ count }]] = await db.query('SELECT COUNT(*) as count FROM messages WHERE is_deleted = 0');
      totalMessages = count;
      const [[{ rcount }]] = await db.query('SELECT COUNT(*) as rcount FROM rooms WHERE is_active = 1');
      totalRooms = rcount;
    } catch (e) {
      console.error(e);
    }
  } else {
    totalMessages = Object.values(inMemoryMessages).reduce((s, m) => s + m.length, 0);
  }

  return { totalOnline, totalRooms, totalMessages, roomStats };
}

async function broadcastAdminStats() {
  if (io && io.sockets && io.sockets.adapter.rooms.has('super_admins')) {
    try {
      const stats = await getStatsData();
      io.to('super_admins').emit('admin_stats_update', { stats });
    } catch (e) {
      console.error('Error broadcasting admin stats:', e);
    }
  }
}

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

// TURN server credentials for WebRTC
app.get('/api/turn-credentials', (req, res) => {
  // If the user has set a METERED_API_KEY, use metered.ca for best performance
  const meteredKey = process.env.METERED_API_KEY;
  
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Free TURN servers (relay) - essential for mobile networks
    {
      urls: 'turn:a.relay.metered.ca:80',
      username: 'e8dd65b92f6aee65c3912070',
      credential: '3TFjp+MFtGLKXHR0'
    },
    {
      urls: 'turn:a.relay.metered.ca:80?transport=tcp',
      username: 'e8dd65b92f6aee65c3912070',
      credential: '3TFjp+MFtGLKXHR0'
    },
    {
      urls: 'turn:a.relay.metered.ca:443',
      username: 'e8dd65b92f6aee65c3912070',
      credential: '3TFjp+MFtGLKXHR0'
    },
    {
      urls: 'turns:a.relay.metered.ca:443?transport=tcp',
      username: 'e8dd65b92f6aee65c3912070',
      credential: '3TFjp+MFtGLKXHR0'
    }
  ];

  // If user provided custom TURN credentials via environment
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

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

// Helper: Check if super admin is valid
async function isValidSuperAdmin(username, password) {
  if (!password) return false;
  const cleanUser = (username || 'admin').trim().toLowerCase();

  if (db) {
    try {
      const [adminRows] = await db.query('SELECT password FROM admin_users WHERE username = ?', [cleanUser]);
      if (adminRows.length > 0) {
        return password === adminRows[0].password;
      }
    } catch (e) {
      console.error('Error validating super admin from DB:', e);
    }
  }

  // Fallback
  if (cleanUser === 'admin') {
    return password === (process.env.ADMIN_PASSWORD || 'admin123');
  }

  return false;
}

// Admin: Login verification
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const isValid = await isValidSuperAdmin(username, password);
  if (isValid) {
    res.json({ success: true, username: username || 'admin' });
  } else {
    res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
});

// Admin: Get stats
app.get('/api/admin/stats', async (req, res) => {
  const { username, password } = req.query;
  const isValid = await isValidSuperAdmin(username, password);
  if (!isValid) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }
  try {
    const stats = await getStatsData();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: List all admins
app.get('/api/admin/list-admins', async (req, res) => {
  const { username, password } = req.query;
  const isValid = await isValidSuperAdmin(username, password);
  if (!isValid) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }

  try {
    if (db) {
      const [rows] = await db.query('SELECT id, username, created_at FROM admin_users ORDER BY id ASC');
      res.json({ success: true, admins: rows });
    } else {
      res.json({ success: true, admins: [{ id: 1, username: 'admin', created_at: new Date() }] });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Add new admin
app.post('/api/admin/add-admin', async (req, res) => {
  const { adminUsername, adminPassword, newUsername, newPassword } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }

  if (!newUsername || !newPassword) {
    return res.status(400).json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  const cleanUser = newUsername.trim().toLowerCase();
  if (cleanUser.length < 3 || cleanUser.length > 50) {
    return res.status(400).json({ success: false, error: 'اسم المستخدم يجب أن يكون بين 3 و 50 حرفاً' });
  }

  try {
    if (db) {
      const [existing] = await db.query('SELECT id FROM admin_users WHERE username = ?', [cleanUser]);
      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: 'اسم المستخدم موجود مسبقاً' });
      }
      await db.query('INSERT INTO admin_users (username, password) VALUES (?, ?)', [cleanUser, newPassword]);
      res.json({ success: true, message: 'تم إضافة المسؤول بنجاح' });
    } else {
      res.status(501).json({ success: false, error: 'قاعدة البيانات غير متصلة' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Delete admin
app.post('/api/admin/delete-admin', async (req, res) => {
  const { adminUsername, adminPassword, targetId } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }

  try {
    if (db) {
      // Find the username of the target
      const [rows] = await db.query('SELECT username FROM admin_users WHERE id = ?', [targetId]);
      if (rows.length === 0) {
        return res.status(444).json({ success: false, error: 'المسؤول غير موجود' });
      }
      const targetUser = rows[0].username.toLowerCase();
      if (targetUser === (adminUsername || 'admin').trim().toLowerCase()) {
        return res.status(400).json({ success: false, error: 'لا يمكنك حذف حسابك الشخصي النشط' });
      }

      await db.query('DELETE FROM admin_users WHERE id = ?', [targetId]);
      res.json({ success: true, message: 'تم حذف المسؤول بنجاح' });
    } else {
      res.status(501).json({ success: false, error: 'قاعدة البيانات غير متصلة' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Delete room
app.post('/api/admin/delete-room', async (req, res) => {
  const { adminUsername, adminPassword, roomId } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }

  try {
    let roomName = '';
    if (db) {
      const [rows] = await db.query('SELECT name FROM rooms WHERE id = ?', [roomId]);
      if (rows.length === 0) {
        return res.status(444).json({ success: false, error: 'الغرفة غير موجودة' });
      }
      roomName = rows[0].name;
      // Mark room as inactive in database
      await db.query('UPDATE rooms SET is_active = 0 WHERE id = ?', [roomId]);
    } else {
      // Memory fallback
      const found = Object.values(inMemoryRooms).find(r => r.id === parseInt(roomId));
      if (!found) {
        return res.status(444).json({ success: false, error: 'الغرفة غير موجودة' });
      }
      roomName = found.name;
      delete inMemoryRooms[roomName];
    }

    // Emit kicked to all users inside the room
    const socketsInRoom = roomUsers.get(roomName);
    if (socketsInRoom) {
      for (const sid of socketsInRoom) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('kicked', { message: 'تم إغلاق هذه الغرفة بواسطة الإدارة العامة.' });
          s.leave(roomName);
        }
      }
      roomUsers.delete(roomName);
    }

    // Cleanup room state
    micQueues.delete(roomName);
    activeSpeakers.delete(roomName);
    micLockedRooms.delete(roomName);

    // Broadcast updated stats to other admins
    broadcastAdminStats();

    // Broadcast room list updated to all clients
    io.emit('room_list_updated');

    res.json({ success: true, message: 'تم حذف الغرفة وطرد المتواجدين بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/verify-admin', async (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.json({ success: false, message: 'يرجى إدخال اسم المستخدم للمسؤول' });

  const cleanUser = username.trim().toLowerCase();
  
  // Check if they are database admin
  let isDbAdmin = false;
  let dbAdminPassword = null;
  if (db) {
    try {
      const [adminRows] = await db.query('SELECT password FROM admin_users WHERE username = ?', [cleanUser]);
      if (adminRows.length > 0) {
        isDbAdmin = true;
        dbAdminPassword = adminRows[0].password;
      }
    } catch (e) {}
  }

  if (isDbAdmin) {
    if (password === dbAdminPassword) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false, message: 'كلمة مرور حساب المسؤول غير صحيحة!' });
    }
  } else if (cleanUser === 'admin') {
    if (password === (process.env.ADMIN_PASSWORD || 'admin123')) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false, message: 'كلمة مرور حساب المسؤول غير صحيحة!' });
    }
  }

  // Not an admin account, always success
  return res.json({ success: true });
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
  // SUPER ADMIN AUTH & SOCKET JOIN
  // -----------------------------------------------
  socket.on('admin_auth', async ({ username, password }) => {
    const isValid = await isValidSuperAdmin(username, password);
    if (isValid) {
      socket.join('super_admins');
      const stats = await getStatsData();
      socket.emit('admin_stats_update', { stats });
      console.log(`👑 المسؤول الكبير [${username || 'admin'}] اتصل بلوحة الإدارة عبر Socket.io`);
    } else {
      socket.emit('admin_auth_failed', { message: 'بيانات غير صحيحة' });
    }
  });

  // -----------------------------------------------
  // JOIN ROOM
  // -----------------------------------------------
  socket.on('join_room', async ({ username, room, color, password }) => {
    if (!username || !room) return;

    const cleanUser = username.trim().substring(0, 30);
    const cleanRoom = room.trim().substring(0, 50);
    const userColor = color || getUserColor(cleanUser);

    // Admin password security check
    let isDbAdmin = false;
    let dbAdminPassword = null;
    
    if (db) {
      try {
        const [adminRows] = await db.query('SELECT password FROM admin_users WHERE username = ?', [cleanUser.toLowerCase()]);
        if (adminRows.length > 0) {
          isDbAdmin = true;
          dbAdminPassword = adminRows[0].password;
        }
      } catch (e) {}
    }

    if (isDbAdmin) {
      if (password !== dbAdminPassword) {
        socket.emit('error_msg', { message: 'كلمة مرور حساب المسؤول غير صحيحة!' });
        setTimeout(() => socket.disconnect(), 800);
        return;
      }
    } else if (cleanUser.toLowerCase() === 'admin' && password !== (process.env.ADMIN_PASSWORD || 'admin123')) {
      socket.emit('error_msg', { message: 'كلمة مرور حساب المسؤول غير صحيحة!' });
      setTimeout(() => socket.disconnect(), 800);
      return;
    }

    // Special registered user check for خالد
    const rawUser = cleanUser.replace(/^\[(عضو|مسجل)\]\s*/, '');
    if (rawUser === 'خالد') {
      if (password !== '1234') {
        socket.emit('error_msg', { message: 'كلمة المرور غير صحيحة لحساب خالد!' });
        setTimeout(() => socket.disconnect(), 800);
        return;
      }
    }

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

    const activeSpk = activeSpeakers.get(cleanRoom);
    const qList = micQueues.get(cleanRoom) || [];
    const isAdmin = await checkIsAdmin(cleanUser, cleanRoom);

    socket.emit('joined_room', {
      room: cleanRoom,
      username: cleanUser,
      color: userColor,
      users: usersInRoom,
      time: formatTime(),
      isAdmin: isAdmin,
      isMicLocked: micLockedRooms.has(cleanRoom),
      speaker: activeSpk ? {
        username: activeSpk.username,
        color: activeSpk.color,
        timeLeft: Math.max(0, Math.round((activeSpk.expiresAt - Date.now()) / 1000))
      } : null,
      queue: qList.map(q => ({ username: q.username, color: q.color }))
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
    broadcastAdminStats();
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
    broadcastAdminStats();
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
  // UNBAN USER (Admin only)
  // -----------------------------------------------
  socket.on('unban_user', async ({ targetUsername }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) {
      socket.emit('error_msg', { message: 'ليس لديك صلاحية لرفع الحظر' });
      return;
    }

    const cleanTarget = targetUsername.trim();
    if (db) {
      try {
        const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [user.room]);
        if (roomRow.length > 0) {
          await db.query(
            'DELETE FROM banned_users WHERE room_id = ? AND username = ?',
            [roomRow[0].id, cleanTarget]
          );
        }
      } catch (e) {}
    }

    io.to(user.room).emit('new_message', {
      id: uuidv4(),
      username: 'النظام',
      color: '#4caf50',
      message: `تم رفع الحظر عن ${cleanTarget} بواسطة المشرف ${user.username}`,
      time: formatTime(),
      type: 'system'
    });
  });

  // -----------------------------------------------
  // GET BANNED USERS (Admin only)
  // -----------------------------------------------
  socket.on('get_banned_users', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) return;

    if (db) {
      try {
        const [roomRow] = await db.query('SELECT id FROM rooms WHERE name = ?', [user.room]);
        if (roomRow.length > 0) {
          const [banned] = await db.query(
            'SELECT username, reason, banned_by, created_at FROM banned_users WHERE room_id = ? ORDER BY created_at DESC',
            [roomRow[0].id]
          );
          socket.emit('banned_users_list', { banned });
        } else {
          socket.emit('banned_users_list', { banned: [] });
        }
      } catch (e) {
        socket.emit('banned_users_list', { banned: [] });
      }
    } else {
      socket.emit('banned_users_list', { banned: [] });
    }
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

      // Leave mic or queue if they were in it
      leaveMic(socket, user.room);

      console.log(`👋 ${user.username} غادر الغرفة: ${user.room}`);
      broadcastAdminStats();
    }
  });

  // -----------------------------------------------
  // VOICE / MIC QUEUE EVENTS
  // -----------------------------------------------

  socket.on('request_mic', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const roomName = user.room;
    if (!micQueues.has(roomName)) micQueues.set(roomName, []);
    const queue = micQueues.get(roomName);

    // Enforce mic queue lock check
    const isAdmin = await checkIsAdmin(user.username, roomName);
    if (micLockedRooms.has(roomName) && !isAdmin) {
      socket.emit('error_msg', { message: 'المايك مقفل حالياً بواسطة إدارة الغرفة!' });
      return;
    }

    const speaker = activeSpeakers.get(roomName);
    if (!speaker) {
      // Direct promotion
      activeSpeakers.set(roomName, {
        socketId: socket.id,
        username: user.username,
        color: user.color,
        ready: false
      });

      socket.emit('mic_assigned');
      startSpeakerSetupTimeout(roomName);
    } else {
      // Add to queue if not already there and not the speaker
      if (speaker.socketId !== socket.id && !queue.some(q => q.socketId === socket.id)) {
        queue.push({
          socketId: socket.id,
          username: user.username,
          color: user.color
        });

        io.to(roomName).emit('queue_updated', {
          queue: queue.map(q => ({ username: q.username, color: q.color }))
        });
      }
    }
  });

  socket.on('speaker_ready', () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const roomName = user.room;
    const speaker = activeSpeakers.get(roomName);
    if (speaker && speaker.socketId === socket.id && !speaker.ready) {
      clearTimeout(speaker.setupTimer);
      speaker.ready = true;
      speaker.expiresAt = Date.now() + 180000;

      io.to(roomName).emit('speaker_changed', {
        username: speaker.username,
        color: speaker.color,
        timeLeft: 180
      });
      startSpeakerTimer(roomName);
    }
  });

  socket.on('leave_mic', () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    leaveMic(socket, user.room);
  });

  socket.on('lock_mic', async ({ locked }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) return;

    if (locked) {
      micLockedRooms.add(user.room);
    } else {
      micLockedRooms.delete(user.room);
    }

    io.to(user.room).emit('mic_lock_status', { locked });
    console.log(`🔒 تم ${locked ? 'قفل' : 'فتح'} المايك في غرفة ${user.room} بواسطة ${user.username}`);
  });

  socket.on('broadcast_announcement', async ({ text }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) return;

    io.to(user.room).emit('announcement_updated', { text });
    console.log(`📢 إعلان جديد في غرفة ${user.room} بواسطة ${user.username}: ${text}`);
  });

  socket.on('drop_speaker', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const isAdmin = await checkIsAdmin(user.username, user.room);
    if (!isAdmin) return;

    console.log(`🎤 تم سحب المايك في غرفة ${user.room} بواسطة ${user.username}`);
    demoteSpeaker(user.room);
  });

  // WebRTC Signaling for Single-Speaker Star Topology
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
    socket.to(voiceRoom).emit('voice_mute_update', { username: user.username, muted });
  });

  socket.on('voice_speaking', ({ room: voiceRoom, speaking }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(voiceRoom).emit('voice_speaking', { username: user.username, speaking });
  });

  // -----------------------------------------------
  // PRIVATE CHAT (DM) EVENTS
  // -----------------------------------------------
  socket.on('send_private_message', async ({ to, message }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !message || !to) return;

    const cleanMsg = message.trim().substring(0, 1000);
    if (!cleanMsg) return;

    const targetSocket = findSocketByUsername(to);
    
    // Save to DB if connected
    if (db) {
      try {
        await db.query(
          'INSERT INTO private_messages (sender, receiver, message) VALUES (?, ?, ?)',
          [user.username, to, cleanMsg]
        );
      } catch (e) {
        console.error('Error saving private message to DB:', e);
      }
    } else {
      // In memory fallback
      inMemoryPrivateMessages.push({
        sender: user.username,
        receiver: to,
        message: cleanMsg,
        created_at: new Date()
      });
      if (inMemoryPrivateMessages.length > 1000) {
        inMemoryPrivateMessages.shift();
      }
    }

    const msgData = {
      sender: user.username,
      receiver: to,
      message: cleanMsg,
      time: formatTime(),
      color: user.color
    };

    // Emit to receiver if online
    if (targetSocket) {
      io.to(targetSocket).emit('new_private_message', msgData);
    }
    
    // Emit confirmation back to sender
    socket.emit('private_message_sent', msgData);
  });

  socket.on('get_private_history', async ({ withUser }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !withUser) return;

    try {
      let messages = [];
      if (db) {
        const [rows] = await db.query(
          `SELECT sender, receiver, message, created_at 
           FROM private_messages 
           WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
           ORDER BY created_at DESC LIMIT 50`,
          [user.username, withUser, withUser, user.username]
        );
        messages = rows.reverse().map(r => ({
          sender: r.sender,
          receiver: r.receiver,
          message: r.message,
          time: formatTime(new Date(r.created_at)),
          color: getUserColor(r.sender)
        }));
      } else {
        const rows = inMemoryPrivateMessages.filter(m => 
          (m.sender === user.username && m.receiver === withUser) ||
          (m.sender === withUser && m.receiver === user.username)
        ).slice(-50);
        messages = rows.map(r => ({
          sender: r.sender,
          receiver: r.receiver,
          message: r.message,
          time: formatTime(r.created_at),
          color: getUserColor(r.sender)
        }));
      }

      socket.emit('private_history', { withUser, messages });
    } catch (e) {
      console.error('Error fetching private history:', e);
      socket.emit('private_history', { withUser, messages: [] });
    }
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
  if (db) {
    try {
      const [adminUsersRow] = await db.query('SELECT id FROM admin_users WHERE username = ?', [username.toLowerCase()]);
      if (adminUsersRow.length > 0) return true;

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
    if (username === 'admin') return true;
    return (inMemoryAdmins[roomName] || []).includes(username);
  }
}

function startSpeakerTimer(roomName) {
  const speaker = activeSpeakers.get(roomName);
  if (!speaker) return;

  speaker.timer = setTimeout(() => {
    console.log(`⏰ انتهى وقت مايك ${speaker.username} في غرفة ${roomName}`);

    io.to(roomName).emit('new_message', {
      id: uuidv4(),
      username: 'النظام',
      color: '#ff6b6b',
      message: `انتهى وقت المايك الخاص بـ ${speaker.username} (3 دقائق)، تم الانتقال للتالي`,
      time: formatTime(),
      type: 'system'
    });

    demoteSpeaker(roomName);
  }, 180000);
}

function startSpeakerSetupTimeout(roomName) {
  const speaker = activeSpeakers.get(roomName);
  if (!speaker) return;

  clearTimeout(speaker.setupTimer);
  speaker.setupTimer = setTimeout(() => {
    const current = activeSpeakers.get(roomName);
    if (current && current.socketId === speaker.socketId && !current.ready) {
      console.log(`⚠️ انتهت مهلة إعداد المايك لـ ${speaker.username} في غرفة ${roomName}`);
      demoteSpeaker(roomName);
    }
  }, 12000);
}

function demoteSpeaker(roomName) {
  const speaker = activeSpeakers.get(roomName);
  if (!speaker) return;

  clearTimeout(speaker.timer);
  clearTimeout(speaker.setupTimer);
  activeSpeakers.delete(roomName);

  // Notify the demoted speaker
  io.to(speaker.socketId).emit('mic_demoted');

  // Check queue
  const queue = micQueues.get(roomName) || [];
  if (queue.length > 0) {
    const nextSpeaker = queue.shift();
    activeSpeakers.set(roomName, {
      socketId: nextSpeaker.socketId,
      username: nextSpeaker.username,
      color: nextSpeaker.color,
      ready: false
    });

    io.to(nextSpeaker.socketId).emit('mic_assigned');
    io.to(roomName).emit('queue_updated', {
      queue: queue.map(q => ({ username: q.username, color: q.color }))
    });
    
    startSpeakerSetupTimeout(roomName);
  } else {
    io.to(roomName).emit('speaker_changed', null);
    io.to(roomName).emit('queue_updated', { queue: [] });
  }
}

function leaveMic(socket, roomName) {
  const speaker = activeSpeakers.get(roomName);
  if (speaker && speaker.socketId === socket.id) {
    console.log(`🎤 ${speaker.username} غادر المايك اختيارياً في غرفة ${roomName}`);
    demoteSpeaker(roomName);
    return;
  }

  const queue = micQueues.get(roomName) || [];
  const idx = queue.findIndex(q => q.socketId === socket.id);
  if (idx !== -1) {
    const removed = queue.splice(idx, 1)[0];
    console.log(`✋ ${removed.username} غادر طابور الانتظار في غرفة ${roomName}`);
    io.to(roomName).emit('queue_updated', {
      queue: queue.map(q => ({ username: q.username, color: q.color }))
    });
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
