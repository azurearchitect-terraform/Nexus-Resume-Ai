# NexusPro AI: High-Performance Resume Intelligence System

NexusPro AI is a production-grade, full-stack application designed to transform how candidates interact with the modern recruitment landscape. It doesn't just "rewrite" resumes; it applies advanced engineering heuristics and multi-agent LLM pipelines to align professional history with high-stakes job requirements.

## 🚀 Key Features & Engine Logic

### 1. The NexusPro Optimization Pipeline (`/api/optimize-pipeline`)
Unlike simple prompt-based wrappers, NexusPro uses a multi-stage server-side pipeline:
- **Requirement Deconstruction**: Analyzes JDs to extract explicit and implicit technical/leadership requirements.
- **Agentic Role Synthesis**: Spawns concurrent LLM tasks, one per professional role, that rewrite each role's bullets in Google's XYZ format ("Accomplished X as measured by Y, by doing Z"). These per-role tasks receive the target role and company but not the job description; the Hybrid OpenAI and single-engine paths tailor against the full JD instead.
- **Deduplication**: Removes duplicate bullets within each role before the resume is assembled.
- **Match Score (computed, not AI-guessed)**: `src/lib/matchScore.ts` scores the resume against the job description in code - weighted JD keyword coverage (70%; "required" items and repeated terms weigh more, "preferred" items and soft skills less), job title (10%), years of experience from role dates (10%) and minimum degree (10%). Components the JD doesn't mention are dropped and the rest re-weighted. The same resume and JD always produce the same score; "Old" scores the submitted resume and "New" the rewrite. Hover a score to see its breakdown.
- **Logic**: Implemented in Node.js using `server/optimization.ts` and `server/roleGenerator.ts`.

### 2. Multi-Audience Strategy
Generate and manage multiple variations of your resume targeting different career trajectories (e.g., "Engineering Leader" vs "Solution Architect") simultaneously.
- **Logic**: Leverages the `AUDIENCES` state mapping in `src/App.tsx`.
- **Audience Intelligence**: Auto-Select re-analyzes the current job description and applies the strongest catalog personas, even after manual edits. Its compact details popover shows confidence, rationale, quoted posting evidence and opt-in suggestions without taking space in the configuration column. Management personas require verified management/seniority signals; CTO/VP and Microsoft personas have additional evidence gates.
- **Generation cost**: Automatic selection and Apply choose the primary plus at most one secondary with confidence at least 75% and within 15 percentage points of the primary. Other suggestions remain opt-in; each selected audience generates its own resume version. Executive stakeholders and Office-suite proficiency do not establish executive or Microsoft-cloud audiences.
- **Control and fallback**: The Auto-Select caret contains the persisted "Auto-select when the JD changes" toggle, on by default. Background analysis is debounced and never overwrites manual selections for the current posting; an explicit Auto-Select click always applies. The selector's AI badge appears only for an unchanged automatic selection matching the current JD. Provider routing honors the selected engine; timeouts use a clearly labeled rules fallback. A bounded cache saves only decision IDs/confidence locally, not the job description.

### 3. NexusPro Insights (STAR Story Generation)
The AI doesn't just tailor bullets; it prepares you for the interview. It extracts high-impact bullets and builds comprehensive STAR stories (Situation, Task, Action, Result) for each.
- **Logic**: Viewable in the "Insights" pane, powered by `NexusProInsights.tsx`.

### 4. Interactive Style & Layout Engine
A complete DTP-style interface to control the resume's visual identity.
- **Controls**: Live font switching (Sans/Mono/Serif), fluid margin/padding adjustments, and drag-and-drop section reordering.
- **Logic**: Powered by `@dnd-kit/core` and a custom `FormattingContext`.
- **Smart page breaks**: Roles and entries are never split across pages; spacing tightens slightly before text shrinks to keep two pages.

### 5. Job Tracker & CRM
A built-in workflow manager to track applications, document metadata, and track historical match scores.
- **Logic**: `src/components/JobTracker.tsx` integrated with Firestore for persistence.

