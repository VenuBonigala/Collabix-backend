const mongoose = require("mongoose");

const roomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    name: { type: String, default: "Untitled Room" }, // <--- ADD THIS
    files: [
        {
            name: { type: String, required: true },
            type: { type: String, required: true }, // 'file' or 'folder'
            language: { type: String }, // 'javascript', 'python', etc.
            content: { type: String, default: "" }
        }
    ]
});

module.exports = mongoose.model("Room", roomSchema);