/**
 * Required External Modules
 */

const pool = require('./db');

async function getOrCreateUser(auth0User) {
  const auth0Id = auth0User.sub;

  // 1. Check if the user already exists
  // Note: Column names are case-sensitive in Postgres if created with quotes, 
  // but generally standard practice is to use exact case as defined in schema.
  const checkQuery = 'SELECT * FROM users WHERE Authzero_id = $1';
  const checkResult = await pool.query(checkQuery, [auth0Id]);

  if (checkResult.rows.length > 0) {
    return checkResult.rows[0];
  }

  
  // 3. Insert the new user
  // We leave out UserID (GENERATED ALWAYS) and created_at (DEFAULT CURRENT_TIMESTAMP)
  // because PostgreSQL will automatically handle them for us.
  const insertQuery = `
    INSERT INTO users (authzero_id, email, role) 
    VALUES ($1, $2, $3) 
    RETURNING *; 
  `;

  const values = [
    auth0Id,            // $1: Authzero_id
    auth0User.email,    // $2: Email
    'Customer'          // $3: Role
  ];

  const insertResult = await pool.query(insertQuery, values);

  return insertResult.rows[0];
}

const express = require('express');
const path = require('path');
const { auth, requiresAuth } = require('express-openid-connect');

require("dotenv").config();

/**
 * App Variables
 */

const env = process.env.NODE_ENV || "development";
const app = express();
const port = process.env.PORT || 3000;

/**
 *  App Configuration
 */

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  auth({
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    baseURL: process.env.BASE_URL,
    clientID: process.env.AUTH0_CLIENT_ID,
    secret: process.env.SESSION_SECRET,
    authRequired: false,
    auth0Logout: true,
  }),
);

app.use((req, res, next) => {
  res.locals.isAuthenticated = req.oidc.isAuthenticated();
  res.locals.activeRoute = req.originalUrl;
  next();
});

/**
 * Routes Definitions
 */

// > Home

app.get('/', (req, res) => {
  res.render('home');
});

// > Profile

app.get('/profile', requiresAuth(), async (req, res) => {
  try {
    // 1. Call our reusable function using the Auth0 user data
    const dbUser = await getOrCreateUser(req.oidc.user);

    // 2. Pass BOTH the Auth0 data and the Database data to the Pug template
    res.render('profile', {
      user: req.oidc.user, // From Auth0 (has picture, nickname)
      dbUser: dbUser       // From Postgres (has your internal ID, role, etc.)
    });

  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// > External API

app.get('/external-api', (req, res) => {
  res.render('external-api');
});

// > User
app.get('/users', async (req, res) => {
  try {
    // Write your raw SQL query
    const result = await pool.query('SELECT * FROM users');

    // Send the database rows back to the client
    res.json(result.rows);
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// > Authentication

app.get('/sign-up/:page', (req, res) => {
  const { page } = req.params;

  res.oidc.login({
    returnTo: page,
    authorizationParams: {
      screen_hint: 'signup',
    },
  });
});

app.get('/login/:page', (req, res) => {
  const { page } = req.params;

  res.oidc.login({
    returnTo: page,
  });
});

/*
app.get('/logout/:page', (req, res) => {
  const { page } = req.params;

  res.oidc.logout({
    returnTo: page,
  });
});
*/

/**
 * Server Activation
 */

app.listen(port, () => {
  console.log(`Listening to requests on http://localhost:${port}`);
});
