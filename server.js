require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ALLOWED_MIME = ['image/jpeg','image/png','image/webp','image/gif','video/mp4'];
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('지원하지 않는 파일 형식입니다. (jpg/png/webp/gif/mp4만 가능)'));
  },
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// DB 테이블 자동 생성 + is_featured 컬럼 마이그레이션
pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    name VARCHAR(200) NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    is_featured BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).then(() => {
  // 기존 테이블에 컬럼이 없을 경우 안전하게 추가 (이미 있으면 무시)
  return pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE
  `);
}).catch(err => console.error('DB 초기화 오류:', err));

// 상품 전체 조회
app.get('/api/products', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
  res.json(rows);
});

// 카테고리 목록
app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT DISTINCT category FROM products ORDER BY category');
  res.json(rows.map(r => r.category));
});

// 관리자 인증
app.post('/api/auth', async (req, res) => {
  const { code } = req.body;
  const ok = (code === process.env.ADMIN_PASSWORD);
  res.json({ ok });
});

// 상품 등록 (이미지/gif/mp4 업로드)
app.post('/api/products', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { category, name, adminToken } = req.body;
  const ok = (adminToken === process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: '인증 실패' });

  const isVideo = req.file.mimetype === 'video/mp4';
  const isGif   = req.file.mimetype === 'image/gif';
  // const needsTransform = !isVideo && !isGif; // gif/mp4는 색보정 변환 스킵
  const needsTransform = false; // 사용자 요청사항 반영

  try {
    // 1. Cloudinary 업로드 (gif/mp4는 video resource_type 사용)
    const resourceType = isVideo ? 'video' : 'image';
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: resourceType, eager_async: true },
        (err, result) => err ? reject(err) : resolve(result)
      ).end(req.file.buffer);
    });

    // 2. jpg/png/webp만 웜톤 필터 및 자동 압축 적용 (gif/mp4는 원본 URL 사용)
    const transformedUrl = needsTransform
      ? result.secure_url.replace('/upload/', '/upload/q_auto,f_auto,e_brightness:5,cs_srgb/')
      : result.secure_url;

    // 3. 변환된 URL을 DB에 저장
    const { rows } = await pool.query(
      'INSERT INTO products (category, name, image_url) VALUES ($1, $2, $3) RETURNING *',
      [category, name, transformedUrl]
    );
    
    res.json(rows[0]);

  } catch (error) {
    console.error("업로드 오류:", error);
    res.status(500).json({ error: '이미지 업로드 중 오류가 발생했습니다.' });
  }
});

// 주력 상품 설정 (기존 featured 해제 후 새 상품 설정)
app.patch('/api/products/:id/feature', async (req, res) => {
  const { adminToken } = req.body;
  const ok = (adminToken === process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: '인증 실패' });

  const id = req.params.id;
  try {
    await pool.query('UPDATE products SET is_featured = FALSE');
    await pool.query('UPDATE products SET is_featured = TRUE WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('주력 설정 오류:', err);
    res.status(500).json({ error: '설정 중 오류가 발생했습니다.' });
  }
});

// 주력 상품 해제
app.patch('/api/products/:id/unfeature', async (req, res) => {
  const { adminToken } = req.body;
  const ok = (adminToken === process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: '인증 실패' });

  try {
    await pool.query('UPDATE products SET is_featured = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('주력 해제 오류:', err);
    res.status(500).json({ error: '해제 중 오류가 발생했습니다.' });
  }
});

// 상품 삭제
app.delete('/api/products/:id', async (req, res) => {
  const { adminToken } = req.body;
  const ok = (adminToken === process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: '인증 실패' });
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('서버 시작'));
