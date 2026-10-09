import express from "express";
import path from "path";
import puppeteer from "puppeteer";
import bodyParser from "body-parser";
import cors from "cors";
import crypto from "crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import { google } from "googleapis";
import stream from "stream";
import fs from "fs";
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as Optimization from "./server/optimization.ts";
import { renderResumeToHTML } from "./server/resumeTemplate.ts";
import { pipelineCache } from "./server/cacheUtility";
import { calculateCost, UsageLog } from "./server/analytics";
import { runAgents } from "./server/agents";
import { generatePerRole, selectStarStories } from "./server/roleGenerator";
import { deduplicateAndScore } from "./server/dedup";
import { saveResumeVersion } from "./server/memory";
import { buildResumeGenerationPrompt } from "./src/lib/resumePrompt";
import {
  activeBulletRules,
  bulletRulesFingerprint,
  enforceBulletBudgets,
  planBulletBudgets,
} from "./src/lib/bulletBudget";
import {
  activeLinkedInTrends,
  applyTrendCoverage,
  buildTrendBrief,
  trendEvidenceText,
  trendFingerprint,
  trendPreferTerms,
} from "./src/lib/linkedinTrends";
// import { scrapeJobs } from "./server/jobScraper";

dotenv.config();

// Initialize Firebase Admin
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
if (!fs.existsSync(firebaseConfigPath)) {
  console.error("firebase-applet-config.json not found. Skipping Firebase initialization.");
} else {
  const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf8"));
  
  // Safe initialization
  let app;
  try {
    app = (admin && admin.apps && Array.isArray(admin.apps) && admin.apps.length > 0)
      ? admin.apps[0]
      : admin.initializeApp({
          projectId: firebaseConfig.projectId,
        });
  } catch (err) {
    console.error("Firebase app initialization failed:", err);
    // Fallback or handle accordingly if needed
  }

  let firestoreApp;
  try {
    firestoreApp = admin.app("firestore");
  } catch {
    firestoreApp = admin.initializeApp({}, "firestore");
  }

  // Robust Firestore initialization: fallback to default database if specific ID fails or is not provided
  let db: admin.firestore.Firestore;
  try {
    const dbId = (firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "")
      ? firebaseConfig.firestoreDatabaseId
      : undefined;
    db = getFirestore(firestoreApp, dbId);
  } catch (e) {
    console.warn("[Server] Failed to initialize Firestore with specified database ID, falling back to default.", e);
    db = getFirestore(firestoreApp);
  }
}

// Helper to get API keys from Firestore securely
async function getApiKeys(idToken: string) {
    if (idToken === "SYSTEM_PIPELINE" || !idToken || idToken === "undefined" || idToken === "null") return null;
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uid = decodedToken.uid;
      const doc = await db.collection("users").doc(uid).get();
      
      if (!doc.exists) {
        return null; // Return null instead of throwing
      }
      
      let data = doc.data();
      
      // Strictly use user-specific key. No fallback to shared admin key.
      if (!data || !data.encryptedApiKey) {
        console.log(`[Server] User ${uid} key missing in Firestore.`);
        return null;
      }
      
      console.log(`[Server] Using strictly user-specific key for ${uid}.`);

      if (!data || !data.encryptedApiKey) {
        return null; // Return null instead of throwing
      }

      // Decrypt the keys before returning
      try {
        const decrypted = decrypt(data.encryptedApiKey);
        try {
          return JSON.parse(decrypted);
        } catch (e) {
          // Fallback for older single-key format
          return { gemini: decrypted };
        }
      } catch (error: any) {
        if (error.message.includes("DECRYPTION_FAILED")) {
          console.warn(`[Server] Decryption failed for user ${uid}. Treating as no key found.`);
          return null;
        }
        return null; // Fallback to null on decryption error
      }
    } catch (error) {
      console.warn("[Server] Token verification or key fetch failed, falling back to system keys:", error instanceof Error ? error.message : String(error));
      return null;
    }
}

// Function to log usage to Firestore
async function logUsage(log: UsageLog) {
  try {
    await db.collection("analytics").add({
      ...log,
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error("Error logging usage to Firestore:", error);
  }
}

// PDF Sessions storage
const pdfSessions = new Map<string, { html: string, css: string, fonts: string, title?: string, scale?: number, timestamp: number }>();

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pdfSessions.entries()) {
    if (now - session.timestamp > 1800000) { // 30 minutes
      pdfSessions.delete(id);
    }
  }
}, 600000);

// Encryption Setup
// We use a stable key derived from GEMINI_API_KEY if ENCRYPTION_KEY is not provided.
// This prevents "bad decrypt" errors after server restarts.
const getEncryptionKey = () => {
  const envKey = process.env.ENCRYPTION_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  
  if (envKey) {
    if (envKey.length === 64) {
      console.log("[Encryption] Using ENCRYPTION_KEY from environment.");
      return envKey;
    } else {
      console.warn("[Encryption] ENCRYPTION_KEY in environment is not 64 characters. Hashing it to ensure 32-byte key.");
      return crypto.createHash('sha256').update(envKey).digest('hex');
    }
  }
  
  if (geminiKey) {
    console.log("[Encryption] Deriving ENCRYPTION_KEY from GEMINI_API_KEY.");
    return crypto.createHash('sha256').update(geminiKey).digest('hex');
  }
  
  console.warn("[Encryption] No ENCRYPTION_KEY or GEMINI_API_KEY found. Using static fallback key. WARNING: Your encrypted data will be lost if you provide an API key later.");
  return "4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b"; 
};

const ENCRYPTION_KEY = getEncryptionKey();
const IV_LENGTH = 16;

