const jwt = require('jsonwebtoken'),
    secret = appconfig.jwt_secret,
    crypto = require('crypto');

exports.verifyRefreshBodyField = (req, res, next) => {
    if (req.body && req.body.refresh_token) {
        return next();
    } else {
        return res.status(400).send({error: 'need to pass refresh_token field'});
    }
};

exports.validRefreshNeeded = (req, res, next) => {
    let b = Buffer.from(req.body.refresh_token, 'base64');
    let refresh_token = b.toString();
    let hash = crypto.createHmac('sha512', req.jwt.refreshKey).update(req.jwt.userId + secret).digest("base64");
    if (hash === refresh_token) {
        req.body = req.jwt;
        return next();
    } else {
        return res.status(400).send({error: 'Invalid refresh token'});
    }
};

/**
 * Requires `Authorization: Bearer <jwt>`. Sets `req.jwt` on success.
 * Logs reason on 401/403 (does not log the token).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
exports.validJWTNeeded = (req, res, next) => {
    const label = `[auth JWT] ${req.method} ${req.originalUrl || req.url}`;
    if (req.headers['authorization']) {
        try {
            const authorization = req.headers['authorization'].split(' ');
            if (authorization[0] !== 'Bearer') {
                console.log(`${label} -> 401: scheme must be "Bearer", got "${authorization[0]}"`);
                return res.status(401).send();
            }
            if (!authorization[1]) {
                console.log(`${label} -> 403: Bearer token is missing after scheme`);
                return res.status(403).send();
            }
            req.jwt = jwt.verify(authorization[1], secret);
            console.log(`${label} -> OK userId=${req.jwt.userId} permissionLevel=${req.jwt.permissionLevel}`);
            return next();
        } catch (err) {
            const detail =
                err.name === 'TokenExpiredError'
                    ? `expired at ${err.expiredAt}`
                    : err.message;
            console.log(`${label} -> 403: verify failed (${err.name}): ${detail}`);
            return res.status(403).send();
        }
    } else {
        console.log(`${label} -> 401: no Authorization header`);
        return res.status(401).send();
    }
};
