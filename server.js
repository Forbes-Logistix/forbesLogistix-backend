const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const pdfRoutes = require('./routes/pdfRoutes');
const contactRoutes = require('./routes/contactRoutes');
const leadRoutes = require('./routes/leadRoutes');

dotenv.config();

const app = express();

// Don't advertise the framework in response headers.
app.disable('x-powered-by');

// Vercel sits behind a proxy; trust it so rate limiter sees the real client IP.
app.set('trust proxy', 1);

const PROD_ORIGINS = [
    'https://www.forbeslogistix.com',
    'https://forbeslogistix.com',
    'https://forbes-frontend.vercel.app',
];

const DEV_ORIGINS = ['http://localhost:3000'];

// Only allow localhost outside prod. We don't enable credentials, so the
// localhost surface is small even if a stale production deploy was running,
// but defense in depth.
const allowedOrigins =
    process.env.NODE_ENV === 'production'
        ? PROD_ORIGINS
        : [...PROD_ORIGINS, ...DEV_ORIGINS];

// `credentials: true` is intentionally NOT set. The frontend doesn't send
// cookies (fetch() calls don't pass `credentials: 'include'`), so leaving
// this off shrinks the CSRF surface. The allowlist above is still enforced.
app.use(cors({
    origin: function (origin, callback) {
        // Disallowed origins get a clean CORS denial (no ACAO header on the
        // response) instead of a thrown error, which Express would otherwise
        // surface as a 500.
        callback(null, !origin || allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST'],
}));

// Contact and lead payloads are tiny; the driver-application PDF route is also
// well under this cap because it's just form fields, not file uploads.
app.use(express.json({ limit: '100kb' }));

const tenMinuteWindow = 10 * 60 * 1000;

const contactLimiter = rateLimit({
    windowMs: tenMinuteWindow,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again later.' },
});
app.use('/api/contact', contactLimiter);

const leadLimiter = rateLimit({
    windowMs: tenMinuteWindow,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again later.' },
});
app.use('/api/lead', leadLimiter);

// Driver application PDF endpoint — heavier work per request, so cap tighter.
const pdfLimiter = rateLimit({
    windowMs: tenMinuteWindow,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again later.' },
});
app.use('/api/send-pdf', pdfLimiter);

app.use('/api', pdfRoutes);
app.use('/api', contactRoutes);
app.use('/api', leadRoutes);

app.get('/', (req, res) => {
    res.send('Forbes Logistix Backend is Running');
});

module.exports = app;
