// Shared Cloudflare Turnstile verification used by the contact, lead, and
// PDF controllers. If TURNSTILE_SECRET is unset, verification is skipped so
// the endpoints stay functional until the Cloudflare site is provisioned.

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare siteverify normally answers well under a second; the timeout
// keeps a hung call from holding the serverless function until the platform
// kills it. Verification fails closed on timeout, matching the existing
// network-error behavior.
const VERIFY_TIMEOUT_MS = 8000;

async function verifyTurnstile(token, remoteIp) {
    if (!TURNSTILE_SECRET) {
        return { ok: true, skipped: true };
    }
    if (!token || typeof token !== 'string') {
        return { ok: false, reason: 'missing-token' };
    }
    try {
        const params = new URLSearchParams();
        params.append('secret', TURNSTILE_SECRET);
        params.append('response', token);
        if (remoteIp) params.append('remoteip', remoteIp);

        const resp = await fetch(TURNSTILE_VERIFY_URL, {
            method: 'POST',
            body: params,
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
        const data = await resp.json();
        return { ok: data && data.success === true };
    } catch (err) {
        console.error('Turnstile verification error:', err.message);
        return { ok: false, reason: 'verify-failed' };
    }
}

module.exports = { verifyTurnstile };
