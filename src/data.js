'use strict';

const { pool } = require('./db');

async function listBooks() {
  const { rows } = await pool.query('SELECT * FROM books ORDER BY id');
  return rows;
}

async function addBook({ title, author, student_id, teacher_id }) {
  const { rows } = await pool.query(
    'INSERT INTO books (title, author, student_id, teacher_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [title, author, student_id, teacher_id]
  );
  return rows[0];
}

async function removeBook(id) {
  const { rows } = await pool.query('DELETE FROM books WHERE id = $1 RETURNING *', [id]);
  return rows[0] || null;
}

async function listComputers() {
  const { rows } = await pool.query('SELECT * FROM computers ORDER BY id');
  return rows;
}

async function projectorsByFacility() {
  const { rows } = await pool.query('SELECT * FROM projectors ORDER BY facility, id');
  return rows.reduce((acc, p) => {
    (acc[p.facility] = acc[p.facility] || []).push(p);
    return acc;
  }, {});
}

module.exports = { listBooks, addBook, removeBook, listComputers, projectorsByFacility };
