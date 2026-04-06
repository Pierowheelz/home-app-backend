const jwt = require('jsonwebtoken'),
    secret = appconfig['jwt_secret'];

const ADMIN_PERMISSION = 4096;

/**
 * @param {number} required_permission_level Bitmask; user must have `(level & required) !== 0`,
 *   or the admin bit (see `ADMIN_PERMISSION`); admins need not also set e.g. NORMAL_USER.
 * @returns {import('express').RequestHandler}
 */
exports.minimumPermissionLevelRequired = (required_permission_level) => {
    return (req, res, next) => {
        let user_permission_level = parseInt(req.jwt.permissionLevel, 10);
        let userId = req.jwt.userId;
        const hasRequired =
            (user_permission_level & required_permission_level) !== 0;
        const isAdmin = (user_permission_level & ADMIN_PERMISSION) !== 0;
        if (hasRequired || isAdmin) {
            return next();
        } else {
            const label = `[auth permission] ${req.method} ${req.originalUrl || req.url}`;
            console.log(
                `${label} -> 403: userId=${userId} effectiveLevel=${user_permission_level} (claim=${JSON.stringify(req.jwt.permissionLevel)}) lacks required bit ${required_permission_level} and admin bit ${ADMIN_PERMISSION}`
            );
            return res.status(403).send();
        }
    };
};

/**
 * @param {number} user_id Allowed JWT `userId` (numeric).
 * @returns {import('express').RequestHandler}
 */
exports.onlyUserCanDoThisAction = (user_id) => {
    return (req, res, next) => {
        let userId = parseInt(req.jwt.userId, 10);
        if (userId === parseInt(user_id, 10)) {
            return next();
        } else {
            const label = `[auth permission] ${req.method} ${req.originalUrl || req.url}`;
            console.log(`${label} -> 403: userId ${userId} is not allowed (only user ${user_id})`);
            return res.status(403).send();
        }
    };
};

/**
 * Allows the user in `req.params.userId` or any user with the admin permission bit.
 * @type {import('express').RequestHandler}
 */
exports.onlySameUserOrAdminCanDoThisAction = (req, res, next) => {

    let user_permission_level = parseInt(req.jwt.permissionLevel, 10);
    let userId = parseInt(req.jwt.userId, 10);
    if (req.params && req.params.userId && userId === parseInt(req.params.userId, 10)) {
        return next();
    } else {
        if (user_permission_level & ADMIN_PERMISSION) {
            return next();
        } else {
            const label = `[auth permission] ${req.method} ${req.originalUrl || req.url}`;
            console.log(
                `${label} -> 403: userId ${userId} is not target user ${req.params && req.params.userId} and lacks admin bit`
            );
            return res.status(403).send();
        }
    }

};

exports.sameUserCantDoThisAction = (req, res, next) => {
    let userId = req.jwt.userId;

    if (req.params.userId !== userId) {
        return next();
    } else {
        return res.status(400).send();
    }

};
