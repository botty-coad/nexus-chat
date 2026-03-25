// ═══════════════════════════════════════════════════════════════════════════════
// NEXUS CHAT — Backend Server (Node.js + Express + Socket.IO)
// Production-Ready Real-Time Chat Application
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 50 * 1024 * 1024, // 50MB for file transfers
    transports: ['websocket', 'polling']
});

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─── FILE UPLOAD CONFIG ─────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}-${Date.now()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/webm',
            'application/pdf', 'application/msword', 'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain', 'text/csv'
        ];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// ─── IN-MEMORY DATABASE (production would use MongoDB/PostgreSQL) ──────────
const db = {
    rooms: new Map(),
    users: new Map(),
    messages: new Map(),
    callSessions: new Map(),
    typingUsers: new Map()
};

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// File upload endpoint
app.post('/api/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files.map(file => ({
        id: file.filename,
        name: file.originalname,
        size: file.size,
        mime: file.mimetype,
        path: `/files/${file.filename}`,
        uploadedAt: Date.now()
    }));

    res.json({ success: true, files });
});

// Serve uploaded files
app.get('/files/:filename', (req, res) => {
    const filepath = path.join(uploadsDir, req.params.filename);
    res.download(filepath);
});

// Get room info
app.get('/api/rooms/:roomId', (req, res) => {
    const room = db.rooms.get(req.params.roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    res.json(room);
});

// Create room via REST (optional, can also use Socket)
app.post('/api/rooms', express.json(), (req, res) => {
    const { name, description, isPrivate, maxMembers } = req.body;
    const roomId = uuidv4();
    
    const room = {
        id: roomId,
        name: name || 'Unnamed Room',
        description: description || '',
        isPrivate: isPrivate || false,
        maxMembers: maxMembers || 1000,
        createdAt: Date.now(),
        members: new Map(),
        pinnedMessages: [],
        settings: {
            allowVoice: true,
            allowVideo: true,
            allowFileSharing: true
        }
    };
    
    db.rooms.set(roomId, room);
    res.json({ success: true, room: { ...room, members: Array.from(room.members.values()) } });
});

// ─── SOCKET.IO EVENTS ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
    const userId = uuidv4();
    let currentRoom = null;
    let userInfo = null;

    console.log(`[User Connected] ID: ${userId}`);

    // ─── USER JOIN ROOM ─────────────────────────────────────────────────────
    socket.on('user:join_room', (data) => {
        const { roomId, username, avatar, status } = data;
        
        if (!db.rooms.has(roomId)) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        currentRoom = roomId;
        userInfo = {
            id: userId,
            username: username || `User${Math.random().toString(36).substr(2, 5)}`,
            avatar: avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`,
            status: status || 'online',
            joinedAt: Date.now(),
            lastSeen: Date.now(),
            socketId: socket.id
        };

        const room = db.rooms.get(roomId);
        room.members.set(userId, userInfo);
        db.users.set(userId, { ...userInfo, currentRoom });

        socket.join(roomId);

        // Broadcast user joined
        io.to(roomId).emit('user:joined', {
            userId,
            user: userInfo,
            memberCount: room.members.size,
            members: Array.from(room.members.values())
        });

        console.log(`[User Joined Room] ${userInfo.username} in ${roomId}`);
    });

    // ─── SEND MESSAGE ───────────────────────────────────────────────────────
    socket.on('message:send', (data) => {
        if (!currentRoom || !userInfo) return;

        const { content, type, files, replyTo } = data;
        const messageId = uuidv4();
        const timestamp = Date.now();

        const message = {
            id: messageId,
            userId,
            username: userInfo.username,
            avatar: userInfo.avatar,
            content,
            type: type || 'text', // text, image, video, audio, file, document
            files: files || [],
            replyTo: replyTo || null,
            reactions: new Map(),
            pinned: false,
            edited: false,
            editedAt: null,
            createdAt: timestamp,
            readBy: [userId]
        };

        if (!db.messages.has(currentRoom)) {
            db.messages.set(currentRoom, []);
        }
        db.messages.get(currentRoom).push(message);

        io.to(currentRoom).emit('message:new', {
            ...message,
            reactions: Object.fromEntries(message.reactions)
        });

        // Update last seen
        userInfo.lastSeen = timestamp;
    });

    // ─── TYPING INDICATOR ────────────────────────────────────────────────────
    socket.on('typing:start', () => {
        if (!currentRoom || !userInfo) return;

        if (!db.typingUsers.has(currentRoom)) {
            db.typingUsers.set(currentRoom, new Set());
        }
        db.typingUsers.get(currentRoom).add(userId);

        socket.to(currentRoom).emit('typing:user_typing', {
            userId,
            username: userInfo.username,
            typingUsers: Array.from(db.typingUsers.get(currentRoom))
                .map(id => db.users.get(id))
                .filter(Boolean)
        });
    });

    socket.on('typing:stop', () => {
        if (!currentRoom) return;
        if (db.typingUsers.has(currentRoom)) {
            db.typingUsers.get(currentRoom).delete(userId);
        }
        socket.to(currentRoom).emit('typing:user_stopped', {
            userId,
            typingUsers: Array.from(db.typingUsers.get(currentRoom) || [])
                .map(id => db.users.get(id))
                .filter(Boolean)
        });
    });

    // ─── MESSAGE REACTIONS ──────────────────────────────────────────────────
    socket.on('message:react', (data) => {
        const { messageId, emoji } = data;
        if (!currentRoom) return;

        const messages = db.messages.get(currentRoom) || [];
        const message = messages.find(m => m.id === messageId);

        if (message) {
            if (!message.reactions.has(emoji)) {
                message.reactions.set(emoji, []);
            }
            const reactionList = message.reactions.get(emoji);
            if (!reactionList.includes(userId)) {
                reactionList.push(userId);
            }

            io.to(currentRoom).emit('message:reaction_added', {
                messageId,
                emoji,
                users: reactionList,
                reactions: Object.fromEntries(message.reactions)
            });
        }
    });

    // ─── MESSAGE EDIT ───────────────────────────────────────────────────────
    socket.on('message:edit', (data) => {
        const { messageId, content } = data;
        if (!currentRoom) return;

        const messages = db.messages.get(currentRoom) || [];
        const message = messages.find(m => m.id === messageId);

        if (message && message.userId === userId) {
            message.content = content;
            message.edited = true;
            message.editedAt = Date.now();

            io.to(currentRoom).emit('message:edited', {
                messageId,
                content,
                editedAt: message.editedAt
            });
        }
    });

    // ─── MESSAGE DELETE ─────────────────────────────────────────────────────
    socket.on('message:delete', (data) => {
        const { messageId } = data;
        if (!currentRoom) return;

        const messages = db.messages.get(currentRoom) || [];
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex !== -1) {
            const message = messages[messageIndex];
            if (message.userId === userId) {
                messages.splice(messageIndex, 1);
                io.to(currentRoom).emit('message:deleted', { messageId });
            }
        }
    });

    // ─── VOICE CALL INITIATION ──────────────────────────────────────────────
    socket.on('call:initiate', (data) => {
        const { targetUserId, type } = data; // type: 'audio' or 'video'
        if (!currentRoom || !userInfo) return;

        const callId = uuidv4();
        const callSession = {
            id: callId,
            initiator: userId,
            initiatorInfo: userInfo,
            target: targetUserId,
            type,
            status: 'ringing',
            startedAt: Date.now(),
            roomId: currentRoom
        };

        db.callSessions.set(callId, callSession);

        // Send ring to target user
        const targetUser = db.users.get(targetUserId);
        if (targetUser) {
            socket.to(targetUser.socketId).emit('call:incoming', {
                callId,
                type,
                initiator: userInfo,
                initiatorId: userId
            });
        }
    });

    // ─── CALL RESPONSE ──────────────────────────────────────────────────────
    socket.on('call:respond', (data) => {
        const { callId, accept, sdpOffer } = data;
        const callSession = db.callSessions.get(callId);

        if (!callSession) return;

        if (accept) {
            callSession.status = 'connected';
            callSession.answerer = userId;
            callSession.answererInfo = userInfo;

            const initiatorSocket = Array.from(io.sockets.sockets.values())
                .find(s => s.data?.userId === callSession.initiator);

            if (initiatorSocket) {
                initiatorSocket.emit('call:accepted', {
                    callId,
                    answerer: userInfo,
                    answererId: userId,
                    sdpOffer
                });
            }

            io.to(callId).emit('call:connected', {
                callId,
                participants: [callSession.initiatorInfo, userInfo]
            });
        } else {
            callSession.status = 'rejected';
            const initiatorSocket = Array.from(io.sockets.sockets.values())
                .find(s => s.data?.userId === callSession.initiator);

            if (initiatorSocket) {
                initiatorSocket.emit('call:rejected', { callId });
            }
        }
    });

    // ─── WEBRTC SIGNAL RELAY ────────────────────────────────────────────────
    socket.on('webrtc:signal', (data) => {
        const { callId, signal, targetUserId } = data;
        const targetSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.data?.userId === targetUserId);

        if (targetSocket) {
            targetSocket.emit('webrtc:signal', {
                callId,
                signal,
                fromUserId: userId
            });
        }
    });

    // ─── END CALL ────────────────────────────────────────────────────────────
    socket.on('call:end', (data) => {
        const { callId } = data;
        const callSession = db.callSessions.get(callId);

        if (callSession) {
            callSession.status = 'ended';
            callSession.endedAt = Date.now();
            io.to(callId).emit('call:ended', { callId });
            db.callSessions.delete(callId);
        }
    });

    // ─── CREATE ROOM ─────────────────────────────────────────────────────────
    socket.on('room:create', (data) => {
        const { name, description, isPrivate, maxMembers } = data;
        const roomId = uuidv4();

        const room = {
            id: roomId,
            name: name || 'New Room',
            description: description || '',
            isPrivate: isPrivate || false,
            maxMembers: maxMembers || 1000,
            createdBy: userId,
            createdAt: Date.now(),
            members: new Map(),
            pinnedMessages: [],
            settings: {
                allowVoice: true,
                allowVideo: true,
                allowFileSharing: true
            }
        };

        db.rooms.set(roomId, room);

        io.emit('room:created', {
            room: {
                ...room,
                members: Array.from(room.members.values())
            }
        });
    });

    // ─── GET ALL ROOMS ──────────────────────────────────────────────────────
    socket.on('rooms:list', () => {
        const rooms = Array.from(db.rooms.values()).map(room => ({
            id: room.id,
            name: room.name,
            description: room.description,
            isPrivate: room.isPrivate,
            memberCount: room.members.size,
            createdAt: room.createdAt
        }));

        socket.emit('rooms:list_response', { rooms });
    });

    // ─── GET MESSAGE HISTORY ────────────────────────────────────────────────
    socket.on('messages:history', (data) => {
        const { roomId, limit = 50, offset = 0 } = data;
        const messages = db.messages.get(roomId) || [];
        const history = messages.slice(-limit - offset, -offset || undefined)
            .map(m => ({
                ...m,
                reactions: Object.fromEntries(m.reactions || new Map())
            }));

        socket.emit('messages:history_response', { messages: history });
    });

    // ─── STATUS UPDATE ──────────────────────────────────────────────────────
    socket.on('user:status_update', (data) => {
        const { status } = data;
        if (userInfo) {
            userInfo.status = status;
            if (currentRoom) {
                io.to(currentRoom).emit('user:status_changed', {
                    userId,
                    status,
                    username: userInfo.username
                });
            }
        }
    });

    // ─── USER DISCONNECT ────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        if (currentRoom && userInfo) {
            const room = db.rooms.get(currentRoom);
            if (room) {
                room.members.delete(userId);
                io.to(currentRoom).emit('user:left', {
                    userId,
                    username: userInfo.username,
                    memberCount: room.members.size,
                    members: Array.from(room.members.values())
                });
            }

            if (db.typingUsers.has(currentRoom)) {
                db.typingUsers.get(currentRoom).delete(userId);
            }
        }

        db.users.delete(userId);
        console.log(`[User Disconnected] ID: ${userId}`);
    });

    // Store user ID in socket data for lookups
    socket.data.userId = userId;
});

// ─── SERVER STARTUP ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════════════════════════╗
    ║          🚀 NEXUS CHAT SERVER RUNNING                      ║
    ║          Port: ${PORT}                                       ║
    ║          Environment: ${process.env.NODE_ENV || 'development'}                  ║
    ╚═══════════════════════════════════════════════════════════╝
    `);
});

module.exports = { app, server, io };
