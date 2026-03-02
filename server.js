// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

require("dotenv").config();

const OpenAI = require("openai");

// ---------- App Setup ----------
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight (Express 5-safe)
app.options(/.*/, cors());

// JSON body parsing for non-multipart routes
app.use(express.json({ limit: "2mb" }));

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Uploads (Multer) ----------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// ---------- Helpers ----------
function safeUploadPath(filename) {
  // Disallow path traversal and weird inputs
  if (!filename || typeof filename !== "string") return null;
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
  return path.join(uploadDir, filename);
}

// ---------- Routes ----------
app.get("/version", (req, res) => {
  res.json({ ok: true, version: "phase2-transcribe-v1" });
});

app.post("/ask", async (req, res) => {
  try {
    const userMessage = req.body?.message || req.body?.input || req.body?.userMessage;

    if (!userMessage) {
      return res.status(400).json({ error: "Missing message in request body" });
    }

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: userMessage,
    });

    const reply =
      response.output_text ||
      (response.output?.[0]?.content?.[0]?.text ?? "No response text returned.");

    res.json({ reply });
  } catch (err) {
    console.error("Error in /ask:", err);
    res.status(500).json({ error: "Server error in /ask" });
  }
});

// Upload endpoint: expects multipart/form-data with field name "video"
app.post("/upload", upload.single("video"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    res.json({
      ok: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    console.error("Error in /upload:", err);
    res.status(500).json({ ok: false, error: "Server error in /upload" });
  }
});

/**
 * Transcribe endpoint:
 * Body: { filename: "12345-interview.webm" }
 * Returns: { ok: true, text: "..." }
 */
app.post("/transcribe", async (req, res) => {
  try {
    const filename = req.body?.filename;
    const filePath = safeUploadPath(filename);

    if (!filePath) {
      return res.status(400).json({ ok: false, error: "Invalid filename" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "File not found" });
    }

    // Whisper can transcribe webm directly (no ffmpeg needed)
    const transcript = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(filePath),
      // Optional:
      // response_format: "json",
      // language: "en",
    });

    // The SDK returns an object with .text
    res.json({ ok: true, text: transcript.text, filename });
  } catch (err) {
    console.error("Error in /transcribe:", err);
    res.status(500).json({ ok: false, error: "Server error in /transcribe" });
  }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});