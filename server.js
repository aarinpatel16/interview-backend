import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.post("/ask", async (req, res) => {
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: req.body.message
    });

    res.json({ reply: response.output_text });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(3001, () => {
  console.log("Server running at http://localhost:3001");
});