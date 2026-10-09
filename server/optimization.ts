import crypto from 'crypto';
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { pipelineCache } from './cacheUtility';
import { planBulletBudgets } from "../src/lib/bulletBudget";
import type { BudgetOptions } from "../src/lib/bulletBudget";

/**
 * Token Optimization Strategy
 */

/**
 * Trims input text to a reasonable limit before sending to any AI
 */
export function trimInput(text: string, maxLength: number = 8000): string {
  if (!text) return "";
  return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
}

export async function extractRelevantResumeData(resumeText: string, geminiApiKey: string, openaiApiKey: string = '', pipelineType: string = 'hybrid-gemini') {
  const isHybridOpenAI = pipelineType === 'hybrid-openai' && openaiApiKey;

  if (isHybridOpenAI) {
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const trimmedResume = trimInput(resumeText, 15000);
    const prompt = `
      Extract essential professional data from this resume. 
      Focus on high-impact achievements and core skills.
      Return ONLY a JSON object:
      {
        "personal_info": { "name": "", "location": "", "email": "", "phone": "", "linkedin": "" },
        "summary": "Brief professional overview",
        "skills": ["Skill 1", "Skill 2"],
        "experience": [
          {
            "role": "Job Title",
            "company": "Company Name",
            "duration": "Dates",
            "achievements": ["Achievement 1", "Achievement 2"]
          }
        ],
        "projects": [
          { "title": "Project Name", "description": "Description" }
        ],
        "education": ["Degree, School"],
        "certifications": [
          { "name": "Cert Name", "issuer": "Issuing Body", "date": "Date" }
        ]
      }
      STRICT RULE: Extract EVERY SINGLE role present in the resume. Do not skip any jobs, even very old ones.
      Extract all bullets per role EXACTLY AS WRITTEN in the original resume. DO NOT summarize, rewrite, or attempt to refine the language of bullet points in this stage. Maintain absolute fidelity to original experience text.
      
      RESUME:
      ${trimmedResume}
    `;

    try {
      console.log(`[Nexus AI] Stage 1: Extraction. Attempting with OpenAI (gpt-4o)...`);
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      });
      const text = completion.choices[0].message.content || "";
      const parsed = JSON.parse(text);
      return { 
        data: parsed, 
        usage: { promptTokenCount: completion.usage?.prompt_tokens, candidatesTokenCount: completion.usage?.completion_tokens, totalTokenCount: completion.usage?.total_tokens }, 
        _model: "gpt-4o" 
      };
    } catch (error) {
      console.error("Error extracting resume data with OpenAI:", error);
    }
  }

  const genAI = new GoogleGenAI(geminiApiKey ? { apiKey: geminiApiKey } : {});
  const trimmedResume = trimInput(resumeText, 15000);

  const prompt = `
    Extract ALL professional data from this resume with absolute fidelity. 
    Return ONLY a JSON object ensuring NO content is skipped or summarized in this stage.
    
    REQUIRED SCHEMA:
    {
      "personal_info": { "name": "", "location": "", "email": "", "phone": "", "linkedin": "" },
      "summary": "Full summary text",
      "skills": ["Skill 1", "Skill 2", ...],
      "experience": [
        {
          "role": "Job Title",
          "company": "Company Name",
          "duration": "Dates",
          "achievements": ["Bullet 1", "Bullet 2", ...]
        }
      ],
      "projects": [
        { "title": "Project Name", "description": "Full Description" }
      ],
      "education": [
        { "degree": "e.g. B.Tech in Computer Science", "institution": "e.g. Stanford University", "semester": "e.g. 5, only if the source states it", "expected_completion": "e.g. 2018" },
        "Or just string representing school and degree"
      ],
      "certifications": [
        { "name": "Cert Name", "issuer": "Issuing Body", "date": "Date" }
      ]
    }

    STRICT RULES:
    1. EXTRACT EVERY SINGLE ROLE: You MUST extract every job entry listed, from most recent to oldest. Do not skip or merge any roles.
    2. EXTRACT EVERY SINGLE PROJECT: If the resume lists multiple projects, extract ALL of them individually.
    3. EDUCATION: Extract ALL educational background. Use the object format if details are clear, otherwise a string.
    4. NO SUMMARIZATION: Extract bullets and descriptions EXACTLY as they appear in the source text. do not rewrite or shorten them yet.
    5. ACCURACY: Ensure company names, roles, and dates are captured perfectly.
    
    RESUME TEXT:
    ${trimmedResume}
  `;

  // Stage 1: Extraction
  let primaryModel = "gemini-3.1-flash-lite"; // Swapped to lite as primary to avoid 3.5-flash quota issues
  let fallbackModel = "gemini-3.5-flash"; 

  try {
    try {
      console.log(`[Nexus AI] Stage 1: Extraction. Attempting with ${primaryModel}...`);
      const response = await genAI.models.generateContent({
        model: primaryModel,
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      const text = response.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      
      if (parsed) {
        console.log(`[Extraction] Success. Found ${parsed.experience?.length || 0} roles and ${parsed.projects?.length || 0} projects.`);
        return { data: parsed, usage: (response as any).usageMetadata, _model: primaryModel };
      }
    } catch (quotaError: any) {
      const errorMsg = quotaError?.message?.toLowerCase() || "";
      if (errorMsg.includes("quota") || errorMsg.includes("429") || errorMsg.includes("resource_exhausted")) {
        console.log(`[Optimization] ${primaryModel} quota reached. Trying ${fallbackModel}...`);
        const response = await genAI.models.generateContent({
          model: fallbackModel,
          contents: prompt,
          config: { responseMimeType: "application/json" }
        });
        const text = response.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        
        if (parsed) {
          return { data: parsed, usage: (response as any).usageMetadata, _model: fallbackModel };
        }
      } else {
        throw quotaError;
      }
    }
    return { data: null, usage: null };
  } catch (error) {
    console.error("Error extracting resume data:", error);
    return { data: null, usage: null };
  }
}

export async function extractJDKeywords(jobDescription: string, geminiApiKey: string, openaiApiKey: string = '', pipelineType: string = 'hybrid-gemini') {
  const isHybridOpenAI = pipelineType === 'hybrid-openai' && openaiApiKey;

  if (isHybridOpenAI) {
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const trimmedJD = trimInput(jobDescription, 10000);
    const prompt = `
      Extract the top 12 essential keywords and requirements from this job description.
      Return ONLY a JSON array of strings.
      
      JD:
      ${trimmedJD}
    `;

    try {
      console.log(`[Nexus AI] Stage 1: JD Keywords. Attempting with OpenAI (gpt-4o)...`);
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      });
      const text = completion.choices[0].message.content || "";
      const parsed = JSON.parse(text);
      // Expected output is a JSON array
      const keywords = (parsed && Array.isArray(parsed)) ? parsed : (parsed.keywords || []);
      return { 
        data: keywords, 
        usage: { promptTokenCount: completion.usage?.prompt_tokens, candidatesTokenCount: completion.usage?.completion_tokens, totalTokenCount: completion.usage?.total_tokens }, 
        _model: "gpt-4o" 
      };
    } catch (error) {
      console.error("Error extracting JD keywords with OpenAI:", error);
    }
  }

  const genAI = new GoogleGenAI(geminiApiKey ? { apiKey: geminiApiKey } : {});
  const trimmedJD = trimInput(jobDescription, 10000);

  const prompt = `
    Extract the top 12 essential keywords and requirements from this job description.
    Return ONLY a JSON array of strings.
    
    JD:
    ${trimmedJD}
  `;

  // Stage 1: JD Analysis
  let primaryModel = "gemini-3.1-flash-lite"; // Swapped to lite as primary
  let fallbackModel = "gemini-3.5-flash";

  try {
    try {
      console.log(`[Nexus AI] Stage 1: JD Keywords. Attempting with ${primaryModel}...`);
      const response = await genAI.models.generateContent({
        model: primaryModel,
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      const text = response.text || "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      const keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      
      if (keywords && keywords.length > 0) {
        return { data: keywords, usage: (response as any).usageMetadata, _model: primaryModel };
      }
    } catch (quotaError: any) {
      const errorMsg = quotaError?.message?.toLowerCase() || "";
      if (errorMsg.includes("quota") || errorMsg.includes("429") || errorMsg.includes("resource_exhausted")) {
        console.log(`[Optimization] ${primaryModel} quota reached. Trying ${fallbackModel}...`);
        const response = await genAI.models.generateContent({
          model: fallbackModel,
          contents: prompt,
          config: { responseMimeType: "application/json" }
        });
        const text = response.text || "";
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        const keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        
        if (keywords && keywords.length > 0) {
          return { data: keywords, usage: (response as any).usageMetadata, _model: fallbackModel };
        }
      } else {
        throw quotaError;
      }
    }
    return { data: [], usage: null };
  } catch (error) {
    console.error("Error extracting JD keywords:", error);
    return { data: [], usage: null };
  }
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Best-effort parse of one endpoint of a duration string into a Date.
 * Handles "Jan 2024", "January 2024", "01/2024", "2024-01" and bare "2024".
 * Returns null when nothing recognisable is found.
 */
function parseDurationEndpoint(part: string, isEnd: boolean): Date | null {
  const s = part.trim().toLowerCase();
  if (!s) return null;
  if (/present|current|now|till date|to date|ongoing/.test(s)) return new Date();

  const monthName = s.match(/([a-z]{3,9})\.?\s*,?\s*(\d{4})/);
  if (monthName && MONTHS[monthName[1].slice(0, 3)] !== undefined) {
    return new Date(Number(monthName[2]), MONTHS[monthName[1].slice(0, 3)], 1);
  }

  const numeric = s.match(/(\d{1,2})[\/\-.](\d{4})/);
  if (numeric) {
    const m = Number(numeric[1]);
    if (m >= 1 && m <= 12) return new Date(Number(numeric[2]), m - 1, 1);
  }

  const isoish = s.match(/(\d{4})[\/\-.](\d{1,2})/);
  if (isoish) {
    const m = Number(isoish[2]);
    if (m >= 1 && m <= 12) return new Date(Number(isoish[1]), m - 1, 1);
  }

  const yearOnly = s.match(/\b(19|20)\d{2}\b/);
  if (yearOnly) {
    const y = Number(yearOnly[0]);
    return isEnd ? new Date(y, 11, 31) : new Date(y, 0, 1);
  }

  return null;
}

/**
 * Tenure of a role in whole months, or null when the duration cannot be parsed.
 */
export function parseTenureMonths(duration: string): number | null {
  if (!duration || typeof duration !== "string") return null;

  const parts = duration.split(/\s*(?:-|–|—|\bto\b|\buntil\b)\s*/i).filter(Boolean);
  if (parts.length < 2) return null;

  const start = parseDurationEndpoint(parts[0], false);
  const end = parseDurationEndpoint(parts[parts.length - 1], true);
  if (!start || !end || end < start) return null;

  const months =
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.max(1, months + 1);
}

/**
 * Bullet allowance for a role, driven by tenure first and recency second.
 *
 * Tenure dominates deliberately: a long bullet list under a very short stint
 * reads as padding and undermines the credibility of the whole document.
 * Returns null when the duration cannot be parsed, letting the model fall back
 * to the prompt's own heuristics rather than acting on a bad guess.
 */
export function suggestBulletBudget(duration: string, isMostRecent: boolean): string | null {
  const months = parseTenureMonths(duration);
  if (months === null) return null;

  if (months <= 2) return "1";
  if (months <= 6) return "1-2";
  if (months <= 12) return "2-3";

  const endsNow = /present|current|now|till date|to date|ongoing/i.test(duration);
  if (isMostRecent || endsNow) return months >= 24 ? "6-7" : "4-5";
  if (months >= 24) return "3-4";
  return "2-3";
}

export function trimContentForAI(resumeData: any, keywords: string[], budgetOptions: BudgetOptions = {}) {
  // Remove duplicates from skills and achievements
  const seenSkills = new Set<string>();
  const uniqueSkills = (resumeData.skills || []).filter((s: string) => {
    const normalized = s.toLowerCase().trim();
    if (seenSkills.has(normalized)) return false;
    seenSkills.add(normalized);
    return true;
  });

    // Ensure we don't exceed reasonable limits but provide enough for Step 3
    const sourceRoles = (resumeData.experience || []).map((exp: any, index: number) => ({
      ...exp,
      id: `role_${index + 1}`,
      bullets: exp.achievements || [],
    }));
    const budgetPlan = planBulletBudgets(sourceRoles, budgetOptions);
    return {
      personal_info: resumeData.personal_info || {},
      // Trim summary to reasonable length for prompt safety
      summary: resumeData.summary?.substring(0, 1200),
      skills: uniqueSkills.slice(0, 100),
      experience: sourceRoles.map((exp: any, index: number) => {
        const seenBullets = new Set<string>();
        const budget = budgetPlan.budgets[index];
        return {
          id: `role_${index + 1}`,
          role: exp.role,
          company: exp.company,
          duration: exp.duration,
          ...(budget.tenureMonths !== null ? { tenure_months: budget.tenureMonths } : {}),
          ...(budget.label !== null ? { bullet_budget: budget.label } : {}),
          // Remove duplicate bullets and provide more context for AI selection
          original_bullets: (exp.achievements || [])
            .filter((a: string) => {
              const normalized = a.toLowerCase().trim();
              if (seenBullets.has(normalized)) return false;
              seenBullets.add(normalized);
              return true;
            })
            .slice(0, 50)
        };
      }),
      projects: (resumeData.projects || []).slice(0, 20),
      education: resumeData.education,
      certifications: resumeData.certifications,
      jd_keywords: (keywords || []).slice(0, 30)
    };
}

export function enforceFidelity(aiResponse: any, originalInput: any) {
  try {
    const aiData = typeof aiResponse === 'string' ? JSON.parse(aiResponse) : aiResponse;
    const originalExperience = originalInput.experience || [];
    const aiExperience = aiData.experience || [];

    // Create a map for quick lookup by ID
    const aiRoleMap = new Map();
    aiExperience.forEach((role: any) => {
      if (role.id) aiRoleMap.set(role.id, role);
    });

    // Reconstruct experience based STRICKLY on original structure
    const enforcedExperience = originalExperience.map((originalRole: any) => {
      const matchedAI = aiRoleMap.get(originalRole.id);
      
      return {
        role: originalRole.role,
        company: originalRole.company,
        duration: originalRole.duration,
        // Force use of original_bullets to prevent AI from overwriting experience.
        bullets: (originalRole.original_bullets || [])
      };
    });

    // Return the full object with enforced experience
    return {
      ...aiData,
      experience: enforcedExperience
    };
  } catch (error) {
    console.error("[Fidelity] Error enforcing structure:", error);
    return aiResponse; // Fallback to raw if logic fails
  }
}

export function clearCache() {
  pipelineCache.clear();
}

export function saveToCache(key: string, data: any) {
  pipelineCache.set(key, data);
}
