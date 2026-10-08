import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { routeTask, RouterConfig } from "./aiRouter";
import { MasterResume, SuitabilityResult, Certification, StarStory, AuditReport } from "../types";
import { doc, getDoc, getDocFromServer } from "firebase/firestore";
import { db, auth } from "../firebase";
import { categorizeSkills } from "../lib/skillCategorizer";
import { buildResumeGenerationPrompt, resolvePromptCompany } from "../lib/resumePrompt";
import { computeMatchScore, MatchScoreOptions, MatchScoreResult } from "../lib/matchScore";
import { applyImpactAudit, computeImpactScore, resumeForAudit, ImpactScoreResult } from "../lib/impactScore";

export interface OptimizationResult {
  personal_info: {
    name: string;
    location: string;
    email: string;
    phone: string;
    linkedin: string;
    linkedinText?: string;
  };
  summary: string;
  skills: {
    Infrastructure: string[];
    DevSecOps: string[];
    Governance: string[];
    Observability: string[];
  };
  experience: {
    role: string;
    company: string;
    duration: string;
    bullets: string[];
  }[];
  certifications: (string | Certification)[];
  projects: { title: string; description: string }[];
  education: string[];
  ats_keywords_from_jd: string[];
  ats_keywords_added_to_resume: string[];
  keyword_gap: string[];
  /** Computed by computeMatchScore from the rewritten resume - never taken from the model. */
  match_score?: number;
  /** Computed by computeMatchScore from the resume that was submitted for optimization. */
  baseline_score?: number;
  match_analysis?: {
    baseline: MatchScoreResult;
    optimized: MatchScoreResult;
  };
  improvement_notes: string[];
  audience_alignment_notes: string;
  why_this_job?: string;
  rejection_reasons?: string[];
  star_stories?: StarStory[];
  /** Computed FAANG/STAR bullet-quality audit of the rewrite; absent when there are too few bullets. */
  impact_audit?: ImpactScoreResult;
  audit_report?: AuditReport;
  _usage?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  _geminiUsage?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  _intermediateData?: {
    resumeData: any;
    jdKeywords: string[];
  };
  _engine?: string;
  _model?: string;
}

export interface DeepResearchResult {
  status: string;
  output: string;
  progress: number;
}

export type EngineType = 'gemini' | 'openai';

export interface EngineConfig {
  engine: EngineType;
  model: string;
  apiKey?: string; // This will now hold the encrypted API key
}

function extractJson(text: string): string {
  if (!text) return "";
  
  // Try to find JSON block in markdown
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
  let extracted = text;
  if (jsonMatch && jsonMatch[1]) {
    extracted = jsonMatch[1].trim();
  } else {
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');

    if (firstBrace !== -1 && firstBracket !== -1) {
      if (firstBrace < firstBracket) {
        extracted = text.substring(firstBrace).trim();
      } else {
        extracted = text.substring(firstBracket).trim();
      }
    } else if (firstBrace !== -1) {
      extracted = text.substring(firstBrace).trim();
    } else if (firstBracket !== -1) {
      extracted = text.substring(firstBracket).trim();
    } else {
      extracted = text.trim();
    }
  }

  try {
    return jsonrepair(extracted);
  } catch (e) {
    console.error("Failed to repair JSON:", e);
    return extracted;
  }
}

export async function getDecryptedKey(encryptedKey: string): Promise<string> {
  const idToken = await auth.currentUser?.getIdToken();
  let keyToDecrypt = encryptedKey;

  if (!keyToDecrypt) return '';
  if (!keyToDecrypt.includes(':')) return keyToDecrypt;

  try {
    const response = await fetch('/api/decrypt-keys', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ encryptedKey: keyToDecrypt })
    });
    if (response.ok) {
      const data = await response.json();
      return data.keys?.gemini || data.keys?.openai || '';
    }
  } catch (e) {
    console.warn("Failed to decrypt key:", e);
  }
  return process.env.GEMINI_API_KEY || '';
}

async function callAI(prompt: string, model: string, engine: EngineType, encryptedKey?: string) {
  const idToken = await auth.currentUser?.getIdToken();

  if (engine === 'openai' && !encryptedKey) {
    throw new Error("OpenAI API Key is missing. Please save your profile first.");
  }

  // Fallback Logic definitions
  const FALLBACK_GEMINI_MODEL = "gemini-3.6-flash"; // Global fallback now 3.6 flash
  const LITE_GEMINI_MODEL = "gemini-3.1-flash-lite"; // Feature fallback
  
  if (engine === 'gemini') {
    // Gemini MUST be called from the frontend as per guidelines
    try {
      const apiKey = await getDecryptedKey(encryptedKey || "");
      
      if (!apiKey) {
        throw new Error("Gemini API key is missing. Please provide your own key in settings or contact the administrator.");
      }

      const ai = new GoogleGenAI({ apiKey });
      
      // USER REQUIREMENT: Specific Fallback Chains
      const getFallbackChain = (primaryModel: string): string[] => {
        // High Thinking: Prioritize pro-preview for complex tasks
        if (primaryModel === 'gemini-3.1-pro-preview' || primaryModel === 'gemini-pro') {
          return ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];
        }
        if (primaryModel === 'gemini-3.1-flash-lite') {
          return ['gemini-3.1-flash-lite', 'gemini-3.6-flash'];
        }
        if (primaryModel === 'gemini-3.6-flash') {
          return ['gemini-3.6-flash', 'gemini-3.1-flash-lite'];
        }
        
        // Default catch-all fallback
        return [primaryModel, 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];
      };

      const chain = getFallbackChain(model);

      const executeWithFallback = async (modelChain: string[]): Promise<any> => {
        const modelToTry = modelChain[0];
        
        // Clean model and handle legacy mappings
        const cleanModel = modelToTry
          .replace(':thinking', '')
          .replace('gemini-1.5-pro', 'gemini-3.1-pro-preview')
          .replace('gemini-1.5-flash', 'gemini-3.6-flash') // Redirect old flash to 3.5 flash
          .replace('gemini-3-flash-preview', 'gemini-3.6-flash') // Clean up renamed models
          .replace('gemini-pro', 'gemini-3.1-pro-preview');
              
        const config: any = {
          responseMimeType: prompt.toLowerCase().includes('json') ? "application/json" : "text/plain",
        };

        // Use MEDIUM thinking for pro preview by default to balance cost and quality,
        // unless it's a high-priority complex task or explicitly requested.
        if (cleanModel === 'gemini-3.1-pro-preview') {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.MEDIUM };
        } else if (cleanModel.includes('3.')) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }

        try {
          const response = await ai.models.generateContent({ 
            model: cleanModel,
            contents: prompt,
            config
          });

          return {
            result: response.text || "",
            usage: {
              promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
              candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
              totalTokenCount: response.usageMetadata?.totalTokenCount || 0
            }
          };
        } catch (innerError: any) {
          const errorMsg = String(innerError?.message || innerError).toLowerCase();
          const isQuotaError = errorMsg.includes("quota") || 
                               errorMsg.includes("429") || 
                               errorMsg.includes("limit") || 
                               errorMsg.includes("exhausted") ||
                               errorMsg.includes("resource_exhausted") ||
                               errorMsg.includes("rate_limit");
          
          if (modelChain.length > 1) {
            const isProModel = modelToTry.includes('pro') || modelToTry.includes('thinking');
            const shouldFallback = isQuotaError || isProModel || errorMsg.includes("not found") || errorMsg.includes("model");

            if (shouldFallback) {
              console.warn(`[Gemini Service] Error on ${cleanModel}: ${errorMsg}. Falling back to ${modelChain[1]}...`);
              return await executeWithFallback(modelChain.slice(1));
            }
          }
          
          throw innerError;
        }
      };

      return await executeWithFallback(chain);
      
    } catch (error: any) {
      let errorMessage = error?.message || String(error);
      
      // Try to parse Gemini error if it's a JSON string
      try {
        if (errorMessage.startsWith('{')) {
          const parsed = JSON.parse(errorMessage);
          if (parsed.error?.message) {
            errorMessage = parsed.error.message;
          }
        }
      } catch (e) {
        // Not a JSON string, ignore
      }

      console.error("Gemini Frontend Error:", errorMessage);
      throw new Error(errorMessage);
    }
  } else {
    // OpenAI and other engines can stay on the backend
    try {
      const response = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          prompt,
          model,
          engine,
          encryptedKey
        })
      });

      if (!response.ok) {
        throw new Error("Backend AI Call Failed");
      }

      return await response.json();
    } catch (error) {
      console.warn(`[AI Service] OpenAI failed, falling back to Gemini ${FALLBACK_GEMINI_MODEL}...`, error);
      return await callAI(prompt, FALLBACK_GEMINI_MODEL, 'gemini', encryptedKey);
    }
  }
}


