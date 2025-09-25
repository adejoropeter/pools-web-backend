// server.js
// Run with Node 18+ and "type": "module" in package.json
import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";       // ✅ full puppeteer for local
import * as cheerio from "cheerio";
import pkg from "pg";
import dotenv from "dotenv";
import process from "process";
import { randomUUID } from "crypto";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 4000;
// Postgres pool (Render requires SSL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----------------- DB initialization -----------------
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fixtures (
        week TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS adverts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("DB initialized ✅");
  } catch (err) {
    console.error("DB init error:", err);
    process.exit(1);
  }
}
await initDB();

// ----------------- Admin auth -----------------
const ADMIN_KEY = process.env.ADMIN_KEY || "";
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized. Provide valid x-admin-key header." });
  }
  next();
}

// ----------------- Puppeteer utils -----------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0",
];
function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ✅ Works both locally and on Render
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}


async function fetchHtmlWithPuppeteer(url) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.setUserAgent(randomUserAgent());
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType()))
        req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    try {
      await page.waitForSelector("select option", { timeout: 5000 });
    } catch {
      console.warn("⚠️ No <select> options found before timeout");
    }

    const content = await page.content();
    await page.close();
    await browser.close();
    return content;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("Puppeteer fetch error:", err);
    throw err;
  }
}

// ----------------- Fixtures -----------------
async function parseFixtures(html) {
  const $ = cheerio.load(html);
  const fixtures = [];
  $("#table tbody tr").each((i, row) => {
    const cols = $(row).find("td");
    const number = $(cols[0]).text().trim();
    const home = $(cols[1]).text().trim();
    const away = $(cols[3]).text().trim();
    const result = $(cols[4]).text().trim();
    const status = $(cols[5]).text().trim();
    if (number && home && away)
      fixtures.push({ number, home, away, result, status });
  });
  return fixtures;
}

async function saveFixturesToCache(week, fixtures) {
  try {
    await pool.query(
      `INSERT INTO fixtures (week, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (week) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [week, JSON.stringify(fixtures)]
    );
  } catch (err) {
    console.error("Error saving fixtures:", err);
  }
}

async function loadFixturesFromCache(week) {
  try {
    const r = await pool.query(
      `SELECT data, updated_at FROM fixtures WHERE week = $1`,
      [week]
    );
    if (!r.rows.length) return null;

    const { data, updated_at } = r.rows[0];
    return {
      fixtures: data,
      timestamp: new Date(updated_at).getTime(),
    };
  } catch (err) {
    console.error("Error loading fixtures from cache:", err);
    return null;
  }
}

async function fetchLatestFixtures() {
  const week = "latest";
  const cached = await loadFixturesFromCache(week);
  const now = Date.now();
  const cacheExpiry = 10 * 60 * 1000;

  if (cached && now - cached.timestamp < cacheExpiry) {
    return { week, fixtures: cached.fixtures, cached: true };
  }

  const html = await fetchHtmlWithPuppeteer("https://ablefast.com/");
  const fixtures = await parseFixtures(html);

  await saveFixturesToCache(week, { fixtures, timestamp: now });

  return { week, fixtures, cached: false };
}

async function fetchFixturesByDate(date) {
  const cached = await loadFixturesFromCache(date);
  if (cached) return { week: date, fixtures: cached, cached: true };
  const html = await fetchHtmlWithPuppeteer(
    `https://ablefast.com/results/${date}`
  );
  const fixtures = await parseFixtures(html);
  await saveFixturesToCache(date, fixtures);
  return { week: date, fixtures, cached: false };
}

async function fetchAvailableWeeks() {
  try {
    const html = await fetchHtmlWithPuppeteer("https://ablefast.com/");
    const $ = cheerio.load(html);
    const weeks = [];

    $("select option").each((i, el) => {
      const value = $(el).attr("value");
      const label = $(el).text().trim();
      if (value && value.includes("-")) {
        weeks.push({ date: value, label });
      }
    });

    return weeks;
  } catch (err) {
    console.error("fetchAvailableWeeks error:", err);
    return [];
  }
}

// ----------------- Routes -----------------
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const result = await fetchLatestFixtures();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch latest fixtures" });
  }
});

app.get("/api/fixtures/:date", async (req, res) => {
  try {
    const result = await fetchFixturesByDate(req.params.date);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch fixtures by date" });
  }
});

app.get("/api/weeks", async (req, res) => {
  try {
    const weeks = await fetchAvailableWeeks();
    if (!Array.isArray(weeks)) {
      return res.status(500).json({ error: "Weeks scraping failed", weeks });
    }
    res.json(weeks);
  } catch (err) {
    console.error("❌ /api/weeks error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------- Adverts -----------------
app.get("/api/adverts", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, excerpt, content, created_at, updated_at 
       FROM adverts ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching adverts:", err);
    res.status(500).json({ error: "Failed to fetch adverts" });
  }
});

app.get("/api/adverts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, title, excerpt, content, created_at, updated_at 
       FROM adverts WHERE id = $1`,
      [id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Advert not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching advert:", err);
    res.status(500).json({ error: "Failed to fetch advert" });
  }
});

app.post("/api/adverts", requireAdmin, async (req, res) => {
  try {
    const { title, excerpt, content } = req.body;
    if (!title || !excerpt || !content)
      return res
        .status(400)
        .json({ error: "title, excerpt and content are required" });

    const id = randomUUID();
    const now = new Date();
    await pool.query(
      `INSERT INTO adverts (id, title, excerpt, content, created_at, updated_at) 
       VALUES ($1,$2,$3,$4,$5,$5)`,
      [id, title, excerpt, content, now]
    );

    const created = (
      await pool.query(
        `SELECT id, title, excerpt, content, created_at, updated_at 
         FROM adverts WHERE id = $1`,
        [id]
      )
    ).rows[0];
    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating advert:", err);
    res.status(500).json({ error: "Failed to create advert" });
  }
});

app.put("/api/adverts/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, excerpt, content } = req.body;
    if (!title || !excerpt || !content)
      return res
        .status(400)
        .json({ error: "title, excerpt and content are required" });

    const result = await pool.query(
      `UPDATE adverts SET title=$1, excerpt=$2, content=$3, updated_at=NOW() 
       WHERE id=$4 
       RETURNING id, title, excerpt, content, created_at, updated_at`,
      [title, excerpt, content, id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Advert not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating advert:", err);
    res.status(500).json({ error: "Failed to update advert" });
  }
});

app.delete("/api/adverts/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM adverts WHERE id=$1 RETURNING id`,
      [id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Advert not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting advert:", err);
    res.status(500).json({ error: "Failed to delete advert" });
  }
});

// ----------------- Start -----------------
app.listen(PORT, () => {
  console.log(`Pool Fixtures & Adverts API running on port ${PORT}`);
});
