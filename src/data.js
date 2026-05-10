'use strict';

/**
 * In-memory data store for the epb_test_js demo app.
 */

let nextId = 4;

const BOOKS = [
  { id: 1, title: 'The Great Gatsby',       author: 'F. Scott Fitzgerald', student_id: 1, teacher_id: 1 },
  { id: 2, title: 'To Kill a Mockingbird',  author: 'Harper Lee',          student_id: 2, teacher_id: 1 },
  { id: 3, title: '1984',                   author: 'George Orwell',       student_id: 1, teacher_id: 2 },
];

function listBooks() {
  return BOOKS.slice();
}

function addBook({ title, author, student_id, teacher_id }) {
  const book = { id: nextId++, title, author, student_id, teacher_id };
  BOOKS.push(book);
  return book;
}

function removeBook(id) {
  const idx = BOOKS.findIndex(b => b.id === id);
  if (idx === -1) return null;
  const [removed] = BOOKS.splice(idx, 1);
  return removed;
}

module.exports = { listBooks, addBook, removeBook };
