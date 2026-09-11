// Vercel serverless function: POST /api/submit
//
// Receives the exact JSON payload the form already builds (see index.html,
// the `payload` object inside the submit handler) and writes it into the
// MySQL schema (sashakt_beneficiary_db, schema v3):
//   clients          <- client name / contact / area / DOB / anniversary
//   service_visits   <- one row for this visit
//   income_transactions <- one row PER beneficiary, linked to that visit
//
// It does NOT touch the Google Sheet / Apps Script integration - that stays
// exactly as it is. index.html now sends to both in parallel (see the
// updated submit handler), so nothing is lost if one side is briefly down.
//
// Required environment variables (set these in Vercel -> Project ->
// Settings -> Environment Variables, then redeploy):
//   MYSQL_HOST, MYSQL_PORT (default 3306), MYSQL_USER, MYSQL_PASSWORD,
//   MYSQL_DATABASE
// Optional:
//   MYSQL_SSL              set to "true" if your MySQL host requires SSL
//   DIVA_SALON_LOCATION    location_name to use/create in `locations`
//                          (default: "Diva Salon, Narol")

const mysql = require('mysql2/promise');

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
      maxIdle: 1,
      idleTimeout: 10000,
    });
  }
  return pool;
}

const LOCATION_NAME = process.env.DIVA_SALON_LOCATION || 'Diva Salon, Narol';

function toDateOrNull(v) {
  if (!v) return null;
  return v; // already 'YYYY-MM-DD' from an <input type="date">
}

function mapPaymentMode(v) {
  if (v === 'G-Pay' || v === 'Cash') return v;
  return 'Other';
}

function mapSplitBasis(distribution) {
  return distribution === 'divided' ? 'Divided' : 'Whole';
}

async function findOrCreateArea(conn, areaName) {
  if (!areaName) return null;
  const [rows] = await conn.query(
    'SELECT area_id FROM areas WHERE area_name = ? LIMIT 1',
    [areaName]
  );
  if (rows.length) return rows[0].area_id;
  const [res] = await conn.query(
    'INSERT INTO areas (area_name) VALUES (?)',
    [areaName]
  );
  return res.insertId;
}

async function findOrCreateLocation(conn) {
  const [rows] = await conn.query(
    "SELECT location_id FROM locations WHERE location_name = ? LIMIT 1",
    [LOCATION_NAME]
  );
  if (rows.length) return rows[0].location_id;
  const [res] = await conn.query(
    "INSERT INTO locations (location_name, location_type) VALUES (?, 'Salon')",
    [LOCATION_NAME]
  );
  return res.insertId;
}

async function findOrCreateBatch(conn, locationId, batchLabel) {
  if (!batchLabel) return null;
  const batchName = String(batchLabel).trim();
  const [rows] = await conn.query(
    'SELECT batch_id FROM batches WHERE location_id = ? AND batch_name = ? LIMIT 1',
    [locationId, batchName]
  );
  if (rows.length) return rows[0].batch_id;
  const [res] = await conn.query(
    'INSERT INTO batches (batch_name, location_id, status) VALUES (?, ?, "Ongoing")',
    [batchName, locationId]
  );
  return res.insertId;
}

async function findOrCreateStaff(conn, fullName, role) {
  if (!fullName) return null;
  const [rows] = await conn.query(
    'SELECT staff_id FROM staff WHERE full_name = ? LIMIT 1',
    [fullName]
  );
  if (rows.length) return rows[0].staff_id;
  const [res] = await conn.query(
    'INSERT INTO staff (full_name, role) VALUES (?, ?)',
    [fullName, role]
  );
  return res.insertId;
}

async function findOrCreateClient(conn, { clientName, contact, areaId, dob, anniversary }) {
  if (contact) {
    const [rows] = await conn.query(
      'SELECT client_id FROM clients WHERE contact_number = ? LIMIT 1',
      [contact]
    );
    if (rows.length) return rows[0].client_id;
  }
  const [res] = await conn.query(
    `INSERT INTO clients (full_name, contact_number, area_id, date_of_birth, wedding_anniversary)
     VALUES (?, ?, ?, ?, ?)`,
    [clientName || 'Unknown', contact || null, areaId, toDateOrNull(dob), toDateOrNull(anniversary)]
  );
  return res.insertId;
}

