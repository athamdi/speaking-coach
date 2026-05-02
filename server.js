const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const initSqlJs = require('sql.js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_...');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { nanoid } = require('nanoid');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = 3000;
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const TEXT_MODEL = 'llama3';
const FALLBACK_MODEL = 'mistral';
const BODY_MODEL = 'llava';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Ensure data directory exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

// Initialize SQLite database
let db;
let SQL;

async function initDatabase() {
  SQL = await initSqlJs();
  
  // Try to load existing database
  let filebuffer = null;
  if (fs.existsSync('./data/speakup.db')) {
    filebuffer = fs.readFileSync('./data/speakup.db');
  }
  
  db = filebuffer ? new SQL.Database(filebuffer) : new SQL.Database();
  
  // Enable WAL mode equivalent (not directly supported in sql.js, but we can implement similar behavior)
  db.run(`PRAGMA foreign_keys = ON`);
  
  // Create tables
  db.run(`
    -- User profile (only ever one row)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      native_language TEXT NOT NULL,
      target_speaking_context TEXT DEFAULT 'both',
      start_date TEXT NOT NULL,
      current_day INTEGER DEFAULT 1,
      streak INTEGER DEFAULT 0,
      last_completed_date TEXT,
      longest_streak INTEGER DEFAULT 0,
      total_minutes_practiced INTEGER DEFAULT 0,
      email TEXT,
      reminder_time TEXT,
      reminder_tz TEXT,
      unsub_token TEXT,
      public_name TEXT,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      referral_count INTEGER DEFAULT 0,
      bonus_day_unlocked INTEGER DEFAULT 0,
      is_pro INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      subscription_status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- One row per day of practice
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER DEFAULT 1,
      day INTEGER NOT NULL,
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      total_minutes INTEGER DEFAULT 0,
      overall_score REAL DEFAULT 0,
      pre_flight_physical TEXT,
      pre_flight_mental TEXT,
      pre_flight_energy TEXT,
      session_intent TEXT,
      post_feeling TEXT,
      tomorrow_plan TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- One row per habit per session
    CREATE TABLE IF NOT EXISTS habit_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      habit_name TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      duration_seconds INTEGER DEFAULT 0,
      data_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Detailed scores per session
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      overall_score REAL,
      filler_count INTEGER DEFAULT 0,
      filler_per_min REAL DEFAULT 0,
      structure_score REAL,
      confidence_score REAL,
      pacing_score REAL,
      avg_wpm REAL,
      emotion_score REAL,
      body_posture REAL,
      body_eye_contact REAL,
      body_gestures REAL,
      body_expression REAL,
      body_overall REAL,
      transcript TEXT,
      feedback_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Filler word tracking across all sessions
    CREATE TABLE IF NOT EXISTS filler_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      word TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Journal entries
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      day INTEGER NOT NULL,
      date TEXT NOT NULL,
      win TEXT,
      gap TEXT,
      tomorrow TEXT,
      raw_entry TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Live camera alerts log
    CREATE TABLE IF NOT EXISTS camera_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      timestamp_seconds INTEGER,
      alert_type TEXT,
      message TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Personal records
    CREATE TABLE IF NOT EXISTS personal_records (
      id INTEGER PRIMARY KEY DEFAULT 1,
      user_id INTEGER DEFAULT 1,
      best_overall_score REAL DEFAULT 0,
      best_score_day INTEGER,
      lowest_filler_rate REAL DEFAULT 99,
      lowest_filler_day INTEGER,
      best_wpm REAL DEFAULT 0,
      best_wpm_day INTEGER,
      longest_streak INTEGER DEFAULT 0,
      total_sessions_completed INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Adaptive plan history
    CREATE TABLE IF NOT EXISTS adaptations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      day INTEGER NOT NULL,
      weakest_dimension TEXT,
      adapted_task TEXT,
      added_drill TEXT,
      difficulty_change TEXT,
      reason TEXT,
      approved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Friend challenges
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY,
      challenger_user_id INTEGER REFERENCES users(id),
      challenger_score REAL,
      challenger_name TEXT,
      day INTEGER,
      theme TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accepted_at DATETIME,
      challenger_won INTEGER
    );

    -- Teams
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      admin_user_id INTEGER REFERENCES users(id),
      company_name TEXT,
      seat_count INTEGER,
      stripe_subscription_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Team members
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT REFERENCES teams(id),
      user_id INTEGER REFERENCES users(id),
      invite_token TEXT UNIQUE,
      joined_at DATETIME,
      PRIMARY KEY (team_id, user_id)
    );

    -- Affiliates
    CREATE TABLE IF NOT EXISTS affiliates (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      ref_code TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      commission_rate REAL DEFAULT 0.30,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Affiliate conversions
    CREATE TABLE IF NOT EXISTS affiliate_conversions (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT REFERENCES affiliates(id),
      converted_user_id INTEGER REFERENCES users(id),
      plan TEXT,
      amount_usd REAL,
      commission_usd REAL,
      stripe_payment_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- User preferences
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      coach_persona TEXT DEFAULT 'encouraging'
    );
  `);
  
  console.log('Database initialized: ./data/speakup.db');
  
  // Auto-save database to file every 30 seconds
  setInterval(() => {
    try {
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const data = db.export();
      const buffer = Buffer.from(data);
      const dbPath = path.join(dataDir, 'speakup.db');
      fs.writeFileSync(dbPath, buffer);
      console.log('Database saved to:', dbPath);
    } catch (err) {
      console.error('Failed to save database:', err);
    }
  }, 30000);
}

// Helper functions for sql.js (different API than better-sqlite3)
function getUser() {
  const stmt = db.prepare('SELECT * FROM users WHERE id = 1');
  const result = stmt.getAsObject();
  stmt.free();
  return result.id ? result : null;
}

function createUser(profile) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO users 
    (id, name, goal, native_language, target_speaking_context, start_date)
    VALUES (1, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    profile.name,
    profile.goal,
    profile.nativeLanguage,
    profile.speakingContext || 'both',
    new Date().toISOString().split('T')[0]
  ]);
  stmt.free();
}

function updateUser(fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(fields), 1];
  const stmt = db.prepare(`UPDATE users SET ${sets} WHERE id = 1`);
  stmt.run(vals);
  stmt.free();
}

function getOrCreateSession(day) {
  const today = new Date().toISOString().split('T')[0];
  let stmt = db.prepare(
    'SELECT * FROM sessions WHERE user_id=1 AND day=? ORDER BY id DESC LIMIT 1'
  );
  let result = stmt.getAsObject([day]);
  stmt.free();
  
  if (!result.id) {
    const insertStmt = db.prepare(
      'INSERT INTO sessions (user_id,day,date) VALUES (1,?,?)'
    );
    const info = insertStmt.run([day, today]);
    insertStmt.free();
    
    stmt = db.prepare('SELECT * FROM sessions WHERE id=?');
    result = stmt.getAsObject([info.insertId]);
    stmt.free();
  }
  return result;
}

function updateSession(sessionId, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const stmt = db.prepare(`UPDATE sessions SET ${sets} WHERE id = ?`);
  stmt.run([...Object.values(fields), sessionId]);
  stmt.free();
}

