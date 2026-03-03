// utils/coaching.js (v2)

function normalize(text = "") {
  return String(text)
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
  const hay = normalize(text).toLowerCase();
  const needle = String(phrase || "").toLowerCase();
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

  // long sentence = 25+ words
  const longCount = sentenceWordCounts.filter((n) => n >= 25).length;
  const longRatio = sentences ? longCount / sentences : 0;

  return { sentences, avg_sentence_words: avg, long_sentence_ratio: longRatio };
}

function detectBehavioral(question = "") {
  const q = String(question || "").toLowerCase();
  const cues = [
    "tell me about a time",
    "describe a time",
    "give an example",
    "when was a time",
    "challenge",
    "conflict",
    "lead",
    "leadership",
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

  const S = /when|at the time|during|in (my|our)|we were|i was (in|at)/.test(t);
  const T = /my goal|i needed to|we needed to|task was|responsible for|objective/.test(t);
  const A = /i did|i decided|i worked|i led|i created|i implemented|i organized|i built|i learned|i asked/.test(t);
  const R = /result|as a result|we achieved|i achieved|impact|improved|increased|decreased|led to|learned that/.test(t);

  const score = Math.round(((+S + +T + +A + +R) / 4) * 100);

  const missing = [];
  if (!S) missing.push("Situation");
  if (!T) missing.push("Task");
  if (!A) missing.push("Action");
  if (!R) missing.push("Result");

  return { coverage: { S, T, A, R }, score, missing };
}

function quantifySignals(text = "") {
  const t = normalize(text);

  // numbers like 10, 10%, 3.5, $200, 2x
  const numberMatches = t.match(/\b(\$?\d+(\.\d+)?%?|\d+x)\b/g) || [];
  const numberCount = numberMatches.length;

  const metricWords = [
    "percent",
    "%",
    "increase",
    "decrease",
    "improved",
    "reduced",
    "grew",
    "growth",
    "impact",
    "results",
    "metric",
    "kpi",
    "conversion",
    "retention",
    "revenue",
    "users",
    "views",
    "hours",
    "minutes",
    "days",
    "weeks",
    "months",
  ];
  const metricWordHits = metricWords.filter((w) => countOccurrences(t, w) > 0);

  // a simple “impact” score
  const score = Math.min(100, numberCount * 18 + metricWordHits.length * 8);

  return {
    number_count: numberCount,
    metric_word_hits: metricWordHits.slice(0, 6),
    score,
  };
}

function confidenceScore({ fillerPerMin, hedgeCount }) {
  // 0–100 (higher = more confident delivery language)
  let score = 100;

  if (fillerPerMin > 10) score -= 22;
  else if (fillerPerMin > 7) score -= 14;
  else if (fillerPerMin > 4) score -= 8;

  if (hedgeCount >= 6) score -= 16;
  else if (hedgeCount >= 3) score -= 10;
  else if (hedgeCount >= 1) score -= 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function admissionsReadinessScore({ wpm, fillerPerMin, hedgeCount, starScore, longSentenceRatio, impactScore }) {
  let score = 100;

  // WPM target: 130–170 ideal
  if (wpm < 110) score -= 12;
  else if (wpm < 130) score -= 6;
  else if (wpm <= 170) score -= 0;
  else if (wpm <= 190) score -= 6;
  else score -= 12;

  // filler density
  if (fillerPerMin > 10) score -= 18;
  else if (fillerPerMin > 7) score -= 12;
  else if (fillerPerMin > 4) score -= 6;

  // hedging
  if (hedgeCount >= 6) score -= 10;
  else if (hedgeCount >= 3) score -= 6;
  else if (hedgeCount >= 1) score -= 2;

  // STAR (behavioral only)
  if (typeof starScore === "number") {
    if (starScore >= 75) score += 4;
    else if (starScore >= 50) score += 0;
    else score -= 6;
  }

  // clarity
  if (longSentenceRatio > 0.25) score -= 8;
  else if (longSentenceRatio > 0.15) score -= 4;

  // impact (numbers / metrics)
  if (typeof impactScore === "number") {
    if (impactScore >= 40) score += 4;
    else if (impactScore >= 20) score += 2;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildFeedback({ wpm, filler, hedging, star, isBehavioral, impact, confidence }) {
  const bullets = [];

  // pace
  if (wpm < 110) bullets.push(`Pace was slow (${wpm} WPM). Aim for ~130–170 WPM.`);
  else if (wpm > 190) bullets.push(`Pace was rushed (${wpm} WPM). Slow slightly for clarity.`);
  else bullets.push(`Good pace (${wpm} WPM).`);

  // filler
  if (filler.per_min > 7) bullets.push(`Filler words were noticeable (~${filler.per_min}/min). Replace with pauses.`);
  else if (filler.per_min > 4) bullets.push(`Some filler (~${filler.per_min}/min). Try trimming a bit.`);
  else bullets.push(`Low filler usage (~${filler.per_min}/min).`);

  // confidence
  if (confidence < 70) bullets.push(`Confidence language could be stronger. Reduce hedging and filler.`);
  else bullets.push(`Confident delivery (confidence ${confidence}/100).`);

  // impact
  if (impact.score < 20) bullets.push(`Add measurable impact (numbers, outcomes, results).`);
  else bullets.push(`Nice use of impact signals (impact ${impact.score}/100).`);

  // STAR
  if (isBehavioral) {
    if (star.score >= 75) bullets.push(`Strong STAR structure (score ${star.score}).`);
    else if (star.score >= 50) bullets.push(`Decent STAR (score ${star.score}). Add: ${star.missing?.[0] || "Task/Result"}.`);
    else bullets.push(`STAR is missing key parts (score ${star.score}). Include Situation → Task → Action → Result.`);
  }

  // hedging detail
  if (hedging.count >= 3) bullets.push(`Hedging appeared (${hedging.count}). Use more direct phrasing.`);

  return bullets.slice(0, 5);
}

function analyzeTranscript({ transcript, question, durationSeconds }) {
  const text = normalize(transcript || "");
  const words = countWords(text);

  const minutes = Math.max(0.1, Number(durationSeconds || 0) / 60); // avoid divide by 0
  const wpm = Math.round(words / minutes);

  const fillerPhrases = ["um", "uh", "like", "you know", "basically", "literally", "kind of", "sort of"];
  const fillerCounts = fillerPhrases
    .map((p) => [p, countOccurrences(text, p)])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);

  const fillerCount = fillerCounts.reduce((acc, [, c]) => acc + c, 0);
  const fillerPerMin = Math.round((fillerCount / minutes) * 10) / 10;
  const fillerPct = words ? Math.round((fillerCount / words) * 1000) / 10 : 0; // % of words

  const hedgePhrases = ["i think", "maybe", "i guess", "probably", "kind of", "sort of", "i feel like", "in my opinion"];
  const hedgeHits = hedgePhrases.filter((p) => countOccurrences(text, p) > 0);
  const hedgeCount = hedgeHits.length;

  const stats = sentenceStats(text);

  const isBehavioral = detectBehavioral(question);
  const star = isBehavioral
    ? starCoverage(text)
    : { coverage: { S: false, T: false, A: false, R: false }, score: null, missing: [] };

  const impact = quantifySignals(text);

  const confidence = confidenceScore({ fillerPerMin, hedgeCount });

  const admissions_readiness = admissionsReadinessScore({
    wpm,
    fillerPerMin,
    hedgeCount,
    starScore: star.score,
    longSentenceRatio: stats.long_sentence_ratio,
    impactScore: impact.score,
  });

  const coaching = {
    words,
    duration_seconds: Number(durationSeconds || 0),
    wpm,
    pacing_band: wpm < 110 ? "slow" : wpm > 190 ? "fast" : "ideal",

    filler: {
      count: fillerCount,
      per_min: fillerPerMin,
      pct_words: fillerPct,
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
      missing: star.missing || [],
    },

    impact,

    clarity: {
      avg_sentence_words: Math.round(stats.avg_sentence_words * 10) / 10,
      long_sentence_ratio: Math.round(stats.long_sentence_ratio * 100) / 100,
    },

    confidence,
    admissions_readiness,
  };

  coaching.feedback_bullets = buildFeedback({
    wpm,
    filler: coaching.filler,
    hedging: coaching.hedging,
    star: coaching.star,
    isBehavioral,
    impact,
    confidence,
  });

  return coaching;
}

function aggregateCoaching(turns = []) {
  const valid = turns.filter((t) => t?.coaching);
  if (!valid.length) return null;

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

  const avgWpm = Math.round(avg(valid.map((t) => t.coaching.wpm)));
  const avgFillerPerMin = Math.round(avg(valid.map((t) => t.coaching.filler.per_min)) * 10) / 10;
  const avgFillerPct = Math.round(avg(valid.map((t) => t.coaching.filler.pct_words)) * 10) / 10;
  const avgReadiness = Math.round(avg(valid.map((t) => t.coaching.admissions_readiness)));
  const avgConfidence = Math.round(avg(valid.map((t) => t.coaching.confidence)));
  const avgImpact = Math.round(avg(valid.map((t) => t.coaching.impact.score)));

  const behavioral = valid.filter((t) => t.coaching.star.is_behavioral);
  const avgStar = behavioral.length ? Math.round(avg(behavioral.map((t) => t.coaching.star.score || 0))) : null;

  // Top fillers overall
  const fillerMap = new Map();
  for (const t of valid) {
    for (const [phrase, c] of t.coaching.filler.top || []) {
      fillerMap.set(phrase, (fillerMap.get(phrase) || 0) + c);
    }
  }
  const topFillers = Array.from(fillerMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const priorities = [];
  if (avgFillerPerMin > 7) priorities.push("Reduce filler words (replace with pauses).");
  if (avgWpm > 190) priorities.push("Slow pace slightly for clarity.");
  if (avgWpm < 110) priorities.push("Increase pace slightly for energy.");
  if (avgStar !== null && avgStar < 60) priorities.push("Use STAR more consistently for behavioral questions.");
  if (avgImpact < 20) priorities.push("Add measurable outcomes (numbers, results, impact).");
  if (!priorities.length) priorities.push("Maintain strong delivery; focus on sharper results and specificity.");

  return {
    avg_wpm: avgWpm,
    avg_filler_per_min: avgFillerPerMin,
    avg_filler_pct_words: avgFillerPct,
    avg_star_score_behavioral: avgStar,
    avg_impact: avgImpact,
    avg_confidence: avgConfidence,
    admissions_readiness: avgReadiness,
    top_fillers: topFillers,
    priorities: priorities.slice(0, 4),
  };
}

module.exports = { analyzeTranscript, aggregateCoaching };