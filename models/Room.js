
const mongoose = require('mongoose');
const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true
    },
    files: [
        {
            name: { type: String, required: true },
            type: { type: String, required: true }, // 'file' or 'folder'
            content: { type: String, default: "" }, // <--- THIS WAS LIKELY MISSING
            language: { type: String, default: "javascript" }
        }
    ]
}, { timestamps: true });
const Room = mongoose.model('Room', roomSchema);
module.exports = Room;
