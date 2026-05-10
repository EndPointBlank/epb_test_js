'use strict';

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { LogWriter } = require('end-point-blank-js/src/writers/log-writer');
const { listBooks, addBook, removeBook } = require('../data');

const router = Router();

/**
 * GET /books
 * Returns all books.
 */
router.get('/', authorized, versioned(['1'], { state: 'Current' }), (req, res) => {
  LogWriter.info('Fetching books list');
  res.json({ books: listBooks() });
});

/**
 * POST /books
 * Body: { title, author, student_id, teacher_id }
 * Adds a new book.
 */
router.post('/', authorized, versioned(['1'], { state: 'Current' }), (req, res) => {
  const { title, author, student_id, teacher_id } = req.body;

  if (!title || !author) {
    return res.status(422).json({ error: 'title and author are required' });
  }

  const book = addBook({ title, author, student_id, teacher_id });
  LogWriter.info(`Added book: ${title}`);
  res.status(201).json({ book });
});

/**
 * DELETE /books/:id
 * Removes a book by id.
 */
router.delete('/:id', authorized, versioned(['1'], { state: 'Current' }), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = removeBook(id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }

  LogWriter.info(`Removed book: ${book.title}`);
  res.json({ message: 'Book removed', book });
});

module.exports = router;
