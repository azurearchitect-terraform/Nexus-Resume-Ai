import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtsResume } from "../src/components/AtsResume";
import { atsSafePDFStyle, canonicalResume, exportBlocks, groupExportUnits } from "../src/lib/atsDocument";
import type { AtsDocument } from "../src/lib/atsDocument";
import { validateExportText } from "../src/lib/exportValidation";
import { DEFAULT_STYLE } from "../src/context/FormattingContext";
import { paginationFixture } from "./paginationFixture";

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("real server Puppeteer PDF path preserves canonical content, readable fonts and smart page breaks", { timeout: 180000 }, async () => {
  const port = await unusedPort();
  const chrome = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === "win32" &&
    existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", data => { logs += data.toString(); });
  child.stderr.on("data", data => { logs += data.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const resume: AtsDocument = {
    personal_info: { name: "Avery & Candidate", email: "avery@example.org", phone: "+44 20 7946 0958", location: "London",
      linkedin: "https://www.linkedin.com/in/avery-candidate" },
    summary: "Configured efficient workflows, defined firewalls and certified office infrastructure.",
    skills: ["Azure", "Bicep", "TypeScript"],
    experience: [
      { role: "Platform Engineer", company: "Example Services Ltd", duration: "05/2021 - Present",
        bullets: Array.from({ length: 90 }, (_, index) => `Configured efficient workflow ${index + 1} and defined reliable firewall infrastructure for office services.`) },
      { role: "Consultant", company: "Prior Employer", duration: "2018 - 2020", bullets: ["Delivered cloud migration."] },
    ],
    projects: [{ title: "Office Platform", description: "Reliable infrastructure and workflow automation." }],
    certifications: ["Azure Fundamentals"],
    education: [{ degree: "BSc", institution: "Example University", duration: "2014 - 2018" }],
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      if (child.exitCode !== null) throw new Error(`PDF test server exited: ${logs}`);
      try {
        const response = await fetch(`${base}/api/health-check`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Isolated PDF server did not become ready: ${logs}`);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (const mode of ["standard", "simplified", "stress", "short"] as const) {
      const fixture = mode === "short" ? { ...paginationFixture, experience: paginationFixture.experience.slice(0, 1), projects: [] } : paginationFixture;
      const fixtureBlocks = exportBlocks(fixture);
      const html = `<div id="resume-container">${renderToStaticMarkup(createElement(AtsResume, {
        blocks: fixtureBlocks, masked: false,
        ...(mode !== "simplified" ? { sectionStyle: () => ({
          fontFamily: DEFAULT_STYLE.fontFamily, fontSize: `${DEFAULT_STYLE.fontSize}pt`, lineHeight: DEFAULT_STYLE.lineHeight,
          color: DEFAULT_STYLE.color, letterSpacing: `${DEFAULT_STYLE.letterSpacing}em`,
          padding: `${mode === "stress" ? 10 : DEFAULT_STYLE.padding}px`,
          marginBottom: `${mode === "stress" ? 12 : DEFAULT_STYLE.margin}px`,
        }) } : {}),
      }))}</div>`;
      const session = await fetch(`${base}/api/pdf-session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, css: mode === "simplified" ? atsSafePDFStyle() : "", fonts: "", title: "Morgan Candidate - Resume" }),
      });
      assert.equal(session.status, 200);
      const { sessionId } = await session.json();
      const response = await fetch(`${base}/api/download-pdf/${sessionId}`);
      assert.equal(response.status, 200, logs);
      const layout = response.headers.get("X-Resume-Layout");
      assert.ok(layout);
      console.log(`Pagination ${mode}: ${layout}`);
      if (mode === "simplified" || mode === "short") assert.equal(layout, "density=1; scale=1");
      if (mode === "stress") assert.ok(Number(/density=([\d.]+)/.exec(layout)![1]) < 1, "stress case uses density before scaling");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
      try {
        const pages: string[] = [];
        const sizes: number[] = [];
        for (let index = 1; index <= pdf.numPages; index++) {
          const content = await (await pdf.getPage(index)).getTextContent();
          pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
          for (const item of content.items) if ("str" in item && item.str.trim() && !/^[•·]$/.test(item.str)) {
            sizes.push(Math.hypot(item.transform[0], item.transform[1]));
          }
        }
        if (mode === "standard" || mode === "stress") assert.equal(pdf.numPages, 2, mode);
        assert.deepEqual(validateExportText(fixtureBlocks.map(block => block.text).join("\n"), pages).errors, [], mode);
        const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
        const normalizedPages = pages.map(normalize);
        for (const unit of groupExportUnits(fixtureBlocks)) {
          const pageNumbers = unit.blocks.map(block => normalizedPages.findIndex(page => page.includes(normalize(block.text))));
          assert.ok(pageNumbers.every(page => page >= 0), `${mode}: complete text of ${unit.unit}`);
          assert.equal(new Set(pageNumbers).size, 1, `${mode}: no split or orphan in ${unit.unit}`);
        }
        assert.ok(Math.min(...sizes) >= 10, `${mode}: readability floor`);
        assert.ok(!/[\uFB00-\uFB06]/u.test(pages.join("\n")));
        if (process.env.ATS_EXPORT_ARTIFACT_DIR) {
          await mkdir(process.env.ATS_EXPORT_ARTIFACT_DIR, { recursive: true });
          await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, `pagination-${mode}.pdf`), bytes);
          await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, `pagination-${mode}-layout.txt`), layout);
        }
      } finally {
        await pdf.destroy();
      }
    }
    const blocks = exportBlocks(resume);
    const html = `<div id="resume-container">${renderToStaticMarkup(createElement(AtsResume, { blocks, masked: false }))}</div>`;
    const sessionResponse = await fetch(`${base}/api/pdf-session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, css: atsSafePDFStyle(), fonts: "", title: `${resume.personal_info.name} - Resume`, scale: 0.5 }),
    });
    assert.equal(sessionResponse.status, 200);
    const { sessionId } = await sessionResponse.json();
    const response = await fetch(`${base}/api/download-pdf/${sessionId}`, { signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200, logs);
    assert.ok(response.headers.get("content-type")?.includes("application/pdf"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
    try {
      const pages: string[] = [];
      const sizes: number[] = [];
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
        for (const item of content.items) {
          if ("str" in item && item.str.trim() && !/^[•·]$/.test(item.str)) sizes.push(Math.hypot(item.transform[0], item.transform[1]));
        }
      }
      assert.deepEqual(validateExportText(blocks.map(block => block.text).join("\n"), pages).errors, []);
      assert.ok(pdf.numPages > 2, "safe exports preserve readability rather than forcing a two-page fit");
      assert.ok(Math.min(...sizes) >= 10.2, `safe PDF font floor (including compact contacts): ${Math.min(...sizes)}`);
      assert.ok(!/[\uFB00-\uFB06]/u.test(pages.join("\n")));
      assert.ok(pages.join("\n").includes("2018 - 2020"), "year-only dates survive extraction without invented months");
      const metadata = await pdf.getMetadata();
      assert.equal((metadata.info as { Title: string }).Title, "Avery & Candidate - Resume");
      assert.ok(Buffer.from(bytes).toString("latin1").includes("/FontFile2"), "local fonts are embedded");
      const annotations = await (await pdf.getPage(1)).getAnnotations();
      assert.ok(annotations.some(annotation => annotation.url === resume.personal_info.linkedin));
      if (process.env.ATS_EXPORT_ARTIFACT_DIR) {
        await mkdir(process.env.ATS_EXPORT_ARTIFACT_DIR, { recursive: true });
        await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, "ats-real-server.pdf"), bytes);
        await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, "ats-real-server-extracted.txt"), pages.join("\n\n"));
      }
    } finally {
      await pdf.destroy();
    }
    const master = canonicalResume(JSON.parse(await readFile(path.join(process.cwd(), "src", "services", "master_resume.json"), "utf8")));
    const masterBlocks = exportBlocks(master);
    for (const mode of ["standard", "simplified"] as const) {
      const masterHTML = `<div id="resume-container">${renderToStaticMarkup(createElement(AtsResume, {
        blocks: masterBlocks, masked: false,
        ...(mode === "standard" ? { sectionStyle: () => ({
          fontFamily: DEFAULT_STYLE.fontFamily, fontSize: `${DEFAULT_STYLE.fontSize}pt`, lineHeight: DEFAULT_STYLE.lineHeight,
          color: DEFAULT_STYLE.color, letterSpacing: `${DEFAULT_STYLE.letterSpacing}em`,
          padding: `${DEFAULT_STYLE.padding}px`, marginBottom: `${DEFAULT_STYLE.margin}px`,
        }) } : {}),
      }))}</div>`;
      const session = await fetch(`${base}/api/pdf-session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: masterHTML, css: mode === "simplified" ? atsSafePDFStyle() : "", fonts: "", title: `${master.personal_info.name} - Resume` }),
      });
      assert.equal(session.status, 200);
      const id = (await session.json()).sessionId;
      const result = await fetch(`${base}/api/download-pdf/${id}`);
      assert.equal(result.status, 200);
      const masterBytes = new Uint8Array(await result.arrayBuffer());
      const masterPDF = await getDocument({ data: masterBytes.slice(), useSystemFonts: true }).promise;
      try {
        const pages: string[] = [];
        const sizes: number[] = [];
        const bodySizes: number[] = [];
        const contactText = masterBlocks.find(block => block.kind === "contact")!.text;
        let contactLines: number[] = [];
        for (let index = 1; index <= masterPDF.numPages; index++) {
          const page = await masterPDF.getPage(index);
          const content = await page.getTextContent();
          pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
          for (const item of content.items) {
            if ("str" in item && item.str.trim() && !/^[•·]$/.test(item.str)) {
              const size = Math.hypot(item.transform[0], item.transform[1]);
              sizes.push(size);
              if (!contactText.includes(item.str.trim())) bodySizes.push(size);
            }
          }
          const longStandard = await fetch(`${base}/api/generate-pdf`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html: html.replace("ats-safe-resume", ""), css: "", fonts: "", scale: 0.5 }),
          });
          assert.equal(longStandard.status, 200);
          const longBytes = new Uint8Array(await longStandard.arrayBuffer());
          const longPDF = await getDocument({ data: longBytes.slice(), useSystemFonts: true }).promise;
          try {
            const pages: string[] = [];
            const sizes: number[] = [];
            for (let index = 1; index <= longPDF.numPages; index++) {
              const content = await (await longPDF.getPage(index)).getTextContent();
              pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
              for (const item of content.items) if ("str" in item && item.str.trim() && !/^[•·]$/.test(item.str)) sizes.push(Math.hypot(item.transform[0], item.transform[1]));
            }
            assert.ok(longPDF.numPages > 2, "long Standard content must not be silently shrunk to two pages");
            assert.ok(Math.min(...sizes) >= 10, `Standard readability floor: ${Math.min(...sizes)}`);
            assert.deepEqual(validateExportText(blocks.map(block => block.text).join("\n"), pages).errors, []);
          } finally {
            await longPDF.destroy();
          }
          if (index === 1) contactLines = content.items.filter(item => "str" in item &&
            (item.str.includes(master.personal_info.email) || item.str.includes("linkedin.com/in/")))
            .map(item => "str" in item ? item.transform[5] : 0);
          if (process.env.ATS_EXPORT_ARTIFACT_DIR) {
            const { createCanvas } = await import("@napi-rs/canvas");
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport }).promise;
            await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, `ats-master-${mode}-page${index}.png`), canvas.toBuffer("image/png"));
          }
        }
        const minimumPt = Math.min(...sizes);
        console.log(`Master ${mode}: ${masterPDF.numPages} pages; minimum effective text ${minimumPt.toFixed(3)} pt; body ${Math.min(...bodySizes).toFixed(3)} pt; ${master.experience.length} roles, ${master.experience.reduce((total, role) => total + role.bullets.length, 0)} bullets preserved.`);
        if (process.env.ATS_EXPORT_ARTIFACT_DIR) {
          await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, `ats-master-${mode}.pdf`), masterBytes);
          await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, `ats-master-${mode}-extracted.txt`), pages.join("\n\n"));
          await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, `ats-master-${mode}-measurements.json`), JSON.stringify({
            pages: masterPDF.numPages, minimumEffectiveTextPt: minimumPt, minimumBodyTextPt: Math.min(...bodySizes), contactBaselines: contactLines,
            roles: master.experience.length, bullets: master.experience.reduce((total, role) => total + role.bullets.length, 0),
          }, null, 2));
        }
        assert.deepEqual(validateExportText(masterBlocks.map(block => block.text).join("\n"), pages).errors, [], mode);
        assert.ok(masterPDF.numPages <= 2, `Master ${mode} uses ${masterPDF.numPages} pages`);
        assert.ok(minimumPt >= 10, `Master ${mode} minimum effective font: ${minimumPt}`);
        assert.ok(contactLines.length >= 1 && Math.max(...contactLines) - Math.min(...contactLines) < 1, `${mode}: email and LinkedIn must share a line`);
        assert.ok(pages.join("\n").includes("linkedin.com/in/harnishjariwala"));
        assert.ok(!pages.join("\n").includes("https://linkedin.com"));
        assert.ok((await (await masterPDF.getPage(1)).getAnnotations()).some(annotation => annotation.url === master.personal_info.linkedin));
      } finally {
        await masterPDF.destroy();
      }
    }
    const masked = await fetch(`${base}/api/generate-pdf`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>[REDACTED EMAIL]</p>", css: "", fonts: "" }),
    });
    assert.equal(masked.status, 400);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
