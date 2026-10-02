const { google } = require('googleapis');

// Service-account credentials are loaded from an env var (base64-encoded JSON)
// instead of a committed key file. Set GOOGLE_SERVICE_ACCOUNT_BASE64 in .env.
const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
if (!b64) {
    throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_BASE64 is not set. Add the base64-encoded ' +
        'service-account JSON to your .env file.'
    );
}

let credentials;
try {
    credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
} catch (err) {
    throw new Error('Failed to parse GOOGLE_SERVICE_ACCOUNT_BASE64: ' + err.message);
}

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
});

module.exports = auth;
