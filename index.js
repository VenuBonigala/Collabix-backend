const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Room = require('./models/Room');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip'); 
require('dotenv').config();

const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://collabix-frontend.onrender.com"],
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// --- STATE MAPS ---
const userSocketMap = {}; // { socketId: username }
const roomHostMap = {};   // { roomId: socketId } (Tracks who is the host)

const DB_URL = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/collabix";

mongoose.connect(DB_URL)
  .then(() => console.log("MongoDB Connected Successfully"))
  .catch((err) => console.error("DB Connection Failed", err));

app.use('/api/auth', authRoutes);

// --- DOWNLOAD ZIP ROUTE ---
app.get('/api/download/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;
        const room = await Room.findOne({ roomId });

        if (!room) return res.status(404).send("Room not found");

        const zip = new AdmZip();

        room.files.forEach(file => {
            if (file.type === 'file') {
                zip.addFile(file.name, Buffer.from(file.content, "utf8"));
            }
        });

        const downloadName = `Collabix-${roomId}.zip`;
        const data = zip.toBuffer();

        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename=${downloadName}`);
        res.set('Content-Length', data.length);
        res.send(data);

    } catch (error) {
        console.error(error);
        res.status(500).send("Error generating zip");
    }
});

// REMOVED: const defaultFiles = [...] 

io.on('connection', (socket) => {
  
  socket.on('join-room', async ({ roomId, username }) => {
    userSocketMap[socket.id] = username;
    socket.join(roomId);
    
    // 1. HOST ASSIGNMENT LOGIC
    // If room has no host, this user becomes the host
    if (!roomHostMap[roomId]) {
        roomHostMap[roomId] = socket.id;
    }
    const hostId = roomHostMap[roomId];

    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    
    const clientsList = clients.map((clientId) => ({
        socketId: clientId,
        username: userSocketMap[clientId],
    }));
    
    // Notify others
    clients.forEach((clientId) => {
        io.to(clientId).emit('user-joined', { socketId: socket.id, username });
    });

    let room = await Room.findOne({ roomId });
    if (!room) {
        // UPDATED: Initialize with empty array for empty room
        room = await Room.create({ roomId, files: [] }); 
    }

    const filesPayload = {};
    room.files.forEach(file => filesPayload[file.name] = file);

    // Send Join Data + Host Info
    socket.emit('joined', {
        clients: clientsList, 
        username,
        roomId,
        files: filesPayload,
        hostId // Tell the user who the host is
    });

    // Broadcast updated host ID to everyone (just in case)
    io.to(roomId).emit('update-host', { hostId });
  });

  // --- KICK USER (HOST ONLY) ---
  socket.on('kick-user', ({ roomId, targetSocketId }) => {
      // Security: Check if requester is the host
      if (roomHostMap[roomId] === socket.id) {
          // Tell the target they are kicked
          io.to(targetSocketId).emit('kicked');
          // Force disconnect socket logic on server side
          io.sockets.sockets.get(targetSocketId)?.leave(roomId);
          
          // Notify others
          const username = userSocketMap[targetSocketId] || "User";
          socket.in(roomId).emit('user-disconnected', { 
              socketId: targetSocketId, 
              username: username 
          });
      }
  });

  socket.on('code-change', async ({ roomId, fileName, code, originId }) => {
    socket.in(roomId).emit('code-change', { fileName, code, originId });
    await Room.updateOne(
        { roomId, "files.name": fileName },
        { $set: { "files.$.content": code } }
    );
  });

  socket.on('line-change', ({ roomId, lineNumber, fileName, username }) => {
      socket.in(roomId).emit('line-change', { socketId: socket.id, lineNumber, fileName, username });
  });

  socket.on('run-code', ({ language, code }) => {
      if (!code) {
          socket.emit('code-output', { output: "Error: No code to run." });
          return;
      }
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

      let fileName = `temp_${socket.id}`;
      let command = '';

      if (language === 'python') {
          fileName += '.py';
          command = `python "${path.join(tempDir, fileName)}"`;
      } else if (language === 'javascript') {
          fileName += '.js';
          command = `node "${path.join(tempDir, fileName)}"`;
      } else if (language === 'java') {
          fileName = 'Main.java'; 
          const filePath = path.join(tempDir, fileName);
          try { fs.unlinkSync(path.join(tempDir, 'Main.class')); } catch(e){}
          command = `javac "${filePath}" && java -cp "${tempDir}" Main`;
      } else {
          socket.emit('code-output', { output: "Language not supported." });
          return;
      }

      const filePath = path.join(tempDir, fileName);

      fs.writeFile(filePath, code, (err) => {
          if (err) {
              socket.emit('code-output', { output: "Error writing temp file." });
              return;
          }
          exec(command, (error, stdout, stderr) => {
              if (error) {
                  socket.emit('code-output', { output: stderr || error.message, isError: true });
              } else {
                  socket.emit('code-output', { output: stdout, isError: false });
              }
          });
      });
  });

  socket.on('file-created', async ({ roomId, fileName, type }) => {
      const ext = fileName.split('.').pop();
      const language = ext === 'js' ? 'javascript' : ext === 'css' ? 'css' : ext === 'py' ? 'python' : ext === 'java' ? 'java' : 'html';
      const newFile = { name: fileName, type, language: type === 'folder' ? null : language, content: '' };
      await Room.updateOne({ roomId }, { $push: { files: newFile } });
      io.to(roomId).emit('file-created', newFile);
  });

  socket.on('file-deleted', async ({ roomId, fileName }) => {
      await Room.updateOne({ roomId }, { $pull: { files: { name: fileName } } });
      io.to(roomId).emit('file-deleted', fileName);
  });

  socket.on('send-message', ({ roomId, message, username }) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    io.to(roomId).emit('receive-message', { message, username, time });
  });

  socket.on("sending-signal", payload => {
    io.to(payload.userToSignal).emit('user-joined-call', { signal: payload.signal, callerID: payload.callerID, username: payload.username });
  });

  socket.on("returning-signal", payload => {
    io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
  });

  socket.on('disconnecting', () => {
    const rooms = [...socket.rooms];
    rooms.forEach((roomId) => {
      socket.in(roomId).emit('user-disconnected', { 
          socketId: socket.id, 
          username: userSocketMap[socket.id] || "User"
      });
    });
  });

  socket.on('disconnect', () => {
      // 2. HOST TRANSFER LOGIC
      // Iterate through all rooms this socket was in (though usually just 1)
      // Since socket.rooms is empty after disconnect, we must iterate the roomHostMap
      for (const roomId in roomHostMap) {
          if (roomHostMap[roomId] === socket.id) {
              // The Host Left! Assign new host.
              const remainingClients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
              if (remainingClients.length > 0) {
                  const newHostId = remainingClients[0]; // The next person becomes host
                  roomHostMap[roomId] = newHostId;
                  io.to(roomId).emit('update-host', { hostId: newHostId });
              } else {
                  // Room is empty
                  delete roomHostMap[roomId];
              }
          }
      }

      delete userSocketMap[socket.id];
      socket.leave();
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
