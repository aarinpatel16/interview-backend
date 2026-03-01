// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const OpenAI = require("openai");

// ---------- App Setup ----------
const app = express();

// CORS (adjust origin if you want to lock it down)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight
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

// ---------- Routes ----------
app.get("/version", (req, res) => {
  res.json({ ok: true, version: "phase1-upload-v1" });
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

    // Safely extract text output
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

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});