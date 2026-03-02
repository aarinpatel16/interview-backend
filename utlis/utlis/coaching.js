// utils/coaching.js
function normalize(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function countWords(text = "") {
  const t = normalize(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function countOccurrences(text, phrase) {
  // phrase can contain spaces; count overlapping minimally by scanning
  const hay = normalize(text).toLowerCase();
  const needle = phrase.toLowerCase();
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    idx = hay.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function sentenceStats(text = "") {
  const t = normalize(text);
  if (!t) return { sentences: 0, avg_sentence_words: 0, long_sentence_ratio: 0 };

  const parts = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const sentenceWordCounts = parts.map((s) => countWords(s));
  const sentences = sentenceWordCounts.length || 0;
  const total = sentenceWordCounts.reduce((a, b) => a + b, 0);
  const avg = sentences ? total / sentences : 0;

  // “Long” = 25+ words (readability penalty)
  const longCount = sentenceWordCounts.filter((n) => n >= 25).length;
  const longRatio = sentences ? longCount / sentences : 0;

  return { sentences, avg_sentence_words: avg, long_sentence_ratio: longRatio };
}

function detectBehavioral(question = "") {
  const q = (question || "").toLowerCase();
  const cues = [
    "tell me about a time",
    "describe a time",
    "give an example",
    "when was a time",
    "challenge",
    "conflict",
    "lead",
    "failure",
    "overcame",
    "mistake",
    "team",
    "problem you solved",
  ];
  return cues.some((c) => q.includes(c));
}

function starCoverage(text = "") {
  const t = normalize(text).toLowerCase();

  // Heuristic cues for each STAR piece (simple + robust enough for v1)
  const S = /when|at the time|in (my|our)|during|i was (in|at)|we were/.test(t);
  const T = /my goal|i needed to|we needed to|task was|responsible for|objective/.test(t);
  const A = /i did|i decided|i worked|i led|i created|i implemented|i organized|i built|i learned|i asked/.test(t);
  const R = /result|as a result|we achieved|i achieved|impact|improved|increased|decreased|learned that|led to/.test(t);

  const score = Math.round(((+S + +T + +A + +R) / 4) * 100);
  return { coverage: { S, T, A, R }, score };
}

function admissionsReadinessScore({ wpm, fillerPerMin, hedgeCount, starScore, longSentenceRatio }) {
  // Start at 100 and subtract penalties (then clamp)
  let score = 100;

  // WPM target: 130–170 ideal
  if (wpm < 110) score -= 12;
  else if (wpm < 130) score -= 6;
  else if (wpm <= 170) score -= 0;
  else if (wpm <= 190) score -= 6;
  else score -= 12;

  // Filler density penalty
  if (fillerPerMin > 10) score -= 18;
  else if (fillerPerMin > 7) score -= 12;
  else if (fillerPerMin > 4) score -= 6;

  // Hedging penalty
  if (hedgeCount >= 6) score -= 10;
  else if (hedgeCount >= 3) score -= 6;
  else if (hedgeCount >= 1) score -= 2;

  // STAR bonus/penalty (mostly impacts behavioral answers)
  if (typeof starScore === "number") {
    if (starScore >= 75) score += 4;
    else if (starScore >= 50) score += 0;
    else score -= 6;
  }

  // Clarity penalty: too many long sentences
  if (longSentenceRatio > 0.25) score -= 8;
  else if (longSentenceRatio > 0.15) score -= 4;

  score = Math.max(0, Math.min(100, Math.round(score)));
  return score;
}

function buildFeedback({ wpm, filler, hedging, star, isBehavioral }) {
  const bullets = [];

  // WPM
  if (wpm < 110) bullets.push(`Speaking pace was slow (${wpm} WPM). Aim for ~130–170 WPM.`);
  else if (wpm > 190) bullets.push(`Speaking pace was rushed (${wpm} WPM). Slow down slightly for clarity.`);
  else bullets.push(`Good speaking pace (${wpm} WPM).`);

  // Filler
  if (filler.per_min > 7) bullets.push(`Filler words were noticeable (${filler.count}; ~${filler.per_min}/min). Try pausing instead.`);
  else if (filler.per_min > 4) bullets.push(`Some filler words (${filler.count}; ~${filler.per_min}/min). Reduce a bit for polish.`);
  else bullets.push(`Low filler usage (${filler.count}; ~${filler.per_min}/min).`);

  // Hedging
  if (hedging.count >= 3) bullets.push(`Hedging language appeared (${hedging.count}). Use more direct phrasing for confidence.`);
  else if (hedging.count >= 1) bullets.push(`Minor hedging (${hedging.count}). Consider slightly firmer phrasing.`);

  // STAR
  if (isBehavioral) {
    if (star.score >= 75) bullets.push(`Strong STAR structure (score ${star.score}).`);
    else if (star.score >= 50) bullets.push(`Decent STAR structure (score ${star.score}). Add a clearer Task or Result.`);
    else bullets.push(`STAR structure missing key pieces (score ${star.score}). Include Situation → Task → Action → Result.`);
  }

  return bullets.slice(0, 4);
}

function analyzeTranscript({ transcript, question, durationSeconds }) {
  const text = normalize(transcript || "");
  const words = countWords(text);
  const minutes = Math.max(0.1, (durationSeconds || 0) / 60); // avoid divide by 0
  const wpm = Math.round(words / minutes);

  const fillerPhrases = ["um", "uh", "like", "you know", "basically", "literally", "kind of", "sort of"];
  const fillerCounts = fillerPhrases
    .map((p) => [p, countOccurrences(text, p)])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);

  const fillerCount = fillerCounts.reduce((acc, [, c]) => acc + c, 0);
  const fillerPerMin = Math.round((fillerCount / minutes) * 10) / 10;

  const hedgePhrases = ["i think", "maybe", "i guess", "probably", "kind of", "sort of", "i feel like", "in my opinion"];
  const hedgeHits = hedgePhrases.filter((p) => countOccurrences(text, p) > 0);
  const hedgeCount = hedgeHits.length;

  const stats = sentenceStats(text);

  const isBehavioral = detectBehavioral(question);
  const star = isBehavioral ? starCoverage(text) : { coverage: { S: false, T: false, A: false, R: false }, score: null };

  const admissions_readiness = admissionsReadinessScore({
    wpm,
    fillerPerMin,
    hedgeCount,
    starScore: star.score,
    longSentenceRatio: stats.long_sentence_ratio,
  });

  const coaching = {
    words,
    duration_seconds: durationSeconds || 0,
    wpm,
    filler: {
      count: fillerCount,
      per_min: fillerPerMin,
      top: fillerCounts.slice(0, 3),
    },
    hedging: {
      count: hedgeCount,
      examples: hedgeHits.slice(0, 3),
    },
    star: {
      is_behavioral: isBehavioral,
      coverage: star.coverage,
      score: star.score,
    },
    clarity: {
      avg_sentence_words: Math.round(stats.avg_sentence_words * 10) / 10,
      long_sentence_ratio: Math.round(stats.long_sentence_ratio * 100) / 100,
    },
    admissions_readiness,
  };

  coaching.feedback_bullets = buildFeedback({
    wpm,
    filler: coaching.filler,
    hedging: coaching.hedging,
    star: coaching.star,
    isBehavioral,
  });

  return coaching;
}

function aggregateCoaching(turns = []) {
  const valid = turns.filter((t) => t?.coaching);
  if (!valid.length) return null;

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

  const avgWpm = Math.round(avg(valid.map((t) => t.coaching.wpm)));
  const avgFillerPerMin = Math.round(avg(valid.map((t) => t.coaching.filler.per_min)) * 10) / 10;
  const avgReadiness = Math.round(avg(valid.map((t) => t.coaching.admissions_readiness)));

  const behavioral = valid.filter((t) => t.coaching.star.is_behavioral);
  const avgStar = behavioral.length
    ? Math.round(avg(behavioral.map((t) => t.coaching.star.score || 0)))
    : null;

  // Top filler overall
  const fillerMap = new Map();
  for (const t of valid) {
    for (const [phrase, c] of t.coaching.filler.top || []) {
      fillerMap.set(phrase, (fillerMap.get(phrase) || 0) + c);
    }
  }
  const topFillers = Array.from(fillerMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Priorities
  const priorities = [];
  if (avgFillerPerMin > 7) priorities.push("Reduce filler words (replace with pauses).");
  if (avgWpm > 190) priorities.push("Slow pace slightly for clarity.");
  if (avgWpm < 110) priorities.push("Increase pace slightly for energy.");
  if (avgStar !== null && avgStar < 60) priorities.push("Use STAR more consistently for behavioral questions.");
  if (!priorities.length) priorities.push("Maintain strong delivery; focus on adding sharper outcomes/results.");

  return {
    avg_wpm: avgWpm,
    avg_filler_per_min: avgFillerPerMin,
    avg_star_score_behavioral: avgStar,
    admissions_readiness: avgReadiness,
    top_fillers: topFillers         ,
    priorities: priorities.slice(0, 3),
  };
}

module.exports = { analyzeTranscript, aggregateCoaching };