// Vercel serverless function: GET /api/db-health
//
// A read-only connectivity check. Visit this URL in your browser after
// setting the MYSQL_* environment variables and redeploying:
//   https://<your-app>.vercel.app/api/db-health
//
// It never writes anything - it just tries to connect and run a trivial
// query, then reports exactly what happened. Safe to leave in place
// permanently (it reveals no credentials), or delete once things are
// confirmed working.

const mysql = require('mysql2/promise');

module.exports = async (req, res) => {
  const config = {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    database: process.env.MYSQL_DATABASE,
  };

  // Fail fast with a clear message if the env vars themselves are missing -
  // this is the most common first problem, before networking even matters.
  const missing = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
    .filter(key => !process.env[key]);
  if (missing.length) {
    res.status(500).json({
      status: 'error',
      stage: 'config',
      message: `Missing environment variable(s): ${missing.join(', ')}. Set them in Vercel -> Settings -> Environment Variables, then redeploy.`,
    });
    return;
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 8000,
    });

    const [rows] = await connection.query(
      "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = ?",
      [process.env.MYSQL_DATABASE]
    );

    res.status(200).json({
      status: 'ok',
      message: 'Connected to MySQL successfully.',
      connectedTo: { host: config.host, port: config.port, database: config.database },
      tablesFound: rows[0].table_count,
    });
  } catch (err) {
    // Translate the most common failure codes into plain language, since
    // "connect ETIMEDOUT" alone won't mean much.
    let hint = 'Unexpected error - see the raw message below.';
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      hint = 'Could not reach the MySQL server at all. Most likely: MYSQL_HOST is still a local address (localhost/127.0.0.1/your laptop\'s LAN IP), or a firewall is blocking inbound connections on the MySQL port.';
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      hint = 'Reached the server, but the username/password was rejected. Double-check MYSQL_USER and MYSQL_PASSWORD.';
    } else if (err.code === 'ER_BAD_DB_ERROR') {
      hint = 'Reached the server and logged in, but the database named in MYSQL_DATABASE does not exist there yet. Did you run schema.sql against THIS host?';
    } else if (err.code === 'ENOTFOUND') {
      hint = 'MYSQL_HOST does not resolve to anything. Check for typos in the hostname.';
    }

    res.status(500).json({
      status: 'error',
      stage: 'connection',
      code: err.code || null,
      hint,
      rawMessage: err.message,
    });
  } finally {
    if (connection) await connection.end();
  }
};
