-- ============================================
-- نظام دردشة عربي - Chat System Database Schema
-- ============================================

CREATE DATABASE IF NOT EXISTS chat_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chat_system;

-- ============================================
-- جدول الغرف - Rooms Table
-- ============================================
CREATE TABLE IF NOT EXISTS rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    type ENUM('public', 'private') DEFAULT 'public',
    password VARCHAR(255) NULL,
    max_users INT DEFAULT 100,
    created_by VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_name (name),
    INDEX idx_type (type),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- جدول المستخدمين - Users Table
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    display_name VARCHAR(100),
    avatar_color VARCHAR(20) DEFAULT '#6c63ff',
    role ENUM('user', 'moderator', 'admin') DEFAULT 'user',
    ip_address VARCHAR(45),
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    total_messages INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_username (username),
    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- جدول الرسائل - Messages Table
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    username VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    message_type ENUM('text', 'emoji', 'system', 'image') DEFAULT 'text',
    is_pinned BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    reply_to INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_room (room_id),
    INDEX idx_username (username),
    INDEX idx_created (created_at),
    INDEX idx_pinned (is_pinned),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- جدول مشرفي الغرف - Room Admins Table
-- ============================================
CREATE TABLE IF NOT EXISTS room_admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    username VARCHAR(50) NOT NULL,
    assigned_by VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_admin (room_id, username),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- جدول المحظورين - Banned Users Table
-- ============================================
CREATE TABLE IF NOT EXISTS banned_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT,
    username VARCHAR(50),
    ip_address VARCHAR(45),
    reason TEXT,
    banned_by VARCHAR(50),
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_room (room_id),
    INDEX idx_username (username),
    INDEX idx_ip (ip_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- إدخال بيانات أولية - Initial Data
-- ============================================

-- غرف افتراضية
INSERT IGNORE INTO rooms (name, description, type, created_by) VALUES
('عام', 'الغرفة العامة للجميع', 'public', 'system'),
('تقنية', 'نقاشات تقنية وبرمجية', 'public', 'system'),
('ترفيه', 'موسيقى وأفلام وترفيه', 'public', 'system'),
('رياضة', 'أخبار ونقاشات رياضية', 'public', 'system'),
('VIP', 'غرفة خاصة للأعضاء المميزين', 'private', 'system');
