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

    `CREATE TABLE IF NOT EXISTS private_blocks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      blocker VARCHAR(50) NOT NULL,
      blocked VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_block (blocker, blocked),
      INDEX idx_blocker (blocker)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS directory_sites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      url VARCHAR(500) NOT NULL,
      description TEXT,
      short_desc VARCHAR(400),
      category VARCHAR(100) DEFAULT 'عام',
      keywords TEXT,
      icon_emoji VARCHAR(20) DEFAULT '🌐',
      is_featured BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      visit_count INT DEFAULT 0,
      slug VARCHAR(200) UNIQUE,
      og_image VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_slug (slug),
      INDEX idx_category (category),
      INDEX idx_active (is_active)
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
const inMemoryPrivateBlocks = new Set(); // blockerUsername:blockedUsername

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

// Upload avatar endpoint
app.post('/api/upload-avatar', (req, res) => {
  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ success: false, error: 'No image data provided' });
  }

  try {
    const fs = require('fs');
    const avatarsDir = path.join(__dirname, 'public', 'images', 'avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }

    // Remove the data URI scheme header if present
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    const filename = `avatar_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`;
    const filepath = path.join(avatarsDir, filename);

    fs.writeFileSync(filepath, buffer);
    res.json({ success: true, url: `/images/avatars/${filename}` });
  } catch (err) {
    console.error('Error saving avatar:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Directory API Routes
// ============================================

// In-memory fallback for directory
const inMemoryDirectory = [];

// Helper: create URL-friendly slug
function createSlug(text) {
  return text
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9-]/g, '')
    .substring(0, 100)
    .replace(/-+$/, '') || 'site-' + Date.now();
}

// GET /api/directory - get all active sites
app.get('/api/directory', async (req, res) => {
  const { category, search, featured } = req.query;
  try {
    if (db) {
      let query = 'SELECT * FROM directory_sites WHERE is_active = 1';
      const params = [];
      if (category && category !== 'all') { query += ' AND category = ?'; params.push(category); }
      if (featured === '1') { query += ' AND is_featured = 1'; }
      if (search) { query += ' AND (name LIKE ? OR short_desc LIKE ? OR keywords LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
      query += ' ORDER BY is_featured DESC, visit_count DESC, created_at DESC';
      const [rows] = await db.query(query, params);
      res.json({ success: true, sites: rows });
    } else {
      let sites = inMemoryDirectory.filter(s => s.is_active);
      if (category && category !== 'all') sites = sites.filter(s => s.category === category);
      if (search) { const s = search.toLowerCase(); sites = sites.filter(s2 => s2.name.toLowerCase().includes(s) || (s2.short_desc || '').toLowerCase().includes(s)); }
      res.json({ success: true, sites });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/directory/categories - list unique categories
app.get('/api/directory/categories', async (req, res) => {
  try {
    if (db) {
      const [rows] = await db.query('SELECT DISTINCT category, COUNT(*) as count FROM directory_sites WHERE is_active=1 GROUP BY category ORDER BY count DESC');
      res.json({ success: true, categories: rows });
    } else {
      const cats = {};
      inMemoryDirectory.forEach(s => { if (s.is_active) cats[s.category] = (cats[s.category] || 0) + 1; });
      res.json({ success: true, categories: Object.entries(cats).map(([category, count]) => ({ category, count })) });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/directory/add - add new site (admin only)
app.post('/api/directory/add', async (req, res) => {
  const { adminUsername, adminPassword, name, url, description, short_desc, category, keywords, icon_emoji, is_featured, og_image } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) return res.status(403).json({ success: false, error: 'غير مصرح' });
  if (!name || !url) return res.status(400).json({ success: false, error: 'الاسم والرابط مطلوبان' });

  const slug = createSlug(name);
  const siteData = {
    name: name.trim(),
    url: url.trim(),
    description: description || '',
    short_desc: short_desc || '',
    category: category || 'عام',
    keywords: keywords || '',
    icon_emoji: icon_emoji || '🌐',
    is_featured: is_featured ? 1 : 0,
    slug,
    og_image: og_image || ''
  };

  try {
    if (db) {
      const [existing] = await db.query('SELECT id FROM directory_sites WHERE slug = ?', [slug]);
      const finalSlug = existing.length > 0 ? slug + '-' + Date.now() : slug;
      siteData.slug = finalSlug;
      const [result] = await db.query(
        'INSERT INTO directory_sites (name, url, description, short_desc, category, keywords, icon_emoji, is_featured, slug, og_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [siteData.name, siteData.url, siteData.description, siteData.short_desc, siteData.category, siteData.keywords, siteData.icon_emoji, siteData.is_featured, siteData.slug, siteData.og_image]
      );
      res.json({ success: true, site: { id: result.insertId, ...siteData } });
    } else {
      const id = inMemoryDirectory.length + 1;
      const site = { id, ...siteData, is_active: true, visit_count: 0, created_at: new Date() };
      inMemoryDirectory.push(site);
      res.json({ success: true, site });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/directory/:id - update site (admin only)
app.put('/api/directory/:id', async (req, res) => {
  const { adminUsername, adminPassword, name, url, description, short_desc, category, keywords, icon_emoji, is_featured, is_active, og_image } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) return res.status(403).json({ success: false, error: 'غير مصرح' });
  const siteId = parseInt(req.params.id);
  try {
    if (db) {
      await db.query(
        'UPDATE directory_sites SET name=?, url=?, description=?, short_desc=?, category=?, keywords=?, icon_emoji=?, is_featured=?, is_active=?, og_image=?, updated_at=NOW() WHERE id=?',
        [name, url, description, short_desc, category, keywords, icon_emoji, is_featured ? 1 : 0, is_active !== false ? 1 : 0, og_image || '', siteId]
      );
      res.json({ success: true, message: 'تم التحديث بنجاح' });
    } else {
      const site = inMemoryDirectory.find(s => s.id === siteId);
      if (!site) return res.status(404).json({ success: false, error: 'الموقع غير موجود' });
      Object.assign(site, { name, url, description, short_desc, category, keywords, icon_emoji, is_featured, is_active });
      res.json({ success: true, message: 'تم التحديث بنجاح' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/directory/:id - delete site (admin only)
app.delete('/api/directory/:id', async (req, res) => {
  const { adminUsername, adminPassword } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) return res.status(403).json({ success: false, error: 'غير مصرح' });
  const siteId = parseInt(req.params.id);
  try {
    if (db) {
      await db.query('UPDATE directory_sites SET is_active = 0 WHERE id = ?', [siteId]);
      res.json({ success: true, message: 'تم الحذف بنجاح' });
    } else {
      const idx = inMemoryDirectory.findIndex(s => s.id === siteId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'الموقع غير موجود' });
      inMemoryDirectory[idx].is_active = false;
      res.json({ success: true, message: 'تم الحذف بنجاح' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/directory/visit/:id - increment visit count
app.post('/api/directory/visit/:id', async (req, res) => {
  const siteId = parseInt(req.params.id);
  try {
    if (db) {
      await db.query('UPDATE directory_sites SET visit_count = visit_count + 1 WHERE id = ?', [siteId]);
    } else {
      const site = inMemoryDirectory.find(s => s.id === siteId);
      if (site) site.visit_count = (site.visit_count || 0) + 1;
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// POST /api/directory/generate-description - AI description writer
app.post('/api/directory/generate-description', async (req, res) => {
  const { adminUsername, adminPassword, siteName, siteUrl, category, keywords } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) return res.status(403).json({ success: false, error: 'غير مصرح' });

  // Smart template-based AI description (no external API needed - always works)
  const categoryDescriptions = {
    'دردشة': { adj: 'رائدة', features: 'تواصل فوري وآمن مع مستخدمين من جميع أنحاء العالم العربي', type: 'منصة دردشة' },
    'دردشة عراقية': { adj: 'العراقية الأولى', features: 'غرف دردشة صوتية وكتابية تجمع العراقيين من بغداد وسائر المحافظات', type: 'دردشة عراقية' },
    'شات': { adj: 'متميزة', features: 'محادثات حية وغرف متعددة وتواصل بلا حدود', type: 'شات عربي' },
    'ترفيه': { adj: 'المميزة', features: 'محتوى ترفيهي متجدد يومياً يشمل الفيديو والصوت والألعاب', type: 'منصة ترفيهية' },
    'تقنية': { adj: 'التقنية الرائدة', features: 'أحدث الأخبار والمقالات والبرامج التقنية والتطبيقات', type: 'موقع تقني' },
    'اجتماعي': { adj: 'الاجتماعية الأولى', features: 'تواصل اجتماعي حقيقي وبناء علاقات صادقة', type: 'شبكة اجتماعية' },
    'عام': { adj: 'المتميز', features: 'خدمات متنوعة وشاملة تلبي احتياجات المستخدم العربي', type: 'موقع إلكتروني' }
  };

  const catKey = Object.keys(categoryDescriptions).find(k => (category || '').includes(k)) || 'عام';
  const catData = categoryDescriptions[catKey];
  const kw = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [];
  const kwStr = kw.length > 0 ? ` يتميز بـ ${kw.slice(0, 3).join(' و')}` : '';

  const fullDesc = `${siteName} هو ${catData.type} ${catData.adj} يوفر ${catData.features}${kwStr}. يتميز ${siteName} بواجهة عربية سهلة الاستخدام وتجربة مستخدم استثنائية تجمع أفضل المميزات في منصة واحدة متكاملة. سواء كنت تبحث عن التواصل أو الترفيه أو المعلومات، فإن ${siteName} هو وجهتك الأولى والأمثل في عالم الإنترنت العربي.`;

  const shortDesc = `${catData.type} ${catData.adj} - ${catData.features.substring(0, 80)}...`;

  const suggestedKeywords = [
    siteName,
    category || 'عام',
    ...kw.slice(0, 3),
    'عربي', 'مجاني', 'للجوال'
  ].filter(Boolean).join(', ');

  res.json({
    success: true,
    description: fullDesc,
    short_desc: shortDesc,
    keywords: suggestedKeywords
  });
});

// POST /api/directory/sql - execute custom SQL (admin only)
app.post('/api/directory/sql', async (req, res) => {
  const { adminUsername, adminPassword, query: sqlQuery } = req.body;
  const isValid = await isValidSuperAdmin(adminUsername, adminPassword);
  if (!isValid) return res.status(403).json({ success: false, error: 'غير مصرح' });
  if (!sqlQuery || !sqlQuery.trim()) return res.status(400).json({ success: false, error: 'الاستعلام فارغ' });

  // Safety: only allow SELECT, INSERT, UPDATE on directory_sites table + SHOW, DESCRIBE
  const cleanQ = sqlQuery.trim().toUpperCase();
  const allowed = cleanQ.startsWith('SELECT') || cleanQ.startsWith('SHOW') || cleanQ.startsWith('DESCRIBE') ||
    (cleanQ.startsWith('INSERT') && cleanQ.includes('DIRECTORY_SITES')) ||
    (cleanQ.startsWith('UPDATE') && cleanQ.includes('DIRECTORY_SITES')) ||
    (cleanQ.startsWith('DELETE') && cleanQ.includes('DIRECTORY_SITES'));
  if (!allowed) {
    return res.status(403).json({ success: false, error: 'هذا الاستعلام غير مسموح به. يُسمح فقط بـ SELECT/SHOW/INSERT/UPDATE/DELETE على جدول directory_sites' });
  }

  try {
    if (!db) return res.status(503).json({ success: false, error: 'قاعدة البيانات غير متصلة' });
    const [rows, fields] = await db.query(sqlQuery);
    const columns = fields ? fields.map(f => f.name) : [];
    res.json({ success: true, rows: Array.isArray(rows) ? rows : [{ affected_rows: rows.affectedRows || 0 }], columns });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /sitemap.xml - dynamic sitemap
app.get('/sitemap.xml', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  let sites = [];
  try {
    if (db) {
      const [rows] = await db.query('SELECT slug, updated_at FROM directory_sites WHERE is_active = 1');
      sites = rows;
    } else {
      sites = inMemoryDirectory.filter(s => s.is_active);
    }
  } catch (e) {}

  const siteUrls = sites.map(s => `
  <url>
    <loc>${baseUrl}/directory/${encodeURIComponent(s.slug)}</loc>
    <lastmod>${s.updated_at ? new Date(s.updated_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/directory</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>${siteUrls}
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// GET /directory/:slug - Server-Side Rendered page for each site
app.get('/directory/:slug', async (req, res) => {
  const slug = req.params.slug;
  let site = null;
  let relatedSites = [];

  try {
    if (db) {
      const [rows] = await db.query('SELECT * FROM directory_sites WHERE slug = ? AND is_active = 1', [slug]);
      if (rows.length > 0) {
        site = rows[0];
        const [related] = await db.query(
          'SELECT id, name, short_desc, icon_emoji, slug, category FROM directory_sites WHERE category = ? AND slug != ? AND is_active = 1 LIMIT 4',
          [site.category, slug]
        );
        relatedSites = related;
      }
    } else {
      site = inMemoryDirectory.find(s => s.slug === slug && s.is_active);
      if (site) relatedSites = inMemoryDirectory.filter(s => s.category === site.category && s.slug !== slug && s.is_active).slice(0, 4);
    }
  } catch (e) { console.error(e); }

  if (!site) {
    return res.status(404).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>الصفحة غير موجودة</title></head><body style="text-align:center;padding:80px;font-family:sans-serif"><h1>404 - الصفحة غير موجودة</h1><a href="/directory">← العودة للدليل</a></body></html>`);
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const pageUrl = `${baseUrl}/directory/${slug}`;
  const ogImage = site.og_image || `${baseUrl}/images/master_gold_shield.png`;
  const kw = site.keywords || `${site.name}, ${site.category}, عربي`;

  const relatedHTML = relatedSites.length > 0 ? `
    <section class="related-section">
      <h2 class="related-title">مواقع مشابهة في فئة "${site.category}"</h2>
      <div class="related-grid">
        ${relatedSites.map(r => `
          <a href="/directory/${encodeURIComponent(r.slug)}" class="related-card">
            <span class="related-icon">${r.icon_emoji || '🌐'}</span>
            <div>
              <div class="related-name">${r.name}</div>
              <div class="related-desc">${r.short_desc || ''}</div>
            </div>
          </a>`).join('')}
      </div>
    </section>` : '';

  const schemaOrg = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": site.name,
    "description": site.short_desc || site.description,
    "url": pageUrl,
    "image": ogImage,
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "الرئيسية", "item": baseUrl },
        { "@type": "ListItem", "position": 2, "name": "دليل المواقع", "item": `${baseUrl}/directory` },
        { "@type": "ListItem", "position": 3, "name": site.name, "item": pageUrl }
      ]
    }
  });

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${site.name} | دليل المواقع العربية</title>
  <meta name="description" content="${(site.short_desc || site.description || '').substring(0, 160)}">
  <meta name="keywords" content="${kw}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${site.name} | دليل المواقع العربية">
  <meta property="og:description" content="${(site.short_desc || site.description || '').substring(0, 200)}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:title" content="${site.name}">
  <meta property="twitter:description" content="${(site.short_desc || '').substring(0, 160)}">
  <meta property="twitter:image" content="${ogImage}">
  <link rel="canonical" href="${pageUrl}">
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
  <script type="application/ld+json">${schemaOrg}</script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Tajawal',sans-serif}
    body{background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;color:#fff}
    .hero{background:linear-gradient(135deg,rgba(124,58,237,0.3),rgba(236,72,153,0.2));padding:0;border-bottom:1px solid rgba(255,255,255,0.1)}
    .nav-bar{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:rgba(0,0,0,0.3)}
    .nav-logo{font-size:20px;font-weight:900;color:#a78bfa;text-decoration:none}
    .breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,0.6);padding:12px 24px}
    .breadcrumb a{color:rgba(255,255,255,0.6);text-decoration:none}.breadcrumb a:hover{color:#a78bfa}
    .breadcrumb span{color:rgba(255,255,255,0.3)}
    .hero-content{display:flex;align-items:center;gap:24px;padding:48px 24px 40px;max-width:900px;margin:0 auto}
    .hero-icon{width:88px;height:88px;border-radius:24px;background:linear-gradient(135deg,#7c3aed,#ec4899);display:flex;align-items:center;justify-content:center;font-size:44px;flex-shrink:0;box-shadow:0 8px 32px rgba(124,58,237,0.5)}
    .hero-text h1{font-size:2rem;font-weight:900;margin-bottom:8px;line-height:1.2}
    .hero-text .category-tag{display:inline-block;background:rgba(167,139,250,0.2);color:#a78bfa;border:1px solid rgba(167,139,250,0.3);padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;margin-bottom:12px}
    .hero-text .short-desc{font-size:16px;color:rgba(255,255,255,0.75);line-height:1.6}
    .visit-btn{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;text-decoration:none;cursor:pointer;transition:transform 0.2s,box-shadow 0.2s;box-shadow:0 4px 20px rgba(124,58,237,0.4)}
    .visit-btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(124,58,237,0.6)}
    .stats-bar{display:flex;gap:24px;padding:16px 24px;background:rgba(0,0,0,0.2);border-top:1px solid rgba(255,255,255,0.05)}
    .stat-item{display:flex;align-items:center;gap:6px;font-size:13px;color:rgba(255,255,255,0.5)}
    .stat-item strong{color:rgba(255,255,255,0.9)}
    .main-content{max-width:900px;margin:0 auto;padding:40px 24px}
    .desc-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:32px;margin-bottom:32px;backdrop-filter:blur(10px)}
    .desc-card h2{font-size:18px;font-weight:800;color:#a78bfa;margin-bottom:16px;display:flex;align-items:center;gap:8px}
    .desc-text{font-size:15px;line-height:2;color:rgba(255,255,255,0.8)}
    .keywords-section{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px}
    .kw-tag{background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#c4b5fd;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600}
    .related-section{margin-top:40px}
    .related-title{font-size:18px;font-weight:800;color:#a78bfa;margin-bottom:20px;display:flex;align-items:center;gap:8px}
    .related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
    .related-card{display:flex;align-items:center;gap:12px;padding:16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:16px;text-decoration:none;color:#fff;transition:all 0.2s}
    .related-card:hover{background:rgba(124,58,237,0.15);border-color:rgba(124,58,237,0.4);transform:translateY(-2px)}
    .related-icon{font-size:28px;flex-shrink:0}
    .related-name{font-size:14px;font-weight:700;margin-bottom:3px}
    .related-desc{font-size:11px;color:rgba(255,255,255,0.5)}
    footer{text-align:center;padding:40px 24px;color:rgba(255,255,255,0.3);font-size:13px;border-top:1px solid rgba(255,255,255,0.05)}
    footer a{color:#a78bfa;text-decoration:none}
    @media(max-width:600px){.hero-content{flex-direction:column;text-align:center;padding:32px 16px}.hero-text h1{font-size:1.5rem}.stats-bar{flex-wrap:wrap;gap:12px}.related-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="hero">
    <nav class="nav-bar">
      <a href="/directory" class="nav-logo">🗂️ دليل المواقع</a>
      <a href="/" style="color:rgba(255,255,255,0.6);font-size:13px;text-decoration:none;">🏠 الرئيسية</a>
    </nav>
    <div class="breadcrumb">
      <a href="/">الرئيسية</a>
      <span>›</span>
      <a href="/directory">دليل المواقع</a>
      <span>›</span>
      <span style="color:rgba(255,255,255,0.9)">${site.name}</span>
    </div>
    <div class="hero-content">
      <div class="hero-icon">${site.icon_emoji || '🌐'}</div>
      <div class="hero-text">
        <span class="category-tag">${site.category}</span>
        <h1>${site.name}</h1>
        <p class="short-desc">${site.short_desc || ''}</p>
        <a href="${site.url}" target="_blank" rel="noopener nofollow" class="visit-btn" onclick="incrementVisit(${site.id})">
          🚀 زيارة الموقع
        </a>
      </div>
    </div>
    <div class="stats-bar">
      <div class="stat-item">👁️ <strong>${site.visit_count || 0}</strong> زيارة</div>
      <div class="stat-item">📁 <strong>${site.category}</strong></div>
      <div class="stat-item">📅 <strong>${new Date(site.created_at).toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' })}</strong></div>
    </div>
  </div>

  <main class="main-content">
    <article class="desc-card">
      <h2>📖 عن الموقع</h2>
      <p class="desc-text">${site.description || site.short_desc || 'لا يوجد وصف متاح حالياً.'}</p>
      ${site.keywords ? `<div class="keywords-section">${site.keywords.split(',').map(k => `<span class="kw-tag">${k.trim()}</span>`).join('')}</div>` : ''}
    </article>

    ${relatedHTML}
  </main>

  <footer>
    <p>© 2025 دليل المواقع العربية | <a href="/directory">العودة للدليل</a> | <a href="/">الدردشة العراقية</a></p>
  </footer>

  <script>
    function incrementVisit(id) {
      fetch('/api/directory/visit/' + id, { method: 'POST' }).catch(() => {});
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/directory', (req, res) => res.sendFile(path.join(__dirname, 'public', 'directory.html')));

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
  socket.on('join_room', async ({ username, room, color, password, avatar }) => {
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
    
    const userData = { username: cleanUser, room: cleanRoom, color: userColor, id: socket.id, ip: clientIp, avatar: avatar || '' };
    onlineUsers.set(socket.id, userData);

    if (!roomUsers.has(cleanRoom)) roomUsers.set(cleanRoom, new Set());
    roomUsers.get(cleanRoom).add(socket.id);

    // Get users in room
    const usersInRoom = getRoomUsers(cleanRoom);
    const isAdmin = await checkIsAdmin(cleanUser, cleanRoom);
    const isKh = (cleanUser.replace(/^\[(عضو|مسجل)\]\s*/, '') === 'خالد');
    const isVipUser = isKh || isAdmin;

    // Notify user joined
    socket.to(cleanRoom).emit('user_joined', {
      username: cleanUser,
      color: userColor,
      time: formatTime(),
      usersCount: usersInRoom.length,
      users: usersInRoom,
      isVip: isVipUser
    });

    const activeSpk = activeSpeakers.get(cleanRoom);
    const qList = micQueues.get(cleanRoom) || [];

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

    // Fetch blocks
    let blockedUsers = [];
    if (db) {
      try {
        const [blockRows] = await db.query('SELECT blocked FROM private_blocks WHERE blocker = ?', [cleanUser]);
        blockedUsers = blockRows.map(r => r.blocked);
      } catch (e) {
        console.error('Error fetching blocks:', e);
      }
    } else {
      // In-memory blocks
      for (const blockStr of inMemoryPrivateBlocks) {
        const [blocker, blocked] = blockStr.split(':');
        if (blocker === cleanUser) {
          blockedUsers.push(blocked);
        }
      }
    }
    socket.emit('blocked_list', { blocked: blockedUsers });

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
      avatar: user.avatar || '',
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

    // Check if recipient has blocked sender
    let isBlocked = false;
    if (db) {
      try {
        const [blockRows] = await db.query(
          'SELECT id FROM private_blocks WHERE blocker = ? AND blocked = ?',
          [to, user.username]
        );
        isBlocked = blockRows.length > 0;
      } catch (e) {
        console.error('Error checking blocks:', e);
      }
    } else {
      isBlocked = inMemoryPrivateBlocks.has(`${to}:${user.username}`);
    }

    if (isBlocked) {
      socket.emit('error_msg', { message: 'لا يمكنك إرسال رسائل خاصة لهذا المستخدم بسبب قيود الخصوصية.' });
      return;
    }

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
      color: user.color,
      avatar: user.avatar || ''
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

  socket.on('block_user_private', async ({ targetUsername }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !targetUsername) return;

    if (db) {
      try {
        await db.query(
          'INSERT IGNORE INTO private_blocks (blocker, blocked) VALUES (?, ?)',
          [user.username, targetUsername]
        );
      } catch (e) {
        console.error('Error blocking user:', e);
      }
    } else {
      inMemoryPrivateBlocks.add(`${user.username}:${targetUsername}`);
    }
    
    socket.emit('user_blocked_private', { targetUsername });
  });

  socket.on('unblock_user_private', async ({ targetUsername }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !targetUsername) return;

    if (db) {
      try {
        await db.query(
          'DELETE FROM private_blocks WHERE blocker = ? AND blocked = ?',
          [user.username, targetUsername]
        );
      } catch (e) {
        console.error('Error unblocking user:', e);
      }
    } else {
      inMemoryPrivateBlocks.delete(`${user.username}:${targetUsername}`);
    }
    
    socket.emit('user_unblocked_private', { targetUsername });
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
      if (u) users.push({ username: u.username, color: u.color, id: sid, avatar: u.avatar || '' });
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

  // Search Engine Auto-Ping for Sitemap indexing
  setTimeout(pingSearchEngines, 15000); // Initial ping after 15s
  setInterval(pingSearchEngines, 3 * 60 * 60 * 1000); // Repeating ping every 3 hours
});

const https = require('https');
function pingSearchEngines() {
  const sitemapUrl = 'https://mandubi.shop/sitemap.xml';
  const targets = [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`
  ];

  targets.forEach(url => {
    https.get(url, (res) => {
      console.log(`📡 [Sitemap Ping] Sent to search engine | Status: ${res.statusCode}`);
    }).on('error', (e) => {
      console.error(`❌ [Sitemap Ping] Failed | Error: ${e.message}`);
    });
  });
}
