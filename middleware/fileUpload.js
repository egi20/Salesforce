'use strict';

const multer = require('multer');
const config = require('../config/config');
const { returnTo } = require('../utils/returnTo');
const { ACCEPTED_MIME: CV_MIME, ACCEPTED_EXT: CV_EXT, MAX_DOCUMENT_BYTES } = require('../config/cvImport');
const { verifyDeferred, csrfError } = require('./csrf');
const { SCREENSHOTS } = require('../config/issues');

/*
 * Every route that accepts a multipart body, as the full path. The CSRF middleware defers
 * its check for exactly these (see middleware/csrf.js) and the helpers below run it once
 * multer has parsed the body. A new upload route that is not listed here is refused by the
 * CSRF middleware — it fails closed, loudly, the first time anybody tries it.
 */
const UPLOAD_PATHS = Object.freeze([
  /^\/profile\/consultant\/photo$/,
  /^\/profile\/company\/logo$/,
  /^\/admin\/stories\/\d+\/photo$/,
  /^\/report-issue$/,
  /^\/profile\/consultant\/import-cv$/,
  /^\/profile\/consultant\/documents$/
]);

function isUploadPath(req) {
  return req.method === 'POST' && UPLOAD_PATHS.some((re) => re.test(req.path));
}

/**
 * Uploads are held in memory and written straight to the database.
 *
 * There is deliberately no disk destination: the host filesystem is ephemeral, so a
 * file that exists only on disk is gone at the next deploy. Keeping the bytes in memory
 * for the length of one request and storing them in MySQL removes that whole class of
 * "the image disappeared" bug.
 *
 * The extension allowlist is checked ALONGSIDE the MIME type, never instead of it: the
 * client controls both, so neither alone is evidence. The real guarantee comes later,
 * when sharp re-encodes the image and anything that was not an image fails to decode.
 */
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

function imageFilter(req, file, cb) {
  if (!IMAGE_MIME.has(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG, WebP or GIF images are accepted.'));
  }
  if (!IMAGE_EXT.test(file.originalname || '')) {
    return cb(new Error('That file extension is not accepted for an image.'));
  }
  return cb(null, true);
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxPhotoBytes, files: 1 },
  fileFilter: imageFilter
});

/**
 * Turn multer's own errors into flash + redirect rather than a 500.
 * A file that is too large is a user mistake, not a server fault.
 */
function handleUploadErrors(req, res, next) {
  return (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The limit is ${Math.round(config.uploads.maxPhotoBytes / 1024 / 1024)} MB.`
        : err.message;
    req.flash('error', message);
    return res.redirect(returnTo(req, '/dashboard'));
  };
}

/** Wrap a multer middleware so its errors go through `handleUploadErrors`. */
function singleImage(fieldName) {
  const handler = imageUpload.single(fieldName);
  return (req, res, next) => handler(req, res, (err) => {
    // The deferred CSRF check comes first: a forged request learns nothing from an upload error.
    if (!verifyDeferred(req)) return next(csrfError());
    return handleUploadErrors(req, res, next)(err);
  });
}

/**
 * The CV a consultant uploads for "Import from CV". Same memory-only, never-touches-disk
 * rule as an image — and the same reasoning: this file is read once, for one request, and
 * nothing about it is kept afterwards.
 */
function cvFilter(req, file, cb) {
  if (!CV_MIME.has(file.mimetype)) {
    return cb(new Error('Only a .docx or .txt file is accepted.'));
  }
  if (!CV_EXT.test(file.originalname || '')) {
    return cb(new Error('That file extension is not accepted.'));
  }
  return cb(null, true);
}

const cvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  fileFilter: cvFilter
});

/**
 * Errors here answer JSON, not a flash + redirect — the caller is a fetch() from the
 * profile form, not a full-page form post.
 */
function singleCv(fieldName) {
  const handler = cvUpload.single(fieldName);
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (!verifyDeferred(req)) return next(csrfError());
      if (!err) return next();
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `That file is too large. The limit is ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`
          : err.message;
      return res.status(400).json({ success: false, error: message });
    });
}

/*
 * Screenshots on /report-issue (migration 034): a few images, each bounded. Images only —
 * every one is re-encoded by sharp before it is stored, and a PDF or an office document
 * from a stranger is exactly what that re-encode exists to keep away from the administrator
 * who opens the report.
 *
 * An upload problem does NOT throw: it is put on `req.uploadError` for the route to say,
 * because the person's typed report matters more than the picture that failed.
 */
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCREENSHOTS.maxBytes, files: SCREENSHOTS.maxFiles, fields: 30 },
  fileFilter: imageFilter
});

function screenshots(fieldName) {
  const handler = screenshotUpload.array(fieldName, SCREENSHOTS.maxFiles);
  return (req, res, next) => handler(req, res, (err) => {
    if (!verifyDeferred(req)) return next(csrfError());
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE' ? `Each screenshot can be at most ${SCREENSHOTS.maxBytes / 1024 / 1024} MB.`
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `At most ${SCREENSHOTS.maxFiles} screenshots.`
            : err.message;
      req.files = [];
    }
    return next();
  });
}

/*
 * A consultant's own CV or cover letter (migration 037). Held in memory only; the bytes are
 * validated by utils/documentUpload.js before anything is stored. An upload problem is put on
 * `req.uploadError` for the route to flash, the same way screenshots do, because this is a
 * page form and the person should land back on the page with a reason.
 */
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 }
});

function singleDocument(fieldName) {
  const handler = documentUpload.single(fieldName);
  return (req, res, next) => handler(req, res, (err) => {
    if (!verifyDeferred(req)) return next(csrfError());
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large. The limit is 5 MB.' : err.message;
      req.file = null;
    }
    return next();
  });
}

module.exports = { singleImage, imageUpload, singleCv, singleDocument, screenshots, isUploadPath, UPLOAD_PATHS };
