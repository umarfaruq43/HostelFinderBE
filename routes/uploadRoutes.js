const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const isCloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

async function saveFile(file, req) {
  if (isCloudinaryConfigured) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'ochf' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(file.buffer);
    });
  }

  // Local fallback: write to uploads/ folder
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const ext = path.extname(file.originalname) || '.jpg';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, file.buffer);

  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/uploads/${filename}`;
}

// POST /upload  or  POST /upload/single
// Accepts multipart/form-data with field 'file', 'image', or 'document'
router.post('/single', upload.any(), async (req, res) => {
  try {
    const file = req.files && req.files.length > 0 ? req.files[0] : null;
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const url = await saveFile(file, req);
    return res.status(201).json({
      message: 'File uploaded successfully',
      url,
      filename: file.originalname,
      size: file.size,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// Alias for single upload at /upload
router.post('/', upload.any(), async (req, res) => {
  try {
    const file = req.files && req.files.length > 0 ? req.files[0] : null;
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const url = await saveFile(file, req);
    return res.status(201).json({
      message: 'File uploaded successfully',
      url,
      filename: file.originalname,
      size: file.size,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// POST /upload/multiple
// Accepts multipart/form-data with multiple files (e.g. property photos)
router.post('/multiple', upload.any(), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    const uploadPromises = req.files.map((file) => saveFile(file, req));
    const urls = await Promise.all(uploadPromises);

    return res.status(201).json({
      message: `${urls.length} file(s) uploaded successfully`,
      count: urls.length,
      urls,
      photos: urls.map((url, index) => ({ url, order: index })),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Multiple upload failed', error: err.message });
  }
});

module.exports = router;
