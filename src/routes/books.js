'use strict';

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { LogWriter } = require('end-point-blank-js/src/writers/log-writer');
const { listBooks, addBook, removeBook } = require('../data');

const router = Router();

router.get('/', authorized, versioned(['1']), async (req, res, next) => {
  try {
    LogWriter.info('Fetching books list');
    res.json({ books: await listBooks() });
  } catch (err) { next(err); }
});

router.post('/', authorized, versioned(['1']), async (req, res, next) => {
  try {
    const { title, author, student_id, teacher_id } = req.body;
    if (!title || !author) {
      return res.status(422).json({ error: 'title and author are required' });
    }
    const book = await addBook({ title, author, student_id, teacher_id });
    LogWriter.info(`Added book: ${title}`);
    res.status(201).json({ book });
  } catch (err) { next(err); }
});

router.delete('/:id', authorized, versioned(['1']), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const book = await removeBook(id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    LogWriter.info(`Removed book: ${book.title}`);
    res.json({ message: 'Book removed', book });
  } catch (err) { next(err); }
});

module.exports = router;