### 6. ATS Autofill floating Helper
A floating utility that overlays job application portals. It provides quick-copy access to your tailored resume data, categorized by field, specifically filtered to match job board requirements.
- **Logic**: `src/components/ATSAutofillHelper.tsx`.

### 7. Secure Encryption Layer
All sensitive API keys (Gemini, OpenAI) are never stored in plain text. They are encrypted at the server level using stable, hardware-backed keys and AES-256-CBC.
- **Logic**: `encrypt()` and `decrypt()` routines in `server.ts`.

### 8. Global Command Palette (`Cmd+K`)
A unified search and action bar for high-efficiency navigation across the entire application workspace.

### LinkedIn Trends and Bullet Rules
- **LinkedIn Trends** compares a curated, role-specific trend list with evidence in the candidate's resume. Supported skills can inform tailoring; unsupported skills are reported as gaps and are never added.
- **Bullet Rules** lets candidates set budgets for pinned companies, recent roles, platform experience, and total page fit. Rule budgets take precedence over tenure defaults; enforcement can trim excess bullets but never invents bullets to meet a minimum.
- Settings are stored locally and synced to the signed-in profile. The generated results include a per-role budget report and, when enabled, a trend coverage report.

### Greenhouse and Workday resume exports
- Preview, PDF, DOCX and compatibility checks share the ordered content from `src/lib/atsDocument.ts`: Professional Summary, Skills, Certifications, Work Experience, Projects and Education. Empty sections are omitted. Each role shows the bold role title (dates right-aligned) on its first line and the bold company name on its second; project titles are bold; education reads `Degree | Institution | Sem - N | Expected YYYY` using only details present in the source (a semester dropped by generation is restored from the master resume for the same institution).
- Contact details stay centered in the document body with real ` | ` separators and a compact `linkedin.com/in/<handle>` label linked to the full HTTPS URL. Employment dates are normalized without inventing months for year-only ranges.
- Standard preview retains per-section formatting, uppercase ruled headings and bold skill categories. Job titles and employers are bold, with dates aligned right in title → company → dates text order; Word uses a right tab stop, never a table. Simplified preview keeps a plain ATS layout.
- DOCX uses one section, built-in headings, real list bullets and black Calibri 11 pt text, without tables, images, headers or footers. PDF uses locally installed fonts and disables ligatures; simplified mode uses 11 pt body text and 10.25 pt contacts. Standard fitting never shrinks readable text below 10 pt just to force two pages; extra pages retain all content.
- The compatibility card flags incomplete contacts/employment/education, uncertain dates, overlaps, suspicious characters and typography. PDF text is checked against the canonical blocks before download. PII masking blocks PDF/DOCX downloads and autosave.
- These checks are not ATS certification. Review all autofilled application fields and follow each employer's accepted file formats and size limits.

## 🛠 Technical Architecture

- **Frontend**: React 18, Vite, Tailwind CSS, Framer Motion (animations).
- **Backend**: Express.js (Node.js) handling heavy AI computation and PDF generation.
- **Database/Auth**: Firebase Firestore & Authentication.
- **AI Core**: Native integration with `@google/genai` (Gemini 1.5 Pro) and OpenAI.
- **PDF Engine**: Puppeteer for pixel-perfect, ATS-parseable document exports.

## 📦 Installation & Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Firebase Configuration**:
   Update `firebase-applet-config.json` with your Firebase project credentials. Ensure Firestore and Auth are enabled.

3. **API Keys**:
   Add your Gemini API Key in the application's **Profile > API Settings** section or set it as an environment variable in `.env`.

4. **Development**:
   ```bash
   npm run dev
   ```

5. **Production Build**:
   ```bash
   npm run build
   ```

## 🔒 Security & Privacy
NexusPro is built with privacy-first principles. Your Master Resume remains your own. LLM processing is stateless, and your data is only used to generate your specific document versions.

---
**Developer**: Harnish Jariwala  
**Contact**: hackerharnish@gmail.com
