require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// DB 테이블 자동 생성
pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    name VARCHAR(200) NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )
`);

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

// 상품 등록 (이미지 업로드 속도 개선 버전)
app.post('/api/products', upload.single('image'), async (req, res) => {
  const { category, name, adminToken } = req.body;
  const ok = (adminToken === process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: '인증 실패' });

  try {
    // 1. 변환 없이 원본만 Cloudinary에 초고속 업로드
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image' },
        (err, result) => err ? reject(err) : resolve(result)
      ).end(req.file.buffer);
    });

    // 2. URL 문자열 조작으로 웜톤 필터 및 자동 압축 적용 (서버 연산 시간 0초)
    const transformedUrl = result.secure_url.replace(
      '/upload/',
      '/upload/q_auto,f_auto,e_brightness:5,cs_srgb/'
    );

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

// 상품 삭제
app.delete('/api/products/:id', async (req, res) => {
  const { adminToken } = req.body;
  const ok = (adminToken === process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: '인증 실패' });
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('서버 시작'));
