const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Tesseract = require('tesseract.js');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'super-secret-gpa-key-change-in-production'; // In real app, use environment variables

// Setup Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database Setup ─────────────────────────────────────────────
const dataDir = process.env.DATABASE_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database at', dbPath);
  }
});

// Initialize Tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL
    )
  `);

  // Attempt to add email column if it doesn't exist (for backward compatibility)
  db.run("ALTER TABLE users ADD COLUMN email TEXT", (err) => {
    if (err) console.log("Note: email column already exists or error:", err.message);
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS gpa_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      courses_data TEXT NOT NULL,
      gpa REAL NOT NULL,
      classification TEXT NOT NULL,
      total_credits INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS visitors (
      visitor_id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

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
app.post('/api/visitors', (req, res) => {
  const { visitor_id } = req.body;
  
  if (!visitor_id) {
    return res.status(400).json({ success: false, error: 'Visitor ID required' });
  }

  // Insert safely (ignores if exists due to PRIMARY KEY)
  db.run('INSERT OR IGNORE INTO visitors (visitor_id) VALUES (?)', [visitor_id], (err) => {
    if (err) {
      console.error('Error tracking visitor:', err);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    // Return the total count
    db.get('SELECT COUNT(*) AS count FROM visitors', [], (err, row) => {
      if (err) {
        console.error('Error counting visitors:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      res.json({ success: true, count: row.count });
    });
  });
});

// ─── Grading Logic ────────────────────────────────────────────
const GRADE_MAP = {
  'A+': 4.0, 'A':  4.0, 'A-': 3.7, 'B+': 3.3, 'B':  3.0, 'B-': 2.7,
  'C+': 2.3, 'C':  2.0, 'C-': 1.7, 'D+': 1.3, 'D':  1.0, 'E':  0.0,
};

const VALID_GRADES = Object.keys(GRADE_MAP);

function getClassification(gpa) {
  if (gpa >= 3.70) return 'First Class Honours';
  if (gpa >= 3.30) return 'Second Class Upper Division';
  if (gpa >= 2.70) return 'Second Class Lower Division';
  if (gpa >= 2.00) return 'Third Class';
  if (gpa >= 1.00) return 'Pass';
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
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ success: false, error: 'Username, email, and password required' });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Invalid email format' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    db.run('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', [username, email, hash], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          if (err.message.includes('users.email')) {
            return res.status(400).json({ success: false, error: 'Email already registered' });
          }
          return res.status(400).json({ success: false, error: 'Username already taken' });
        }
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      
      const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ success: true, token, username });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

/**
 * POST /api/login
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });
    if (!user) return res.status(400).json({ success: false, error: 'Invalid username or password' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ success: false, error: 'Invalid username or password' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, username: user.username });
  });
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
app.post('/api/save-gpa', authenticateToken, (req, res) => {
  const { gpa, classification, totalCredits, courses } = req.body;
  
  if (gpa == null || !classification || !courses) {
    return res.status(400).json({ success: false, error: 'Incomplete data to save' });
  }

  const coursesJson = JSON.stringify(courses);
  
  db.run(
    'INSERT INTO gpa_records (user_id, courses_data, gpa, classification, total_credits) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, coursesJson, gpa, classification, totalCredits],
    function(err) {
      if (err) return res.status(500).json({ success: false, error: 'Failed to save record' });
      res.json({ success: true, message: 'Result saved successfully', recordId: this.lastID });
    }
  );
});

/**
 * GET /api/my-records
 * Protected route to get user's saved records
 */
app.get('/api/my-records', authenticateToken, (req, res) => {
  db.all('SELECT * FROM gpa_records WHERE user_id = ? ORDER BY created_at DESC', [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch records' });
    
    // Parse JSON
    const records = rows.map(r => ({
      ...r,
      courses_data: JSON.parse(r.courses_data)
    }));
    
    res.json({ success: true, data: records });
  });
});

// ─── OCR Route ────────────────────────────────────────────────
/**
 * POST /api/scan-image
 * Extracts text from an uploaded image using Tesseract.js on the server.
 */
app.post('/api/scan-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image uploaded' });
  }

  try {
    const { data: { text } } = await Tesseract.recognize(
      req.file.buffer,
      'eng',
      {
        logger: m => {
          // You could optionally log progress on the server
          // console.log(m);
        }
      }
    );
    res.json({ success: true, text });
  } catch (err) {
    console.error('OCR Processing Error:', err);
    res.status(500).json({ success: false, error: 'Failed to process image' });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎓 GPA Calculator server running at http://0.0.0.0:${PORT}\n`);
});
