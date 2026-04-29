const pool = require('./db');

// ─── Users ───────────────────────────────────────────────────────────────────

async function getOrCreateUser(auth0User) {
  const auth0Id = auth0User.sub;

  const checkResult = await pool.query(
    'SELECT * FROM users WHERE authzero_id = $1',
    [auth0Id]
  );

  if (checkResult.rows.length > 0) {
    return checkResult.rows[0];
  }

  const insertResult = await pool.query(
    `INSERT INTO users (authzero_id, email, role)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [auth0Id, auth0User.email, 'Customer']
  );

  return insertResult.rows[0];
}

async function updateUserProfile(userID, data) {
  const { firstName, lastName, streetAddress, city, state, zipCode, phoneNumber } = data;
  const result = await pool.query(
    `UPDATE users
     SET firstname = $1, lastname = $2, streetaddress = $3,
         city = $4, state = $5, zipcode = $6, phonenumber = $7
     WHERE userid = $8
     RETURNING *`,
    [firstName, lastName, streetAddress, city, state, zipCode, phoneNumber, userID]
  );
  return result.rows[0];
}

async function getEmployees() {
  const result = await pool.query(
    `SELECT userid, firstname, lastname FROM users
     WHERE role IN ('Employee', 'Owner')
     ORDER BY lastname, firstname`
  );
  return result.rows;
}

// ─── Vehicles ────────────────────────────────────────────────────────────────

async function getVehiclesByUser(userID) {
  const result = await pool.query(
    `SELECT * FROM vehicles WHERE userid = $1 ORDER BY year DESC`,
    [userID]
  );
  return result.rows;
}

async function addVehicle(userID, vehicleData) {
  const { make, model, year, color, licensePlateNumber, vin } = vehicleData;
  const result = await pool.query(
    `INSERT INTO vehicles (userid, make, model, year, color, licenseplatenumber, vin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userID, make, model, year, color, licensePlateNumber || null, vin]
  );
  return result.rows[0];
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

async function getServicesCatalog() {
  const result = await pool.query(
    `SELECT * FROM servicescatalog ORDER BY servicename`
  );
  return result.rows;
}

async function getPartsCatalog() {
  const result = await pool.query(
    `SELECT * FROM partscatalog ORDER BY partname`
  );
  return result.rows;
}

// ─── Repair Orders ───────────────────────────────────────────────────────────

async function createRepairOrder(data) {
  const { vehicleID, userID, scheduledDate, scheduledTime, serviceIDs } = data;

  const orderResult = await pool.query(
    `INSERT INTO repairorderd (vehicleid, userid, scheduleddate, scheduledtime, status)
     VALUES ($1, $2, $3, $4, 'Pending')
     RETURNING *`,
    [vehicleID, userID, scheduledDate, scheduledTime]
  );
  const order = orderResult.rows[0];

  if (serviceIDs && serviceIDs.length > 0) {
    for (const serviceID of serviceIDs) {
      // Pull default labor hours from the catalog
      const svcResult = await pool.query(
        `SELECT defaultlaborhours FROM servicescatalog WHERE serviceid = $1`,
        [serviceID]
      );
      const defaultHours = svcResult.rows[0]?.defaultlaborhours || null;

      await pool.query(
        `INSERT INTO repairservices (repairid, serviceid, laborhours)
         VALUES ($1, $2, $3)`,
        [order.repairid, serviceID, defaultHours]
      );
    }
  }

  return order;
}

async function getRepairOrders(filters = {}) {
  const conditions = [];
  const values = [];

  if (filters.status && filters.status !== 'all') {
    values.push(filters.status);
    conditions.push(`ro.status = $${values.length}`);
  } else if (!filters.status) {
    // Default: exclude completed statuses
    conditions.push(`ro.status NOT IN ('Completed', 'Invoice Generated', 'Completed-and-Paid')`);
  }

  if (filters.techID && filters.techID !== 'all') {
    values.push(filters.techID);
    conditions.push(`ro.assignedtechid = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT
       ro.repairid,
       ro.scheduleddate,
       ro.scheduledtime,
       ro.status,
       u.firstname AS customer_firstname,
       u.lastname  AS customer_lastname,
       v.make, v.model, v.year,
       tech.firstname AS tech_firstname,
       tech.lastname  AS tech_lastname
     FROM repairorderd ro
     JOIN users u ON ro.userid = u.userid
     JOIN vehicles v ON ro.vehicleid = v.vehicleid
     LEFT JOIN users tech ON ro.assignedtechid = tech.userid
     ${where}
     ORDER BY ro.scheduleddate ASC, ro.scheduledtime ASC`,
    values
  );
  return result.rows;
}

async function getRepairOrderByID(repairID) {
  const orderResult = await pool.query(
    `SELECT
       ro.*,
       u.firstname AS customer_firstname,
       u.lastname  AS customer_lastname,
       u.email     AS customer_email,
       u.phonenumber AS customer_phone,
       u.streetaddress AS customer_address,
       u.city AS customer_city,
       u.state AS customer_state,
       u.zipcode AS customer_zip,
       v.make, v.model, v.year, v.color, v.vin, v.licenseplatenumber,
       tech.firstname AS tech_firstname,
       tech.lastname  AS tech_lastname
     FROM repairorderd ro
     JOIN users u ON ro.userid = u.userid
     JOIN vehicles v ON ro.vehicleid = v.vehicleid
     LEFT JOIN users tech ON ro.assignedtechid = tech.userid
     WHERE ro.repairid = $1`,
    [repairID]
  );

  if (orderResult.rows.length === 0) return null;
  const order = orderResult.rows[0];

  const servicesResult = await pool.query(
    `SELECT rs.repairserviceid, rs.laborhours, sc.serviceid, sc.servicename, sc.hourlyrate
     FROM repairservices rs
     JOIN servicescatalog sc ON rs.serviceid = sc.serviceid
     WHERE rs.repairid = $1`,
    [repairID]
  );
  order.services = servicesResult.rows;

  const partsResult = await pool.query(
    `SELECT rp.repairpartid, rp.quantity, pc.partid, pc.partname, pc.cost
     FROM repairparts rp
     JOIN partscatalog pc ON rp.partid = pc.partid
     WHERE rp.repairid = $1`,
    [repairID]
  );
  order.parts = partsResult.rows;

  return order;
}

async function updateRepairOrder(repairID, data) {
  const { status, assignedTechID, techNotes, scheduledDate, scheduledTime, services, parts } = data;

  await pool.query(
    `UPDATE repairorderd
     SET status = $1, assignedtechid = $2, technotes = $3,
         scheduleddate = $4, scheduledtime = $5
     WHERE repairid = $6`,
    [
      status,
      assignedTechID || null,
      techNotes || null,
      scheduledDate,
      scheduledTime,
      repairID
    ]
  );

  // Update service labor hours
  if (services && services.length > 0) {
    for (const svc of services) {
      await pool.query(
        `UPDATE repairservices SET laborhours = $1
         WHERE repairserviceid = $2 AND repairid = $3`,
        [svc.laborHours || null, svc.repairServiceID, repairID]
      );
    }
  }

  // Sync parts: delete existing and re-insert
  if (parts !== undefined) {
    await pool.query(`DELETE FROM repairparts WHERE repairid = $1`, [repairID]);
    for (const part of parts) {
      if (part.quantity > 0) {
        await pool.query(
          `INSERT INTO repairparts (partid, repairid, quantity)
           VALUES ($1, $2, $3)`,
          [part.partID, repairID, part.quantity]
        );
      }
    }
  }
}

async function getRepairOrdersByUser(userID) {
  const result = await pool.query(
    `SELECT
       ro.repairid,
       ro.status,
       ro.scheduleddate,
       ro.scheduledtime,
       v.make, v.model, v.year, v.color,
       COALESCE(
         STRING_AGG(sc.servicename, ', ' ORDER BY sc.servicename),
         'No services listed'
       ) AS services_summary
     FROM repairorderd ro
     JOIN vehicles v ON ro.vehicleid = v.vehicleid
     LEFT JOIN repairservices rs ON rs.repairid = ro.repairid
     LEFT JOIN servicescatalog sc ON sc.serviceid = rs.serviceid
     WHERE ro.userid = $1
       AND ro.status NOT IN ('Completed-and-Paid')
     GROUP BY ro.repairid, ro.status, ro.scheduleddate, ro.scheduledtime,
              v.make, v.model, v.year, v.color
     ORDER BY ro.scheduleddate ASC NULLS LAST, ro.scheduledtime ASC NULLS LAST`,
    [userID]
  );
  return result.rows;
}

async function createInvoice(repairID, userID, amount) {
  const invoiceNumber = `INV-${repairID}-${Date.now()}`;
  const result = await pool.query(
    `INSERT INTO transactions (userid, repairid, transactionamount, invoicenumber)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userID, repairID, amount, invoiceNumber]
  );

  // Advance the status to Invoice Generated automatically
  await pool.query(
    `UPDATE repairorderd SET status = 'Invoice Generated' WHERE repairid = $1`,
    [repairID]
  );

  return result.rows[0];
}

async function getInvoicesByUser(userID) {
  const result = await pool.query(
    `SELECT t.*, ro.scheduleddate, v.make, v.model, v.year
     FROM transactions t
     LEFT JOIN repairorderd ro ON t.repairid = ro.repairid
     LEFT JOIN vehicles v ON ro.vehicleid = v.vehicleid
     WHERE t.userid = $1
     ORDER BY t.created_at DESC`,
    [userID]
  );
  return result.rows;
}

async function getAllInvoices() {
  const result = await pool.query(
    `SELECT t.*, u.firstname, u.lastname, ro.scheduleddate, v.make, v.model, v.year
     FROM transactions t
     JOIN users u ON t.userid = u.userid
     LEFT JOIN repairorderd ro ON t.repairid = ro.repairid
     LEFT JOIN vehicles v ON ro.vehicleid = v.vehicleid
     ORDER BY t.created_at DESC`
  );
  return result.rows;
}

async function getInvoiceByID(transactionID) {
  const result = await pool.query(
    `SELECT t.*, u.firstname, u.lastname, u.email
     FROM transactions t
     JOIN users u ON t.userid = u.userid
     WHERE t.transactionid = $1`,
    [transactionID]
  );
  return result.rows[0] || null;
}

async function payInvoice(transactionID, paymentMethod) {
  const result = await pool.query(
    `UPDATE transactions
     SET paymentmethod = $1
     WHERE transactionid = $2
     RETURNING *`,
    [paymentMethod, transactionID]
  );

  // Mark the repair order as Completed-and-Paid
  if (result.rows[0]?.repairid) {
    await pool.query(
      `UPDATE repairorderd SET status = 'Completed-and-Paid'
       WHERE repairid = $1`,
      [result.rows[0].repairid]
    );
  }

  return result.rows[0];
}

module.exports = {
  getOrCreateUser,
  updateUserProfile,
  getEmployees,
  getVehiclesByUser,
  addVehicle,
  getServicesCatalog,
  getPartsCatalog,
  createRepairOrder,
  getRepairOrders,
  getRepairOrdersByUser,
  getRepairOrderByID,
  updateRepairOrder,
  createInvoice,
  getInvoicesByUser,
  getAllInvoices,
  getInvoiceByID,
  payInvoice,
};
