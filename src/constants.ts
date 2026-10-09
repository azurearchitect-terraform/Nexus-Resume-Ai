export const MODE_DESCRIPTIONS = {
  conservative: "Minimal edits. Preserves your original structure and wording while ensuring basic keyword alignment.",
  balanced: "The 'Sweet Spot'. Improves clarity, strengthens action verbs, and strategically aligns keywords. Recommended.",
  aggressive: "Maximum Impact. Rewrites bullets for peak ATS compatibility and high-stakes competitive roles.",
  automatic: "Optimize based on Job Description requirements.",
};

export const AUDIENCES = [
  { id: 'general', label: 'General Professional', icon: '👤' },
  { id: 'microsoft', label: 'Microsoft / Enterprise', icon: '🏢' },
  { id: 'leadership', label: 'Leadership / Manager', icon: '👔' },
  { id: 'cloud-architect', label: 'Cloud Architect', icon: '☁️' },
  { id: 'solution-architect', label: 'Solution Architect', icon: '🏗️' },
  { id: 'consulting', label: 'Consulting / Client-Facing', icon: '🤝' },
  { id: 'cloud-eng-mgr', label: 'Cloud Engineering Manager', icon: '⚙️' },
  { id: 'infra-mgr', label: 'Infrastructure Manager', icon: '🛠️' },
  { id: 'assoc-director', label: 'Associate Director / Lead roles', icon: '🎖️' },
  { id: 'director-mid', label: 'Director / Head of Cloud (mid-size)', icon: '📈' },
  { id: 'director-large', label: 'Director / Head of Cloud (large-size)', icon: '🌐' },
  { id: 'principal-architect', label: 'Principal Cloud Architect', icon: '💎' },
  { id: 'cto-vp', label: 'CTO / VP of Engineering', icon: '👑' },
  { id: 'digital-transform', label: 'Digital Transformation Lead', icon: '⚡' },
  { id: 'platform-dir', label: 'Platform Engineering Director', icon: '🏗️' },
  { id: 'custom', label: 'Custom Persona...', icon: '✍️' }
];

export const TARGET_COMPANIES = [
  { id: 'none', label: 'Generic Tech', icon: '💻', signal: 'standard technical excellence' },
  { id: 'amazon', label: 'Amazon', icon: '📦', signal: 'Ownership, Bias for Action, Dive Deep' },
  { id: 'microsoft', label: 'Microsoft', icon: '🪟', signal: 'Enterprise Scale, Cloud Transformation' },
  { id: 'google', label: 'Google', icon: '🔍', signal: 'Systems Design, Scale, Algorithmic Impact' },
  { id: 'meta', label: 'Meta', icon: '♾️', signal: 'Move Fast, Ship Impact, Performance' },
  { id: 'apple', label: 'Apple', icon: '🍎', signal: 'Precision, User Experience, Discretion' },
  { id: 'accenture', label: 'Accenture', icon: '📈', signal: 'Client Value, Global Delivery' },
  { id: 'infosys', label: 'Infosys', icon: '🌐', signal: 'Managed Services, Transformation' },
];

export const MODEL_PRICING: Record<string, { input: number, output: number }> = {
  // OpenAI
  'gpt-5.4': { input: 5.00, output: 15.00 },
  'gpt-5.4-mini': { input: 0.15, output: 0.60 },
  'gpt-5.4-nano': { input: 0.05, output: 0.20 },
  'o1': { input: 15.00, output: 60.00 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'gpt-4.5': { input: 75.00, output: 150.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  // Gemini
  'gemini-3.1-pro-preview': { input: 1.25, output: 5.00 },
  'gemini-3-flash-preview': { input: 0.10, output: 0.40 },
  'gemini-3.1-flash-lite': { input: 0.05, output: 0.20 },
};

export const BACKGROUND_THEMES = [
  { id: 'infogeneus', label: 'InfoGeneus', url: 'https://images.unsplash.com/photo-1510511459019-5dee11b05978?q=80&w=2670&auto=format&fit=crop' },
  { id: 'cosmic', label: 'Cosmic', url: 'https://images.unsplash.com/photo-1464802686167-b939a8175b5f?q=80&w=2669&auto=format&fit=crop' },
  { id: 'midnight', label: 'Midnight', url: 'https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?q=80&w=2671&auto=format&fit=crop' },
  { id: 'frosted', label: 'Frosted', url: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?q=80&w=2670&auto=format&fit=crop' },
];
