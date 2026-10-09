import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export async function generatePerRole(
  experience: any[], 
  geminiKey: string, 
  targetCompany?: string, 
  targetRole?: string,
  audience?: string,
  mode?: string,
  customPrompt?: string,
  brainDump?: string
) {
  const genAI = new GoogleGenAI({ apiKey: geminiKey });

  const promises = experience.map(async (role, index) => {
    const prompt = `
ACT AS:
You are a Principal Resume Intelligence Architect and FAANG Recruiter.
Your objective is to rewrite this specific role into a recruiter-safe, technically mature, and human-written document that reflects factual realism.

Target Role: ${targetRole || 'Professional'}.
Audience: ${audience || 'Recruiters'}. Mode: ${mode || 'Standard'}.
${customPrompt ? `Custom Instructions: ${customPrompt}` : ''}
${brainDump ? `ADDITIONAL CONTEXT (BRAIN DUMP): ${brainDump}\nSift through this raw data to extract hidden achievements.` : ''}

ROLE DATA:
${JSON.stringify(role)}

CORPORATE DNA TAILORING (DEMONSTRATE, DO NOT DECLARE):
${targetCompany ? `Tailor appropriately for ${targetCompany}. Focus on specific impacts and technologies relevant to their industry.` : ''}

STRICT OPERATIONAL REALISM RULES (GLOBAL SYSTEM RULES):
1. TRUTHFULNESS IS MANDATORY: NEVER fabricate metrics, budget numbers, or leadership ownership. (Use ONLY provided role data).
2. AI-GENERATED LANGUAGE PREVENTION: DO NOT use "Spearheaded", "Orchestrated", "Pioneered". Use "Managed", "Implemented", "Coordinated", "Optimized", "Configured", "Automated".
3. THE FAANG Standard (Google XYZ): EVERY single bullet point MUST follow Google's XYZ formula: 'Accomplished [X] as measured by [Y], by doing [Z]'. Bullets can span 1 to 2 lines maximum. Be highly technical, metric-driven, and dense. Do not use filler words.
4. ROLE-SPECIFIC COUNTS:
   - RECENT ROLES (2022–Present): Strictly 5 to 6 XYZ bullet points.
   - MID-CAREER (2017–2022): Strictly 3 to 4 XYZ bullet points.
   - OLDER ROLES (Before 2017): Strictly 1 brief XYZ bullet point focusing only on the core outcome.
5. DETAIL: Each bullet should be impactful, technical, and dense. Provide specific technical context and outcomes within the 1-2 line limit.
6. DEVOPS BAN: The terms "CI/CD", "Pipelines", and "DevOps" are ABSOLUTELY FORBIDDEN. Use "Infrastructure Automation", "Workflow Orchestration", or "Release Engineering".
7. PROJECT FIDELITY: Limit descriptions to 2 sentences or 25 words.

OUTPUT SCHEMA:
Return ONLY a valid JSON array of strings containing the high-impact bullet points for this role. Example: ["Bullet 1", "Bullet 2"]
`;

    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        let currentModel = "gemini-3.5-flash"; // Switched to Flash for cost efficiency
        let res;
        try {
          res = await genAI.models.generateContent({
            model: currentModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { 
              responseMimeType: "application/json",
              // Use LOW thinking or none for bullets to save costs
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
            }
          });
        } catch (e) {
          console.warn(`[RoleGen] ${currentModel} failed, trying fallback...`);
          currentModel = "gemini-3.1-flash-lite";
          res = await genAI.models.generateContent({
            model: currentModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { responseMimeType: "application/json" }
          });
        }

        const text = res.text || "[]";
        let bullets = [];
        try {
          const parsed = JSON.parse(text);
          bullets = Array.isArray(parsed) ? parsed : (parsed.bullets || []);
        } catch (e) {
          console.error(`[RoleGen] JSON Parse error for ${role.id || index}:`, e);
          throw e; // Trigger retry
        }

        return {
          id: role.id || `role_${index + 1}`,
          role: role.role,
          company: role.company,
          duration: role.duration,
          bullets: bullets
        };
      } catch (err) {
        retryCount++;
        console.warn(`[RoleGen] Failed for ${role.id || index}. Retry ${retryCount}/${maxRetries}...`, err);
        if (retryCount >= maxRetries) {
          return {
            id: role.id || `role_${index + 1}`,
            role: role.role,
            company: role.company,
            duration: role.duration,
            bullets: role.original_bullets || []
          };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    // Fallback if loop ends (should not happen due to return in loop)
    return {
      id: role.id || `role_${index + 1}`,
      role: role.role,
      company: role.company,
      duration: role.duration,
      bullets: role.original_bullets || []
    };
  });

  return Promise.all(promises);
}
