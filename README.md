# NexusPro AI: High-Performance Resume Intelligence System

NexusPro AI is a production-grade, full-stack application designed to transform how candidates interact with the modern recruitment landscape. It doesn't just "rewrite" resumes; it applies advanced engineering heuristics and multi-agent LLM pipelines to align professional history with high-stakes job requirements.

## 🚀 Key Features & Engine Logic

### 1. The NexusPro Optimization Pipeline (`/api/optimize-pipeline`)
Unlike simple prompt-based wrappers, NexusPro uses a multi-stage server-side pipeline:
- **Requirement Deconstruction**: Analyzes JDs to extract explicit and implicit technical/leadership requirements.
- **FAANG / STAR bullet standard (every engine)**: One shared standard in `src/lib/resumePrompt.ts` drives the per-role, whole-document and fallback prompts. STAR is the reasoning scaffold, never a bullet template: the model rebuilds each achievement's Situation, Task, Action and Result from your source material only, then writes the bullet as the compressed Action → Result in Google's XYZ shape ("Accomplished X, as measured by Y, by doing Z"). It includes Y only when your material states the measure, never invents a number, and aims for roughly one quantified bullet in three. Bullets are past tense, verb-first, with no "we"/"I", one claim each, and calibrated to your seniority.
- **Agentic Role Synthesis**: Spawns concurrent LLM tasks, one per role, each tailored against the full job description. Every role's output is checked in code for banned lead verbs, passive or "we" voice, figures your material never states, the CI/CD/Pipelines/DevOps term ban, duplicates and bullet count. A role that fails gets one corrective retry naming the exact problems (`server/roleGenerator.ts`).
- **Deduplication**: Removes duplicate bullets within each role before the resume is assembled.
- **Match Score (computed, not AI-guessed)**: `src/lib/matchScore.ts` scores the resume against the job description in code - weighted JD keyword coverage (70%; "required" items and repeated terms weigh more, "preferred" items and soft skills less), job title (10%), years of experience from role dates (10%) and minimum degree (10%). Components the JD doesn't mention are dropped and the rest re-weighted. The same resume and JD always produce the same score; "Old" scores the submitted resume and "New" the rewrite. Hover a score to see its breakdown.
- **FAANG / STAR Impact audit (computed)**: `src/lib/impactScore.ts` grades bullet quality without any model call. It covers action-verb ownership, impact stated rather than duties, measurement balance (too few and too many numbers both cost), figures traceable to your own material, concrete systems named, no passive phrasing, varied cadence, and STAR stories linked to real bullets. Version numbers such as "Windows Server 2019" or "ISO 27001" never count as metrics. The card in Job Analysis shows Old → New with the top fixes. "FAANG READY" on the fit check requires both a JD match of 80% or more and an impact score of 75 or more.
- **Logic**: Implemented in Node.js using `server/optimization.ts` and `server/roleGenerator.ts`.

### 2. Multi-Audience Strategy
Generate and manage multiple variations of your resume targeting different career trajectories (e.g., "Engineering Leader" vs "Solution Architect") simultaneously.
- **Logic**: Leverages the `AUDIENCES` state mapping in `src/App.tsx`.

### 3. NexusPro Insights (STAR Story Generation)
The AI doesn't just tailor bullets; it prepares you for the interview. STAR stories are drafted per role from the bullets actually written, and each one must quote its bullet verbatim, so the platform drops any story that expands work the resume never claims. Each story is framed on the target company's competency model: Amazon's Leadership Principles, Google's hiring attributes, or the Meta, Microsoft, Apple or Netflix equivalents, with a general set otherwise. It carries the likely interview question, an Action told in first person, a lesson learned, probable follow-up questions, and the details you must prepare because your resume doesn't state them. When Target Company is "Generic Tech", the hiring company you typed decides the framework.
- **Logic**: Viewable in the "Insights" pane, powered by `NexusProInsights.tsx`.

### 4. Interactive Style & Layout Engine
A complete DTP-style interface to control the resume's visual identity.
- **Controls**: Live font switching (Sans/Mono/Serif), fluid margin/padding adjustments, and drag-and-drop section reordering.
- **Logic**: Powered by `@dnd-kit/core` and a custom `FormattingContext`.

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
