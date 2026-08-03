// pdf-common.js
// Shared PDF engine for Brane OD / Brane HR / Brane Scan, built to match
// the branded multi-page PDF (cover, table of contents, one section per
// page-group, closing page) that app.html (Brane) already generates
// client-side with jsPDF + html2canvas. Pulled out into one file so the
// three diagnostic tools don't each carry their own copy.
//
// Include AFTER the jspdf + html2canvas <script> tags and BEFORE each
// page's own inline <script> block:
//
//   <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
//   <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
//   <script src="pdf-common.js"></script>
//   <script> ...page-specific code, calls window.BranePDF... </script>

(function () {
  const A4_WIDTH_PX = 794;   // 210mm @ 96dpi
  const A4_HEIGHT_PX = 1123; // 297mm @ 96dpi
  const PX_TO_MM = 210 / A4_WIDTH_PX;
  const PDF_MARGIN_X = 64;
  const PDF_MARGIN_TOP = 72;
  const PDF_MARGIN_BOTTOM = 96;
  const PDF_CONTENT_W = A4_WIDTH_PX - PDF_MARGIN_X * 2;
  const PDF_CONTENT_H = A4_HEIGHT_PX - PDF_MARGIN_TOP - PDF_MARGIN_BOTTOM;
  const DEFAULT_ACCENT = '#008060';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function slugFileName(name) {
    return (name || 'Document').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'Document';
  }

  function pdfStage() {
    let stage = document.getElementById('pdf-stage');
    if (!stage) {
      stage = document.createElement('div');
      stage.id = 'pdf-stage';
      stage.style.position = 'fixed';
      stage.style.left = '-99999px';
      stage.style.top = '0';
      stage.style.zIndex = '-1';
      document.body.appendChild(stage);
    }
    return stage;
  }

  function pdfDiv(styles, html) {
    const d = document.createElement('div');
    Object.assign(d.style, styles || {});
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function makePage() {
    const page = document.createElement('div');
    page.style.width = A4_WIDTH_PX + 'px';
    page.style.height = A4_HEIGHT_PX + 'px';
    page.style.background = '#ffffff';
    page.style.position = 'relative';
    page.style.boxSizing = 'border-box';
    page.style.fontFamily = "'Inter', Arial, sans-serif";
    page.style.color = '#1A1A1A';

    const content = document.createElement('div');
    content.style.position = 'absolute';
    content.style.left = PDF_MARGIN_X + 'px';
    content.style.top = PDF_MARGIN_TOP + 'px';
    content.style.width = PDF_CONTENT_W + 'px';
    content.style.minHeight = PDF_CONTENT_H + 'px';
    page.appendChild(content);

    pdfStage().appendChild(page);
    return { page, content };
  }

  // ---------- Generic content-block helpers ----------

  function sectionHeadingBlock(docLabel, title, accent) {
    return pdfDiv({ marginBottom: '4px' },
      `<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${accent};margin-bottom:8px;">${escapeHtml(docLabel)}</div>
       <div style="font-size:26px;font-weight:800;color:#1A1A1A;margin-bottom:20px;border-bottom:2px solid ${accent};padding-bottom:14px;">${escapeHtml(title)}</div>`
    );
  }

  function kvBlock(k, v) {
    if (v === undefined || v === null || v === '') return null;
    return pdfDiv({ marginBottom: '16px' },
      `<div style="font-size:11px;font-weight:700;color:#6D6D6D;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.03em;">${escapeHtml(k)}</div>
       <div style="font-size:13px;line-height:1.65;color:#1A1A1A;">${escapeHtml(v)}</div>`
    );
  }

  function subheadBlock(text) {
    return pdfDiv({ fontSize: '13px', fontWeight: '700', color: '#1A1A1A', margin: '18px 0 8px' }, escapeHtml(text));
  }

  function bulletListBlock(items) {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return null;
    const rows = clean.map(item =>
      `<div style="padding:9px 0;border-top:1px solid #ECEDEF;font-size:12.5px;line-height:1.6;">• ${escapeHtml(item)}</div>`
    ).join('');
    return pdfDiv({}, `<div style="margin-top:-9px;">${rows}</div>`);
  }

  function numberedListBlock(items) {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return null;
    const rows = clean.map((item, i) =>
      `<div style="padding:9px 0;border-top:1px solid #ECEDEF;font-size:12.5px;line-height:1.6;"><strong>${i + 1}.</strong> ${escapeHtml(item)}</div>`
    ).join('');
    return pdfDiv({}, `<div style="margin-top:-9px;">${rows}</div>`);
  }

  function traitsBlock(items) {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return null;
    const chips = clean.map(t =>
      `<span style="font-size:11px;padding:6px 12px;border:1px solid #E1E3E5;border-radius:999px;color:#1A1A1A;">${escapeHtml(t)}</span>`
    ).join('');
    return pdfDiv({ display: 'flex', flexWrap: 'wrap', gap: '8px' }, chips);
  }

  function badgeBlock(label, value, color, bg) {
    if (!value) return null;
    return pdfDiv({ marginBottom: '16px' },
      `<div style="font-size:11px;font-weight:700;color:#6D6D6D;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.03em;">${escapeHtml(label)}</div>
       <span style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;padding:5px 12px;border-radius:999px;background:${bg};color:${color};">${escapeHtml(value)}</span>`
    );
  }

  function riskColors(level) {
    const l = (level || '').toLowerCase();
    if (l.includes('low')) return { color: '#0F5132', bg: '#E3F1E1' };
    if (l.includes('high')) return { color: '#B02A28', bg: '#FBE2E1' };
    return { color: '#8A5A15', bg: '#FCF0D9' };
  }

  // ---------- Cover / TOC / Closing pages ----------

  function buildCoverPage(pageEl, { title, eyebrow, tagline, dateStr, accent }) {
    pageEl.innerHTML = '';
    pageEl.style.display = 'flex';
    pageEl.style.flexDirection = 'column';
    pageEl.style.justifyContent = 'space-between';
    pageEl.style.padding = '90px 70px';
    pageEl.style.background = `linear-gradient(155deg, #FFFFFF 0%, #FFFFFF 55%, ${accent}14 100%)`;

    const top = document.createElement('div');
    top.appendChild(pdfDiv({
      width: '64px', height: '64px', borderRadius: '50%', background: accent, color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '28px', fontWeight: '800', marginBottom: '40px'
    }, escapeHtml((title || 'B').trim().charAt(0).toUpperCase())));
    top.appendChild(pdfDiv({
      fontSize: '13px', fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: accent, marginBottom: '18px'
    }, escapeHtml(eyebrow || '')));
    top.appendChild(pdfDiv({
      fontSize: '50px', fontWeight: '800', color: '#1A1A1A', lineHeight: '1.1',
      marginBottom: '20px', maxWidth: '560px'
    }, escapeHtml(title || 'Untitled')));
    if (tagline) {
      top.appendChild(pdfDiv({
        fontSize: '18px', fontWeight: '500', color: '#4A4A4A', lineHeight: '1.5',
        maxWidth: '480px', fontStyle: 'italic'
      }, '"' + escapeHtml(tagline) + '"'));
    }

    const bottom = document.createElement('div');
    bottom.appendChild(pdfDiv({ height: '10px', borderRadius: '6px', background: accent, marginBottom: '20px', width: '100%' }));
    bottom.appendChild(pdfDiv({
      fontSize: '12px', color: '#8A8A8A', display: 'flex', justifyContent: 'space-between'
    }, `<span>Prepared ${escapeHtml(dateStr)}</span><span>Generated by Brane AI</span>`));

    pageEl.appendChild(top);
    pageEl.appendChild(bottom);
  }

  function buildTocPage(pageEl, { eyebrow, entries, accent }) {
    pageEl.innerHTML = '';
    pageEl.style.padding = '90px 70px';
    pageEl.appendChild(pdfDiv({
      fontSize: '12px', fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: accent, marginBottom: '10px'
    }, escapeHtml(eyebrow || '')));
    pageEl.appendChild(pdfDiv({ fontSize: '30px', fontWeight: '800', color: '#1A1A1A', marginBottom: '40px' }, 'Table of Contents'));

    const list = document.createElement('div');
    entries.forEach((e, idx) => {
      list.appendChild(pdfDiv({
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: '14px 0', borderBottom: '1px solid #E1E3E5', fontSize: '15px'
      }, `<span style="font-weight:600;color:#1A1A1A;">${String(idx + 1).padStart(2, '0')} &nbsp; ${escapeHtml(e.title)}</span><span style="color:#8A8A8A;">Page ${e.pageNumber}</span>`));
    });
    pageEl.appendChild(list);
  }

  function buildClosingPage(pageEl, { title, toolLabel, dateStr, accent }) {
    pageEl.innerHTML = '';
    pageEl.style.display = 'flex';
    pageEl.style.flexDirection = 'column';
    pageEl.style.alignItems = 'center';
    pageEl.style.justifyContent = 'center';
    pageEl.style.padding = '90px 70px';
    pageEl.style.textAlign = 'center';

    pageEl.appendChild(pdfDiv({
      width: '56px', height: '56px', borderRadius: '50%', background: accent, color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '24px', fontWeight: '800', marginBottom: '28px'
    }, escapeHtml((title || 'B').trim().charAt(0).toUpperCase())));
    pageEl.appendChild(pdfDiv({ fontSize: '14px', color: '#6D6D6D', marginBottom: '6px' },
      escapeHtml(`${title || 'This document'} — ${toolLabel}`)));
    pageEl.appendChild(pdfDiv({ fontSize: '12px', color: '#8A8A8A', marginBottom: '40px' },
      escapeHtml(`Prepared ${dateStr}`)));
    pageEl.appendChild(pdfDiv({ fontSize: '16px', fontWeight: '700', color: '#1A1A1A', letterSpacing: '0.02em' },
      'Generated by Brane AI'));
  }

  // ---------- Pagination ----------

  function layoutBlocksToPages(blocks) {
    const pages = [];
    const GAP = 14;
    let current = makePage();
    let usedHeight = 0;

    blocks.forEach((block) => {
      current.content.appendChild(block);
      const h = block.offsetHeight;
      const addGap = usedHeight > 0 ? GAP : 0;
      if (usedHeight > 0 && usedHeight + addGap + h > PDF_CONTENT_H) {
        current.content.removeChild(block);
        pages.push(current);
        current = makePage();
        current.content.appendChild(block);
        usedHeight = h;
      } else {
        usedHeight += addGap + h;
      }
    });
    pages.push(current);
    return pages;
  }

  function findLinkRects(pageEl) {
    const rects = [];
    const pageBox = pageEl.getBoundingClientRect();
    pageEl.querySelectorAll('[data-pdf-link]').forEach(node => {
      const r = node.getBoundingClientRect();
      rects.push({ url: node.getAttribute('data-pdf-link'), x: r.left - pageBox.left, y: r.top - pageBox.top, w: r.width, h: r.height });
    });
    return rects;
  }

  // ---------- Public entry point ----------

  /**
   * @param {Object} opts
   * @param {string} opts.title - document title (org name / job title / etc.)
   * @param {string} [opts.eyebrow] - small label above the title (industry, department, etc.)
   * @param {string} [opts.tagline] - italic quote on the cover, if there is one
   * @param {string} opts.toolLabel - e.g. 'Organizational Development Diagnostic'
   * @param {Array<{title: string, blocks: (HTMLElement|null)[]}>} opts.sectionDefs
   * @param {string} [opts.accent] - hex color, defaults to Brane green
   * @returns {Promise<{blobUrl: string, fileName: string}>}
   */
  async function generateDocumentPDF(opts) {
    if (!window.jspdf || !window.html2canvas) throw new Error('PDF libraries failed to load');
    const { jsPDF } = window.jspdf;
    const stage = pdfStage();
    stage.innerHTML = '';

    const accent = opts.accent || DEFAULT_ACCENT;
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const cover = makePage();
    buildCoverPage(cover.page, { title: opts.title, eyebrow: opts.eyebrow, tagline: opts.tagline, dateStr, accent });

    const cleanedSectionDefs = (opts.sectionDefs || [])
      .map(def => ({ title: def.title, blocks: (def.blocks || []).filter(Boolean) }))
      .filter(def => def.blocks.length);

    const allContentPages = [];
    const tocEntries = [];
    cleanedSectionDefs.forEach(def => {
      const pages = layoutBlocksToPages(def.blocks);
      tocEntries.push({ title: def.title, pageIndexInContent: allContentPages.length });
      allContentPages.push(...pages);
    });
    tocEntries.forEach(entry => { entry.pageNumber = 2 + 1 + entry.pageIndexInContent; });

    const toc = makePage();
    buildTocPage(toc.page, { eyebrow: opts.eyebrow, entries: tocEntries, accent });

    const closing = makePage();
    buildClosingPage(closing.page, { title: opts.title, toolLabel: opts.toolLabel, dateStr, accent });

    const finalPages = [cover.page, toc.page, ...allContentPages.map(p => p.page), closing.page];

    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const totalPages = finalPages.length;

    for (let i = 0; i < finalPages.length; i++) {
      const pageEl = finalPages[i];
      const canvas = await html2canvas(pageEl, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
      const imgData = canvas.toDataURL('image/png');
      if (i > 0) doc.addPage();
      doc.addImage(imgData, 'PNG', 0, 0, 210, 297);

      if (i > 0) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(120, 120, 120);
        doc.text(dateStr, 15, 289);
        doc.text(`Page ${i + 1} of ${totalPages}`, 195, 289, { align: 'right' });
      }

      findLinkRects(pageEl).forEach(r => {
        doc.link(r.x * PX_TO_MM, r.y * PX_TO_MM, r.w * PX_TO_MM, r.h * PX_TO_MM, { url: r.url });
      });
    }

    const blob = doc.output('blob');
    const blobUrl = URL.createObjectURL(blob);
    const fileName = `${slugFileName(opts.title)}-${slugFileName(opts.toolLabel)}.pdf`;

    stage.innerHTML = '';
    return { blobUrl, fileName };
  }

  function triggerPdfDownload(blobUrl, fileName) {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  window.BranePDF = {
    escapeHtml,
    pdfDiv,
    sectionHeadingBlock,
    kvBlock,
    subheadBlock,
    bulletListBlock,
    numberedListBlock,
    traitsBlock,
    badgeBlock,
    riskColors,
    generateDocumentPDF,
    triggerPdfDownload
  };
})();