function encrypt(text: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

const STATIC_FALLBACK_KEY = "4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b";

function decrypt(text: string) {
  if (!text) return "";
  if (!text.includes(':')) return text;

  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift()!, 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');

  const attemptDecrypt = (keyHex: string) => {
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch (e) {
      return null;
    }
  };

  // Try primary key (derived from env at start)
  let result = attemptDecrypt(ENCRYPTION_KEY);

  // If failed and primary wasn't the static one, try the static one as fallback
  if (result === null && ENCRYPTION_KEY !== STATIC_FALLBACK_KEY) {
    console.log("[Decrypt] Primary key mismatch. Attempting static fallback decryption...");
    result = attemptDecrypt(STATIC_FALLBACK_KEY);
  }

  if (result !== null) {
    return result;
  }

  console.error("Decryption Error: DECRYPTION_FAILED");
  throw new Error("DECRYPTION_FAILED: The encryption key has changed or the data is corrupted. Please re-save your API keys in your profile.");
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(cors());
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  // Debug: Log all incoming requests
  app.use((req, res, next) => {
    console.log(`[Server] ${req.method} ${req.url}`);
    next();
  });

  app.get("/api/health-check", (req, res) => {
    res.json({ status: "alive", timestamp: new Date().toISOString() });
  });

  app.get("/api/generate-resume-pdf", async (req, res) => {
    try {
      const html = renderResumeToHTML();
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox"],
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.evaluateHandle('document.fonts.ready');
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        res.contentType("application/pdf");
        res.setHeader('Content-Disposition', 'inline; filename="resume.pdf"');
        res.send(pdf);
      } finally {
        await browser.close();
      }
    } catch (error) {
      console.error(error);
      res.status(500).send("Failed to generate PDF");
    }
  });

  console.log("Environment Variables Check:");
  console.log("PUPPETEER_EXECUTABLE_PATH:", process.env.PUPPETEER_EXECUTABLE_PATH);
  console.log("HTTP_PROXY:", process.env.HTTP_PROXY);

  // Google Drive Client Setup
  const getDriveClient = (accessToken?: string) => {
    // Ensure accessToken is a valid string and not "null", "undefined", or empty
    const isValidToken = accessToken && 
                        typeof accessToken === 'string' && 
                        accessToken !== 'null' && 
                        accessToken !== 'undefined' && 
                        accessToken.trim() !== '';

    if (isValidToken) {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: accessToken });
      return google.drive({ version: 'v3', auth });
    }

    const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const folderId = process.env.GOOGLE_SERVICE_ACCOUNT_FOLDER_ID;

    if (!serviceAccountKey) {
      console.warn("GOOGLE_SERVICE_ACCOUNT_KEY is not set. Drive fallback to Service Account will be unavailable.");
      return null;
    }

    if (folderId && (folderId.startsWith('{') || folderId.includes('service_account'))) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_FOLDER_ID appears to contain a Service Account JSON instead of a Folder ID. Please check your environment variables.");
    }
    
    let credentials;
    try {
      credentials = JSON.parse(serviceAccountKey);
    } catch (e) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not a valid JSON string. Ensure it is the full content of your service account key file.");
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
      },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    return google.drive({ version: 'v3', auth });
  };

  app.post("/api/save-to-drive", async (req, res) => {
    const { pdfData, fileName, versioningEnabled, accessToken, parentFolderId } = req.body;
    
    if (!pdfData || !fileName) {
      return res.status(400).json({ error: "PDF data and file name are required" });
    }

    // Escape single quotes in file name for Drive query
    const escapedFileName = fileName.replace(/'/g, "\\'");

    try {
      const drive = getDriveClient(accessToken);
      const folderId = parentFolderId || process.env.GOOGLE_SERVICE_ACCOUNT_FOLDER_ID;
      
      // Determine mimeType from fileName
      const mimeType = fileName.endsWith('.csv') ? 'text/csv' : 'application/pdf';

      // Convert base64 to stream
      const buffer = Buffer.from(pdfData, 'base64');
      const bufferStream = new stream.PassThrough();
      bufferStream.end(buffer);

      let fileId = null;
      
      if (!versioningEnabled) {
        // Search for existing file with same name
        const query = folderId 
          ? `name = '${escapedFileName}' and '${folderId}' in parents and trashed = false`
          : `name = '${escapedFileName}' and trashed = false`;

        const response = await drive.files.list({
          q: query,
          fields: 'files(id, name)',
          spaces: 'drive',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        
        if (response.data.files && response.data.files.length > 0) {
          fileId = response.data.files[0].id;
        }
      }

      if (fileId) {
        // Update existing file
        await drive.files.update({
          fileId: fileId,
          media: {
            mimeType: mimeType,
            body: bufferStream,
          },
          supportsAllDrives: true,
        });
        res.json({ success: true, message: "File updated successfully", fileId });
      } else {
        // Create new file
        const finalFileName = versioningEnabled 
          ? `${fileName.replace(/\.(pdf|csv)$/, '')} (v${new Date().toISOString().replace(/[:.]/g, '-')})${fileName.endsWith('.csv') ? '.csv' : '.pdf'}`
          : fileName;

        const fileMetadata: any = {
          name: finalFileName,
          mimeType: mimeType,
        };

        if (folderId) {
          fileMetadata.parents = [folderId];
        }
        
        const media = {
          mimeType: mimeType,
          body: bufferStream,
        };

        const file = await drive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: 'id',
          supportsAllDrives: true,
        });
        res.json({ success: true, message: "File created successfully", fileId: file.data.id });
      }
    } catch (error: any) {
      console.error("Drive Save Error:", error.message || error);
      let errorData = null;
      if (error.response && error.response.data) {
        errorData = error.response.data;
        console.error("Drive Save Error Details:", JSON.stringify(errorData));
      }
      
      let errorMessage = "Failed to save to Google Drive";
      let statusCode = error.response?.status || 500;
      
      if (statusCode === 401) {
        errorMessage = "AUTH_EXPIRED: Your Google Drive session has expired. Please reconnect your Drive in settings.";
      } else if (statusCode === 403 && errorData?.error?.message?.includes("storage quota")) {
        errorMessage = "STORAGE_QUOTA_EXCEEDED: Service Account has no storage quota on personal drives. Please set your parent folder to a folder inside a 'Shared Drive' (created in Google Drive).";
      } else if (error.code === 404) {
        errorMessage = "Folder or File not found. Please verify your folder ID and permissions.";
      } else if (error.message && error.message.includes("invalid_grant")) {
        errorMessage = "Authentication failed. Please check your Service Account configuration.";
      } else {
        errorMessage = error.message || errorMessage;
      }

      res.status(statusCode).json({ error: errorMessage });
    }
  });

  app.get("/api/list-drive-folders", async (req, res) => {
    const accessToken = req.query.accessToken as string | undefined;
    try {
      const drive = getDriveClient(accessToken);
      if (!drive) {
        return res.status(401).json({ error: "Google Drive is not connected. Please connect via OAuth in settings." });
      }
      const response = await drive.files.list({
        // List folders that are not trashed
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        pageSize: 1000,
        fields: 'files(id, name, modifiedTime)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      res.json({ 
        success: true, 
        folders: response.data.files || [] 
      });
    } catch (error: any) {
      console.error("Drive Folder List Error:", error.message || error);
      
      let errorMessage = error.message || "Failed to fetch Drive folders";
      if (error.code === 401 || (error.response && error.response.status === 401)) {
        errorMessage = "AUTH_EXPIRED: Your Google Drive session has expired. Please reconnect your Drive in settings.";
      }

      res.status(error.response?.status || 500).json({ 
        success: false, 
        error: errorMessage
      });
    }
  });

  app.get("/api/list-drive-files", async (req, res) => {
    const accessToken = req.query.accessToken as string | undefined;
    try {
      const drive = getDriveClient(accessToken);
      if (!drive) {
        return res.status(401).json({ error: "Google Drive is not connected. Please connect via OAuth in settings." });
      }
      const folderId = process.env.GOOGLE_SERVICE_ACCOUNT_FOLDER_ID;
      
      const query = folderId 
        ? `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`
        : "mimeType = 'application/pdf' and trashed = false";

      const response = await drive.files.list({
        q: query,
        pageSize: 50,
        fields: 'files(id, name, webViewLink, modifiedTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      res.json({ 
        success: true, 
        files: response.data.files || [] 
      });
    } catch (error: any) {
      console.error("Drive List Error:", error.message || error);
      if (error.response && error.response.data) {
        console.error("Drive List Error Details:", JSON.stringify(error.response.data));
      }
      
      let errorMessage = error.message || "Failed to fetch Drive files";
      if (error.code === 401 || (error.response && error.response.status === 401)) {
        errorMessage = "AUTH_EXPIRED: Your Google Drive session has expired. Please reconnect your Drive in settings.";
      }

      res.status(error.response?.status || 500).json({ 
        success: false, 
        error: errorMessage
      });
    }
  });

  app.patch("/api/rename-drive-file", express.json(), async (req, res) => {
    const { fileId, newName, accessToken } = req.body;
    if (!fileId || !newName) {
      return res.status(400).json({ error: "Missing fileId or newName" });
    }
    try {
      const drive = getDriveClient(accessToken);
      await drive.files.update({
        fileId: fileId,
        requestBody: {
          name: newName.endsWith('.pdf') ? newName : `${newName}.pdf`
        },
        supportsAllDrives: true,
      });
      res.json({ success: true, message: "File renamed successfully" });
    } catch (error: any) {
      console.error("Drive Rename Error:", error.message || error);
      if (error.response && error.response.data) {
        console.error("Drive Rename Error Details:", JSON.stringify(error.response.data));
      }
      
      let errorMessage = error.message || "Failed to rename file";
      if (error.code === 401 || (error.response && error.response.status === 401)) {
        errorMessage = "AUTH_EXPIRED: Your Google Drive session has expired. Please reconnect your Drive in settings.";
      }
      
      res.status(error.response?.status || 500).json({ error: errorMessage });
    }
  });

  app.delete("/api/delete-drive-file", express.json(), async (req, res) => {
    const { fileId, accessToken } = req.body;
    if (!fileId) {
      return res.status(400).json({ error: "Missing fileId" });
    }
    try {
      const drive = getDriveClient(accessToken);
      await drive.files.delete({
        fileId: fileId,
        supportsAllDrives: true,
      });
      res.json({ success: true, message: "File deleted successfully" });
    } catch (error: any) {
      console.error("Drive Delete Error:", error.message || error);
      if (error.response && error.response.data) {
        console.error("Drive Delete Error Details:", JSON.stringify(error.response.data));
      }
      
      let errorMessage = error.message || "Failed to delete file";
      if (error.code === 401 || (error.response && error.response.status === 401)) {
        errorMessage = "AUTH_EXPIRED: Your Google Drive session has expired. Please reconnect your Drive in settings.";
      }
      
      res.status(error.response?.status || 500).json({ error: errorMessage });
    }
  });

  app.get("/api/test-drive", async (req, res) => {
    const accessToken = req.query.accessToken as string | undefined;
    try {
      const drive = getDriveClient(accessToken);
      const response = await drive.files.list({
        pageSize: 1,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      res.json({ 
        success: true, 
        message: accessToken 
          ? "Connection successful! Authenticated via Google OAuth." 
          : "Connection successful! Drive API is enabled and Service Account is authenticated.",
        filesFound: response.data.files?.length || 0
      });
    } catch (error: any) {
      console.error("Drive Test Error:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message || "Failed to connect to Google Drive",
        details: accessToken 
          ? "Ensure your Google account has Drive API permissions and the token is valid."
          : "Ensure GOOGLE_SERVICE_ACCOUNT_KEY is correct and Drive API is enabled in Google Cloud Console."
      });
    }
  });

  // API Endpoint to encrypt API Key
  app.post("/api/encrypt-key", (req, res) => {
    const { apiKey, existingEncryptedKey } = req.body;
    if (!apiKey) {
      return res.status(400).json({ error: "API key is required" });
    }
    try {
      let keysToEncrypt = apiKey;
      
      // If we're passing a JSON string of keys and an existing encrypted key, merge them
      if (existingEncryptedKey) {
        try {
          const newKeys = JSON.parse(apiKey);
          const decryptedExisting = decrypt(existingEncryptedKey);
          let existingKeys: any = {};
          try {
            existingKeys = JSON.parse(decryptedExisting);
          } catch (e) {
            // If the existing key wasn't JSON, assume it was a Gemini key for backwards compatibility
            existingKeys = { gemini: decryptedExisting };
          }
          
          // Merge keys, keeping existing ones if the new one is empty
          const mergedKeys = {
            gemini: newKeys.gemini || existingKeys.gemini || '',
            openai: newKeys.openai || existingKeys.openai || ''
          };
          keysToEncrypt = JSON.stringify(mergedKeys);
        } catch (e) {
          // Ignore decryption errors, assume existing keys are invalid/inaccessible
        }
      }

      const encryptedKey = encrypt(keysToEncrypt);
      res.json({ encryptedKey });
    } catch (error: any) {
      console.error("Encryption Error:", error);
      res.status(500).json({ error: "Failed to encrypt API key" });
    }
  });

  // API Endpoint to decrypt API keys for frontend use
  app.post("/api/decrypt-keys", (req, res) => {
    const { encryptedKey } = req.body;
    if (!encryptedKey) {
      return res.status(400).json({ error: "Encrypted key is required" });
    }
    try {
      const decryptedString = decrypt(encryptedKey);
      let keys: any = {};
      try {
        keys = JSON.parse(decryptedString);
      } catch (e) {
        // For backwards compatibility if it was a single raw key
        keys = { gemini: decryptedString };
      }
      res.json({ keys });
    } catch (error: any) {
      console.error("Decryption Error:", error);
      res.status(500).json({ error: "Failed to decrypt API keys", details: error.message });
    }
  });

  // API Endpoint to clear cache
  app.post("/api/cache/clear", (req, res) => {
    Optimization.clearCache();
    res.json({ success: true, message: "Cache cleared successfully" });
  });

  // Admin Analytics Endpoints
  app.get("/api/admin/stats", async (req, res) => {
    try {
      const snapshot = await db.collection("analytics").get();
      const logs = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          ...data,
          timestamp: data.timestamp?.toDate?.()?.getTime() || data.timestamp || Date.now()
        } as UsageLog;
      });

      const totalRequests = logs.filter(l => l.endpoint === "/api/v2/optimize").length;
      const totalTokens = logs.reduce((sum, l) => sum + l.totalTokens, 0);
      const totalCost = logs.reduce((sum, l) => sum + l.cost, 0);
      const cacheHits = logs.filter(l => l.cacheHit).length;
      const cacheHitRatio = totalRequests > 0 ? (cacheHits / totalRequests) * 100 : 0;

      res.json({
        totalRequests,
        totalTokens,
        totalCost,
        cacheHitRatio
      });
    } catch (error) {
      console.error("Error fetching admin stats:", error);
      res.status(500).json({ error: "Failed to fetch admin stats" });
    }
  });

  app.get("/api/admin/usage-by-day", async (req, res) => {
    try {
      const snapshot = await db.collection("analytics").get();
      const logs = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          ...data,
          timestamp: data.timestamp?.toDate?.()?.getTime() || data.timestamp || Date.now()
        } as UsageLog;
      });

      const dailyData: Record<string, { tokens: number, cost: number }> = {};
      
      logs.forEach(log => {
        const date = new Date(log.timestamp).toISOString().split('T')[0];
        if (!dailyData[date]) {
          dailyData[date] = { tokens: 0, cost: 0 };
        }
        dailyData[date].tokens += log.totalTokens;
        dailyData[date].cost += log.cost;
      });

      const result = Object.entries(dailyData).map(([date, data]) => ({
        date,
        ...data
      })).sort((a, b) => a.date.localeCompare(b.date));

      res.json(result);
    } catch (error) {
      console.error("Error fetching usage by day:", error);
      res.status(500).json({ error: "Failed to fetch usage by day" });
    }
  });

  app.get("/api/admin/model-usage", async (req, res) => {
    try {
      const snapshot = await db.collection("analytics").get();
      const logs = snapshot.docs.map(doc => doc.data() as UsageLog);

      const modelData: Record<string, number> = {};
      
      logs.forEach(log => {
        const model = log.cacheHit ? "Cache" : log.model;
        modelData[model] = (modelData[model] || 0) + 1;
      });

      const result = Object.entries(modelData).map(([name, value]) => ({
        name,
        value
      }));

      res.json(result);
    } catch (error) {
      console.error("Error fetching model usage:", error);
      res.status(500).json({ error: "Failed to fetch model usage" });
    }
  });

  app.post("/api/v2/optimize", async (req, res) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const idToken = authHeader.split('Bearer ')[1];

    const { 
      resumeText, 
      jobDescription, 
      targetRole, 
      mode, 
      audience, 
      customPrompt, 
      pipelineType,
      targetCompany,
      brainDump,
      apiKey,
      bulletRules: requestedBulletRules,
      linkedinTrends
    } = req.body;

    if (!resumeText || !jobDescription) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const bulletRules = activeBulletRules(requestedBulletRules);
    const trends = activeLinkedInTrends(linkedinTrends, targetRole, jobDescription);

    try {
      // 1. Fetch keys securely from Firestore
      const keys = await getApiKeys(idToken);
      let geminiKey = keys?.gemini || "";
      let openaiKey = keys?.openai || "";
      
      // 1.1 Fetch Master Resumes from Firestore
      let masterResumes: any[] = [];
      try {
        const snapshot = await db.collection("master_resumes").get();
        masterResumes = snapshot.docs.map(doc => doc.data());
        console.log(`[Pipeline] Fetched ${masterResumes.length} master resumes.`);
      } catch (err) {
        console.warn("[Pipeline] Failed to fetch master resumes, proceeding without them:", err);
      }
      
      // Only fall back to system key if NO identity is provided (Guest Mode)
      if (!idToken) {
        geminiKey = geminiKey || process.env.GEMINI_API_KEY || "";
        openaiKey = openaiKey || "";
      }
      
      if (!geminiKey && !idToken) {
         console.warn("No API key found in Guest Mode. System may fall back to platform default.");
      }

      // 2. Override with API key from request if provided (supports both raw and encrypted)
      if (apiKey) {
        try {
          const decrypted = decrypt(apiKey);
          let parsedKeys: any = {};
          try {
            parsedKeys = JSON.parse(decrypted);
          } catch (e) {
            parsedKeys = { gemini: decrypted };
          }
          if (parsedKeys.gemini) geminiKey = parsedKeys.gemini;
          if (parsedKeys.openai) openaiKey = parsedKeys.openai;
        } catch (e) {
          // If decryption fails, assume it's a raw key (for Gemini)
          if (typeof apiKey === 'string' && apiKey.length > 20) {
             geminiKey = apiKey;
          }
        }
      }
      
      if (!geminiKey) console.warn("Gemini API key not found. Expecting platform-provided authentication to be available.");
      
      const selectedPipeline = pipelineType || 'hybrid-gemini';

      const config: any = {};
      if (geminiKey) config.apiKey = geminiKey;
      
      // Need to find where Gemini is instantiated to update it
      // Let's first verify where it's initialized and how it's used before changing too much.

      // 2. Check Cache First (Key includes all relevant fields + API key presence to avoid stale results from different keys)
      const cacheKey = pipelineCache.generateKey({ 
        resumeText: resumeText,
        jobDescription: jobDescription,
        targetRole, 
        mode, 
        audience, 
        customPrompt,
        pipelineType: selectedPipeline,
        hasGemini: !!geminiKey,
        hasOpenAI: !!openaiKey,
        ...(bulletRules ? { bulletRules: bulletRulesFingerprint(bulletRules) } : {}),
        ...(trends ? { linkedinTrends: trendFingerprint(trends) } : {})
      });
      
      const cachedResult = pipelineCache.get(cacheKey);
      if (cachedResult) {
        // Log cache hit
        logUsage({
          userId: "anonymous",
          model: "cache",
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheHit: true,
          endpoint: "/api/v2/optimize",
          timestamp: Date.now(),
          cost: 0
        });
        return res.json(cachedResult);
      }

      if (!geminiKey && !openaiKey && !process.env.GEMINI_API_KEY) {
        throw new Error("No valid API keys found. Please provide at least 1 Gemini or OpenAI API key in your profile.");
      }

      // STEP 1: Gemini (Cheap) - Extraction & Analysis
      console.log(`[Pipeline] Step 1: Gemini Extraction (${geminiKey ? 'User Key' : 'System Key'})...`);
      const [resumeExtraction, jdExtraction] = await Promise.all([
        Optimization.extractRelevantResumeData(resumeText, geminiKey, openaiKey, selectedPipeline),
        Optimization.extractJDKeywords(jobDescription, geminiKey, openaiKey, selectedPipeline)
      ]);

      const resumeData = resumeExtraction?.data;
      const jdKeywords = jdExtraction?.data || [];
      const extractionModelUsed = (resumeExtraction as any)?._model || "gemini-3-flash-preview";
      
      const geminiUsage = {
        promptTokenCount: (resumeExtraction?.usage?.promptTokenCount || 0) + (jdExtraction?.usage?.promptTokenCount || 0),
        candidatesTokenCount: (resumeExtraction?.usage?.candidatesTokenCount || 0) + (jdExtraction?.usage?.candidatesTokenCount || 0),
        totalTokenCount: (resumeExtraction?.usage?.totalTokenCount || 0) + (jdExtraction?.usage?.totalTokenCount || 0)
      };

      if (!resumeData) throw new Error("Failed to extract resume data using Gemini.");

      // STEP 2: Internal Logic (Free) - Trimming
      console.log("[Pipeline] Step 2: Trimming Content...");
      const budgetOptions = { now: new Date(), rules: bulletRules, jobDescription };
      const optimizedInput = Optimization.trimContentForAI(resumeData, jdKeywords, budgetOptions);
      const budgetPlan = planBulletBudgets(optimizedInput.experience, budgetOptions);
      const trendBrief = trends
        ? buildTrendBrief(trends, {
            scope: "document",
            evidenceText: trendEvidenceText(resumeText, brainDump),
          })
        : "";
      
      console.log("=== OPTIMIZED INPUT EXPERIENCE ===");
      console.dir(optimizedInput.experience, { depth: null });

      // STEP 3: Gemini 3.1 Pro (Premium) - Final Generation
      const roleCount = optimizedInput.experience.length;
      const finalPrompt = buildResumeGenerationPrompt({
        targetRole,
        audience,
        mode,
        targetCompany,
        customPrompt,
        brainDump,
        roleCount,
        jdKeywords: optimizedInput.jd_keywords,
        masterResumes,
        // The extracted keyword list alone is too lossy to differentiate two job
        // descriptions for similar roles, which caused near-identical output across
        // different JDs. The model needs the actual posting to tailor against.
        jobDescription: Optimization.trimInput(jobDescription, 6000),
        inputLabel: "INPUT DATA (structured, pre-extracted and trimmed)",
        inputData: JSON.stringify(optimizedInput, null, 2),
        bulletBudgets: budgetPlan.budgets,
        bulletRules: budgetPlan.rules,
        platformDecision: budgetPlan.platform,
        trendBrief,
      });

      let result;
      let usedModel = pipelineType === 'hybrid-openai' ? "gpt-4o" : "gemini-3.1-pro-preview";

      if (pipelineType === 'hybrid-openai') {
        // OPENAI BRANCH
        try {
          console.log(`[Hybrid Pipeline] Step 3: Premium OpenAI Generation (${usedModel})...`);
          const openai = new OpenAI({ apiKey: openaiKey });
          const chatCompletion = await openai.chat.completions.create({
            model: usedModel,
            messages: [{ 
              role: "system", 
              content: "You are a senior executive resume strategist. Output strictly JSON. Ensure EVERY SINGLE role from input is preserved." 
            }, { 
              role: "user", 
              content: finalPrompt
            }],
            response_format: { type: "json_object" }
          });

          const responseText = chatCompletion.choices[0].message.content || "";
          const genInput = chatCompletion.usage?.prompt_tokens || 0;
          const genOutput = chatCompletion.usage?.completion_tokens || 0;

          logUsage({
            userId: "anonymous",
            model: usedModel,
            inputTokens: genInput,
            outputTokens: genOutput,
            totalTokens: genInput + genOutput,
            cacheHit: false,
            endpoint: "/api/v2/optimize",
            timestamp: Date.now(),
            cost: calculateCost(usedModel, genInput, genOutput)
          });

          // Log Gemini Extraction
          logUsage({
            userId: "anonymous",
            model: extractionModelUsed,
            inputTokens: geminiUsage.promptTokenCount,
            outputTokens: geminiUsage.candidatesTokenCount,
            totalTokens: geminiUsage.totalTokenCount,
            cacheHit: false,
            endpoint: "/api/v2/optimize",
            timestamp: Date.now(),
            cost: calculateCost(extractionModelUsed, geminiUsage.promptTokenCount, geminiUsage.candidatesTokenCount)
          });

          result = {
            result: responseText,
            usage: {
              promptTokenCount: genInput,
              candidatesTokenCount: genOutput,
              totalTokenCount: genInput + genOutput
            },
            geminiUsage,
            intermediateData: { resumeData, jdKeywords },
            _engine: 'hybrid-openai',
            _model: usedModel
          };
        } catch (openaiError: any) {
          console.warn("[Pipeline] OpenAI Premium Failed, falling back to Gemini Flash Lite...", openaiError.message);
          // CRITICAL FALLBACK: If OpenAI (Premium) fails, use Gemini 3.1 Flash Lite then 3.5 Flash
          let fallbackModelName = "gemini-3.1-flash-lite";
          const genAI = new GoogleGenAI({ apiKey: geminiKey });
          
          let fallbackResult;
          try {
            fallbackResult = await genAI.models.generateContent({
              model: fallbackModelName,
              contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
              config: { responseMimeType: "application/json" }
            });
          } catch (e) {
            console.warn(`[Pipeline] Fallback to ${fallbackModelName} failed, trying 3.5-flash...`);
            fallbackModelName = "gemini-3.5-flash";
            fallbackResult = await genAI.models.generateContent({
              model: fallbackModelName,
              contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
              config: { responseMimeType: "application/json" }
            });
          }
          
          const text = fallbackResult.text || "";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("Both OpenAI and Fallback Gemini failed.");

          result = {
            result: jsonMatch[0],
            usage: {
              promptTokenCount: fallbackResult.usageMetadata?.promptTokenCount || 0,
              candidatesTokenCount: fallbackResult.usageMetadata?.candidatesTokenCount || 0,
              totalTokenCount: fallbackResult.usageMetadata?.totalTokenCount || 0
            },
            geminiUsage,
            intermediateData: { resumeData, jdKeywords },
            _model: fallbackModelName,
            _fallback: true
          };
        }
      } else {
        // GEMINI BRANCH
        try {
        console.log(`[Pipeline] Step 3: Split Generation (Gemini ${usedModel} with HIGH thinking)...`);
        const genAI = new GoogleGenAI({ apiKey: geminiKey });
        
        // 1. Generate Meta Data (Summary, Skills, Why This Job, etc.)
        const metaPrompt = `
          ACT AS:
          You are a Principal Resume Intelligence Architect and FAANG Recruiter.
          Optimize the meta-sections of this resume for factual realism and believable operational ownership.

          Target Role: ${targetRole}.
          Audience: ${audience}. Mode: ${mode}.
          ${customPrompt ? `READER GUIDANCE AND CUSTOM INSTRUCTIONS (emphasis only, never evidence): ${customPrompt}` : ''}
          Keywords: ${optimizedInput.jd_keywords.join(', ')}.
          ${brainDump ? `ADDITIONAL CONTEXT (BRAIN DUMP): ${brainDump}` : ''}
          ${trendBrief}
          
          INPUT DATA:
          ${JSON.stringify({
            personal_info: optimizedInput.personal_info,
            summary: optimizedInput.summary,
            skills: optimizedInput.skills,
            projects: optimizedInput.projects,
            education: optimizedInput.education,
            certifications: optimizedInput.certifications,
            jd_keywords: optimizedInput.jd_keywords
          }, null, 2)}
          
          STRICT RULES:
          1. Summary: 50-100 words, high impact, NO AI-slop words. Use natural, grounded operational verbs. Provide a concise overview of technical expertise and career trajectory.
          2. Skills: Categorize into exactly 4 logical categories relevant to ${targetRole}. Rename 'DevOps & Automation' to 'Infrastructure Operations & Automation'. Strictly replace 'CI/CD Pipeline Design' with 'Infrastructure Provisioning'.
          3. Why This Job: 75-125 words compelling response based on factual alignment.
          4. Projects (CRITICAL): You MUST output EVERY project provided in the INPUT DATA. Do not merge them. Keep project descriptions to a maximum of 2 sentences or 25 words, focusing strictly on the technical architecture and the business outcome.
          5. Education (MANDATORY): You MUST output the Education section. Do not skip or omit it.
          6. TRUTHFULNESS: DO NOT invent metrics, technologies, or certifications.
          7. GLOBAL NEGATIVE CONSTRAINTS: ABSOLUTELY FORBIDDEN: "CI/CD", "Pipelines", "DevOps".
          8. COMPLETE DATA: You MUST process and include EVERY SINGLE section provided in the INPUT DATA. Do not omit any roles, projects, or certifications.
          
          OUTPUT JSON SCHEMA:
          {
            "personal_info": { ... },
            "summary": "...",
            "skills": { "Category 1": ["skill1", ...], ... },
            "why_this_job": "...",
            "projects": [ { "title": "...", "description": "..." } ],
            "education": [ { "degree": "...", "institution": "...", "semester": "... (only if the source states it)", "expected_completion": "..." } ],
            "certifications": [...],
            "ats_keywords_from_jd": [...],
            "ats_keywords_added_to_resume": [...],
            "keyword_gap": [...],
            "improvement_notes": [...],
            "audience_alignment_notes": "...",
            "audit_report": { ... }
          }
        `;

        // 2. Generate Roles Individually (Parallel) and Deduplicate
        console.log(`[Pipeline] Spawning meta generation and ${optimizedInput.experience.length} role generation tasks...`);
        const [metaResponse, roleResults] = await Promise.all([
          genAI.models.generateContent({
            model: usedModel,
            contents: [{ role: 'user', parts: [{ text: metaPrompt }] }],
            config: { 
              responseMimeType: "application/json",
              thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM }
            }
          }),
          generatePerRole(
            optimizedInput.experience, 
            geminiKey, 
            targetCompany, 
            targetRole,
            audience,
            mode,
            customPrompt,
            brainDump,
            {
              budgetPlan,
              bulletRules: budgetPlan.rules,
              trends,
              // Each role is tailored against the real posting, like the whole-document path.
              jobDescription: Optimization.trimInput(jobDescription, 6000),
              jdKeywords: optimizedInput.jd_keywords,
            }
          )
        ]);

        const metaText = metaResponse.text || "";
        if (!metaText || metaText.length < 50) {
          throw new Error("Meta generation returned empty or invalid response.");
        }
        const metaData = JSON.parse(metaText);
        
        // 3. Deduplicate and Score
        console.log("[Pipeline] Deduplicating and Scoring...");
        const finalExperience = deduplicateAndScore(
          roleResults.map(({ star_stories, generation, ...role }) => role)
        );

        const finalResult = {
          ...metaData,
          experience: finalExperience,
          // Drafted per role, next to the evidence and the bullets they expand. The meta
          // call never sees the bullets, so stories it wrote could not link to any.
          star_stories: selectStarStories(roleResults)
        };

        // STEP 4: Agentic Review (Multi-Agent Refinement)
        console.log("[Pipeline] Step 4: Multi-Agent Review...");
        const agentFeedback = await runAgents(finalResult, geminiKey);

        result = {
          result: JSON.stringify(finalResult),
          agentFeedback,
          usage: {
            promptTokenCount: metaResponse.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: metaResponse.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: metaResponse.usageMetadata?.totalTokenCount || 0
          },
          geminiUsage,
          intermediateData: { resumeData, jdKeywords },
          _model: usedModel,
          _optimized: true,
          _split_gen: true,
          _agents: true
        };

        console.log("[Pipeline] Split Generation Complete.");

      } catch (genError: any) {
        console.error("[Pipeline] Split Generation Failed:", genError);
        // Fallback to simpler single call if split gen fails
        res.status(500).json({ error: "Failed to optimize resume via split pipeline", details: genError.message });
        return;
      }
    }
    
    if (result?.result) {
      const parsedResult = JSON.parse(result.result);
      if (trends) delete parsedResult.linkedin_trends;
      enforceBulletBudgets(parsedResult, {
        sourceText: [resumeText, brainDump].filter(Boolean).join("\n\n"),
        rules: budgetPlan.rules,
        jobDescription,
        sourceRoles: optimizedInput.experience,
        now: budgetOptions.now,
        ...(trends
          ? { preferTerms: trendPreferTerms(trends, trendEvidenceText(resumeText, brainDump)) }
          : {}),
      });
      if (trends) {
        applyTrendCoverage(parsedResult, trends, {
          sourceText: resumeText,
          extraEvidence: brainDump ? [brainDump] : [],
        });
      }
      result.result = JSON.stringify(parsedResult);
    }

    // STEP 5: Cache Result (Merged/Unified)
    if (result) {
      Optimization.saveToCache(cacheKey, result);
      res.json(result);
    }
    } catch (error: any) {
      console.error("V2 Optimization Error:", error);
      res.status(500).json({ error: "Failed to optimize resume via V2 pipeline", details: error.message });
    }
  });
  
  app.post("/api/v3/optimize", async (req, res) => {
    try {
      const authHeader = req.header('Authorization');
      if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
  
      const idToken = authHeader.split('Bearer ')[1];
  
      const { 
        resumeText, 
        jobDescription,
        targetRole,
        targetCompany,
        mode,
        audience,
        customPrompt,
        brainDump
      } = req.body;
  
      if (!resumeText || !jobDescription) {
        return res.status(400).json({ error: "Missing input" });
      }
  
      // ===============================
      // 1. GET KEYS
      // ===============================
      const keys = await getApiKeys(idToken);
      let geminiKey = process.env.GEMINI_API_KEY;
      if (keys && keys.gemini) {
        geminiKey = keys.gemini;
      } else {
        console.warn("User has no API key configured. Using system key.");
      }
  
      // ===============================
      // 2. EXTRACTION
      // ===============================
      const resumeExtraction = await Optimization.extractRelevantResumeData(resumeText, geminiKey);
      const jdExtraction = await Optimization.extractJDKeywords(jobDescription, geminiKey);
  
      const resumeData = resumeExtraction?.data;
      const jdKeywords = jdExtraction?.data || [];
  
      if (!resumeData) throw new Error("Extraction failed");
  
      // ===============================
      // 3. MULTI AGENT
      // ===============================
      const agentOutput = await runAgents({
        resume: resumeData,
        jd: jdKeywords
      }, geminiKey);
  
      // ===============================
      // 4. ROLE GENERATION (NO DUP)
      // ===============================
      const roles = await generatePerRole(
        agentOutput.hr.experience || resumeData.experience,
        geminiKey,
        targetCompany,
        targetRole,
        audience,
        mode,
        customPrompt,
        brainDump,
        {
          jobDescription: Optimization.trimInput(jobDescription, 6000),
          jdKeywords,
        }
      );
  
      // ===============================
      // 5. DEDUP + SCORE
      // ===============================
      const cleaned = deduplicateAndScore(
        roles.map(({ star_stories, generation, ...role }) => role)
      );
  
      const totalScore = cleaned.reduce((sum, r: any) => sum + (r.score || 0), 0);
  
      // ===============================
      // 6. SAVE MEMORY
      // ===============================
      await saveResumeVersion(db, "anonymous", {
        input: resumeData,
        output: cleaned,
        score: totalScore
      });
  
      // ===============================
      // 7. RESPONSE
      // ===============================
      res.json({
        experience: cleaned,
        score: totalScore,
        _engine: "multi-agent-v3"
      });
  
    } catch (error: any) {
      console.error("V3 Error:", error);
      res.status(500).json({
        error: "Optimization failed",
        details: error.message
      });
    }
  });

  // API Endpoint for PDF Generation (Direct)
  app.post("/api/generate-pdf", async (req, res) => {
    const { html, css, fonts } = req.body;
    await handlePdfGeneration(html, css, fonts, res);
  });

  // API Endpoint to create a PDF session
  app.post("/api/pdf-session", (req, res) => {
    const { html, css, fonts, title, scale } = req.body;
    if (!html) {
      return res.status(400).json({ error: "HTML content is required" });
    }
    const sessionId = uuidv4();
    pdfSessions.set(sessionId, { html, css, fonts, title, scale, timestamp: Date.now() });
    res.json({ sessionId });
  });

  // API Endpoints for Diagnostics
  app.get("/api/key-status", async (req, res) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(200).json({ type: "system", geminiStatus: "Using System Default", openaiStatus: "Using System Default" });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
      const keys = await getApiKeys(idToken);
      if (keys && keys.gemini) {
        return res.json({ 
          type: "user", 
          geminiStatus: `Personal Key (${keys.gemini.substring(0, 4)}...${keys.gemini.slice(-4)})`,
          openaiStatus: keys.openai ? `Personal Key (${keys.openai.substring(0, 4)}...${keys.openai.slice(-4)})` : "Not Configured"
        });
      }
      res.json({ type: "system", geminiStatus: "System Default (No Personal Key Found)", openaiStatus: "System Default" });
    } catch (error) {
      res.json({ type: "error", message: "Failed to verify identity" });
    }
  });

  app.post("/api/diagnose/gemini", async (req, res) => {
    const { idToken } = req.body;
    try {
      const keys = await getApiKeys(idToken);
      const geminiKey = keys?.gemini || process.env.GEMINI_API_KEY;
      if (!geminiKey) return res.status(401).json({ error: "No API key configured" });

      const ai = new GoogleGenAI({ apiKey: geminiKey });
      
      // Test 1: Simple List Models
      await ai.models.list();
      
      // Test 2: Deep Research capability test (with minimal/dummy prompt to trigger error if key issue)
      await ai.interactions.create({
        agent: "deep-research-preview-04-2026",
        input: "test connection",
      }).catch(e => {
        if(e.status === 400) throw e;
      });

      res.status(200).json({ status: "ok" });
    } catch (error: any) {
      console.error("[Diagnostics] Gemini Error:", error);
      res.status(500).json({ error: error.message || "Unknown error" });
    }
  });

  app.post("/api/diagnose/openai", async (req, res) => {
    const { idToken } = req.body;
    try {
      const keys = await getApiKeys(idToken);
      const openaiKey = keys?.openai || process.env.OPENAI_API_KEY;
      if (!openaiKey) return res.status(401).json({ error: "No API key configured" });

      const openai = new OpenAI({ apiKey: openaiKey });
      await openai.models.list();
      res.status(200).json({ status: "ok" });
    } catch (error: any) {
      console.error("[Diagnostics] OpenAI Error:", error);
      res.status(500).json({ error: error.message || "Unknown error" });
    }
  });

  app.post("/api/update-keys", async (req, res) => {
    const { idToken, geminiKey, openaiKey } = req.body;
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uid = decodedToken.uid;
      const encrypted = encrypt(JSON.stringify({ gemini: geminiKey, openai: openaiKey }));
      await db.collection("users").doc(uid).set({ encryptedApiKey: encrypted }, { merge: true });
      res.status(200).json({ success: true });
    } catch (error: any) {
      console.error("[Diagnostics] Update Error:", error);
      res.status(500).json({ error: error.message || "Unknown error" });
    }
  });

  // OMNI FEATURES: Vision Scanning
  app.post("/api/gemini/scan-resume", async (req, res) => {
    const { imageData, mimeType, idToken } = req.body;
    if (!imageData) return res.status(400).json({ error: "Image data required" });

    try {
      const keys = await getApiKeys(idToken);
      const geminiKey = keys?.gemini || (!idToken ? process.env.GEMINI_API_KEY : "");
      if (!geminiKey && idToken) return res.status(401).json({ error: "Personal API key required. Please update your profile settings." });
      if (!geminiKey) return res.status(401).json({ error: "No API key found" });

      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [{
          parts: [
            { inlineData: { data: imageData, mimeType: mimeType || "image/png" } },
            { text: "ACT AS: Expert ATS Resume Parser. EXTRACT ALL DATA from this resume image. Output as a clean JSON object compatible with a resume builder. Fields should include: contact (name, email, phone, location, linkedin), summary, experience (title, company, location, dateRange, highlights array), education (degree, school, location, dateRange), skills (category if applicable, or flat array), and projects. If you cannot read certain parts, leave them null. Output ONLY the JSON." }
          ]
        }],
        config: { responseMimeType: "application/json" }
      });

      res.json(JSON.parse(response.text || "{}"));
    } catch (error: any) {
      console.error("[Omni Scan] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // OMNI FEATURES: Deep Research
  app.post("/api/deep-research/start", async (req, res) => {
    const { resume, jd, idToken } = req.body;
    try {
      const keys = await getApiKeys(idToken);
      const geminiKey = keys?.gemini || process.env.GEMINI_API_KEY;
      if (!geminiKey) return res.status(401).json({ error: "No API key found" });

      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const interaction = await ai.interactions.create({
        agent: "deep-research-preview-04-2026",
        input: `Conduct a DEEP RESEARCH analysis of this resume against this Job Description. 
                RESUME: ${JSON.stringify(resume)}
                JD: ${jd}
                
                GOALS:
                1. Identify the most critical gaps in the resume for this specific role.
                2. Suggest highly specific, data-driven achievements to add (based on the provided resume content).
                3. Research the company's culture and typical interview questions for this role to provide tailoring advice.
                4. Final Output: Provide a structured report with "Critical Gaps", "Tailoring Suggestions", and "Strategic Advancements".`,
        background: true,
      });

      res.json({ interactionId: interaction.id });
    } catch (error: any) {
      console.error("[Deep Research] Start Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deep-research/status/:id", async (req, res) => {
    const { id } = req.params;
    const { idToken } = req.query;
    try {
      const keys = await getApiKeys(idToken as string);
      const geminiKey = keys?.gemini || process.env.GEMINI_API_KEY;
      if (!geminiKey) return res.status(401).json({ error: "No API key found" });

      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const interaction = await ai.interactions.get(id);
      
      let fullOutput = "";
      if (interaction.status === "completed") {
        for (const step of interaction.steps || []) {
          if (step.type === 'model_output') {
            const stepContent = step.content as any[];
            const textContent = stepContent?.find((c: any) => c.type === 'text');
            if (textContent && textContent.text) {
              fullOutput += textContent.text;
            }
          }
        }
      }

      res.json({
        status: interaction.status,
        output: fullOutput,
        progress: interaction.status === "completed" ? 100 : 50 // Simplified progress
      });
    } catch (error: any) {
      console.error("[Deep Research] Status Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // OMNI FEATURES: TTS Feedback
  app.post("/api/resume-feedback-audio", async (req, res) => {
    const { text, idToken } = req.body;
    try {
      const keys = await getApiKeys(idToken);
      const geminiKey = keys?.gemini || (!idToken ? process.env.GEMINI_API_KEY : "");
      if (!geminiKey && idToken) return res.status(401).json({ error: "Personal API key required. Please update your profile settings." });
      if (!geminiKey) return res.status(401).json({ error: "No API key found" });

      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-tts-preview',
        contents: [{ parts: [{ text: `Provide professional, encouraging audio feedback on this resume critique: ${text}` }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Zephyr" }
            }
          }
        }
      });

      const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      res.json({ audioData });
    } catch (error: any) {
      console.error("[TTS Feedback] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // API Endpoint to download PDF from session
  app.get("/api/download-pdf/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    const session = pdfSessions.get(sessionId);
    if (!session) {
      return res.status(404).send("PDF session expired or not found. Please try generating again.");
    }
    // Optional: delete session after retrieval to save memory
    // pdfSessions.delete(sessionId);
    await handlePdfGeneration(session.html, session.css, session.fonts, res, session.title, session.scale);
  });

  // Counts pages in a Chrome-generated PDF. Chrome/Skia writes object dictionaries
  // uncompressed, so each page appears as a literal "/Type /Page" (the page-tree
  // node is "/Type /Pages", hence the negative lookahead). Returns 0 if the buffer
  // can't be parsed, which callers treat as "unknown" and fail open.
  function countPdfPages(buffer: Uint8Array): number {
    const raw = Buffer.from(buffer).toString('latin1');
    const matches = raw.match(/\/Type\s*\/Page(?![sA-Za-z0-9])/g);
    return matches ? matches.length : 0;
  }

  async function handlePdfGeneration(html: string, css: string, fonts: string, res: any, title: string = "Resume", scale?: number) {
    if (!html) {
      return res.status(400).json({ error: "HTML content is required" });
    }
    if (/\[(?:REDACTED|MASKED)\b/i.test(html)) {
      return res.status(400).json({ error: "Turn off PII masking before exporting a resume." });
    }
    const safeLayout = /class=["'][^"']*\bats-safe-resume\b/i.test(html);
    const safeDocumentTitle = String(title || "Resume").replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    let browser;
    try {
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      
      browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox"],
      });

      const page = await browser.newPage();
      
      // Hard scale parameters to force perfect layout metrics
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });

      const baseHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <title>${safeDocumentTitle}</title>
            <style>
              /* 1. ATS-SAFE, LOCALLY-RESOLVABLE FONT STACK
                 We deliberately do NOT use a Google web font here. Chrome's PDF
                 backend does not embed downloaded web fonts: it writes a font
                 descriptor with a name but no /FontFile2, /Subtype or /BaseFont.
                 That produces a structurally incomplete font entry, which is why
                 the PDF failed to render in Explorer/Outlook preview panes, tripped
                 viewer warnings, and drifted visually from machine to machine -
                 every reader had to guess a substitute font.
                 Locally-installed fonts ARE embedded properly (full /FontFile2 +
                 /Type0 + /CIDFontType2), so the file becomes self-contained and
                 renders identically everywhere. Calibri first (the metrics the
                 layout is tuned for), then metric-compatible / universally present
                 fallbacks so the same output is produced on Linux CI or a Mac. */
              * { box-sizing: border-box; }

              @page { 
                size: A4; 
                margin: 10mm 10mm !important; /* Reclaims horizontal space on the physical page */
              }

              html, body {
                margin: 0 !important;
                padding: 0 !important;
                width: 100% !important;
                height: auto !important;
                background: white;
                font-family: Calibri, Carlito, 'Segoe UI', Arial, 'Liberation Sans', Helvetica, sans-serif !important;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }

              /* 1b. DISABLE TYPOGRAPHIC LIGATURES - CRITICAL FOR ATS PARSING.
                 By default the font merges 'fi', 'fl', 'ffi' and 'ffl' into single
                 glyphs, and they extract from the PDF as U+FB01/U+FB02/... instead
                 of plain ASCII. An applicant tracking system searching the text
                 layer therefore never matches high-value keywords: 'Configured'
                 became 'Con<fi>gured', 'workflows' became 'work<fl>ows', and
                 'Certified', 'Firewall', 'Defined' and 'Efficiency' were all
                 silently unsearchable. Turning ligatures off keeps them as real
                 characters with no visible change to the layout. */
              html, body, * {
                font-variant-ligatures: none !important;
                -webkit-font-feature-settings: "liga" 0, "clig" 0, "dlig" 0, "hlig" 0 !important;
                font-feature-settings: "liga" 0, "clig" 0, "dlig" 0, "hlig" 0 !important;
              }

              /* 2. STRETCH CONTENT HORIZONTALLY */
              #resume-container, .resume-page {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;   /* index.css pins .resume-page to 210mm; that overflows a 190mm print box */
                height: auto !important;
                min-height: 0 !important;  /* index.css pins 297mm, which forces spurious blank pages */
                margin: 0 auto !important;
                /* Overrides the massive 25mm internal padding from React to use the full page width */
                padding: 0mm 5mm !important; 
                box-shadow: none !important;
                border: none !important;
              }

              .resume-page {
                display: block !important; /* flex containers paginate badly in print */
              }

              /* Reduce bullet point indentation to gain more line length */
              ul {
                padding-left: 16px !important;
                margin-left: 0 !important;
              }

              /* 3. Typography
                 NOTE: We intentionally do NOT force a blanket font-size here anymore.
                 Every resume text node (name, section headings, job titles, bullets)
                 already carries its own explicit inline font-size from the editor's
                 formatting engine (e.g. 18pt name, 13pt section headings, 10.5pt body).
                 An '!important' rule here would beat those inline styles outright and
                 flatten the whole document down to one tiny, illegible size -
                 destroying the visual hierarchy the user configured on-screen.
                 Fitting long resumes to the page is instead handled by the
                 'transform: scale(printScale)' rule injected from the frontend
                 (see scaleCSS in App.tsx), which shrinks the whole layout
                 proportionally so text stays readable and properly sized relative
                 to everything else. */
              p, li, span, div, .resume-bullet-text {
                line-height: 1.4;
              }

              p, li, .resume-bullet-text, .experience-item div {
                text-align: left !important;
                text-justify: auto !important;
              }

              /* 4. Clean Section Spacing */
              .resume-section { margin-bottom: 8px !important; padding: 0 !important; }
              .experience-item { margin-bottom: 6px !important; }
              ul.resume-list { margin-top: 4px !important; margin-bottom: 4px !important; }
              li { margin-bottom: 4px !important; }

              /* Dynamic Scale Injection from Frontend */
              ${css || ''}
              ${fonts || ''}

              /* 5. FINAL ATS ENFORCEMENT - must be last.
                 The captured application CSS above is injected after our base rules,
                 so anything we declared earlier can still be overridden by it (an
                 equally-specific '!important' rule later in the sheet wins). These
                 two guarantees are non-negotiable for a resume that has to survive
                 both a PDF preview handler and an ATS text parser, so we restate
                 them here where nothing can outrank them. */
              html, body, #resume-container, .resume-page, #resume-container * {
                font-family: Calibri, Carlito, 'Segoe UI', Arial, 'Liberation Sans', Helvetica, sans-serif !important;
                font-variant-ligatures: none !important;
                -webkit-font-feature-settings: "liga" 0, "clig" 0, "dlig" 0, "hlig" 0 !important;
                font-feature-settings: "liga" 0, "clig" 0, "dlig" 0, "hlig" 0 !important;
              }

              /* Text must stay real, selectable, opaque text - never outlines or
                 transparent fills, which extract as nothing at all. */
              #resume-container * {
                -webkit-text-fill-color: currentColor !important;
                -webkit-text-stroke: 0 !important;
              }
              #resume-container .resume-contact { text-align: center !important; }
              #resume-container .resume-keep {
                break-inside: avoid !important;
                page-break-inside: avoid !important;
              }
            </style>
          </head>
          <body>
            ${html}
          </body>
        </html>
      `;

      // Set content and wait for it to load
      await page.setContent(baseHtml, { 
        waitUntil: "networkidle0", 
        timeout: 30000 
      });

      // Wait for Google Fonts to load
      await page.evaluateHandle('document.fonts.ready');
      await page.emulateMediaType("print");

      // Prefer two pages, while preserving every block and the readable text floor.
      //
      // The frontend can only estimate a fit factor from the on-screen preview,
      // which has different geometry from the print box - so an estimate alone
      // regularly lands on 3 pages. Instead we close the loop: render, count the
      // pages Chrome actually produced, and binary-search for the LARGEST readable
      // scale that fits. If the readable floor still overflows, retain extra pages.
      //
      // Shrink-to-fit uses page.pdf({ scale }) - Chrome's own print scale, which
      // repaginates correctly - rather than a CSS transform, which does not: Chrome
      // computes page breaks from the untransformed layout box, so a transform
      // shrinks the painted pixels but leaves the pagination alone.
      const MAX_PAGES = 2;
      const smallestTextPt = await page.evaluate(() => {
        const sizes = Array.from(document.querySelectorAll("#resume-container *"))
          .filter(element => Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
          .map(element => parseFloat(getComputedStyle(element).fontSize) * 0.75)
          .filter(size => Number.isFinite(size) && size > 0);
        return sizes.length ? Math.min(...sizes) : 11;
      });
      // Keep the complete content on additional pages rather than forcing sub-10 pt text.
      // A small cushion accounts for Chrome's fractional font-size quantization.
      const MIN_SCALE = Math.min(1, Math.max(0.5, 10.05 / smallestTextPt));

      const renderAt = (s: number) => page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        scale: s,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
      });

      // Full size first - most resumes already fit and need no shrinking at all.
      let pdfBuffer = await renderAt(1);
      let pageCount = countPdfPages(pdfBuffer);
      let density = 1;
      let finalScale = 1;

      if (pageCount > MAX_PAGES && !safeLayout) {
        // Snapshot once so the density steps never compound or change font sizes.
        const spacing = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("#resume-container *"))
          .map(element => {
            const style = getComputedStyle(element);
            return {
              lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize),
              marginTop: parseFloat(style.marginTop), marginBottom: parseFloat(style.marginBottom),
              paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom),
            };
          }));
        for (const factor of [0.94, 0.88]) {
          density = factor;
          await page.evaluate(({ spacing, factor }) => {
            const elements = document.querySelectorAll<HTMLElement>("#resume-container *");
            spacing.forEach((original, index) => {
              const element = elements[index];
              for (const property of ["marginTop", "marginBottom", "paddingTop", "paddingBottom"] as const) {
                if (Number.isFinite(original[property]) && original[property] >= 0) {
                  element.style.setProperty(property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`),
                    `${original[property] * factor}px`, "important");
                }
              }
              if (Number.isFinite(original.lineHeight)) {
                element.style.setProperty("line-height",
                  `${Math.min(original.lineHeight, Math.max(original.fontSize * 1.2, original.lineHeight * factor))}px`, "important");
              }
            });
          }, { spacing, factor });
          pdfBuffer = await renderAt(1);
          pageCount = countPdfPages(pdfBuffer);
          if (pageCount > 0 && pageCount <= MAX_PAGES) break;
        }
      }

      // pageCount === 0 means the buffer couldn't be parsed; fail open and ship it.
      if (pageCount > MAX_PAGES && !safeLayout) {
        let lo = MIN_SCALE;
        let hi = 1;
        let best: Uint8Array | null = null;

        // Seed the search with the frontend's estimate so we converge faster.
        const hint = Number(scale);
        const probes: number[] = [];
        if (Number.isFinite(hint) && hint > lo && hint < hi) probes.push(hint);
        for (let i = probes.length; i < 5; i++) probes.push(NaN);

        for (const seeded of probes) {
          const mid = Number.isFinite(seeded) ? seeded : (lo + hi) / 2;
          const candidate = await renderAt(mid);
          const pages = countPdfPages(candidate);
          if (pages > 0 && pages <= MAX_PAGES) {
            best = candidate; // fits - try to grow back toward full size
            finalScale = mid;
            lo = mid;
          } else {
            hi = mid; // still too long - shrink further
          }
        }

        // If the readable floor still overflows, preserve the extra pages and all content.
        if (best) pdfBuffer = best;
        else {
          finalScale = MIN_SCALE;
          pdfBuffer = await renderAt(MIN_SCALE);
        }
        pageCount = countPdfPages(pdfBuffer);
      }

      res.setHeader("Content-Type", "application/pdf");
      const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_');
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.pdf"`);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.setHeader("X-Resume-Page-Count", String(pageCount));
      res.setHeader("X-Resume-Layout", `density=${density}; scale=${finalScale}`);
      res.end(pdfBuffer);

    } catch (error: any) {
      console.error("CRITICAL PDF ERROR:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate PDF", details: error.message });
      }
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          console.error("Error closing puppeteer:", e);
        }
      }
    }
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.post("/api/match-resume", express.json(), async (req, res) => {
    const { resumes, jobDescription, generateCoverLetter } = req.body;
    try {
        // AI matching logic using Gemini here
        // ... (simplified representation of AI logic)
        res.json({ success: true, bestResume: resumes[0], analysis: "...", coverLetter: generateCoverLetter ? "..." : null });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/generate-cover-letter", express.json(), async (req, res) => {
    const { resume, jobDescription } = req.body;
    try {
        // AI cover letter generation logic
        res.json({ success: true, coverLetter: "..." });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {

    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});