export async function scanResumeImage(imageData: string, mimeType: string): Promise<any> {
  const idToken = await auth.currentUser?.getIdToken();
  const response = await fetch('/api/gemini/scan-resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageData, mimeType, idToken })
  });
  if (!response.ok) throw new Error("Vision Scan Failed");
  return await response.json();
}

export async function startDeepResearch(resume: any, jd: string): Promise<string> {
  const idToken = await auth.currentUser?.getIdToken();
  const response = await fetch('/api/deep-research/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume, jd, idToken })
  });
  if (!response.ok) throw new Error("Deep Research Initiation Failed");
  const data = await response.json();
  return data.interactionId;
}

export async function getDeepResearchStatus(id: string): Promise<DeepResearchResult> {
  const idToken = await auth.currentUser?.getIdToken();
  const response = await fetch(`/api/deep-research/status/${id}?idToken=${idToken}`);
  if (!response.ok) throw new Error("Deep Research Status Check Failed");
  return await response.json();
}

export async function getAudioFeedback(text: string): Promise<string> {
  const idToken = await auth.currentUser?.getIdToken();
  const response = await fetch('/api/resume-feedback-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, idToken })
  });
  if (!response.ok) throw new Error("Audio Generation Failed");
  const data = await response.json();
  return data.audioData;
}

export async function fetchJobDescription(url: string, config: RouterConfig): Promise<string> {
  const routedConfig = routeTask('extract_job_description', config);
  const prompt = `
You are an expert recruiter and data extractor.
Please read the following job posting URL and extract the full job description text.
Include the job title, company name, responsibilities, requirements, and any other relevant details.
Format the output as clean, readable text. Do not include any JSON formatting or extra conversational text.

JOB URL: ${url}
`;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    return data.result || "";
  } catch (error) {
    console.error("Error fetching job description:", error);
    throw error;
  }
}