function saveHabitResult(sessionId, habitName, data, completed=true, skipped=false) {
  const stmt = db.prepare(
    'SELECT id FROM habit_results WHERE session_id=? AND habit_name=?'
  );
  const existing = stmt.getAsObject([sessionId, habitName]);
  stmt.free();
  
  if (existing.id) {
    const updateStmt = db.prepare(`
      UPDATE habit_results SET completed=?,skipped=?,data_json=? WHERE id=?
    `);
    updateStmt.run([completed?1:0, skipped?1:0, JSON.stringify(data), existing.id]);
    updateStmt.free();
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO habit_results (session_id,habit_name,completed,skipped,duration_seconds,data_json)
      VALUES (?,?,?,?,?,?)
    `);
    insertStmt.run([sessionId, habitName, completed?1:0, skipped?1:0, data.durationSeconds||0, JSON.stringify(data)]);
    insertStmt.free();
  }
}

function saveScores(sessionId, scoreData) {
  const stmt = db.prepare('SELECT id FROM scores WHERE session_id=?');
  const existing = stmt.getAsObject([sessionId]);
  stmt.free();
  
  if (existing.id) {
    const updateStmt = db.prepare(`
      UPDATE scores SET 
        overall_score=?, filler_count=?, filler_per_min=?,
        structure_score=?, confidence_score=?, pacing_score=?,
        avg_wpm=?, emotion_score=?, body_posture=?, body_eye_contact=?,
        body_gestures=?, body_expression=?, body_overall=?,
        transcript=?, feedback_json=?
      WHERE id=?
    `);
    updateStmt.run([
      scoreData.overallScore, scoreData.fillerCount, scoreData.fillerPerMin,
      scoreData.structureScore, scoreData.confidenceScore, scoreData.pacingScore,
      scoreData.avgWPM, scoreData.emotionScore,
      scoreData.bodyPosture, scoreData.bodyEyeContact,
      scoreData.bodyGestures, scoreData.bodyExpression, scoreData.bodyOverall,
      scoreData.transcript, JSON.stringify(scoreData.feedback),
      existing.id
    ]);
    updateStmt.free();
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO scores (
        session_id, overall_score, filler_count, filler_per_min,
        structure_score, confidence_score, pacing_score,
        avg_wpm, emotion_score, body_posture, body_eye_contact,
        body_gestures, body_expression, body_overall,
        transcript, feedback_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    insertStmt.run([
      sessionId,
      scoreData.overallScore, scoreData.fillerCount, scoreData.fillerPerMin,
      scoreData.structureScore, scoreData.confidenceScore, scoreData.pacingScore,
      scoreData.avgWPM, scoreData.emotionScore,
      scoreData.bodyPosture, scoreData.bodyEyeContact,
      scoreData.bodyGestures, scoreData.bodyExpression, scoreData.bodyOverall,
      scoreData.transcript, JSON.stringify(scoreData.feedback)
    ]);
    insertStmt.free();
  }
}

function saveFillerHistory(sessionId, fillerBreakdown) {
  const today = new Date().toISOString().split('T')[0];
  const insertStmt = db.prepare(
    'INSERT INTO filler_history (session_id,word,count,date) VALUES (?,?,?,?)'
  );
  for (const [word, count] of Object.entries(fillerBreakdown)) {
    insertStmt.run([sessionId, word, count, today]);
  }
  insertStmt.free();
}

function getFillerTrends() {
  const stmt = db.prepare(`
    SELECT word, SUM(count) as total_count,
           COUNT(DISTINCT session_id) as days_appeared,
           MAX(date) as last_seen
    FROM filler_history
    GROUP BY word
    ORDER BY total_count DESC
    LIMIT 10
  `);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function saveJournalEntry(sessionId, day, entry) {
  const today = new Date().toISOString().split('T')[0];
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO journal (session_id,day,date,win,gap,tomorrow,raw_entry)
    VALUES (?,?,?,?,?,?,?)
  `);
  stmt.run([sessionId, day, today, entry.win, entry.gap, entry.tomorrow, entry.raw]);
  stmt.free();
}

function updatePersonalRecords(day, scores) {
  const stmt = db.prepare('SELECT * FROM personal_records WHERE id=1');
  const existing = stmt.getAsObject();
  stmt.free();
  
  if (!existing.id) {
    const insertStmt = db.prepare('INSERT INTO personal_records (id,user_id) VALUES (1,1)');
    insertStmt.run([]);
    insertStmt.free();
  }
  
  const updates = {};
  if (!existing.best_overall_score || scores.overallScore > existing.best_overall_score) {
    updates.best_overall_score = scores.overallScore;
    updates.best_score_day = day;
  }
  if (!existing.lowest_filler_rate || scores.fillerPerMin < existing.lowest_filler_rate) {
    updates.lowest_filler_rate = scores.fillerPerMin;
    updates.lowest_filler_day = day;
  }
  if (!existing.best_wpm || scores.avgWPM > existing.best_wpm) {
    updates.best_wpm = scores.avgWPM;
    updates.best_wpm_day = day;
  }
  updates.total_sessions_completed = (existing.total_sessions_completed || 0) + 1;
  
  if (Object.keys(updates).length > 0) {
    const sets = Object.keys(updates).map(k=>`${k}=?`).join(',');
    const updateStmt = db.prepare(`UPDATE personal_records SET ${sets} WHERE id=1`);
    updateStmt.run(Object.values(updates));
    updateStmt.free();
  }
}

function updateStreak() {
  const user = getUser();
  if (!user) return;
  
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
  
  let newStreak = 1;
  if (user.last_completed_date === yesterday) {
    newStreak = user.streak + 1;
  } else if (user.last_completed_date === today) {
    return; // already updated today
  }
  
  updateUser({
    streak: newStreak,
    last_completed_date: today,
    longest_streak: Math.max(newStreak, user.longest_streak||0)
  });
}

function exportJsonBackup() {
  // Export all tables to JSON
  const tables = ['users', 'sessions', 'habit_results', 'scores', 'filler_history', 'journal', 'camera_alerts', 'personal_records', 'adaptations'];
  const backup = {
    exportedAt: new Date().toISOString(),
  };
  
  for (const table of tables) {
    const stmt = db.prepare(`SELECT * FROM ${table}`);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    backup[table] = rows;
  }
  
  fs.writeFileSync('./data/progress.json', JSON.stringify(backup, null, 2));
  fs.writeFileSync(
    `./data/backup-${new Date().toISOString().split('T')[0]}.json`,
    JSON.stringify(backup, null, 2)
  );
  
  return backup;
}

function completeSession(day) {
  const session = getOrCreateSession(day);
  updateSession(session.id, { completed: 1 });
  updateStreak();
  updateUser({ current_day: day + 1 });
  exportJsonBackup(); // always backup on complete
}

// ── NEW SQLITE-BASED API ENDPOINTS ────────────────────────────────────────────

// Check if user exists (called on app load)
app.get('/api/user', (req, res) => {
  const user = getUser();
  if (!user) return res.json({ exists: false });
  const stmt = db.prepare('SELECT * FROM personal_records WHERE id=1');
  const records = stmt.getAsObject();
  stmt.free();
  res.json({ exists: true, user, records });
});

