import pool from "./db.js";

// Create cache table if it doesn't exist
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE,
      data JSONB,
      last_fetched TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("✅ Database initialized");
}

// Save data into cache
export async function saveCache(key, data) {
  await pool.query(
    `
    INSERT INTO cache (key, data, last_fetched)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key)
    DO UPDATE SET data = $2, last_fetched = NOW()
    `,
    [key, data]
  );
}

// Get cached data
export async function getCache(key) {
  const result = await pool.query(
    "SELECT data, last_fetched FROM cache WHERE key = $1",
    [key]
  );
  return result.rows[0] || null;
}