export async function evaluateSuitability(
  resumeText: string,
  jobDescription: string,
  config: RouterConfig,
  fastMode: boolean = false,
  scoreOptions: MatchScoreOptions = {}
): Promise<SuitabilityResult> {
  const routedConfig = routeTask('evaluate_suitability', config);
  
  let modelToUse = routedConfig.model;
  if (fastMode && routedConfig.engine === 'gemini') {
    modelToUse = 'gemini-3.6-flash';
  } else if (!modelToUse) {
    modelToUse = routedConfig.engine === 'openai' ? 'gpt-4o-mini' : 'gemini-3.6-flash';
  }

  const prompt = `
You are an expert technical recruiter screening a candidate's resume against a job description.
The current date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.
Your goal is to quickly evaluate if the candidate is a good fit, a stretch, or not recommended.
Additionally, perform a focus Audit identifying flaws in wording, metrics, and alignment.

CRITICAL INSTRUCTIONS FOR AUDIT:
1. Impact: Audit every bullet point. Do they convey clear impact? If not, flag it.
2. Metrics: Achievements should ideally have a metric (%, $, time, scale) or clear outcome. Flag any achievements that are vague.
3. Action Verbs: Ensure bullets start with strong action verbs. Flag passive language like "Participated in" or "Helped with".
4. Dates: A "Present" or "Current" end date in experience is perfectly valid. Do not flag current roles as having date errors.
5. Scoring: The matchScore represents alignment with the JD. The readinessScore represents overall resume professionality and polish.
6. Critique: Be specific. Point out exactly which bullets lack impact or are too wordy.

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

Return ONLY a JSON object with the following structure:
{
  "verdict": "Strong Match" | "Stretch Role" | "Not Recommended",
  "matchScore": number (0-100),
  "dealbreakers": string[] (list of major missing requirements, empty if none),
  "strengths": string[] (list of key matching qualifications),
  "reasoning": string (1-2 sentences explaining the verdict),
  "readinessScore": number (0-100 overall professional readiness / resume quality),
  "critique": [
    {
      "category": "e.g., Metrics/Impact",
      "feedback": "Detailed constructive criticism",
      "severity": "low" | "medium" | "high"
    }
  ]
}
`;

  try {
    const data = await callAI(prompt, modelToUse, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    if (!resultText) throw new Error("No response from AI");
    const parsed = JSON.parse(resultText);
    // The verdict and critique stay AI-written; the percentage is computed from the
    // documents so it is reproducible and comparable across resumes.
    try {
      const computed = computeMatchScore(resumeText, jobDescription, scoreOptions);
      if (computed) {
        parsed.matchScore = computed.score;
        parsed.matchAnalysis = computed;
      }
    } catch (scoreError) {
      console.warn("[MatchScore] Could not compute suitability score:", scoreError);
    }
    // Bullet quality of the resume as it stands: half of "FAANG ready", independent of the JD.
    try {
      const document = resumeForAudit(resumeText);
      const impact = document ? computeImpactScore(document, { expectStarStories: false }) : null;
      if (impact) parsed.impactAudit = impact;
    } catch (auditError) {
      console.warn("[ImpactAudit] Could not audit the resume:", auditError);
    }
    return parsed;
  } catch (error) {
    console.error("Error evaluating suitability:", error);
    throw error;
  }
}

/**
 * Restores any work experience the model dropped.
 *
 * The prompt tells the model to keep every role, but an LLM under a strict
 * page budget will still quietly delete the oldest, shortest entries - which
 * reads on the finished resume as an unexplained employment gap. Prompt text
 * alone cannot guarantee this, so we reconcile the model's output against the
 * source resume in code and re-insert anything missing.
 *
 * Re-inserted roles are capped at a single bullet: the user's stated preference
 * is that losing a bullet point is acceptable, losing a job is not.
 */
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Sort key for reverse-chronological ordering, derived from the start date. */
function roleStartKey(duration: string): number {
  const match = String(duration || '').match(/([A-Za-z]{3,9})?\s*(\d{4})/);
  if (!match) return -1;
  const year = parseInt(match[2], 10);
  const month = match[1] ? (MONTH_INDEX[match[1].slice(0, 3).toLowerCase()] || 1) : 1;
  return year * 100 + month;
}

/** Company names are compared loosely - the model often rewords legal suffixes. */
function normalizeCompany(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llc|inc|incorporated|co|corp|corporation|technologies|tech|india|global)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function reconcileExperience(resumeText: string, aiExperience: any): any[] {
  const output = Array.isArray(aiExperience) ? [...aiExperience] : [];

  // The master resume is normally passed as JSON. If it is free-form text we
  // have no reliable role list to compare against, so leave the output alone.
  let source: any;
  try {
    source = JSON.parse(resumeText);
  } catch {
    return output;
  }

  const sourceRoles = source?.experience || source?.work_experience;
  if (!Array.isArray(sourceRoles) || sourceRoles.length === 0) return output;

  let restored = 0;
  for (const role of sourceRoles) {
    const company = role?.company;
    const title = role?.role || role?.title;
    if (!company && !title) continue;

    const present = output.some((entry: any) =>
      (company && sameCompany(entry?.company, company)) ||
      (!company && title && String(entry?.role || '').toLowerCase() === String(title).toLowerCase())
    );
    if (present) continue;

    const sourceBullets = role?.bullets || role?.achievements || [];
    output.push({
      role: title || '',
      company: company || '',
      duration: role?.duration || '',
      // Single bullet only - these are recovered under a tight page budget.
      bullets: Array.isArray(sourceBullets) && sourceBullets.length > 0
        ? [sourceBullets[0]]
        : [],
    });
    restored++;
    console.warn(`[resume] Model omitted "${title || ''} @ ${company || ''}" - restored from source resume.`);
  }

  if (restored === 0) return output;

  // Restored roles were appended, so re-establish reverse-chronological order -
  // but only when every duration parses, to avoid scrambling a valid ordering.
  const keys = output.map((entry: any) => roleStartKey(entry?.duration));
  if (keys.every(key => key > 0)) {
    output.sort((a: any, b: any) => roleStartKey(b?.duration) - roleStartKey(a?.duration));
  }

  return output;
}

interface AnalysisOptions extends MatchScoreOptions {
  /** The candidate's own material besides the resume; figures stated here count as theirs. */
  brainDump?: string;
  customPrompt?: string;
}

/**
 * Replaces any model-written scores with ones computed from the documents:
 *  - match_score / baseline_score: JD alignment of the rewrite and of the resume as
 *    submitted. Left unset when there is no job description text to score against,
 *    rather than showing a number that measures nothing.
 *  - impact_audit: the FAANG/STAR bullet-quality audit of the rewrite, with every
 *    figure traced back to the candidate's own material; STAR stories that expand no
 *    bullet are removed. Its baseline_score rates the resume as submitted.
 */
function applyDeterministicAnalysis(
  result: any,
  sourceResume: string,
  jobDescription: string,
  options: AnalysisOptions
): any {
  delete result.match_score;
  delete result.baseline_score;
  delete result.match_analysis;
  delete result.impact_audit;

  try {
    const baseline = computeMatchScore(sourceResume, jobDescription, options);
    const optimized = computeMatchScore(result, jobDescription, options);
    if (baseline && optimized) {
      result.baseline_score = baseline.score;
      result.match_score = optimized.score;
      result.match_analysis = { baseline, optimized };
    }
  } catch (error) {
    // A scoring fault must not discard (or re-bill) a finished rewrite.
    console.warn("[MatchScore] Could not compute match score:", error);
  }

  try {
    const sourceText = [sourceResume, options.brainDump, options.customPrompt]
      .filter((part) => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");
    applyImpactAudit(result, { sourceText });
    if (result.impact_audit) {
      const sourceDocument = resumeForAudit(sourceResume);
      const baseline = sourceDocument ? computeImpactScore(sourceDocument, { expectStarStories: false }) : null;
      result.impact_audit.baseline_score = baseline ? baseline.score : null;
    }
  } catch (error) {
    console.warn("[ImpactAudit] Could not audit the rewrite:", error);
  }
  return result;
}

export async function optimizeResume(
  resumeText: string,
  jobDescription: string,
  targetRole: string,
  mode: "conservative" | "balanced" | "aggressive" | "Player-Coach" | "automatic",
  audience: string,
  config: RouterConfig,
  linkedInUrl?: string,
  linkedInPdfText?: string,
  jobUrl?: string,
  fastMode: boolean = false,
  recruiterSimulationMode: boolean = false,
  customPrompt?: string,
  pipelineType?: string,
  targetCompany?: string,
  brainDump?: string,
  companyName?: string
): Promise<OptimizationResult> {
  const routedConfig = routeTask(recruiterSimulationMode ? 'recruiter_simulation' : 'rewrite_resume', config);
  const analysisOptions: AnalysisOptions = { targetRole, companyName, brainDump, customPrompt };
  // "Generic Tech" in the picker falls back to the hiring company, so a posting at Amazon
  // still gets Amazon's Leadership Principles as the STAR framework.
  const promptCompany = resolvePromptCompany(targetCompany, companyName);
  
  // Cost-saving logic: If fastMode is enabled, prefer Gemini Flash even in Hybrid mode to reduce OpenAI costs
  let modelToUse = routedConfig.model;
  let engineToUse = routedConfig.engine;
  
  if (fastMode) {
    if (config.mode === 'production') {
      // In Hybrid mode, fastMode forces Gemini to save costs
      engineToUse = 'gemini';
      modelToUse = 'gemini-3.6-flash';
    } else {
      // In single-engine mode, just use the smaller model
      modelToUse = routedConfig.engine === 'openai' ? 'gpt-4o-mini' : 'gemini-3.6-flash';
    }
  }

  const isLeadershipRole = /director|manager|lead|head|executive|vp|chief|principal|senior manager/i.test(targetRole);

  // V2 PIPELINE INTEGRATION: Use the optimized backend pipeline for production mode
  if ((config.mode === 'production' || pipelineType) && !recruiterSimulationMode && !fastMode) {
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/v2/optimize', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          resumeText,
          jobDescription,
          targetRole,
          mode,
          audience,
          customPrompt,
          apiKey: config.openaiConfig.apiKey,
          pipelineType,
          targetCompany: promptCompany,
          brainDump
        })
      });

      if (response.ok) {
        const data = await response.json();
        const resultText = extractJson(data.result || "");
        const parsed = JSON.parse(resultText);
        
        // Post-processing
        parsed._engine = 'hybrid-v2';
        if (data.usage) parsed._usage = data.usage;
        if (data.geminiUsage) parsed._geminiUsage = data.geminiUsage;
        if (data.intermediateData) parsed._intermediateData = data.intermediateData;
        
        // Apply UI formatting
        // Skills must be grouped into categories.
        let parsedSkills = parsed.skills || {};
        let formattedSkills: Record<string, string[]> = {};

        if (Array.isArray(parsedSkills)) {
          // Flatten array of objects if needed
          const flatSkills = parsedSkills.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean);
          formattedSkills = categorizeSkills(flatSkills);
        } else {
          // Use all categories provided by AI
          const skillCategories = Object.keys(parsedSkills);
          skillCategories.forEach(cat => {
            formattedSkills[cat] = parsedSkills[cat];
          });
        }
        
        const defaultCats = isLeadershipRole 
          ? ["Strategic Leadership", "Management", "Operations", "Technical Proficiency"]
          : ["Core Technical", "Tools & Frameworks", "Process & Methodology", "Soft Skills"];
        
        // Ensure at least 4 categories exist if it's not a categorized object with enough keys
        while (Object.keys(formattedSkills).length < 4) {
          const nextCat = defaultCats.find(c => !formattedSkills[c]);
          if (nextCat) formattedSkills[nextCat] = [];
          else formattedSkills[`Category ${Object.keys(formattedSkills).length + 1}`] = [];
        }
        parsed.skills = formattedSkills;

        // Guarantee no role was silently dropped to satisfy the page budget.
        // The V2 pipeline returns here, well before the legacy path's identical
        // reconcile call, so without this the "never drop a job" safeguard would
        // protect only the Gemini/OpenAI engines and silently miss every Hybrid run.
        parsed.experience = reconcileExperience(resumeText, parsed.experience);

        // Apply title fix to V2 results as well
        const fixTitle = (obj: any): any => {
          if (typeof obj === 'string') {
            return obj.replace(/Office IT [Cc]um Logistics/g, 'Officer IT cum Logistics');
          }
          if (Array.isArray(obj)) {
            return obj.map(fixTitle);
          }
          if (obj !== null && typeof obj === 'object') {
            const newObj: any = {};
            for (const key in obj) {
              newObj[key] = fixTitle(obj[key]);
            }
            return newObj;
          }
          return obj;
        };

        return applyDeterministicAnalysis(fixTitle(parsed), resumeText, jobDescription, analysisOptions);
      }
    } catch (e) {
      console.warn("V2 Pipeline failed, falling back to legacy optimization:", e);
    }
  }

  const prompt = buildResumeGenerationPrompt({
    targetRole,
    audience,
    mode,
    targetCompany: promptCompany,
    customPrompt,
    brainDump,
    recruiterSimulationMode,
    jobDescription,
    inputLabel: "SOURCE RESUME (raw text)",
    inputData: resumeText,
  });

  const maxRetries = 5;
  let retryCount = 0;
  let currentModel = modelToUse;

  while (retryCount <= maxRetries) {
    try {
      // Use the potentially overridden engine and model
      const currentApiKey = engineToUse === 'openai' ? config.openaiConfig.apiKey : config.geminiConfig.apiKey;
      const data = await callAI(prompt, currentModel, engineToUse, currentApiKey);
      const rawResult = data.result || "";
      const resultText = extractJson(rawResult);

      if (!resultText || resultText.length < 100) {
        throw new Error(`Empty or malformed response from ${engineToUse}. (Length: ${resultText.length})`);
      }

      try {
        const parsed = JSON.parse(resultText);

        // Skills must be grouped into categories.
        let parsedSkills = parsed.skills || {};
        let formattedSkills: Record<string, string[]> = {};
        
        if (Array.isArray(parsedSkills)) {
          const flatSkills = parsedSkills.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean);
          formattedSkills = categorizeSkills(flatSkills);
        } else {
          // Use all categories provided by the AI
          const skillCategories = Object.keys(parsedSkills);
          skillCategories.forEach(cat => {
            formattedSkills[cat] = parsedSkills[cat];
          });
        }

        // Fill in missing categories if less than 4
        const defaultCats = isLeadershipRole 
          ? ["Strategic Leadership", "Management", "Operations", "Technical Proficiency"]
          : ["Core Technical", "Tools & Frameworks", "Process & Methodology", "Soft Skills"];
          
        while (Object.keys(formattedSkills).length < 4) {
          const nextCat = defaultCats.find(c => !formattedSkills[c]);
          if (nextCat) formattedSkills[nextCat] = [];
          else formattedSkills[`Category ${Object.keys(formattedSkills).length + 1}`] = [];
        }

        parsed.skills = formattedSkills;
        parsed._engine = engineToUse;

        // Guarantee no role was silently dropped to satisfy the page budget.
        parsed.experience = reconcileExperience(resumeText, parsed.experience);

        if (data.usage) {
          parsed._usage = data.usage;
        }

        // FAIL-SAFE: Ensure "Officer IT cum Logistics" is preserved and not changed to "Office IT cum Logistics"
        const fixTitle = (obj: any): any => {
          if (typeof obj === 'string') {
            // Case insensitive match but replace with exact casing
            return obj.replace(/Office IT [Cc]um Logistics/g, 'Officer IT cum Logistics');
          }
          if (Array.isArray(obj)) {
            return obj.map(fixTitle);
          }
          if (obj !== null && typeof obj === 'object') {
            const newObj: any = {};
            for (const key in obj) {
              newObj[key] = fixTitle(obj[key]);
            }
            return newObj;
          }
          return obj;
        };

        return applyDeterministicAnalysis(fixTitle(parsed), resumeText, jobDescription, analysisOptions);
      } catch (e) {
        console.error(`Error parsing ${engineToUse} response:`, e, "Raw text:", resultText);
        throw new Error(`JSON_PARSING_ERROR: The ${engineToUse} engine returned an invalid response format.`);
      }
    } catch (error: any) {
      const errorString = String(error?.message || error).toLowerCase();
      const isRateLimit = errorString.includes("429") || 
                         errorString.includes("resource_exhausted") ||
                         errorString.includes("quota") ||
                         errorString.includes("exhausted") ||
                         errorString.includes("limit") ||
                         errorString.includes("rate limit");
      const isJsonError = errorString.includes("json_parsing_error") || 
                          errorString.includes("empty or malformed") ||
                          errorString.includes("no response") ||
                          errorString.includes("invalid response format");
      
      if ((isRateLimit || isJsonError) && retryCount < maxRetries) {
        retryCount++;
        
        // Fallback to Flash if Pro fails with rate limit or JSON error
        if (engineToUse === 'gemini' && (currentModel.includes('pro') || currentModel.includes('3.1-pro'))) {
          console.log(`Error hit on Gemini Pro. Falling back to Gemini 3.1 Flash Lite for retry ${retryCount}...`);
          currentModel = 'gemini-3.1-flash-lite';
        }

        const delay = Math.pow(2, retryCount) * 2000 + Math.random() * 1000;
        const retryMsg = isRateLimit 
          ? `AI API quota exceeded. Retrying with exponential backoff (${retryCount}/${maxRetries})...`
          : `Invalid AI response format. Retrying (${retryCount}/${maxRetries})...`;
          
        console.warn(`${retryMsg} (Delay: ${Math.round(delay)}ms)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }

  throw new Error(`Maximum retries exceeded for ${engineToUse}. Please try again in a few minutes.`);
}

export async function analyzeSkillGap(
  resumeText: string,
  jobDescription: string,
  config: RouterConfig
): Promise<{ missing: string[], present: string[] }> {
  const routedConfig = routeTask('extract_skills', config);
  const prompt = `
      Analyze the following resume and job description.
      Identify the skills present in the resume and the skills required by the job description that are missing from the resume.
      Return the result as a JSON object: { "missing": string[], "present": string[] }
      
      RESUME: ${resumeText}
      JOB DESCRIPTION: ${jobDescription}
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    return JSON.parse(resultText || '{"missing":[], "present":[]}');
  } catch (error) {
    console.error("Error analyzing skill gap:", error);
    throw error;
  }
}

export async function analyzeResumeCritique(
  resumeText: string,
  jobDescription: string,
  config: RouterConfig
): Promise<{ score: number, critique: { category: string, feedback: string, severity: 'low' | 'medium' | 'high' }[] }> {
  const routedConfig = routeTask('extract_skills', config);
  const prompt = `
      You are an expert career counselor. Audit this resume against the Job Description.
      Be constructive and thorough. Find areas for improvement in wording, impact, and alignment.
      
      STRICT AUDIT CRITERIA:
      1. IMPACT: Do achievements clearly convey the result of the actions taken?
      2. OUTCOMES: Does the resume highlight measurable outcomes or positive changes?
      3. ACTION VERBS: Are the verbs strong and professional?
      
      Return a JSON object:
      {
        "score": number (0-100 overall professional readiness),
        "critique": [
          {
            "category": "e.g., Metrics/Impact",
            "feedback": "Detailed constructive criticism",
            "severity": "low" | "medium" | "high"
          }
        ]
      }

      RESUME: ${resumeText}
      JOB DESCRIPTION: ${jobDescription}
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    return JSON.parse(resultText || '{"score":0, "critique":[]}');
  } catch (error) {
    console.error("Error analyzing resume critique:", error);
    throw error;
  }
}

export async function extractSkillsFromJD(
  jdText: string,
  resumeText: string,
  config: RouterConfig
): Promise<{ missing: string[], matching: string[], priority: string[] }> {
  const routedConfig = routeTask('extract_skills', config);
  const prompt = `
    ROLE: Expert Technical Recruiter & Keyword Strategist.
    TASK: Analyze the provided Job Description (JD) and Resume.
    
    1. EXTRACT mandatory technical skills, tools, and domain keywords from the JD.
    2. COMPARE these against the provided Resume.
    3. CATEGORIZE result into three arrays:
       - matching: Skills present in both JD and Resume.
       - missing: Important skills from JD not clearly present in Resume.
       - priority: The top 10-15 keywords user MUST have in their profile for this specific JD to pass ATS and filter searches.
    
    RESUME:
    ${resumeText}
    
    JOB DESCRIPTION:
    ${jdText}
    
    Return strictly JSON:
    {
      "matching": ["skill1", "skill2"],
      "missing": ["skill3", "skill4"],
      "priority": ["key1", "key2"]
    }
  `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    return JSON.parse(resultText || '{"matching":[], "missing":[], "priority":[]}');
  } catch (error) {
    console.error('Skill extraction AI error:', error);
    return { matching: [], missing: [], priority: [] };
  }
}

export async function performSkillAssessment(
  resumeText: string,
  config: RouterConfig
): Promise<{ extractedSkills: string[], faangSuggestions: string[] }> {
  const routedConfig = routeTask('extract_skills', config);
  const prompt = `
    ROLE: Expert Career Coach & FAANG Recruiter.
    TASK: Analyze the user's resume and perform a skills assessment.

    1. EXTRACT all clear technical skills, tools, and expertise from the resume.
    2. SUGGEST additional high-demand FAANG-level skills (e.g., advanced system design, specific ML frameworks like PyTorch/TensorFlow, cloud native tech like Kubernetes/Service Mesh, language-specific advanced frameworks like Go/Rust/TypeScript advanced patterns) that the user might already possess based on their experience or should consider adding to stay competitive.

    RESUME:
    ${resumeText}

    Return strictly JSON:
    {
      "extractedSkills": ["skill1", "skill2"],
      "faangSuggestions": ["suggestion1", "suggestion2"]
    }
  `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    return JSON.parse(resultText || '{"extractedSkills":[], "faangSuggestions":[]}');
  } catch (error) {
    console.error('Skill assessment AI error:', error);
    return { extractedSkills: [], faangSuggestions: [] };
  }
}


export async function analyzeBestAudiences(
  jobDescription: string,
  targetRole: string,
  config: RouterConfig,
  fastMode: boolean = false
): Promise<string[]> {
  const routedConfig = routeTask('multi_audience', config);
  console.log('analyzeBestAudiences called', { jobDescription, targetRole });
  
  let modelToUse = routedConfig.model;
  if (fastMode && routedConfig.engine === 'gemini') {
    modelToUse = 'gemini-3.6-flash';
  } else if (!modelToUse) {
    modelToUse = 'gemini-3.6-flash';
  }
  const prompt = `
    Analyze the following Job Description and Target Role.
    Select the MOST SPECIFIC and appropriate audiences from the following list that match the actual seniority and technical focus of the role:
    - microsoft (If Azure/Microsoft stack is primary)
    - leadership (If people management is mentioned)
    - cloud-architect (For strategy/design roles)
    - solution-architect (For client-facing/solution roles)
    - consulting (For agency/consultancy roles)
    - cloud-eng-mgr (Engineering management)
    - infra-mgr (Infrastructure management)
    - assoc-director (Junior leadership)
    - director-mid (Middle management / Head of Cloud for mid-size)
    - director-large (Head of Cloud for large enterprise)
    - principal-architect (Highest level individual contributor)
    - cto-vp (Executive leadership)
    - digital-transform (Strategic transformation)
    - platform-dir (Platform engineering leadership)
    
    CRITICAL: 
    - Do NOT default to "Director" or "Head" roles if the JD is for an Engineer, Senior Engineer, or Architect.
    - If the role is an Individual Contributor (IC), prefer "cloud-architect", "solution-architect", or "principal-architect".
    - Only suggest a CUSTOM audience name if NONE of the above IDs fit at all.
    
    Return ONLY a JSON array of the IDs. Example: ["microsoft", "cloud-architect"]
    
    JOB DESCRIPTION: ${jobDescription}
    TARGET ROLE: ${targetRole}
  `;

  const getKeywordFallback = () => {
    const jd = jobDescription.toLowerCase();
    const role = targetRole.toLowerCase();
    const selected: string[] = [];

    if (jd.includes('leadership') || jd.includes('manager') || jd.includes('director') || role.includes('lead') || role.includes('manager')) {
      selected.push('leadership');
    }
    if (jd.includes('microsoft') || jd.includes('azure')) {
      selected.push('microsoft');
    }
    if (jd.includes('cloud') && (jd.includes('architect') || role.includes('architect'))) {
      selected.push('cloud-architect');
    }
    if (jd.includes('consulting') || jd.includes('client')) {
      selected.push('consulting');
    }
    if (role.includes('director')) {
      selected.push('director-mid');
    }
    if (role.includes('cto') || role.includes('vp')) {
      selected.push('cto-vp');
    }
    if (jd.includes('platform')) {
      selected.push('platform-dir');
    }
    
    return selected.length > 0 ? selected : [targetRole];
  };

  try {
    const data = await callAI(prompt, modelToUse, 'gemini', routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    const parsed = JSON.parse(resultText || '[]');
    return Array.isArray(parsed) ? parsed : (parsed.audiences || [targetRole]);
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    const isQuotaError = errorMsg.includes("429") || errorMsg.includes("quota") || errorMsg.includes("limit") || errorMsg.includes("exhausted");
    
    if (isQuotaError) {
      console.warn("Auto-audience selection skipped: Gemini API quota exceeded. Using keyword-based fallback.");
      return getKeywordFallback();
    } else {
      console.error("Error analyzing best audiences:", errorMsg);
      // Even for other errors, try keyword fallback to provide a better UX than just returning targetRole
      return getKeywordFallback();
    }
  }
}




export async function generateLinkedInTopChoiceMessage(
  jobDescription: string,
  resumeText: string,
  targetRole: string,
  config: RouterConfig
): Promise<string> {
  const routedConfig = routeTask('linkedin_top_choice', config);
  const prompt = `
      You are an expert career strategist and LinkedIn profile optimizer. 
      LinkedIn allows users to add a "Top Choice" message (up to 300 characters) when applying via Easy Apply to stand out to recruiters.
      
      TASK: Write a compelling, punchy "Top Choice" message that:
      1. Expresses genuine enthusiasm for this specific role and company.
      2. Briefly mentions the candidate's strongest matching qualification (from the resume) for this job (from the JD).
      3. Explains why this specific company aligns with their career goals.
      
      CONSTRAINTS:
      - STRICTLY MAX 280 characters.
      - Be direct, professional, and personalized.
      - Do NOT use generic buzzwords.
      - Do NOT include placeholders like "[Company Name]". Use the real names if found, otherwise use "your team".
      
      JOB DESCRIPTION: ${jobDescription}
      RESUME: ${resumeText}
      TARGET ROLE: ${targetRole}
      
      Return ONLY the message text. No conversational padding.
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    let result = data.result || "";
    
    // Clean up if AI wrapped in quotes or JSON
    if (result.includes('{') && result.includes('}')) {
      try {
        const jsonStr = extractJson(result);
        const parsed = JSON.parse(jsonStr);
        result = parsed.message || parsed.top_choice_message || result;
      } catch (e) {}
    }
    
    return result.replace(/^["']|["']$/g, '').trim();
  } catch (error) {
    console.error("Error generating Top Choice message:", error);
    return "";
  }
}

export async function generateInterviewQuestions(
  jobDescription: string,
  resumeText: string,
  config: RouterConfig
): Promise<string[]> {
  const routedConfig = routeTask('interview_questions', config);
  const prompt = `
      Based on the following job description and the candidate's resume, generate 5-10 potential interview questions.
      Return the result as a JSON array of strings: [ "question1", "question2", ... ]
      
      JOB DESCRIPTION: ${jobDescription}
      RESUME: ${resumeText}
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    const parsed = JSON.parse(resultText || '[]');
    return Array.isArray(parsed) ? parsed : (parsed.questions || []);
  } catch (error) {
    console.error("Error generating interview questions:", error);
    return [];
  }
}

export async function generateRecruiterMessage(
  jobDescription: string,
  resumeText: string,
  config: RouterConfig
): Promise<string> {
  const routedConfig = routeTask('recruiter_message', config);
  const prompt = `
      You are an expert career coach.
      Write a short, professional, and engaging message for a recruiter to accompany a resume application.
      The message should be concise (max 100 words), highlight the candidate's interest in the role, and briefly mention why they are a good fit based on the job description and resume.
      
      JOB DESCRIPTION: ${jobDescription}
      RESUME: ${resumeText}
      
      Return the message as a plain text string. Do not include any extra conversational text.
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    let result = data.result || "";
    
    // Try to parse if it looks like JSON
    if (result.includes('{') && result.includes('}')) {
       try {
         const jsonStr = extractJson(result);
         const parsed = JSON.parse(jsonStr);
         if (parsed.message) {
           result = parsed.message;
         } else if (parsed.recruiter_message) {
           result = parsed.recruiter_message;
         }
       } catch (e) {
         // Ignore and use raw result
       }
    }
    return result.trim();
  } catch (error) {
    console.error("Error generating recruiter message:", error);
    return "";
  }
}

export async function generateCoverLetter(
  jobDescription: string,
  resumeText: string,
  targetRole: string,
  config: RouterConfig
): Promise<string> {
  const routedConfig = routeTask('cover_letter', config);
  const prompt = `
      You are an expert career coach and professional writer.
      Write a high-impact, persuasive cover letter for the following job description and candidate resume.
      The cover letter should be professional, concise (max 300-400 words), and specifically highlight how the candidate's experience aligns with the job requirements.
      Focus on the value the candidate brings to the company.
      
      CRITICAL: You MUST identify the company name from the job description and use it throughout the letter. Do not use placeholders like "[Company Name]". If the company name is not explicitly clear, use a generic but professional reference like "the team at your organization".
      
      JOB DESCRIPTION: ${jobDescription}
      RESUME: ${resumeText}
      TARGET ROLE: ${targetRole}
      
      Return the cover letter as a plain text string. Do not include any extra conversational text.
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    let result = data.result || "";
    
    // Try to parse if it looks like JSON
    if (result.includes('{') && result.includes('}')) {
       try {
         const jsonStr = extractJson(result);
         const parsed = JSON.parse(jsonStr);
         if (parsed.cover_letter) {
           result = parsed.cover_letter;
         } else if (parsed.coverLetter) {
           result = parsed.coverLetter;
         }
       } catch (e) {
         // Ignore and use raw result
       }
    }
    return result.trim();
  } catch (error) {
    console.error("Error generating cover letter:", error);
    return "";
  }
}

export async function analyzeLinkedInProfile(
  resumeText: string,
  linkedInText: string,
  config: RouterConfig
): Promise<string> {
  const routedConfig = routeTask('linkedin_analysis', config);
  const prompt = `
      You are an expert LinkedIn profile optimizer and career coach.
      Analyze the following candidate's resume and their LinkedIn profile text.
      Provide a comprehensive review of the LinkedIn profile, highlighting strengths, areas for improvement, and specific suggestions to optimize it for better visibility and impact.
      
      RESUME: ${resumeText}
      LINKEDIN PROFILE: ${linkedInText}
      
      Return the review as a structured markdown document.
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    return data.result || "";
  } catch (error) {
    console.error("Error analyzing LinkedIn profile:", error);
    throw error;
  }
}

