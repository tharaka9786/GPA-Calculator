require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Gemini Client Setup ──────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const JWT_SECRET = 'super-secret-gpa-key-change-in-production'; // In real app, use environment variables

// Setup Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database Setup ─────────────────────────────────────────────
let pool;
let isDbConnected = false;

// Retrieve Postgres URL from environment (Neon standard connection string)
const dbUrl = process.env.POSTGRES_URL;

if (dbUrl) {
  pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  pool.on('connect', () => {
    isDbConnected = true;
  });
} else {
  console.warn('\n⚠️ WARNING: POSTGRES_URL is not set in your .env file!');
  console.warn('The application is running in "No Database" mode. Visitor counts and login will fail.');
  console.warn('If you are running locally, copy the POSTGRES_URL from your Vercel database and paste it into your .env file.\n');
}

// Initialize Tables
let dbInitPromise = null;
const initDB = () => {
  if (!pool) return Promise.resolve();
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL
          )
        `);

        try {
          await pool.query("ALTER TABLE users ADD COLUMN email TEXT");
        } catch (err) {
          if (err.code !== '42701') console.log("Note: email column error:", err.message);
        }

        await pool.query(`
          CREATE TABLE IF NOT EXISTS gpa_records (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            courses_data TEXT NOT NULL,
            gpa REAL NOT NULL,
            classification TEXT NOT NULL,
            total_credits INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
          )
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS visitors (
            visitor_id TEXT PRIMARY KEY,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
      } catch (err) {
        console.error('Database initialization error:', err);
      }
    })();
  }
  return dbInitPromise;
};

// ─── Auth Middleware ──────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ success: false, error: 'Access denied. Please log in.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

