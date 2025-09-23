import pkg from "pg";
const { Pool } = pkg;

// Use Render-provided URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Render requires SSL
  },
});

export default pool;