export async function generateWhyThisJob(
  jobDescription: string,
  resumeText: string,
  config: RouterConfig
): Promise<string> {
  const routedConfig = routeTask('recruiter_message', config);
  const prompt = `
      You are a career strategist.
      Recruiters often ask "Why did you apply for this job?" or "What thrilled you about this role?".
      Based on the job description and the candidate's resume, draft a compelling, authentic response (max 150 words).
      Focus on the specific alignment between the company's mission/needs and the candidate's passions/skills.
      
      JOB DESCRIPTION: ${jobDescription}
      RESUME: ${resumeText}
      
      Return the response as a plain text string. Do not include any extra conversational text.
    `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    return (data.result || "").trim();
  } catch (error) {
    console.error("Error generating Why This Job response:", error);
    return "";
  }
}

export async function optimizeHeadline(
  currentHeadline: string,
  resumeSummary: string,
  keySkills: string[],
  targetRole: string,
  config: RouterConfig
): Promise<{ headline: string; keywords_used: string[] }> {
  const routedConfig = routeTask('optimize_headline', config);
  const prompt = `
    You are a LinkedIn headline optimization expert for IT and Cloud professionals.

    Input:
    - Current Headline: ${currentHeadline}
    - Resume Summary: ${resumeSummary}
    - Key Skills: ${JSON.stringify(keySkills)}
    - Target Role: ${targetRole}

    Tasks:
    1. Rewrite the headline to be:
       - Keyword-rich (ATS and recruiter friendly)
       - Clear and impactful
       - Aligned with target role
    2. Include important keywords like Azure, Cloud, Infrastructure, Migration, etc. if relevant
    3. Keep it under 220 characters

    Constraints:
    - No buzzword stuffing
    - No fake claims
    - Must reflect real experience

    Output (STRICT JSON):
    {
      "headline": "...",
      "keywords_used": ["...", "..."]
    }
  `;

  try {
    const data = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    return JSON.parse(resultText || '{"headline": "", "keywords_used": []}');
  } catch (error) {
    console.error("Error optimizing headline:", error);
    throw error;
  }
}