// ─── Visitor Counter (Database Backed) ────────────────────────
app.post('/api/visitors', async (req, res) => {
  await initDB();
  const { visitor_id } = req.body;
  
  if (!visitor_id) {
    return res.status(400).json({ success: false, error: 'Visitor ID required' });
  }

  try {
    // Insert safely (ignores if exists due to PRIMARY KEY)
    await pool.query('INSERT INTO visitors (visitor_id) VALUES ($1) ON CONFLICT (visitor_id) DO NOTHING', [visitor_id]);

    // Return the total count
    const result = await pool.query('SELECT COUNT(*) AS count FROM visitors');
    res.json({ success: true, count: result.rows[0].count });
  } catch (err) {
    console.error('Error tracking visitor:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ─── Grading Logic ────────────────────────────────────────────
const GRADE_MAP = {
  'A+': 4.0, 'A':  4.0, 'A-': 3.7, 'B+': 3.3, 'B':  3.0, 'B-': 2.7,
  'C+': 2.3, 'C':  2.0, 'C-': 1.7, 'D+': 1.3, 'D':  1.0, 'E':  0.0,
};

const VALID_GRADES = Object.keys(GRADE_MAP);

function getClassification(gpa) {
  if (gpa >= 3.70) return 'First Class';
  if (gpa >= 3.30) return 'Second Class (Upper Division)';
  if (gpa >= 3.00) return 'Second Class (Lower Division)';
  if (gpa >= 2.00) return 'Pass';
  return 'Fail';
}

function normalizeGrade(grade) {
  return grade.replace(/\s+PLUS$/i, '+').replace(/\s+MINUS$/i, '-').replace(/\s+/g, '').toUpperCase();
}

// ─── API Routes ───────────────────────────────────────────────

/**
 * POST /api/signup
 */
app.post('/api/signup', async (req, res) => {
  await initDB();
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ success: false, error: 'Username, email, and password required' });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Invalid email format' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [username, email, hash]
    );
    
    const token = jwt.sign({ id: result.rows[0].id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, username });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint && err.constraint.includes('email')) {
        return res.status(400).json({ success: false, error: 'Email already registered' });
      }
      return res.status(400).json({ success: false, error: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

/**
 * POST /api/login
 */
app.post('/api/login', async (req, res) => {
  await initDB();
  const { username, password } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ success: false, error: 'Invalid username or password' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

/**
 * POST /api/calculate-gpa
 */
app.post('/api/calculate-gpa', (req, res) => {
  try {
    const { courses } = req.body;
    if (!courses || !Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ success: false, error: 'Please provide at least one course.' });
    }

    let totalCredits = 0;
    let totalWeightedPoints = 0;
    const processedCourses = [];
    let pendingCount = 0;

    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const courseName = course.courseName?.trim() || `Course ${i + 1}`;
      const courseCode = course.courseCode?.trim() || '';
      const grade = course.grade?.trim().toUpperCase();
      const credits = Number(course.credits);

      if (grade === 'PENDING' || !grade) {
        pendingCount++;
        processedCourses.push({
          courseName, courseCode, credits: isNaN(credits) ? 0 : credits,
          grade: 'Pending', gradePoint: 0, weightedPoints: 0, isPending: true,
        });
        continue;
      }

      const normalizedGrade = normalizeGrade(grade);
      if (!VALID_GRADES.includes(normalizedGrade)) {
        return res.status(400).json({ success: false, error: `Invalid grade "${course.grade}"` });
      }

      if (isNaN(credits) || credits <= 0 || !Number.isInteger(credits)) {
        return res.status(400).json({ success: false, error: `Invalid credits for "${courseName}"` });
      }

      const gradePoint = GRADE_MAP[normalizedGrade];
      const weightedPoints = credits * gradePoint;
      totalCredits += credits;
      totalWeightedPoints += weightedPoints;

      processedCourses.push({
        courseName, courseCode, credits, grade: normalizedGrade,
        gradePoint, weightedPoints: parseFloat(weightedPoints.toFixed(2)), isPending: false,
      });
    }

    const gpa = totalCredits > 0 ? parseFloat((totalWeightedPoints / totalCredits).toFixed(2)) : 0;
    const classification = getClassification(gpa);

    res.json({
      success: true,
      data: { courses: processedCourses, totalCredits, totalWeightedPoints: parseFloat(totalWeightedPoints.toFixed(2)), gpa, classification, pendingCount }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/save-gpa
 * Protected route to save a calculated GPA result
 */
app.post('/api/save-gpa', authenticateToken, async (req, res) => {
  await initDB();
  try {
    const { gpa, classification, totalCredits, courses } = req.body;
  
    if (gpa == null || !classification || !courses) {
      return res.status(400).json({ success: false, error: 'Incomplete data to save' });
    }

    const coursesJson = JSON.stringify(courses);
    
    const result = await pool.query(
      'INSERT INTO gpa_records (user_id, courses_data, gpa, classification, total_credits) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.user.id, coursesJson, gpa, classification, totalCredits]
    );
    res.json({ success: true, message: 'Result saved successfully', recordId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to save record' });
  }
});

/**
 * GET /api/my-records
 * Protected route to get user's saved records
 */
app.get('/api/my-records', authenticateToken, async (req, res) => {
  await initDB();
  try {
    const result = await pool.query('SELECT * FROM gpa_records WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    
    // Parse JSON
    const records = result.rows.map(r => ({
      ...r,
      courses_data: JSON.parse(r.courses_data)
    }));
    
    res.json({ success: true, data: records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch records' });
  }
});

// ─── Excel Upload Route ────────────────────────────────────────
/**
 * POST /api/upload-excel
 * Reads an uploaded Excel file and returns its rows as a JSON array.
 */
app.post('/api/upload-excel', upload.single('excel'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    // Read the buffer using xlsx
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    
    // Get the first worksheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to 2D array of rows
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    
    res.json({ success: true, data });
  } catch (err) {
    console.error('Excel Processing Error:', err);
    res.status(500).json({ success: false, error: 'Failed to process Excel file' });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * POST /api/gpa-advisor
 */
app.post('/api/gpa-advisor', async (req, res) => {
  try {
    const { gpa, courses, classification } = req.body;
    
    let prompt = `You are a highly encouraging, friendly, and expert university academic advisor at the University of Kelaniya.
You are analyzing a student's current GPA and course results to provide personalized advice.
The response MUST be written beautifully in the SINHALA language.
Use markdown to make the response highly attractive (bolding, lists, emojis).

Current GPA: ${gpa}
Classification: ${classification}

`;
    
    const pendingCourses = courses.filter(c => c.isPending);
    
    if (gpa < 4.0) {
      prompt += `The student has a GPA of ${gpa} and wants to increase it towards 4.0 or at least improve their class. Give them a strategic plan on how many credits of 'A' or 'A+' they might need, or general advice on focusing on high-credit subjects.\n`;
    } else {
      prompt += `The student has a perfect 4.0 GPA! Congratulate them warmly and advise them to maintain this excellence.\n`;
    }

    if (pendingCourses.length > 0) {
      prompt += `\nThe student has the following Pending/Absent/Medical/Repeat subjects:\n`;
      pendingCourses.forEach(c => {
        prompt += `- ${c.courseCode} ${c.courseName} (${c.credits} Credits)\n`;
      });
      prompt += `Explain exactly what grade they should target for these specific subjects when they sit for the exams to maximize their GPA.\n`;
    }

    prompt += `\nKeep the tone professional yet very supportive and engaging. Provide actionable steps. Do NOT output english text, everything must be in native Sinhala (you can use english letters for course codes/grades like 'A', 'B+', 'COST 11012').`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    res.json({ success: true, advice: response.text });
  } catch (err) {
    console.error('Gemini Error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate AI advice.' });
  }
});

// ─── Start Server / Export for Vercel ─────────────────────────
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎓 GPA Calculator server running at http://0.0.0.0:${PORT}\n`);
  });
}
