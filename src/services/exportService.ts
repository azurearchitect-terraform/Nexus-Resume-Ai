import { saveAs } from 'file-saver';
import { canonicalResume, resumeFileName } from '../lib/atsDocument';
import type { AtsDocument, ExportBlock } from '../lib/atsDocument';
import { createResumeDOCX } from '../lib/docxExport';

export const downloadDOCX = async (res: AtsDocument, targetRole: string, companyName: string,
  showToast: (msg: string, type: any) => void, blocks?: ExportBlock[], masked = false) => {
  if (!res) return;
  try {
    const blob = await createResumeDOCX(res, blocks, masked);
    saveAs(blob, resumeFileName(res, targetRole, 'docx'));
    showToast('DOCX Downloaded successfully!', 'success');
  } catch (err: any) {
    console.error('DOCX Generation Error:', err);
    showToast(err.message || 'Failed to generate DOCX. Please try again.', 'error');
  }
};

export const downloadJSON = (res: any, targetRole: string, companyName: string, showToast: (msg: string, type: any) => void) => {
  if (!res) return;
  try {
    const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
    const fileName = resumeFileName(canonicalResume(res), targetRole, 'json', companyName);
    saveAs(blob, fileName);
    showToast('JSON Exported successfully!', 'success');
  } catch (err: any) {
    console.error('JSON Export Error:', err);
    showToast('Failed to export JSON.', 'error');
  }
};
