// server.js — Interview Coach Backend v3.3

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawn } = require("child_process");

const ffmpegPath = require("ffmpeg-static");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3001;

// directories
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CLIPS_DIR = path.join(__dirname, "clips");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR);

// serve clips publicly
app.use("/clips", express.static(CLIPS_DIR));


// =======================
// VERSION / HEALTH CHECKS
// =======================

app.get("/version", (req, res) => {
  res.json({
    version: "v3.3-moments-clips",
    ffmpegInstalled: !!ffmpegPath,
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});


// =======================
// FILE UPLOAD
// =======================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || ".webm");
    const name = `video_${Date.now()}${ext}`;
    cb(null, name);
  },
});

const upload = multer({ storage });

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    res.json({ filename: req.file.filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});


// =======================
// TRANSCRIPTION
// =======================

app.post("/transcribe", async (req, res) => {
  try {
    const { filename } = req.body;

    const filePath = path.join(UPLOAD_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });

    res.json({ transcript: transcript.text });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Transcription failed" });
  }
});


// =======================
// AI QUESTION GENERATION
// =======================

async function generateQuestion(turns, interviewer_style, difficulty) {

  const messages = [
    {
      role: "system",
      content:
        "You are a college interviewer. Ask one realistic interview question at a time.",
    },
  ];

  for (const t of turns || []) {
    messages.push({
      role: "assistant",
      content: `Question: ${t.question}`,
    });

    messages.push({
      role: "user",
      content: `Answer: ${t.transcript}`,
    });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.7,
  });

  return response.choices[0].message.content;
}

app.post("/ask", async (req, res) => {

  try {
    const { interviewer_style, difficulty } = req.body;

    const question = await generateQuestion([], interviewer_style, difficulty);

    res.json({ question });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Question generation failed" });
  }
});

app.post("/next-question", async (req, res) => {

  try {

    const { turns, interviewer_style, difficulty } = req.body;

    const question = await generateQuestion(turns, interviewer_style, difficulty);

    res.json({ question });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Next question failed" });
  }
});


// =======================
// SCORING
// =======================

app.post("/score", async (req, res) => {

  try {

    const { transcript, question } = req.body;

    const prompt = `
Question: ${question}

Answer: ${transcript}

Score the answer from 1-10.

Return JSON:
{
overall_score,
strengths[],
improvements[]
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a college interview coach." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });

    const text = response.choices[0].message.content;

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { overall_score: 6 };
    }

    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scoring failed" });
  }
});


// =======================
// MOMENT DETECTION
// =======================

app.post("/moments", async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();
    const durationSeconds = Number(req.body?.durationSeconds || 60);

    if (!transcript) {
      return res.status(400).json({ error: "transcript required" });
    }

    // Clamp duration to a reasonable range
    const durSec = Number.isFinite(durationSeconds)
      ? Math.max(10, Math.min(600, durationSeconds))
      : 60;

    const maxMs = Math.round(durSec * 1000);

    const prompt = `
You are an interview coach.

TASK:
Identify 2 to 4 short "moments" within the answer: some "excelled" and some "needs_improvement".

Rules:
- Always return at least 2 moments.
- startMs/endMs must be between 0 and ${maxMs}.
- Each moment length must be between 5000ms and 20000ms.
- If you are unsure, make a reasonable guess.
- Return ONLY valid JSON. No markdown. No commentary.

Transcript:
${transcript}

Return JSON exactly in this shape:
{
  "moments": [
    {
      "type": "excelled",
      "title": "Short title",
      "startMs": 5000,
      "endMs": 15000,
      "reason": "Why it was good",
      "howToImprove": null
    },
    {
      "type": "needs_improvement",
      "title": "Short title",
      "startMs": 20000,
      "endMs": 30000,
      "reason": "What went wrong",
      "howToImprove": "Concrete improvement tip"
    }
  ]
}
`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return ONLY valid JSON." },
        { role: "user", content: prompt },
      ],
    });

    const text = response.choices?.[0]?.message?.content || "";

    // Try direct JSON parse, else extract the last {...} block
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}\s*$/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }

    if (!parsed || !Array.isArray(parsed.moments)) {
      parsed = { moments: [] };
    }

    // If model returned empty, add safe fallback moments
    if (parsed.moments.length === 0) {
      parsed.moments = [
        {
          type: "needs_improvement",
          title: "More specificity",
          startMs: Math.min(5000, maxMs - 5000),
          endMs: Math.min(15000, maxMs),
          reason: "Answer stays general and lacks concrete outcomes.",
          howToImprove: "Add one specific example with measurable impact (numbers, result, what you did).",
        },
        {
          type: "excelled",
          title: "Positive intent",
          startMs: Math.min(20000, maxMs - 5000),
          endMs: Math.min(30000, maxMs),
          reason: "You communicated motivation and effort clearly.",
          howToImprove: null,
        },
      ];
    }

    // Clamp/validate timestamps so they’re always valid
    parsed.moments = parsed.moments
      .map((m) => {
        const startMs = Math.max(0, Math.min(maxMs, Number(m.startMs || 0)));
        let endMs = Math.max(0, Math.min(maxMs, Number(m.endMs || 0)));

        // Ensure at least 5s window
        if (endMs - startMs < 5000) {
          endMs = Math.min(maxMs, startMs + 5000);
        }

        return {
          type: m.type === "excelled" ? "excelled" : "needs_improvement",
          title: String(m.title || "").slice(0, 80) || "Moment",
          startMs,
          endMs,
          reason: String(m.reason || "").slice(0, 200) || "Reason not provided.",
          howToImprove:
            m.type === "excelled" ? null : String(m.howToImprove || "").slice(0, 220) || "Try to be more specific and structured.",
        };
      })
      .slice(0, 4);

    res.json(parsed);
  } catch (err) {
    console.error("/moments error:", err);
    res.status(500).json({ error: "Moment detection failed" });
  }
});


// =======================
// CLIP CREATION
// =======================

app.post("/clip", async (req, res) => {

  try {

    const { filename, startMs, endMs } = req.body;

    const inputPath = path.join(UPLOAD_DIR, filename);

    const clipName = `clip_${Date.now()}.mp4`;

    const outputPath = path.join(CLIPS_DIR, clipName);

    const startSeconds = startMs / 1000;
    const duration = (endMs - startMs) / 1000;

    const args = [
      "-ss",
      startSeconds,
      "-i",
      inputPath,
      "-t",
      duration,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-c:a",
      "aac",
      outputPath,
    ];

    const process = spawn(ffmpegPath, args);

    process.on("close", () => {

      const clipUrl =
        process.env.PUBLIC_BASE_URL +
        "/clips/" +
        clipName;

      res.json({ clipUrl });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Clip failed" });
  }
});


// =======================
// DELETE RAW VIDEO
// =======================

app.post("/delete-upload", (req, res) => {

  try {

    const { filename } = req.body;

    const filePath = path.join(UPLOAD_DIR, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ deleted: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  }
});


// =======================
// START SERVER
// =======================

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});