// Beneficiaries submitted from the salon form don't always already exist in
// family_members (family profiling happens separately). Rather than reject
// or silently drop real income, we look them up by beneficiary_book_no and,
// if genuinely new, create a lightweight placeholder family + member so the
// income is captured and clearly flagged for someone to reconcile with the
// real family record later.
async function findOrCreateBeneficiary(conn, { bookNo, name }) {
  const code = (bookNo || '').trim();
  if (code) {
    const [rows] = await conn.query(
      'SELECT member_id FROM family_members WHERE beneficiary_book_no = ? LIMIT 1',
      [code]
    );
    if (rows.length) return rows[0].member_id;
  }

  // Not found - create a placeholder family + member so this beneficiary
  // can be reconciled with the real family record later without losing
  // their income history in the meantime.
  const placeholderFamilyCode = code ? `PENDING-${code}` : `PENDING-${Date.now()}`;
  const [famRows] = await conn.query(
    'SELECT family_id FROM families WHERE family_code = ? LIMIT 1',
    [placeholderFamilyCode]
  );
  let familyId;
  if (famRows.length) {
    familyId = famRows[0].family_id;
  } else {
    const [famRes] = await conn.query(
      `INSERT INTO families (family_code, special_remarks)
       VALUES (?, 'Auto-created from Diva Salon income form submission - needs matching to a real family record.')`,
      [placeholderFamilyCode]
    );
    familyId = famRes.insertId;
  }

  const [memRes] = await conn.query(
    `INSERT INTO family_members (family_id, beneficiary_book_no, member_type, full_name)
     VALUES (?, ?, 'Elder', ?)`,
    [familyId, code || null, name || 'Unknown Beneficiary']
  );
  return memRes.insertId;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ status: 'error', message: 'Use POST' });
    return;
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) {
      res.status(400).json({ status: 'error', message: 'Invalid JSON body' });
      return;
    }
  }

  if (!payload || !Array.isArray(payload.beneficiaries) || payload.beneficiaries.length === 0) {
    res.status(400).json({ status: 'error', message: 'Payload missing beneficiaries[]' });
    return;
  }

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const locationId = await findOrCreateLocation(conn);
    const areaId = await findOrCreateArea(conn, payload.area);
    const visitBatchId = await findOrCreateBatch(conn, locationId, payload.batch);
    const managerStaffId = await findOrCreateStaff(conn, payload.salonManagerPresent, 'Salon Manager');
    const clientId = await findOrCreateClient(conn, {
      clientName: payload.clientName,
      contact: payload.contact,
      areaId,
      dob: payload.dob,
      anniversary: payload.weddingAnniversary,
    });

    const [visitRes] = await conn.query(
      `INSERT INTO service_visits
        (location_id, batch_id, client_id, visit_date, service_description, total_amount,
         split_basis, people_on_service, mode_payment, batch_shift, salon_manager_staff_id,
         client_type, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Form')`,
      [
        locationId,
        visitBatchId,
        clientId,
        toDateOrNull(payload.date),
        payload.serviceProvided || null,
        payload.totalAmount || 0,
        mapSplitBasis(payload.distribution),
        payload.beneficiaries.length,
        mapPaymentMode(payload.paymentMode),
        payload.batchShift || null,
        managerStaffId,
        payload.clientType || null,
      ]
    );
    const visitId = visitRes.insertId;

    const insertedBeneficiaries = [];
    for (const b of payload.beneficiaries) {
      const memberId = await findOrCreateBeneficiary(conn, { bookNo: b.bookNo, name: b.name });

      // A beneficiary can be enrolled in a different batch than the visit
      // itself was logged under (matches "Beneficiary Batch No (form)" vs
      // "Batch" being separate columns in the original Ledger).
      const beneficiaryBatchId = b.batchNumber
        ? await findOrCreateBatch(conn, locationId, b.batchNumber)
        : visitBatchId;

      await conn.query(
        `INSERT INTO income_transactions
          (member_id, visit_id, batch_id, location_id, transaction_date, amount, source_type, reference_note)
         VALUES (?, ?, ?, ?, ?, ?, 'Self-Employment', ?)`,
        [
          memberId,
          visitId,
          beneficiaryBatchId,
          locationId,
          toDateOrNull(payload.date),
          b.amountReceived || 0,
          b.beneficiaryType || null,
        ]
      );
      insertedBeneficiaries.push({ name: b.name, bookNo: b.bookNo, memberId });
    }

    await conn.commit();
    res.status(200).json({
      status: 'ok',
      visitId,
      beneficiaries: insertedBeneficiaries,
    });
  } catch (err) {
    await conn.rollback();
    console.error('submit.js error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    conn.release();
  }
};