export async function autoSelectPlayerCoachRole(
  jobDescription: string,
  config: RouterConfig
): Promise<boolean> {
  const routedConfig = routeTask('rewrite_resume', config);
  const prompt = `
    Analyze the following Job Description.
    Determine if this role is a "Player-Coach" role (individual contributor + team lead/mentor).
    Return ONLY a JSON object: { "isPlayerCoach": boolean }
    
    JOB DESCRIPTION:
    ${jobDescription}
  `;

  try {
    const data = await callAI(prompt, 'gemini-3.6-flash', 'gemini', routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    const parsed = JSON.parse(resultText);
    return parsed.isPlayerCoach;
  } catch (error) {
    console.error("Error auto-selecting player-coach role:", error);
    return false;
  }
}

export async function rankMasterResumes(
  jd: string,
  masters: MasterResume[],
  config: RouterConfig
): Promise<{ id: string; name: string; score: number; reason: string; ats_analysis: string; skill_gap: string[] }[]> {
  if (!masters || masters.length === 0) return [];

  const routedConfig = routeTask('rewrite_resume', config);
  const prompt = `
    You are an expert recruitment strategist.
    Analyze the provided Job Description (JD) and the list of available "Master Resumes".
    Rank all resumes based on their suitability for the JD.
    
    FOR EACH RESUME, PROVIDE:
    1. A match score (0-100).
    2. A brief reason for the score.
    3. A quick ATS optimization analysis (keywords, formatting).
    4. A list of key missing skills (skill gap).
    
    JOB DESCRIPTION:
    ${jd}
    
    AVAILABLE MASTER RESUMES:
    ${masters.map(m => `ID: ${m.id}\nName: ${m.name}\nData: ${JSON.stringify(m.data).substring(0, 2000)}`).join("\n---\n")}
    
    RETURN ONLY JSON:
    [
      { 
        "id": "string", 
        "name": "string", 
        "score": number, 
        "reason": "string", 
        "ats_analysis": "string", 
        "skill_gap": ["string"] 
      }
    ]
    Order by score descending.
  `;

  try {
    const data = await callAI(prompt, "gemini-3.6-flash", "gemini", routedConfig.apiKey);
    const resultText = extractJson(data.result || "");
    return JSON.parse(resultText || "[]");
  } catch (error) {
    console.error("Error ranking master resumes:", error);
    return masters.map(m => ({ id: m.id, name: m.name, score: 0, reason: "Error in analysis", ats_analysis: "", skill_gap: [] }));
  }
}

export async function selectBestMasterResume(
  jd: string,
  masters: MasterResume[],
  config: RouterConfig
): Promise<string | null> {
  if (!masters || masters.length === 0) return null;

  const routedConfig = routeTask('rewrite_resume', config);
  const apiKey = await getDecryptedKey(routedConfig.apiKey || '');
  const ai = new GoogleGenAI({ apiKey });

  const mastersSummary = masters.map((m) => {
    const content = typeof m.data === 'string' ? m.data : JSON.stringify(m.data);
    // Increase context to 3000 chars for better differentiation
    return `ID: ${m.id}\nName: ${m.name}\nDescription: ${m.description || 'N/A'}\nContext Extract: ${content.substring(0, 3000)}...`;
  }).join("\n\n---\n\n");

  const prompt = `
    You are an expert recruitment strategist specializing in profile selection.
    
    TASK:
    Analyze the provided Job Description (JD) and the list of available "Master Resumes".
    Your goal is to pick the SINGLE most appropriate Master Resume to use as the foundation for optimization.
    
    SELECTION CRITERIA:
    1. Technical Stack Alignment: Which resume highlights technologies most relevant to the JD?
    2. Seniority Alignment: Does the JD look for a Lead, Manager, or Individual Contributor? Pick the resume that matches this level.
    3. Industry/Domain Alignment: If the JD is for Fintech, Cloud Infra, or E-commerce, pick the corresponding profile.
    
    JOB DESCRIPTION:
    ${jd}
    
    AVAILABLE MASTER RESUMES:
    ${mastersSummary}
    
    STRICT OUTPUT RULE:
    Return ONLY a JSON object with the following structure:
    { 
      "selectedId": "the-exact-id-string", 
      "reason": "short explanation of why this profile is the best starting point" 
    }
    
    Ensure the "selectedId" matches one of the IDs provided in the MASTER RESUMES list exactly.
  `;

  try {
    const apiKey = await getDecryptedKey(routedConfig.apiKey || '');
    const ai = new GoogleGenAI({ apiKey });
    
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" }
    });
    
    const text = response.text || "";
    const parsed = JSON.parse(text);
    
    // Validate that the returned ID actually exists in the masters list
    const found = masters.find(m => m.id === parsed.selectedId);
    if (found) {
      console.log(`[Nexus selection] AI picked: ${found.name} (${parsed.selectedId}). Reason: ${parsed.reason}`);
      return found.id;
    }
    
    console.warn(`[Nexus selection] AI returned unknown ID: ${parsed.selectedId}. Falling back to first.`);
    return masters[0].id;
  } catch (error) {
    console.error("Error selecting best master resume:", error);
    return masters[0].id; 
  }
}


