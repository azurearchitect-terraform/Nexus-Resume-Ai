import type { MatchScoreResult } from './lib/matchScore';
import type { ImpactScoreResult } from './lib/impactScore';

export interface MasterResume {
  id: string;
  name: string;
  description: string;
  data: ResumeData;
  createdAt: number;
  isActive?: boolean;
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
}

export interface ResumeData {
  personal_info: {
    name: string;
    email: string;
    phone: string;
    location: string;
    summary: string;
    linkedin?: string;
    linkedinText?: string;
  };
  experience: Experience[];
  early_career?: string[];
  skills: string[] | {
    infrastructure: string[];
    devsecops: string[];
    governance: string[];
    observability: string[];
  };
  education: (Education | string)[];
  projects?: (Project | string)[];
  certifications?: (Certification | string)[];
}

export interface Experience {
  id: string;
  company: string;
  role: string;
  duration: string;
  bullets: string[];
  isOptional?: boolean;
}

export interface Education {
  institution: string;
  degree: string;
  expected_completion: string;
  semester?: string | number;
}

export interface Project {
  title: string;
  description: string;
  isOptional: true;
}

export interface LayoutBlock {
  id: string;
  type: 'header' | 'summary' | 'section_header' | 'experience_item' | 'skill_grid' | 'education_item' | 'project_item';
  content: any;
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
}

export interface ResumeTemplate {
  id: string;
  name: string;
  sectionOrder: string[];
  typography: {
    fontFamily: string;
    headerSize: number;
    sectionTitleSize: number;
    bodySize: number;
    lineHeight: number;
  };
  spacing: {
    margins: { top: number; right: number; bottom: number; left: number };
    sectionGap: number;
    itemGap: number;
    bulletGap: number;
  };
  styles: {
    alignment: 'left' | 'center';
    dividerStyle: 'line' | 'none';
  };
}

export interface SuitabilityResult {
  verdict: "Strong Match" | "Stretch Role" | "Not Recommended";
  /** Computed from the resume and JD by computeMatchScore when a JD is available. */
  matchScore: number;
  matchAnalysis?: MatchScoreResult;
  /** Computed FAANG/STAR bullet-quality audit of the resume as it stands. */
  impactAudit?: ImpactScoreResult;
  dealbreakers: string[];
  strengths: string[];
  reasoning: string;
  critique?: {
    category: string;
    feedback: string;
    severity: 'low' | 'medium' | 'high';
  }[];
  readinessScore?: number;
}

export interface StarStory {
  bullet: string;
  /** Role and company the bullet belongs to, attached during STAR linkage. */
  role?: string;
  company?: string;
  /** The one competency the story evidences, from the target company's framework. */
  competency?: string;
  /** The behavioral question this story answers. */
  question?: string;
  situation: string;
  task: string;
  /** Told in first person singular: what the candidate personally did. */
  action: string;
  result: string;
  /** What the candidate took away or would do differently. */
  learning?: string;
  /** Probing questions an interviewer is likely to ask next. */
  follow_ups?: string[];
  /** Details the source does not supply, which the candidate must prepare. */
  prep_gaps?: string[];
}

export interface TrajectoryAnalysis {
  stage: 'early' | 'growth' | 'plateau' | 'acceleration';
  description: string;
  recommendation: string;
}

export interface RedFlag {
  id: string;
  type: string;
  message: string;
  fix: string;
  severity: 'low' | 'medium' | 'high';
}

export interface AuditReport {
  score: number;
  flags: RedFlag[];
  trajectory: TrajectoryAnalysis;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}
