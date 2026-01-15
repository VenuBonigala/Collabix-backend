const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Room = require('./models/Room');
const AdmZip = require('adm-zip');
const axios = require('axios');
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

const userSocketMap = {};
const roomHostMap = {};

const DB_URL = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/collabix";

mongoose.connect(DB_URL)
  .then(() => console.log("MongoDB Connected Successfully"))
  .catch((err) => console.error("DB Connection Failed", err));

app.use('/api/auth', authRoutes);

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

io.on('connection', (socket) => {
  
  socket.on('join-room', async ({ roomId, username }) => {
    userSocketMap[socket.id] = username;
    socket.join(roomId);
    
    if (!roomHostMap[roomId]) {
        roomHostMap[roomId] = socket.id;
    }
    const hostId = roomHostMap[roomId];

    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    
    const clientsList = clients.map((clientId) => ({
        socketId: clientId,
        username: userSocketMap[clientId],
    }));
    
    clients.forEach((clientId) => {
        io.to(clientId).emit('user-joined', { socketId: socket.id, username });
    });

    let room = await Room.findOne({ roomId });
    if (!room) {
        room = await Room.create({ roomId, files: [] }); 
    }

    const filesPayload = {};
    room.files.forEach(file => filesPayload[file.name] = file);

    socket.emit('joined', {
        clients: clientsList, 
        username,
        roomId,
        files: filesPayload,
        hostId 
    });

    io.to(roomId).emit('update-host', { hostId });
  });

  socket.on('kick-user', ({ roomId, targetSocketId }) => {
      if (roomHostMap[roomId] === socket.id) {
          io.to(targetSocketId).emit('kicked');
          io.sockets.sockets.get(targetSocketId)?.leave(roomId);
          
          const username = userSocketMap[targetSocketId] || "User";
          socket.in(roomId).emit('user-disconnected', { 
              socketId: targetSocketId, 
              username: username 
          });
      }
  });

  // --- UPDATED SAVE LOGIC ---
  socket.on('code-change', async ({ roomId, fileName, code, originId }) => {
    socket.in(roomId).emit('code-change', { fileName, code, originId });
    try {
        const result = await Room.updateOne(
            { roomId, "files.name": fileName },
            { $set: { "files.$.content": code } }
        );
        if (result.modifiedCount === 0) {
            console.warn(`[Warning] Code saved but DB not updated for room: ${roomId}, file: ${fileName}`);
        }
    } catch (err) {
        console.error("[Error] Failed to save code to DB:", err);
    }
  });

  socket.on('line-change', ({ roomId, lineNumber, fileName, username }) => {
      socket.in(roomId).emit('line-change', { socketId: socket.id, lineNumber, fileName, username });
  });

  socket.on('run-code', async ({ language, code }) => {
      if (!code) {
          socket.emit('code-output', { output: "Error: No code to run." });
          return;
      }

      const runtimeMap = {
          'javascript': { language: 'javascript', version: '18.15.0' },
          'python': { language: 'python', version: '3.10.0' },
          'java': { language: 'java', version: '15.0.2' },
      };

      const runtime = runtimeMap[language];

      if (!runtime) {
          socket.emit('code-output', { output: "Language not supported." });
          return;
      }

      try {
          const response = await axios.post('https://emkc.org/api/v2/piston/execute', {
              language: runtime.language,
              version: runtime.version,
              files: [
                  {
                      name: language === 'java' ? 'Main.java' : undefined, 
                      content: code
                  }
              ]
          });

          const { run } = response.data;
          
          socket.emit('code-output', { 
              output: run.output, 
              isError: run.stderr.length > 0 
          });

      } catch (error) {
          console.error("Execution Error:", error.message);
          socket.emit('code-output', { 
              output: "Failed to execute code via external API.", 
              isError: true 
          });
      }
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
      for (const roomId in roomHostMap) {
          if (roomHostMap[roomId] === socket.id) {
              const remainingClients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
              if (remainingClients.length > 0) {
                  const newHostId = remainingClients[0]; 
                  roomHostMap[roomId] = newHostId;
                  io.to(roomId).emit('update-host', { hostId: newHostId });
              } else {
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
