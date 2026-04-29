require('dotenv').config();
const { Pool } = require('pg');

// Initialize the database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // THE DIGITAL OCEAN GOTCHA: You MUST configure SSL
    ssl: {
        rejectUnauthorized: false // This allows the connection without needing the CA cert file downloaded locally
    }
});

// A simple test to confirm we are connected
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client:', err.stack);
    }
    console.log('Successfully connected to DigitalOcean PostgreSQL!');
    release();
});

// Export the pool so you can use it in other files
module.exports = pool;