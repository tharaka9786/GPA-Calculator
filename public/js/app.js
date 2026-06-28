/* ═══════════════════════════════════════════════════════════
   GPA Calculator — Frontend Application Logic
   Grade-based input (matches university result sheet)
   ═══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ── Grade → GPV mapping ──────────────────────────────────
  const GRADE_GPV = {
    'A+': 4.0,
    'A':  4.0,
    'A-': 3.7,
    'B+': 3.3,
    'B':  3.0,
    'B-': 2.7,
    'C+': 2.3,
    'C':  2.0,
    'C-': 1.7,
    'D+': 1.3,
    'D':  1.0,
    'E':  0.0,
  };

  // Ordered list of grades for the dropdown
  const GRADE_OPTIONS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'E'];

  // Grading system with marks ranges (for the reference table)
  const GRADING_SYSTEM = [
    { min: 85, max: 100, grade: 'A+', gpa: 4.0 },
    { min: 70, max: 84,  grade: 'A',  gpa: 4.0 },
    { min: 65, max: 69,  grade: 'A-', gpa: 3.7 },
    { min: 60, max: 64,  grade: 'B+', gpa: 3.3 },
    { min: 55, max: 59,  grade: 'B',  gpa: 3.0 },
    { min: 50, max: 54,  grade: 'B-', gpa: 2.7 },
    { min: 45, max: 49,  grade: 'C+', gpa: 2.3 },
    { min: 40, max: 44,  grade: 'C',  gpa: 2.0 },
    { min: 35, max: 39,  grade: 'C-', gpa: 1.7 },
    { min: 30, max: 34,  grade: 'D+', gpa: 1.3 },
    { min: 25, max: 29,  grade: 'D',  gpa: 1.0 },
    { min: 0,  max: 24,  grade: 'E',  gpa: 0.0 },
  ];

  // ── DOM Elements ─────────────────────────────────────────
  const courseRowsContainer = document.getElementById('course-rows');
  const btnAddCourse = document.getElementById('btn-add-course');
  const btnCalculate = document.getElementById('btn-calculate');
  const errorMessage = document.getElementById('error-message');
  const resultsCard = document.getElementById('results-card');
  const gpaValueEl = document.getElementById('gpa-value');
  const gpaClassEl = document.getElementById('gpa-class');
  const gpaPendingNote = document.getElementById('gpa-pending-note');
  const gpaRingFill = document.getElementById('gpa-ring-fill');
  const breakdownTable = document.getElementById('breakdown-table');
  const breakdownSummary = document.getElementById('breakdown-summary');
  const gradingTableEl = document.getElementById('grading-table');
  const visitorCountEl = document.getElementById('visitor-count');
  
  // Auth Elements
  const authNav = document.getElementById('auth-nav');

  // OCR Elements
  const btnScanImage = document.getElementById('btn-scan-image');
  const resultImageInput = document.getElementById('result-image-input');
  const scanOverlay = document.getElementById('scan-overlay');
  const scanStatus = document.getElementById('scan-status');
  const scanProgressFill = document.getElementById('scan-progress-fill');
  const btnSaveResult = document.getElementById('btn-save-result');
  const saveMessage = document.getElementById('save-message');
  let lastCalculatedResult = null;

  let courseCounter = 0;

  // ── Initialize ───────────────────────────────────────────
  function init() {
    injectSVGGradient();
    renderGradingTable();
    fetchVisitorCount();
    updateAuthNav();

    // Start with 4 default rows
    for (let i = 0; i < 4; i++) {
      addCourseRow(true); // Prevent focus on initial load
    }

    btnAddCourse.addEventListener('click', () => addCourseRow(false));
    btnCalculate.addEventListener('click', handleCalculate);
    if (btnSaveResult) {
      btnSaveResult.addEventListener('click', handleSaveResult);
    }
    
    const btnUploadExcel = document.getElementById('btn-upload-excel');
    const resultExcelInput = document.getElementById('result-excel-input');

    // Excel Upload Event Listeners
    if (btnUploadExcel && resultExcelInput) {
      btnUploadExcel.addEventListener('click', () => {
        resultExcelInput.click();
      });
      resultExcelInput.addEventListener('change', handleExcelUpload);
    }
  }

  // ── Excel Processing ─────────────────────────────────────
  async function handleExcelUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Show overlay
    scanOverlay.classList.remove('hidden');
    scanStatus.textContent = "Uploading Excel to Server...";
    scanProgressFill.style.width = "30%";

    try {
      const formData = new FormData();
      formData.append('excel', file);

      scanStatus.textContent = "Parsing Excel Data...";
      scanProgressFill.style.width = "70%";

      const response = await fetch('/api/upload-excel', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to upload Excel file");
      }

      scanStatus.textContent = "Populating Courses...";
      scanProgressFill.style.width = "100%";
      
      // Process Data
      setTimeout(() => {
        processExcelData(result.data);
        scanOverlay.classList.add('hidden');
        event.target.value = ""; // Reset input
      }, 500);

    } catch (err) {
      console.error("Excel Error:", err);
      alert("Failed to read the Excel file. Please try again.");
      scanOverlay.classList.add('hidden');
      event.target.value = "";
    }
  }

  function processExcelData(rows) {
    if (!rows || rows.length === 0) {
      alert("The uploaded Excel file appears to be empty.");
      return;
    }

    let coursesAdded = 0;

    // Clear existing empty rows first
    const existingRows = Array.from(courseRowsContainer.querySelectorAll('.course-row'));
    existingRows.forEach(row => {
      const code = row.querySelector('.col-code-input').value.trim();
      const name = row.querySelector('.col-name-input').value.trim();
      if (!code && !name) {
        row.remove();
      }
    });

    // Strategy: Look through the rows to find column indices for Code, Name, Grade, Credits.
    // We can do a fuzzy match on the first few rows to find the headers.
    let headerMap = {
      code: -1,
      name: -1,
      grade: -1,
      credits: -1
    };

    let dataStartIndex = 0;

    // Find Headers
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const row = rows[i];
      if (!row || !Array.isArray(row)) continue;

      let foundAnyHeader = false;
      row.forEach((cell, index) => {
        if (typeof cell !== 'string') return;
        const lowerCell = cell.toLowerCase().trim();
        if (lowerCell.includes('code') || lowerCell.includes('unit')) {
          headerMap.code = index; foundAnyHeader = true;
        } else if (lowerCell.includes('title') || lowerCell.includes('name') || lowerCell.includes('course')) {
          headerMap.name = index; foundAnyHeader = true;
        } else if (lowerCell.includes('grade')) {
          headerMap.grade = index; foundAnyHeader = true;
        } else if (lowerCell.includes('credit')) {
          headerMap.credits = index; foundAnyHeader = true;
        }
      });

      if (foundAnyHeader) {
        dataStartIndex = i + 1;
        break;
      }
    }

    // If we couldn't find explicit headers, assume a standard order: [Code, Name, Grade, Credits]
    if (headerMap.code === -1 && headerMap.grade === -1) {
      headerMap = { code: 0, name: 1, grade: 2, credits: 3 };
    }

    // Process rows
    for (let i = dataStartIndex; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !Array.isArray(row) || row.length === 0) continue;

      let rawCode = (row[headerMap.code] || "").toString().trim();
      let rawName = (row[headerMap.name] || "").toString().trim();
      let rawGrade = (row[headerMap.grade] || "").toString().trim().toUpperCase();
      let rawCredits = (row[headerMap.credits] || "").toString().trim();

      // Skip empty rows
      if (!rawCode && !rawName) continue;

      // Normalize Grade
      rawGrade = rawGrade.replace(/\s*PLUS/i, '+').replace(/\s*MINUS/i, '-').replace(/\s+/g, '');
      if (rawGrade === 'F') rawGrade = 'E';
      if (!GRADE_GPV.hasOwnProperty(rawGrade)) rawGrade = "";

      // Add it to the UI
      addCourseRow(false, {
        code: rawCode,
        name: rawName,
        grade: rawGrade,
        credits: rawCredits
      });
      coursesAdded++;
    }

    if (coursesAdded > 0) {
      // Trigger calculation automatically
      setTimeout(handleCalculate, 300);
    } else {
      alert("No valid courses were detected in the Excel file. Please ensure it has columns for Code, Title, Grade, and Credits.");
      if (courseRowsContainer.querySelectorAll('.course-row').length === 0) {
        addCourseRow(false);
      }
    }
  }

  function updateAuthNav() {
    if (!authNav) return;
    const token = localStorage.getItem('gpa_token');
    const username = localStorage.getItem('gpa_username');

    if (token && username) {
      authNav.innerHTML = `
        <span style="color: var(--text-secondary); margin-right: 12px;">Welcome, <strong>${username}</strong>!</span>
        <button id="btn-logout" style="background: transparent; border: 1px solid var(--accent-3); color: var(--accent-3); padding: 4px 12px; border-radius: 4px; cursor: pointer;">Logout</button>
      `;
      document.getElementById('btn-logout').addEventListener('click', () => {
        localStorage.removeItem('gpa_token');
        localStorage.removeItem('gpa_username');
        window.location.reload();
      });
    } else {
      authNav.innerHTML = `
        <a href="/login.html" style="color: var(--text-secondary); text-decoration: none; margin-right: 16px; font-weight: 500;">Login</a>
        <a href="/signup.html" style="background: var(--accent-1); color: white; text-decoration: none; padding: 6px 14px; border-radius: 4px; font-weight: 600;">Sign up</a>
      `;
    }
  }

  // ── Fetch Visitor Count (Unique Session) ─────────────────
  async function fetchVisitorCount() {
    if (!visitorCountEl) return;
    
    // Generate or retrieve a unique ID for this browser
    let visitorId = localStorage.getItem('gpa_visitor_id');
    if (!visitorId) {
      visitorId = 'v_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('gpa_visitor_id', visitorId);
    }

    try {
      const response = await fetch('/api/visitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId })
      });
      const data = await response.json();
      if (data.success) {
        visitorCountEl.textContent = data.count.toLocaleString();
      }
    } catch (err) {
      console.error('Failed to fetch visitor count', err);
    }
  }

  // ── Inject SVG Gradient Def ──────────────────────────────
  function injectSVGGradient() {
    const svg = document.querySelector('.gpa-svg');
    if (!svg) return;

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="gpaGradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6c5ce7" />
        <stop offset="50%" stop-color="#a29bfe" />
        <stop offset="100%" stop-color="#00cec9" />
      </linearGradient>
    `;
    svg.prepend(defs);
  }

  // ── Get Grade CSS Class ──────────────────────────────────
  function getGradeClass(grade) {
    if (!grade) return '';
    if (grade === 'Pending') return 'grade-pending';
    const letter = grade.charAt(0).toUpperCase();
    switch (letter) {
      case 'A': return 'grade-a';
      case 'B': return 'grade-b';
      case 'C': return 'grade-c';
      case 'D': return 'grade-d';
      case 'E': return 'grade-e';
      default: return '';
    }
  }

  // ── Build Grade Dropdown Options ─────────────────────────
  function buildGradeOptions() {
    let html = '<option value="" disabled selected>Grade</option>';
    for (const grade of GRADE_OPTIONS) {
      html += `<option value="${grade}">${grade} (${GRADE_GPV[grade].toFixed(1)})</option>`;
    }
    html += '<option value="Pending">Pending</option>';
    return html;
  }

  // ── Add Course Row ───────────────────────────────────────
  function addCourseRow(preventFocus = false, initialData = null) {
    courseCounter++;
    const num = courseCounter;
    const row = document.createElement('div');
    row.className = 'course-row';
    row.dataset.id = num;
    row.style.animationDelay = '0s';

    const defaultCode = initialData ? initialData.code : '';
    const defaultName = initialData ? initialData.name : '';
    const defaultCredits = initialData ? initialData.credits : '';
    let gradeHtml = buildGradeOptions();

    row.innerHTML = `
      <span class="row-num">${num}</span>
      <input
        type="text"
        class="course-input col-code-input"
        placeholder="e.g. LISC 11313"
        id="course-code-${num}"
        aria-label="Course code"
        value="${escapeHtml(defaultCode)}"
      />
      <input
        type="text"
        class="course-input col-name-input"
        placeholder="Course name"
        id="course-name-${num}"
        aria-label="Course name"
        value="${escapeHtml(defaultName)}"
      />
      <select
        class="grade-select col-grade-select"
        id="course-grade-${num}"
        aria-label="Grade"
      >
        ${gradeHtml}
      </select>
      <input
        type="number"
        class="course-input col-credits-input"
        placeholder="Credits"
        min="1"
        max="30"
        id="course-credits-${num}"
        aria-label="Credit hours"
        value="${defaultCredits}"
      />
      <span class="gpv-display" id="gpv-display-${num}">—</span>
      <button class="btn-delete" title="Remove course" aria-label="Remove course" data-delete="${num}">✕</button>
    `;

    courseRowsContainer.appendChild(row);

    const gradeSelect = row.querySelector('.col-grade-select');
    if (initialData && initialData.grade) {
      gradeSelect.value = initialData.grade;
    }
    
    // Attach events
    gradeSelect.addEventListener('change', () => updateGPVDisplay(num));

    const creditsInput = row.querySelector('.col-credits-input');
    creditsInput.addEventListener('blur', () => validateCredits(creditsInput));

    const deleteBtn = row.querySelector('.btn-delete');
    deleteBtn.addEventListener('click', () => removeCourseRow(row));

    if (initialData && initialData.grade) {
      updateGPVDisplay(num);
    }

    // Focus the code input if not prevented
    if (!preventFocus && !initialData) {
      const codeInput = row.querySelector('.col-code-input');
      if (codeInput) codeInput.focus();
    }
  }

  // ── Remove Course Row ────────────────────────────────────
  function removeCourseRow(row) {
    const allRows = courseRowsContainer.querySelectorAll('.course-row');
    if (allRows.length <= 1) {
      showError('You need at least one course.');
      return;
    }

    row.classList.add('removing');
    row.addEventListener('animationend', () => {
      row.remove();
      renumberRows();
    });
  }

  // ── Renumber Rows ────────────────────────────────────────
  function renumberRows() {
    const rows = courseRowsContainer.querySelectorAll('.course-row');
    rows.forEach((row, idx) => {
      const numEl = row.querySelector('.row-num');
      if (numEl) numEl.textContent = idx + 1;
    });
  }

  // ── Update GPV Display when grade changes ────────────────
  function updateGPVDisplay(id) {
    const gradeSelect = document.getElementById(`course-grade-${id}`);
    const gpvDisplay = document.getElementById(`gpv-display-${id}`);
    if (!gradeSelect || !gpvDisplay) return;

    const grade = gradeSelect.value;

    // Reset classes
    gradeSelect.className = 'grade-select col-grade-select';

    if (!grade || grade === '') {
      gpvDisplay.textContent = '—';
      gpvDisplay.className = 'gpv-display';
      return;
    }

    if (grade === 'Pending') {
      gpvDisplay.textContent = '—';
      gpvDisplay.className = 'gpv-display';
      gradeSelect.classList.add('grade-pending');
      return;
    }

    const gpv = GRADE_GPV[grade];
    if (gpv !== undefined) {
      gpvDisplay.textContent = gpv.toFixed(1);
      gpvDisplay.className = 'gpv-display has-value';
      gradeSelect.classList.add(getGradeClass(grade));

      // Pop animation
      gpvDisplay.style.transform = 'scale(1.3)';
      setTimeout(() => { gpvDisplay.style.transform = 'scale(1)'; }, 200);
    }
  }

  // ── Validate Credits ─────────────────────────────────────
  function validateCredits(input) {
    const val = parseInt(input.value, 10);
    if (input.value.trim() !== '' && (isNaN(val) || val <= 0)) {
      input.classList.add('input-error');
    } else {
      input.classList.remove('input-error');
    }
  }

  // ── Show / Hide Error ────────────────────────────────────
  function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.add('visible');
    setTimeout(() => hideError(), 5000);
  }

  function hideError() {
    errorMessage.classList.remove('visible');
  }

  // ── Handle Calculate ─────────────────────────────────────
  async function handleCalculate() {
    hideError();

    const rows = courseRowsContainer.querySelectorAll('.course-row');
    const courses = [];

    for (const row of rows) {
      const codeInput = row.querySelector('.col-code-input');
      const nameInput = row.querySelector('.col-name-input');
      const gradeSelect = row.querySelector('.col-grade-select');
      const creditsInput = row.querySelector('.col-credits-input');

      const courseCode = codeInput.value.trim();
      const courseName = nameInput.value.trim();
      const grade = gradeSelect.value;
      const credits = creditsInput.value.trim();

      // Skip completely empty rows
      if (!courseCode && !courseName && !grade && !credits) {
        continue;
      }

      // Validate grade selection
      if (!grade) {
        showError('Please select a grade for all courses.');
        gradeSelect.classList.add('input-error');
        return;
      }

      // For pending courses, credits are optional (will be excluded from GPA)
      if (grade === 'Pending') {
        courses.push({
          courseCode,
          courseName: courseName || courseCode || `Course ${courses.length + 1}`,
          grade: 'Pending',
          credits: credits ? parseInt(credits, 10) : 0,
        });
        continue;
      }

      // Validate credits for non-pending courses
      if (credits === '') {
        showError('Please enter credits for all graded courses.');
        creditsInput.classList.add('input-error');
        return;
      }

      const creditsNum = parseInt(credits, 10);
      if (isNaN(creditsNum) || creditsNum <= 0) {
        showError(`Invalid credits value. Must be a positive number.`);
        creditsInput.classList.add('input-error');
        return;
      }

      // Clear errors
      gradeSelect.classList.remove('input-error');
      creditsInput.classList.remove('input-error');

      courses.push({
        courseCode,
        courseName: courseName || courseCode || `Course ${courses.length + 1}`,
        grade,
        credits: creditsNum,
      });
    }

    if (courses.length === 0) {
      showError('Please add at least one course with a grade.');
      return;
    }

    // Show loading state
    btnCalculate.classList.add('loading');
    btnCalculate.disabled = true;

    try {
      const response = await fetch('/api/calculate-gpa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courses }),
      });

      const data = await response.json();

      if (!data.success) {
        showError(data.error || 'Calculation failed.');
      } else {
        // Display success UI
        displayResults(data.data);
        
        // Store result for saving
        lastCalculatedResult = data.data;
        if (btnSaveResult && localStorage.getItem('gpa_token')) {
          btnSaveResult.classList.remove('hidden');
          if (saveMessage) saveMessage.textContent = '';
        }
      }
    } catch (err) {
      console.error('Fetch error:', err);
      showError('Could not connect to the server. Please try again.');
    } finally {
      btnCalculate.classList.remove('loading');
      btnCalculate.disabled = false;
    }
  }

  // ── Display Results ──────────────────────────────────────
  function displayResults(result) {
    // Show card
    resultsCard.classList.remove('hidden');
    resultsCard.classList.add('visible');

    // Animate GPA ring
    const gpa = result.gpa;
    const maxGpa = 4.0;
    const circumference = 2 * Math.PI * 88; // r=88
    const offset = circumference - (gpa / maxGpa) * circumference;

    // Reset first
    gpaRingFill.style.transition = 'none';
    gpaRingFill.style.strokeDashoffset = circumference;
    // Force reflow
    gpaRingFill.getBoundingClientRect();
    // Animate
    gpaRingFill.style.transition = 'stroke-dashoffset 1.5s cubic-bezier(0.4, 0, 0.2, 1)';
    gpaRingFill.style.strokeDashoffset = offset;

    // Animate GPA number
    animateGPAValue(0, gpa, 1200);

    // Classification
    gpaClassEl.textContent = result.classification;

    // Pending note
    if (result.pendingCount > 0) {
      gpaPendingNote.textContent = `⏳ ${result.pendingCount} course${result.pendingCount > 1 ? 's' : ''} pending — excluded from GPA calculation`;
      gpaPendingNote.classList.remove('hidden');
    } else {
      gpaPendingNote.classList.add('hidden');
    }

    // Breakdown table
    let breakdownHTML = `
      <div class="breakdown-row header-row">
        <span>Code</span>
        <span>Course</span>
        <span>Credits</span>
        <span>Grade</span>
        <span>Weighted</span>
      </div>
    `;

    result.courses.forEach((course, idx) => {
      const isPending = course.isPending;
      const rowClass = isPending ? 'breakdown-row pending-row' : 'breakdown-row';
      breakdownHTML += `
        <div class="${rowClass}" style="animation-delay: ${idx * 0.05}s">
          <span class="course-code-cell">${escapeHtml(course.courseCode || '—')}</span>
          <span class="course-name-cell">${escapeHtml(course.courseName)}</span>
          <span>${isPending ? '—' : course.credits}</span>
          <span class="grade-badge ${getGradeClass(course.grade)}" style="padding:3px 8px; font-size:0.78rem;">
            ${isPending ? 'Pending' : `${course.grade} (${course.gradePoint})`}
          </span>
          <span>${isPending ? '—' : course.weightedPoints}</span>
        </div>
      `;
    });

    breakdownTable.innerHTML = breakdownHTML;

    // Summary
    breakdownSummary.innerHTML = `
      <span>Total Credits: <strong>${result.totalCredits}</strong></span>
      <span>Total Weighted: <strong>${result.totalWeightedPoints}</strong></span>
      <span>GPA: <strong>${result.gpa}</strong></span>
    `;

    // Scroll to results
    setTimeout(() => {
      resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);
  }

  // ── Animate GPA Value (count up) ─────────────────────────
  function animateGPAValue(start, end, duration) {
    const startTime = performance.now();

    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = start + (end - start) * eased;

      gpaValueEl.textContent = current.toFixed(2);

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    }

    requestAnimationFrame(update);
  }

  // ── Render Grading Table ─────────────────────────────────
  function renderGradingTable() {
    let html = '';
    GRADING_SYSTEM.forEach((entry, idx) => {
      const rangeStr = entry.min === entry.max
        ? `${entry.min}`
        : `${entry.min}–${entry.max}`;

      html += `
        <div class="grading-item" style="animation-delay: ${idx * 0.04}s">
          <span class="grading-marks">${rangeStr}</span>
          <span class="grading-grade grade-badge ${getGradeClass(entry.grade)}">${entry.grade}</span>
          <span class="grading-gpa">${entry.gpa.toFixed(1)}</span>
        </div>
      `;
    });
    gradingTableEl.innerHTML = html;
  }

  // ── Escape HTML ──────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Save Result ──────────────────────────────────────────
  async function handleSaveResult() {
    if (!lastCalculatedResult || !btnSaveResult) return;
    
    const token = localStorage.getItem('gpa_token');
    if (!token) return;

    btnSaveResult.classList.add('loading');
    if (saveMessage) {
      saveMessage.textContent = '';
      saveMessage.style.color = 'var(--text-secondary)';
    }

    try {
      const response = await fetch('/api/save-gpa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          gpa: lastCalculatedResult.gpa,
          classification: lastCalculatedResult.classification,
          totalCredits: lastCalculatedResult.totalCredits,
          courses: lastCalculatedResult.courses
        })
      });

      const data = await response.json();
      
      if (data.success) {
        if (saveMessage) {
          saveMessage.textContent = '✅ Result saved successfully!';
          saveMessage.style.color = '#00e676';
        }
        btnSaveResult.classList.add('hidden');
      } else {
        if (saveMessage) {
          saveMessage.textContent = '❌ Failed to save: ' + (data.error || 'Unknown error');
          saveMessage.style.color = 'var(--accent-1)';
        }
      }
    } catch (err) {
      console.error('Error saving GPA:', err);
      if (saveMessage) {
        saveMessage.textContent = '❌ Server connection error.';
        saveMessage.style.color = 'var(--accent-1)';
      }
    } finally {
      btnSaveResult.classList.remove('loading');
    }
  }

  // Run initialization
  document.addEventListener('DOMContentLoaded', init);
})();