// Create user profile (first run)
app.post('/api/user/create', (req, res) => {
  try {
    const { name, goal, nativeLanguage, speakingContext } = req.body;
    if (!name || !goal || !nativeLanguage) {
      return res.status(400).json({ error: 'name, goal, nativeLanguage are required' });
    }
    createUser({ name, goal, nativeLanguage, speakingContext });
    // Init personal records row
    const stmt = db.prepare('INSERT OR IGNORE INTO personal_records (id,user_id) VALUES (1,1)');
    stmt.run([]);
    stmt.free();
    res.json({ success: true, user: getUser() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update profile
app.put('/api/user/update', (req, res) => {
  try {
    const allowed = ['name','goal','native_language','target_speaking_context'];
    const fields = {};
    allowed.forEach(k => { if (req.body[k]) fields[k] = req.body[k]; });
    updateUser(fields);
    res.json({ success: true, user: getUser() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated progress endpoint using SQLite
app.get('/api/progress', (req, res) => {
  try {
    const user = getUser();
    if (!user) return res.json({ needsSetup: true });

    const stmt = db.prepare(`
      SELECT s.*, sc.overall_score, sc.filler_per_min, sc.structure_score,
             sc.confidence_score, sc.pacing_score, sc.avg_wpm, sc.body_overall
      FROM sessions s
      LEFT JOIN scores sc ON sc.session_id = s.id
      WHERE s.user_id = 1
      ORDER BY s.day ASC
    `);
    const sessions = [];
    while (stmt.step()) {
      sessions.push(stmt.getAsObject());
    }
    stmt.free();

    const recordsStmt = db.prepare('SELECT * FROM personal_records WHERE id=1');
    const records = recordsStmt.getAsObject();
    recordsStmt.free();
    
    const fillerTrends = getFillerTrends();
    const journalStmt = db.prepare(
      'SELECT * FROM journal ORDER BY day DESC LIMIT 15'
    );
    const journalEntries = [];
    while (journalStmt.step()) {
      journalEntries.push(journalStmt.getAsObject());
    }
    journalStmt.free();

    res.json({
      user,
      currentDay: user.current_day,
      streak: user.streak,
      longestStreak: user.longest_streak,
      sessions,
      personalRecords: records,
      fillerTrends,
      journalEntries
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated journal endpoint
app.get('/api/journal', (req, res) => {
  const stmt = db.prepare('SELECT * FROM journal ORDER BY day DESC');
  const entries = [];
  while (stmt.step()) {
    entries.push(stmt.getAsObject());
  }
  stmt.free();
  res.json({ entries });
});

// Updated habit save endpoint
app.post('/api/habit/save', (req, res) => {
  try {
    const { day, habitName, data, completed, skipped } = req.body;
    const session = getOrCreateSession(day);
    saveHabitResult(session.id, habitName, data, completed !== false, skipped === true);
    res.json({ success: true, sessionId: session.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated feedback/full endpoint
app.post('/api/feedback/full', async (req, res) => {
  try {
    const { transcript, day, duration, task, sentenceData, frameBase64 } = req.body;

    if (!transcript || transcript.split(' ').length < 15) {
      return res.status(400).json({ error: 'transcript_too_short' });
    }

    const session = getOrCreateSession(day);
    const feedback = await getFullFeedback(transcript, day, duration, task, sentenceData||[], frameBase64||null);

    if (!feedback.error) {
      // Save to SQLite
      const scoreData = {
        overallScore: feedback.overallScore,
        fillerCount: feedback.fillerAnalysis?.totalCount || 0,
        fillerPerMin: feedback.fillerAnalysis?.perMinute || 0,
        structureScore: feedback.structureScore,
        confidenceScore: feedback.confidenceScore,
        pacingScore: feedback.pacingScore,
        avgWPM: feedback.avgWPM || 0,
        emotionScore: feedback.emotionAnalysis?.energyLevel || 0,
        bodyPosture: feedback.bodyLanguage?.postureScore || 0,
        bodyEyeContact: feedback.bodyLanguage?.eyeContactScore || 0,
        bodyGestures: feedback.bodyLanguage?.gestureScore || 0,
        bodyExpression: feedback.bodyLanguage?.expressionScore || 0,
        bodyOverall: feedback.bodyLanguage?.overallBodyScore || 0,
        transcript,
        feedback
      };

      saveScores(session.id, scoreData);

      // Save filler breakdown
      if (feedback.fillerAnalysis?.byWord) {
        saveFillerHistory(session.id, feedback.fillerAnalysis.byWord);
      }

      // Update personal records
      updatePersonalRecords(day, scoreData);

      // Export JSON backup
      exportJsonBackup();
    }

    res.json(feedback);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Session complete endpoint
app.post('/api/session/complete', (req, res) => {
  try {
    const { day } = req.body;
    completeSession(day);
    res.json({ success: true, user: getUser() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated journal save endpoint
app.post('/api/journal/save', (req, res) => {
  try {
    const { day, entry } = req.body;
    const session = getOrCreateSession(day);
    saveJournalEntry(session.id, day, entry);
    exportJsonBackup();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Camera alerts save endpoint
app.post('/api/alerts/save', (req, res) => {
  try {
    const { day, alerts } = req.body;
    const session = getOrCreateSession(day);
    const insertStmt = db.prepare(
      'INSERT INTO camera_alerts (session_id,timestamp_seconds,alert_type,message) VALUES (?,?,?,?)'
    );
    for (const a of alerts) {
      insertStmt.run([session.id, a.timestamp, a.type, a.message]);
    }
    insertStmt.free();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Data export endpoint
app.get('/api/export', (req, res) => {
  try {
    const backup = exportJsonBackup();
    res.setHeader('Content-Disposition', 'attachment; filename=speakup-backup.json');
    res.json(backup);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset/delete all data endpoint
app.delete('/api/user/reset', (req, res) => {
  try {
    // Backup first
    exportJsonBackup();
    // Clear all data
    const tables = ['camera_alerts', 'filler_history', 'journal', 'scores', 'habit_results', 'adaptations', 'sessions', 'personal_records', 'users'];
    for (const table of tables) {
      db.run(`DELETE FROM ${table}`);
    }
    res.json({ success: true, message: 'All data deleted. Backup saved to data/.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

function parseJsonFromString(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('No text to parse');
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const jsonText = first !== -1 && last !== -1 ? text.slice(first, last + 1) : text;
  return JSON.parse(jsonText);
}

function computeFillerAnalysis(transcript, duration) {
  const fillers = ['um', 'uh', 'like', 'you know', 'basically', 'literally', 'actually', 'right', 'so', 'kind of', 'sort of', 'i mean', 'hmm', 'okay so'];
  const text = transcript.toLowerCase();
  const byWord = {};
  let totalFillers = 0;
  fillers.forEach((word) => {
    const count = (text.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length;
    if (count) {
      byWord[word] = count;
      totalFillers += count;
    }
  });
  const minutes = Math.max(duration / 60, 1 / 60);
  const fillerRate = parseFloat((totalFillers / minutes).toFixed(2));
  let grade = 'A';
  if (fillerRate > 4) grade = 'F';
  else if (fillerRate > 3) grade = 'D';
  else if (fillerRate > 2) grade = 'C';
  else if (fillerRate > 1) grade = 'B';
  return { totalFillers, byWord, fillerRate, grade };
}

async function callOllama(model, prompt, images = null) {
  const payload = { model, prompt, stream: false };
  if (images) {
    payload.images = images;
  }
  const response = await axios.post(OLLAMA_URL, payload, { timeout: 45000 });
  const raw = response.data?.response || response.data?.text || response.data;
  if (!raw) {
    throw new Error('Empty Ollama response');
  }
  return raw;
}

async function fetchDailyContent() {
  const today = new Date().toISOString().split('T')[0];
  if (fs.existsSync(CONTENT_CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CONTENT_CACHE_FILE, 'utf8'));
    if (cache.date === today) {
      return cache;
    }
  }

  const articles = [];
  const topics = ["Richard_Feynman", "Elon_Musk", "Marie_Curie", "Steve_Jobs", "Nikola_Tesla", "Carl_Sagan", "Naval_Ravikant", "Paul_Graham", "Brené_Brown", "Malcolm_Gladwell", "Sundar_Pichai", "Satya_Nadella", "Oprah_Winfrey", "Simon_Sinek", "Adam_Grant"];

  // Try DEV.to
  try {
    const devResponse = await axios.get('https://dev.to/api/articles?tag=startup&per_page=10&top=7');
    const devArticles = devResponse.data.filter(a => a.reading_time_minutes >= 3 && a.reading_time_minutes <= 6);
    devArticles.slice(0, 3).forEach(a => {
      articles.push({
        id: `devto-${a.id}`,
        title: a.title,
        source: 'devto',
        text: a.description,
        topic: 'technology',
        readingTimeSeconds: a.reading_time_minutes * 60,
        hookLine: a.description.split('.')[0] + '.',
        keyMessage: ''
      });
    });
  } catch (e) {
    console.log('DEV.to fetch failed:', e.message);
  }

  // Try Wikipedia
  if (articles.length < 5) {
    const dayIndex = (new Date().getDate() - 1) % topics.length;
    try {
      const wikiResponse = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${topics[dayIndex]}`);
      const text = wikiResponse.data.extract.slice(0, 600);
      articles.push({
        id: `wiki-${topics[dayIndex]}`,
        title: wikiResponse.data.title,
        source: 'wikipedia',
        text: text,
        topic: 'leadership',
        readingTimeSeconds: 120,
        hookLine: text.split('.')[0] + '.',
        keyMessage: ''
      });
    } catch (e) {
      console.log('Wikipedia fetch failed:', e.message);
    }
  }

  // Try HackerNews
  if (articles.length < 5) {
    try {
      const hnTop = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json');
      const topIds = hnTop.data.slice(0, 5);
      for (const id of topIds) {
        const item = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (item.data.url && item.data.score > 100) {
          articles.push({
            id: `hn-${id}`,
            title: item.data.title,
            source: 'hackernews',
            text: item.data.title + '. ' + (item.data.text || ''),
            topic: 'technology',
            readingTimeSeconds: 90,
            hookLine: item.data.title.split('.')[0] + '.',
            keyMessage: ''
          });
          if (articles.length >= 5) break;
        }
      }
    } catch (e) {
      console.log('HackerNews fetch failed:', e.message);
    }
  }

  // Generate keyMessage for each article
  for (const article of articles) {
    try {
      const keyMessage = await callOllama(TEXT_MODEL, `In one sentence (max 20 words), what is the key message of this text: ${article.text.slice(0, 500)}`);
      article.keyMessage = keyMessage.replace(/"/g, '').trim();
    } catch (e) {
      article.keyMessage = 'Key message not available.';
    }
  }

  const content = {
    date: today,
    articles: articles.slice(0, 5),
    twisters: getTodaysTwisters(),
    shadowExcerpt: getTodaysShadowExcerpt()
  };

  fs.writeFileSync(CONTENT_CACHE_FILE, JSON.stringify(content, null, 2));
  return content;
}

const TONGUE_TWISTERS = [
  { text: "She sells seashells by the seashore, and the shells she sells are seashells for sure", difficulty: "beginner", focus: "S sounds" },
  { text: "How much wood would a woodchuck chuck if a woodchuck could chuck wood", difficulty: "beginner", focus: "W sounds" },
  { text: "Red lorry yellow lorry, red lorry yellow lorry, red lorry yellow lorry", difficulty: "beginner", focus: "R/L sounds" },
  { text: "Unique New York, unique New York, you know you need unique New York", difficulty: "intermediate", focus: "N/Y sounds" },
  { text: "Peter Piper picked a peck of pickled peppers", difficulty: "beginner", focus: "P sounds" },
  { text: "Betty Botter bought some butter but the butter Betty bought was bitter", difficulty: "intermediate", focus: "B/T sounds" },
  { text: "How can a clam cram in a clean cream can", difficulty: "intermediate", focus: "CL/CR sounds" },
  { text: "I scream you scream we all scream for ice cream", difficulty: "beginner", focus: "SC sounds" },
  { text: "Six slick slim sycamore saplings", difficulty: "advanced", focus: "SL/S sounds" },
  { text: "Freshly fried fish, freshly fried flesh", difficulty: "intermediate", focus: "FR/FL sounds" },
  { text: "The thirty-three thieves thought that they thrilled the throne throughout Thursday", difficulty: "advanced", focus: "TH sounds" },
  { text: "Lesser leather never weathered wetter weather better", difficulty: "advanced", focus: "W/TH sounds" },
  { text: "Can you can a can as a canner can can a can", difficulty: "intermediate", focus: "CAN sounds" },
  { text: "Which witch is which, and which witch switched the witch", difficulty: "intermediate", focus: "WH sounds" },
  { text: "A proper copper coffee pot", difficulty: "beginner", focus: "P/C sounds" },
  { text: "He threw three free throws", difficulty: "intermediate", focus: "THR sounds" },
  { text: "The big black bug bled blue black blood", difficulty: "advanced", focus: "BL sounds" },
  { text: "Fuzzy Wuzzy was a bear, Fuzzy Wuzzy had no hair, Fuzzy Wuzzy wasn't fuzzy was he", difficulty: "beginner", focus: "W/Z sounds" },
  { text: "If two witches were watching two watches which witch would watch which watch", difficulty: "advanced", focus: "W/TCH sounds" },
  { text: "A skunk sat on a stump and thunk the stump stunk", difficulty: "intermediate", focus: "SK/ST sounds" },
  { text: "World Wide Web, World Wide Web, World Wide Web", difficulty: "beginner", focus: "W sounds" },
  { text: "Mixed biscuits, mixed biscuits, mixed biscuits", difficulty: "intermediate", focus: "MX/SK sounds" },
  { text: "Toy boat, toy boat, toy boat, toy boat", difficulty: "beginner", focus: "OI/OY sounds" },
  { text: "Red blood, blue blood, red blood, blue blood", difficulty: "beginner", focus: "BL sounds" },
  { text: "Swan swam over the sea, swim swan swim, swan swam back again, well swum swan", difficulty: "advanced", focus: "SW sounds" },
  { text: "I thought I thought of thinking of thanking you", difficulty: "intermediate", focus: "TH sounds" },
  { text: "Black background brown background black background brown background", difficulty: "advanced", focus: "BL/BR sounds" },
  { text: "Eleven benevolent elephants", difficulty: "intermediate", focus: "EL/EN sounds" },
  { text: "Good blood bad blood good blood bad blood", difficulty: "intermediate", focus: "BL/D sounds" },
  { text: "Specific Pacific specific Pacific specific Pacific", difficulty: "advanced", focus: "SP/P sounds" }
];

function getTodaysTwisters() {
  const day = new Date().getDate();
  const indices = [(day * 3) % 30, (day * 3 + 1) % 30, (day * 3 + 2) % 30];
  return indices.map(i => TONGUE_TWISTERS[i]);
}

const SHADOW_EXCERPTS = [
  {
    speaker: "Steve Jobs",
    context: "Stanford Commencement 2005",
    targetWPM: 115,
    text: "You've got to find what you love. And that is as true for your work as it is for your lovers. Your work is going to fill a large part of your life, and the only way to be truly satisfied is to do what you believe is great work. And the only way to do great work is to love what you do.",
    pauseMarkers: "You've got to find | what you love. | And that is as true | for your work | as it is | for your lovers.",
    stressedWords: ["find", "love", "truly", "great", "love"]
  },
  {
    speaker: "Brené Brown",
    context: "TED Talk on Vulnerability",
    targetWPM: 125,
    text: "Vulnerability is not winning or losing. It's having the courage to show up and be seen when we have no control over the outcome. Vulnerability is not weakness. And that myth is profoundly dangerous. Vulnerability is our most accurate measurement of courage.",
    pauseMarkers: "Vulnerability | is not winning or losing. | It's having the courage | to show up | and be seen | when we have no control | over the outcome.",
    stressedWords: ["courage", "seen", "control", "weakness", "dangerous", "courage"]
  },
  {
    speaker: "Barack Obama",
    context: "2004 DNC Keynote",
    targetWPM: 130,
    text: "It is that fundamental belief: I am my brother's keeper. I am my sister's keeper that makes this country work. It's what allows us to pursue our individual dreams, yet still come together as a single American family.",
    pauseMarkers: "It is that fundamental belief: | I am my brother's keeper. | I am my sister's keeper | that makes this country work. | It's what allows us | to pursue our individual dreams, | yet still come together.",
    stressedWords: ["fundamental", "keeper", "together", "family", "dreams"]
  },
  {
    speaker: "Oprah Winfrey",
    context: "Harvard Commencement 2013",
    targetWPM: 120,
    text: "There is no such thing as failure. Failure is just life trying to move us in another direction. When you're down there in the hole, it looks like failure. So this is what you have to know: you need to take every mistake, every failure, and ask yourself what is the gift in this experience.",
    pauseMarkers: "There is no such thing as failure. | Failure is just life | trying to move us | in another direction. | When you're down there in the hole, | it looks like failure.",
    stressedWords: ["failure", "direction", "hole", "gift", "experience"]
  },
  {
    speaker: "Simon Sinek",
    context: "TEDx: How Great Leaders Inspire Action",
    targetWPM: 135,
    text: "People don't buy what you do; they buy why you do it. And what you do simply proves what you believe. In fact, people will do the things that prove what they believe. The goal is not to do business with everybody who needs what you have.",
    pauseMarkers: "People don't buy what you do; | they buy why you do it. | And what you do | simply proves | what you believe.",
    stressedWords: ["buy", "why", "proves", "believe", "goal"]
  },
  {
    speaker: "Richard Feynman",
    context: "Lecture on curiosity",
    targetWPM: 140,
    text: "I would rather have questions that can't be answered than answers that can't be questioned. The first principle is that you must not fool yourself, and you are the easiest person to fool. So you have to be very careful about that.",
    pauseMarkers: "I would rather have | questions that can't be answered | than answers | that can't be questioned. | The first principle | is that you must not | fool yourself.",
    stressedWords: ["questions", "answers", "questioned", "fool", "careful"]
  },
  {
    speaker: "Naval Ravikant",
    context: "On building wealth",
    targetWPM: 130,
    text: "Seek wealth, not money or status. Wealth is having assets that earn while you sleep. Money is how we transfer time and wealth. Status is your place in the social hierarchy. You are not going to get rich renting out your time.",
    pauseMarkers: "Seek wealth, | not money or status. | Wealth is having assets | that earn while you sleep. | Money is how we transfer | time and wealth.",
    stressedWords: ["wealth", "assets", "sleep", "time", "rich"]
  },
  {
    speaker: "Malala Yousafzai",
    context: "UN Speech 2013",
    targetWPM: 110,
    text: "One child, one teacher, one book, one pen can change the world. Education is the only solution. Education first. Let us pick up our books and our pens, they are the most powerful weapons.",
    pauseMarkers: "One child, | one teacher, | one book, | one pen | can change the world. | Education is the only solution.",
    stressedWords: ["one", "change", "education", "powerful", "weapons"]
  },
  {
    speaker: "Jeff Bezos",
    context: "On customer obsession",
    targetWPM: 125,
    text: "We see our customers as invited guests to a party, and we are the hosts. It's our job every day to make every important aspect of the customer experience a little bit better.",
    pauseMarkers: "We see our customers | as invited guests to a party, | and we are the hosts. | It's our job every day | to make every important aspect | of the customer experience | a little bit better.",
    stressedWords: ["guests", "hosts", "job", "better", "experience"]
  },
  {
    speaker: "Michelle Obama",
    context: "2016 DNC Speech",
    targetWPM: 120,
    text: "When they go low, we go high. With every word we utter, with every action we take, we know our kids are watching us. We as parents are their first role models.",
    pauseMarkers: "When they go low, | we go high. | With every word we utter, | with every action we take, | we know our kids | are watching us.",
    stressedWords: ["low", "high", "watching", "role", "models"]
  },
  {
    speaker: "Elon Musk",
    context: "On failure and persistence",
    targetWPM: 145,
    text: "Failure is an option here. If things are not failing, you are not innovating enough. When something is important enough, you do it even if the odds are not in your favor. The first step is to establish that something is possible. Then probability will occur.",
    pauseMarkers: "Failure is an option here. | If things are not failing, | you are not innovating enough. | When something is important enough, | you do it | even if the odds | are not in your favor.",
    stressedWords: ["failure", "innovating", "important", "odds", "possible"]
  },
  {
    speaker: "Satya Nadella",
    context: "On growth mindset",
    targetWPM: 125,
    text: "Don't be a know-it-all. Be a learn-it-all. The learn-it-all does better than the know-it-all. This is especially true in the knowledge economy. Empathy is the most important trait you can have as a leader.",
    pauseMarkers: "Don't be a know-it-all. | Be a learn-it-all. | The learn-it-all | does better | than the know-it-all. | Empathy | is the most important trait | you can have | as a leader.",
    stressedWords: ["know", "learn", "better", "empathy", "leader"]
  },
  {
    speaker: "Sundar Pichai",
    context: "On working with teams",
    targetWPM: 120,
    text: "A person who is happy is not because everything is right in his life. He is happy because his attitude towards everything in his life is right. Leadership is not about being in charge. It is about taking care of those in your charge.",
    pauseMarkers: "A person who is happy | is not because everything is right. | He is happy | because his attitude | towards everything | is right. | Leadership is not about being in charge. | It is about taking care.",
    stressedWords: ["happy", "attitude", "right", "leadership", "care"]
  },
  {
    speaker: "Adam Grant",
    context: "On original thinking",
    targetWPM: 135,
    text: "The greatest originals are the ones who fail the most, because they're the ones who try the most. You need a lot of bad ideas in order to get a few good ones. Doubt is not the enemy of originality. It is the doorway to it.",
    pauseMarkers: "The greatest originals | are the ones who fail the most, | because they're the ones | who try the most. | You need a lot of bad ideas | in order to get a few good ones.",
    stressedWords: ["fail", "try", "bad", "good", "doubt", "originality"]
  },
  {
    speaker: "Carl Sagan",
    context: "Pale Blue Dot",
    targetWPM: 105,
    text: "Look again at that dot. That's here. That's home. That's us. On it everyone you love, everyone you know, everyone you ever heard of, every human being who ever was, lived out their lives.",
    pauseMarkers: "Look again | at that dot. | That's here. | That's home. | That's us. | On it everyone you love, | everyone you know, | everyone you ever heard of.",
    stressedWords: ["here", "home", "us", "love", "know", "lived"]
  }
];

function getTodaysShadowExcerpt() {
  const day = new Date().getDate();
  return SHADOW_EXCERPTS[(day - 1) % SHADOW_EXCERPTS.length];
}

async function generateTextAnalysis(transcript, day, duration) {
  const prompt = `You are a strict professional speech coach. Analyze the transcript below and return ONLY a valid JSON object with NO preamble, no markdown, no explanation outside the JSON.

Return this exact structure:
{
  "structureAnalysis": {
    "hookScore": 1-10,
    "flowScore": 1-10,
    "clarityScore": 1-10,
    "closingScore": 1-10,
    "overallStructure": 1-10,
    "suggestions": ["tip1", "tip2", "tip3"]
  },
  "toneAnalysis": {
    "confidenceScore": 1-10,
    "weakPhrases": ["phrase1", "phrase2"],
    "strongPhrases": ["phrase1", "phrase2"],
    "rewriteSuggestions": [{"original": "...", "improved": "..."}]
  },
  "pronunciationGuide": {
    "flaggedWords": [{"word": "...", "phonetic": "...", "tip": "..."}],
    "overallClarity": 1-10
  },
  "todaysDrill": "One specific 5-minute exercise to fix the biggest weakness found",
  "improvedVersion": "Rewrite the opening 2-3 sentences of their speech to show how it could sound with full confidence and structure",
  "overallScore": 1-10
}

Transcript to analyze:
${transcript}`;

  try {
    const raw = await callOllama(TEXT_MODEL, prompt);
    return parseJsonFromString(raw);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      const raw = await callOllama(FALLBACK_MODEL, prompt);
      return parseJsonFromString(raw);
    }
    if (error.code === 'ECONNREFUSED') {
      throw new Error('Ollama not running');
    }
    const raw = await callOllama(FALLBACK_MODEL, prompt);
    return parseJsonFromString(raw);
  }
}

async function generateBodyLanguage(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return null;
  }
  const prompt = `You are analyzing a public speaker's body language from a video frame.\nReturn ONLY valid JSON:\n{\n  "postureScore": 1-10,\n  "eyeContactScore": 1-10,\n  "expressionScore": 1-10,\n  "gestureScore": 1-10,\n  "tip": "one specific actionable improvement"\n}`;
  try {
    const raw = await callOllama(BODY_MODEL, prompt, frames);
    return parseJsonFromString(raw);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error('Ollama not running');
    }
    if (error.response && /llava/i.test(String(error.response.data))) {
      throw new Error('llava-not-installed');
    }
    throw error;
  }
}

function computeOverallScore(textAnalysis) {
  if (!textAnalysis) return 0;
  const structure = textAnalysis.structureAnalysis?.overallStructure || 0;
  const confidence = textAnalysis.toneAnalysis?.confidenceScore || 0;
  const clarity = textAnalysis.pronunciationGuide?.overallClarity || 0;
  const score = Math.round((structure * 0.45) + (confidence * 0.35) + (clarity * 0.2));
  return Math.max(1, Math.min(10, score));
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/content', async (req, res) => {
  try {
    const content = await fetchDailyContent();
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

app.get('/api/progress', (req, res) => {
  try {
    const data = readProgress();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read progress' });
  }
});

app.get('/api/journal', (req, res) => {
  try {
    const data = readJournal();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read journal' });
  }
});

app.post('/api/content/fetch', async (req, res) => {
  try {
    const content = await fetchDailyContent();
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

app.post('/api/habit/save', (req, res) => {
  try {
    const { day, habitName, data, timestamp } = req.body;
    const progress = readProgress();
    const session = progress.sessions.find(s => s.day === day) || { day, date: new Date().toISOString(), habits: {} };
    session.habits[habitName] = { ...data, timestamp };
    if (!progress.sessions.find(s => s.day === day)) {
      progress.sessions.push(session);
    }
    writeProgress(progress);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save habit' });
  }
});

app.post('/api/session/save', (req, res) => {
  try {
    const { day, sessionData } = req.body;
    const progress = readProgress();
    const session = progress.sessions.find(s => s.day === day) || { day, date: new Date().toISOString(), habits: {} };
    Object.assign(session, sessionData);
    session.completed = true;
    if (!progress.sessions.find(s => s.day === day)) {
      progress.sessions.push(session);
    }
    progress.currentDay = Math.max(progress.currentDay, day + 1);
    progress.lastCompleted = new Date().toISOString();
    progress.streak = progress.sessions.filter(s => s.completed).length;
    writeProgress(progress);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save session' });
  }
});

app.post('/api/feedback/article', async (req, res) => {
  try {
    const { transcript, answers } = req.body;
    const prompt = `You are a reading coach. A student just read an article aloud and answered 3 comprehension questions. Article text: ${req.body.articleText || 'N/A'}. Student transcript: ${transcript}. Student answers: ${JSON.stringify(answers)}. Return ONLY valid JSON: {"clarityScore":1-10,"comprehensionScore":1-10,"fillerRate":number,"pacingFeedback":"string","comprehensionFeedback":"string","strongMoment":"string","improveTomorrow":"string","grade":"A-F"}`;
    const raw = await callOllama(TEXT_MODEL, prompt);
    const feedback = parseJsonFromString(raw);
    res.json(feedback);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'Ollama not running' });
    } else {
      res.status(500).json({ error: 'Failed to get article feedback' });
    }
  }
});

app.post('/api/feedback/shadow', async (req, res) => {
  try {
    const { speaker, userWPM, targetWPM, wordAccuracy } = req.body;
    const prompt = `One sentence coaching feedback for a speaker who attempted to shadow ${speaker}. Their WPM: ${userWPM} vs target ${targetWPM}. Word accuracy: ${wordAccuracy}%. Be specific and actionable. Max 20 words.`;
    const feedback = await callOllama(TEXT_MODEL, prompt);
    res.json({ feedback: feedback.trim() });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'Ollama not running' });
    } else {
      res.status(500).json({ error: 'Failed to get shadow feedback' });
    }
  }
});

app.post('/api/plan/adapt', async (req, res) => {
  try {
    const { currentDay, weakestDimension, recentSessions } = req.body;
    const nextDay = currentDay + 1;
    const nextTask = getDailyTask(nextDay);
    const prompt = `You are a speech coach adapting a student's training plan. Student's 3-session history: ${JSON.stringify(recentSessions)}. Weakest dimension: ${weakestDimension}. Tomorrow is Day ${nextDay}: ${nextTask.title}. Current task: ${nextTask.task}. Adapt the task in 2 ways: 1. Add a 5-minute targeted drill for their weakest area BEFORE the main task. 2. Adjust the main task difficulty if needed (make harder if all scores >7, easier if any score <4). Return ONLY JSON: {"adaptedTask":"full modified task description","addedDrill":"specific 5-minute pre-task drill for weakest dimension","difficultyChange":"harder|same|easier","reason":"one sentence explaining why","focusDimension":"filler|pacing|structure|confidence"}`;
    const raw = await callOllama(TEXT_MODEL, prompt);
    const adaptation = parseJsonFromString(raw);
    res.json(adaptation);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'Ollama not running' });
    } else {
      res.status(500).json({ error: 'Failed to adapt plan' });
    }
  }
});

app.post('/api/journal/generate', async (req, res) => {
  try {
    const { day, sessionData } = req.body;
    const prompt = `Write a 3-line daily journal entry for a public speaking student. Today's data: Day ${day}, Overall score: ${sessionData.overallScore}/10, Filler rate: ${sessionData.fillerRate}/min, Best habit: ${sessionData.bestHabit}, Weakest habit: ${sessionData.weakestHabit}. Format exactly: Line 1 (Win): What went well today (specific, not generic). Line 2 (Gap): The one thing that held them back (honest). Line 3 (Tomorrow): One motivating action for tomorrow (specific drill). Total max 70 words. Be a strict coach, not a cheerleader.`;
    const entry = await callOllama(TEXT_MODEL, prompt);
    res.json({ entry: entry.trim() });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'Ollama not running' });
    } else {
      res.status(500).json({ error: 'Failed to generate journal' });
    }
  }
});

app.post('/api/journal/save', (req, res) => {
  try {
    const { day, entry, date } = req.body;
    const journal = readJournal();
    journal.entries.push({ day, date, entry });
    writeJournal(journal);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save journal' });
  }
});

app.post('/api/topic/random', async (req, res) => {
  try {
    const prompt = `Generate a random speaking topic suitable for a 90-second impromptu speech. Make it controversial but safe, interesting, and debatable. Return only the topic as plain text, no quotes or explanation.`;
    const topic = await callOllama(TEXT_MODEL, prompt);
    res.json({ topic: topic.trim() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate topic' });
  }
});

app.post('/api/questions/generate', async (req, res) => {
  try {
    const { transcript } = req.body;
    const prompt = `Based on this speech transcript: "${transcript.slice(0, 500)}". Generate 3 tough follow-up questions that a skeptical audience might ask. Make them specific and challenging. Return as JSON array: ["question1", "question2", "question3"]`;
    const raw = await callOllama(TEXT_MODEL, prompt);
    const questions = JSON.parse(raw);
    res.json({ questions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate questions' });
  }
});

const DAILY_TASKS = [
  { day: 1, title: "The 60-second intro", goal: "Introduce yourself confidently", task: "Speak for exactly 60 seconds. State your name, where you're from, what you do, and one interesting fact about yourself. No filler words. No stopping.", targetDuration: 60, difficulty: "beginner", evaluationCriteria: "clarity, filler count, confidence, completeness" },
  { day: 2, title: "Slow down and breathe", goal: "Master pacing", task: "Explain your favorite hobby to someone who knows nothing about it. Speak slowly. Pause between sentences. Target: 110 WPM. No rushing.", targetDuration: 90, difficulty: "beginner", evaluationCriteria: "pacing, WPM, clarity, pauses" },
  { day: 3, title: "Story time", goal: "Master narrative structure", task: "Tell a 2-minute personal story with a clear beginning (set the scene), middle (conflict or challenge), and end (resolution or lesson learned).", targetDuration: 120, difficulty: "beginner", evaluationCriteria: "story structure, transitions, engagement, clarity" },
  { day: 4, title: "The rule of three", goal: "Use structured arguments", task: "Pick any topic you care about. Give exactly 3 reasons you love or believe in it. Use transition phrases between each point: 'First...', 'Second...', 'Finally...'", targetDuration: 120, difficulty: "beginner", evaluationCriteria: "structure, transitions, argument quality, confidence" },
  { day: 5, title: "Both sides now", goal: "Think on your feet", task: "Choose a controversial but safe topic (e.g., remote work vs office). Argue FOR it for 90 seconds. Then argue AGAINST it for 90 seconds. Commit fully to each side.", targetDuration: 180, difficulty: "intermediate", evaluationCriteria: "argument strength, transitions, commitment, vocabulary" },
  { day: 6, title: "The strong hook", goal: "Open with impact", task: "Prepare 4 different openings for the same 1-minute speech on 'why learning new skills matters'. Each opening must be different: question / shocking stat / story / bold statement.", targetDuration: 240, difficulty: "intermediate", evaluationCriteria: "hook strength, variety, energy, engagement" },
  { day: 7, title: "Confidence boot camp", goal: "Eliminate weak language", task: "Speak for 2 minutes about any topic you know well. BANNED words: think, maybe, sort of, kind of, I guess, I hope, perhaps, probably. Every sentence must be declarative and direct.", targetDuration: 120, difficulty: "intermediate", evaluationCriteria: "confidence signals, banned word count, directness, authority" },
  { day: 8, title: "Explain like I'm five", goal: "Simplify complex ideas", task: "Pick a complex topic from your field (tech, science, business). Explain it in under 2 minutes to a 10-year-old. No jargon. Use analogies. Make them understand.", targetDuration: 120, difficulty: "intermediate", evaluationCriteria: "simplicity, analogy quality, clarity, engagement" },
  { day: 9, title: "Impromptu round", goal: "Speak without preparation", task: "The app will give you a random topic. You have 10 seconds to think. Then speak for 90 seconds. No stopping. No preparing ahead. Pure spontaneous speech.", targetDuration: 90, difficulty: "intermediate", evaluationCriteria: "structure under pressure, filler rate, confidence, completion" },
  { day: 10, title: "The persuader", goal: "Master persuasive speaking", task: "Convince an imaginary skeptical audience to adopt one specific habit (reading, exercise, meditation — your choice). Use evidence, emotion, and a clear call to action.", targetDuration: 180, difficulty: "advanced", evaluationCriteria: "persuasion techniques, emotion, evidence quality, call to action" },
  { day: 11, title: "Q&A simulation", goal: "Handle tough questions", task: "Give a 90-second overview of any project or idea. Then the app will show you 3 tough follow-up questions (generated by AI). Answer each in 30-45 seconds. Stay calm.", targetDuration: 210, difficulty: "advanced", evaluationCriteria: "composure, answer quality, listening, conciseness" },
  { day: 12, title: "The contrast speech", goal: "Use rhetorical devices", task: "Write and deliver a 2-minute speech using at least 3 rhetorical devices: contrast (before vs after), repetition (repeat a key phrase 3 times), and metaphor (compare your idea to something vivid).", targetDuration: 120, difficulty: "advanced", evaluationCriteria: "rhetorical devices used, memorability, language quality, delivery" },
  { day: 13, title: "The 2-minute pitch", goal: "Pitch anything perfectly", task: "Pitch any idea, product, or project you care about in exactly 2 minutes. Must include: what it is, who it's for, why it matters, and what you want from the listener.", targetDuration: 120, difficulty: "advanced", evaluationCriteria: "pitch structure, clarity, confidence, call to action" },
  { day: 14, title: "TED-style talk", goal: "Deliver a mini TED talk", task: "Prepare and deliver a 3-minute talk on 'one idea worth spreading' from your own life or learning. Must have a memorable opening, one story, one surprising insight, and a strong close.", targetDuration: 180, difficulty: "advanced", evaluationCriteria: "all dimensions: structure, story, insight, delivery, memorability" },
  { day: 15, title: "The final assessment", goal: "Show how far you've come", task: "Repeat Day 1's task exactly: introduce yourself for 60 seconds. Then give a 2-minute speech on what you learned about yourself in 15 days. Compare to Day 1 recording.", targetDuration: 180, difficulty: "advanced", evaluationCriteria: "compare to Day 1: filler reduction, confidence gain, structure, WPM control" }
];

function getDailyTask(day) {
  return DAILY_TASKS[day - 1] || DAILY_TASKS[0];
}

// ── NEW SQLITE-BASED API ENDPOINTS ────────────────────────────────────────────

// Check if user exists (called on app load)
app.get('/api/user', (req, res) => {
  const user = getUser();
  if (!user) return res.json({ exists: false });
  const records = db.prepare('SELECT * FROM personal_records WHERE id=1').get();
  res.json({ exists: true, user, records });
});

// Create user profile (first run)
app.post('/api/user/create', (req, res) => {
  try {
    const { name, goal, nativeLanguage, speakingContext } = req.body;
    if (!name || !goal || !nativeLanguage) {
      return res.status(400).json({ error: 'name, goal, nativeLanguage are required' });
    }
    createUser({ name, goal, nativeLanguage, speakingContext });
    // Init personal records row
    db.prepare('INSERT OR IGNORE INTO personal_records (id,user_id) VALUES (1,1)').run();
    res.json({ success: true, user: getUser() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update profile
app.put('/api/user/update', (req, res) => {
  try {
    const allowed = ['name','goal','native_language','target_speaking_context'];
    const fields = {};
    allowed.forEach(k => { if (req.body[k]) fields[k] = req.body[k]; });
    updateUser(fields);
    res.json({ success: true, user: getUser() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated progress endpoint using SQLite
app.get('/api/progress', (req, res) => {
  try {
    const user = getUser();
    if (!user) return res.json({ needsSetup: true });

    const sessions = db.prepare(`
      SELECT s.*, sc.overall_score, sc.filler_per_min, sc.structure_score,
             sc.confidence_score, sc.pacing_score, sc.avg_wpm, sc.body_overall
      FROM sessions s
      LEFT JOIN scores sc ON sc.session_id = s.id
      WHERE s.user_id = 1
      ORDER BY s.day ASC
    `).all();

    const records = db.prepare('SELECT * FROM personal_records WHERE id=1').get();
    const fillerTrends = getFillerTrends();
    const journalEntries = db.prepare(
      'SELECT * FROM journal ORDER BY day DESC LIMIT 15'
    ).all();

    res.json({
      user,
      currentDay: user.current_day,
      streak: user.streak,
      longestStreak: user.longest_streak,
      sessions,
      personalRecords: records,
      fillerTrends,
      journalEntries
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated journal endpoint
app.get('/api/journal', (req, res) => {
  const entries = db.prepare('SELECT * FROM journal ORDER BY day DESC').all();
  res.json({ entries });
});

// Updated habit save endpoint
app.post('/api/habit/save', (req, res) => {
  try {
    const { day, habitName, data, completed, skipped } = req.body;
    const session = getOrCreateSession(day);
    saveHabitResult(session.id, habitName, data, completed !== false, skipped === true);
    res.json({ success: true, sessionId: session.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated feedback/full endpoint
app.post('/api/feedback/full', async (req, res) => {
  try {
    const { transcript, day, duration, task, sentenceData, frameBase64 } = req.body;

    if (!transcript || transcript.split(' ').length < 15) {
      return res.status(400).json({ error: 'transcript_too_short' });
    }

    const session = getOrCreateSession(day);
    const feedback = await getFullFeedback(transcript, day, duration, task, sentenceData||[], frameBase64||null);

    if (!feedback.error) {
      // Save to SQLite
      const scoreData = {
        overallScore: feedback.overallScore,
        fillerCount: feedback.fillerAnalysis?.totalCount || 0,
        fillerPerMin: feedback.fillerAnalysis?.perMinute || 0,
        structureScore: feedback.structureScore,
        confidenceScore: feedback.confidenceScore,
        pacingScore: feedback.pacingScore,
        avgWPM: feedback.avgWPM || 0,
        emotionScore: feedback.emotionAnalysis?.energyLevel || 0,
        bodyPosture: feedback.bodyLanguage?.postureScore || 0,
        bodyEyeContact: feedback.bodyLanguage?.eyeContactScore || 0,
        bodyGestures: feedback.bodyLanguage?.gestureScore || 0,
        bodyExpression: feedback.bodyLanguage?.expressionScore || 0,
        bodyOverall: feedback.bodyLanguage?.overallBodyScore || 0,
        transcript,
        feedback
      };

      saveScores(session.id, scoreData);

      // Save filler breakdown
      if (feedback.fillerAnalysis?.byWord) {
        saveFillerHistory(session.id, feedback.fillerAnalysis.byWord);
      }

      // Update personal records
      updatePersonalRecords(day, scoreData);

      // Export JSON backup
      exportJsonBackup();
    }

    res.json(feedback);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Session complete endpoint
app.post('/api/session/complete', (req, res) => {
  try {
    const { day } = req.body;
    completeSession(day);
    res.json({ success: true, user: getUser() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Updated journal save endpoint
app.post('/api/journal/save', (req, res) => {
  try {
    const { day, entry } = req.body;
    const session = getOrCreateSession(day);
    saveJournalEntry(session.id, day, entry);
    exportJsonBackup();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Camera alerts save endpoint
app.post('/api/alerts/save', (req, res) => {
  try {
    const { day, alerts } = req.body;
    const session = getOrCreateSession(day);
    const insert = db.prepare(
      'INSERT INTO camera_alerts (session_id,timestamp_seconds,alert_type,message) VALUES (?,?,?,?)'
    );
    const insertMany = db.transaction((alts) => {
      for (const a of alts) insert.run(session.id, a.timestamp, a.type, a.message);
    });
    insertMany(alerts);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Data export endpoint
app.get('/api/export', (req, res) => {
  try {
    const backup = exportJsonBackup();
    res.setHeader('Content-Disposition', 'attachment; filename=speakup-backup.json');
    res.json(backup);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset/delete all data endpoint
app.delete('/api/user/reset', (req, res) => {
  try {
    // Backup first
    exportJsonBackup();
    // Clear all data
    db.exec(`
      DELETE FROM camera_alerts;
      DELETE FROM filler_history;
      DELETE FROM journal;
      DELETE FROM scores;
      DELETE FROM habit_results;
      DELETE FROM adaptations;
      DELETE FROM sessions;
      DELETE FROM personal_records;
      DELETE FROM users;
    `);
    res.json({ success: true, message: 'All data deleted. Backup saved to data/.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Start server after database initialization
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Speaking Coach running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});