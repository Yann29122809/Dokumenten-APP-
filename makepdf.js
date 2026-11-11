// Mehrere JPEG-Seiten zu einer PDF-Datei zusammenfügen – ohne Zusatzprogramm.
// Jede Seite bekommt die Breite einer A4-Seite, die Höhe passt sich dem Bild an.

const A4_WIDTH = 595.28; // in PDF-Punkten (1/72 Zoll)

async function imageSize(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Text als UTF-16 in Hex-Schreibweise (damit Umlaute im Titel klappen)
function pdfText(text) {
  let hex = 'FEFF';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) continue;
    hex += code.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

export async function imagesToPdf(jpegBlobs, title = 'Dokument') {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;

  const write = (chunk) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const startObject = (number) => {
    offsets[number] = length;
    write(`${number} 0 obj\n`);
  };

  // Objekt-Nummern: 1 Katalog, 2 Seitenliste, 3 Info, danach je Seite 3 Objekte
  const pageCount = jpegBlobs.length;
  const pageObj = (i) => 4 + i * 3;

  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  startObject(1);
  write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObject(2);
  const kids = jpegBlobs.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  write(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);

  startObject(3);
  write(`<< /Title ${pdfText(title)} /Producer (Dokumente-App) >>\nendobj\n`);

  for (let i = 0; i < pageCount; i++) {
    const blob = jpegBlobs[i];
    const { width, height } = await imageSize(blob);
    const pageW = A4_WIDTH;
    const pageH = (A4_WIDTH * height) / width;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const n = pageObj(i);
    const content = `q ${pageW.toFixed(2)} 0 0 ${pageH.toFixed(2)} 0 0 cm /Im0 Do Q`;

    startObject(n);
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>\nendobj\n`);

    startObject(n + 1);
    write(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    write(bytes);
    write('\nendstream\nendobj\n');

    startObject(n + 2);
    write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  }

  const objectCount = 4 + pageCount * 3;
  const xrefStart = length;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let n = 1; n < objectCount; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  write(xref);
  write(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
