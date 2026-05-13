'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/epb_test_js_development',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      author     TEXT,
      student_id INTEGER,
      teacher_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS computers (
      id          SERIAL PRIMARY KEY,
      description TEXT NOT NULL,
      brand       TEXT,
      student_id  INTEGER,
      teacher_id  INTEGER
    );
    CREATE TABLE IF NOT EXISTS projectors (
      id          SERIAL PRIMARY KEY,
      description TEXT NOT NULL,
      brand       TEXT,
      facility    TEXT
    );
  `);

  const [books, computers, projectors] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM books'),
    pool.query('SELECT COUNT(*) FROM computers'),
    pool.query('SELECT COUNT(*) FROM projectors'),
  ]);

  if (parseInt(books.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO books (title, author, student_id, teacher_id) VALUES
        ('The Great Gatsby',      'F. Scott Fitzgerald', 1, 1),
        ('To Kill a Mockingbird', 'Harper Lee',          2, 1),
        ('1984',                  'George Orwell',       1, 2);
    `);
  }

  if (parseInt(computers.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO computers (description, brand, student_id, teacher_id) VALUES
        ('Dell Chromebook 3100', 'Dell', 1, 1),
        ('HP Desktop 400 G9',   'HP',   2, 1);
    `);
  }

  if (parseInt(projectors.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO projectors (description, brand, facility) VALUES
        ('Epson PowerLite 2250U', 'Epson', 'Room 101'),
        ('BenQ MH550',           'BenQ',  'Room 102');
    `);
  }
}

module.exports = { pool, setup };
