const { requiresAuth } = require('express-openid-connect');
const { getOrCreateUser } = require('./db-queries');

/**
 * Middleware factory that restricts access to users whose DB role
 * matches one of the provided roles. The DB role is fetched via
 * authzero_id — Auth0 roles are NOT used.
 *
 * Usage:
 *   app.get('/repair-orders', requiresRole('Employee', 'Owner'), handler)
 *
 * requiresAuth() is called internally so there is no need to chain it separately.
 */
function requiresRole(...roles) {
  return [
    requiresAuth(),
    async (req, res, next) => {
      try {
        const dbUser = await getOrCreateUser(req.oidc.user);
        if (!roles.includes(dbUser.role)) {
          return res.status(403).render('403');
        }
        req.dbUser = dbUser;
        next();
      } catch (err) {
        next(err);
      }
    },
  ];
}

module.exports = { requiresRole };
