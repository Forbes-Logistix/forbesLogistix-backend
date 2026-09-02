// LIVE: called by the full DOT driver application at
// forbeslogistix.com/application (activated 2026-07-14). See
// controllers/pdfController.js for the full note.

const express = require('express');
const router = express.Router();
const { sendPDF } = require('../controllers/pdfController');

router.post('/send-pdf', sendPDF);

module.exports = router;