export async function generateMasterResume(
  data: { company: string, role: string, startYear: string, endYear: string, description: string },
  config: RouterConfig
): Promise<{ role: string, company: string, duration: string, bullets: string[] }> {
  const routedConfig = routeTask('rewrite_resume', config);
  const prompt = `
    ROLE: Expert Career Coach & Resume Writer.
    TASK: Generate 6-8 high-impact, detailed, and ATS-friendly bullet points for a user's experience entry. A minimum of 6 bullet points is mandatory to ensure technical depth. Each bullet should be substantial (spanning 1-2 lines) and provide specific technical context and outcomes.
    
    INPUT DATA:
    Company: ${data.company}
    Role: ${data.role}
    Tenure: ${data.startYear} - ${data.endYear}
    Context/Description: ${data.description}
    
    STRICT GUIDELINES:
    - Use strong action verbs.
    - Include metrics (%, $, time saved, scale) if imaginable.
    - Focus on outcomes and leadership.
    
    OUTPUT (STRICT JSON):
    { "role": string, "company": string, "duration": string, "bullets": string[] }
  `;

  try {
    const dataResult = await callAI(prompt, routedConfig.model, routedConfig.engine, routedConfig.apiKey);
    const resultText = extractJson(dataResult.result || "");
    return JSON.parse(resultText);
  } catch (error) {
    console.error("Error generating master resume bullets:", error);
    throw error;
  }
}
