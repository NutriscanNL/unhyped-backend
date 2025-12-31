const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');

dotenv.config();

const { analyzeImageWithOpenAI } = require('./openai_unhyped.cjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024 },
});

function sniffMime(buffer, hintedMime, filename) {
  const hinted = (hintedMime || '').toLowerCase().trim();

  // 1) magic bytes
  if (buffer && buffer.length >= 12) {
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    // WEBP: RIFF....WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  }

  // 2) trusted hinted
  if (hinted.startsWith('image/')) return hinted;

  // 3) filename extension
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';

  // 4) common bad default
  if (hinted === 'application/octet-stream' || !hinted) return 'image/jpeg';

  return 'image/jpeg';
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'Missing OPENAI_API_KEY in .env' });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing image file field "image"' });
    }

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = sniffMime(req.file.buffer, req.file.mimetype, req.file.originalname);

    const out = await analyzeImageWithOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      imageBase64,
      mimeType,
    });

    return res.json(out);
  } catch (err) {
    console.error('[analyze] error:', err?.message || String(err));
    return res.status(500).json({
      error: 'Analyze failed',
      detail: err?.message || String(err),
    });
  }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Unhyped backend (OpenAI-only, v5.1.0) running on ${port}`);
});
server.setTimeout(120000);
