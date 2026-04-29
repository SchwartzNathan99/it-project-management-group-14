/**
 * Required External Modules
 */

const express = require('express');
const path = require('path');
const { auth, requiresAuth } = require('express-openid-connect');

require('dotenv').config();

const {
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
} = require('./db-queries');

const { requiresRole } = require('./middleware');

/**
 * App Variables
 */

const app = express();
const port = process.env.PORT || 3000;

/**
 * App Configuration
 */

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  auth({
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    baseURL: process.env.BASE_URL,
    clientID: process.env.AUTH0_CLIENT_ID,
    secret: process.env.SESSION_SECRET,
    authRequired: false,
    auth0Logout: true,
  })
);

// Attach auth state and DB user role to res.locals for all views
app.use(async (req, res, next) => {
  res.locals.isAuthenticated = req.oidc.isAuthenticated();
  res.locals.activeRoute = req.originalUrl;
  res.locals.userRole = null;

  if (req.oidc.isAuthenticated()) {
    try {
      const dbUser = await getOrCreateUser(req.oidc.user);
      req.dbUser = dbUser;
      res.locals.userRole = dbUser.role;
    } catch (err) {
      return next(err);
    }
  }

  next();
});

/**
 * Routes Definitions
 */

// ── Home ──────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.render('home');
});

// ── Create Repair ─────────────────────────────────────────────────────────────

app.get('/create-repair', requiresAuth(), async (req, res) => {
  try {
    const dbUser = req.dbUser;
    const [vehicles, services] = await Promise.all([
      getVehiclesByUser(dbUser.userid),
      getServicesCatalog(),
    ]);
    res.render('create-repair', {
      dbUser,
      vehicles,
      services,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/create-repair', requiresAuth(), async (req, res) => {
  try {
    const dbUser = req.dbUser;
    const {
      firstName, lastName, streetAddress, city, state, zipCode, phoneNumber,
      vehicleID, newVehicleMake, newVehicleModel, newVehicleYear,
      newVehicleColor, newVehiclePlate, newVehicleVIN,
      scheduledDate, scheduledTime,
    } = req.body;

    // serviceIDs may be a string (single) or array (multiple)
    let serviceIDs = req.body.serviceIDs || [];
    if (!Array.isArray(serviceIDs)) serviceIDs = [serviceIDs];

    // Update user profile
    await updateUserProfile(dbUser.userid, {
      firstName, lastName, streetAddress, city, state, zipCode, phoneNumber,
    });

    // Resolve vehicle
    let resolvedVehicleID = vehicleID;
    if (vehicleID === 'new') {
      if (!newVehicleMake || !newVehicleModel || !newVehicleYear || !newVehicleVIN) {
        return res.redirect('/create-repair?error=Please+fill+out+all+required+vehicle+fields.');
      }
      const newVehicle = await addVehicle(dbUser.userid, {
        make: newVehicleMake,
        model: newVehicleModel,
        year: newVehicleYear,
        color: newVehicleColor,
        licensePlateNumber: newVehiclePlate,
        vin: newVehicleVIN,
      });
      resolvedVehicleID = newVehicle.vehicleid;
    }

    await createRepairOrder({
      vehicleID: resolvedVehicleID,
      userID: dbUser.userid,
      scheduledDate,
      scheduledTime,
      serviceIDs,
    });

    const role = dbUser.role;
    if (role === 'Employee' || role === 'Owner') {
      res.redirect('/repair-orders?success=Repair+order+created.');
    } else {
      res.redirect('/my-services?success=Your+repair+has+been+scheduled!');
    }
  } catch (err) {
    console.error(err);
    res.redirect('/create-repair?error=Something+went+wrong.+Please+try+again.');
  }
});

// ── Repair Order List ─────────────────────────────────────────────────────────

app.get('/repair-orders', requiresRole('Employee', 'Owner'), async (req, res) => {
  try {
    const { status, techID } = req.query;
    const [orders, employees] = await Promise.all([
      getRepairOrders({ status, techID }),
      getEmployees(),
    ]);
    res.render('repair-order-list', {
      orders,
      employees,
      filters: { status: status || '', techID: techID || '' },
      success: req.query.success || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

// ── Repair Order Detail ───────────────────────────────────────────────────────

app.get('/repair-orders/:id', requiresRole('Employee', 'Owner'), async (req, res) => {
  try {
    const repairID = parseInt(req.params.id, 10);
    const [order, employees, parts] = await Promise.all([
      getRepairOrderByID(repairID),
      getEmployees(),
      getPartsCatalog(),
    ]);
    if (!order) return res.status(404).send('Repair order not found.');
    res.render('repair-order', {
      order,
      employees,
      parts,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/repair-orders/:id', requiresRole('Employee', 'Owner'), async (req, res) => {
  try {
    const repairID = parseInt(req.params.id, 10);
    const {
      status, assignedTechID, techNotes, scheduledDate, scheduledTime,
    } = req.body;

    // Parse service updates: laborHours_<repairServiceID>
    const services = [];
    for (const key of Object.keys(req.body)) {
      const match = key.match(/^laborHours_(\d+)$/);
      if (match) {
        services.push({ repairServiceID: match[1], laborHours: req.body[key] || null });
      }
    }

    // Parse part updates: partQty_<partID>
    const parts = [];
    for (const key of Object.keys(req.body)) {
      const match = key.match(/^partQty_(\d+)$/);
      if (match) {
        const qty = parseInt(req.body[key], 10) || 0;
        if (qty > 0) parts.push({ partID: match[1], quantity: qty });
      }
    }

    await updateRepairOrder(repairID, {
      status,
      assignedTechID,
      techNotes,
      scheduledDate,
      scheduledTime,
      services,
      parts,
    });

    res.redirect(`/repair-orders/${repairID}?success=Changes+saved.`);
  } catch (err) {
    console.error(err);
    res.redirect(`/repair-orders/${req.params.id}?error=Failed+to+save+changes.`);
  }
});

// ── Generate Invoice ──────────────────────────────────────────────────────────

app.post('/repair-orders/:id/invoice', requiresRole('Employee', 'Owner'), async (req, res) => {
  try {
    const repairID = parseInt(req.params.id, 10);
    const order = await getRepairOrderByID(repairID);
    if (!order) return res.status(404).send('Repair order not found.');

    // Calculate total
    const partsTotal = (order.parts || []).reduce(
      (sum, p) => sum + parseFloat(p.cost) * parseInt(p.quantity, 10),
      0
    );
    const laborTotal = (order.services || []).reduce(
      (sum, s) => sum + parseFloat(s.hourlyrate) * parseFloat(s.laborhours || 0),
      0
    );
    const total = partsTotal + laborTotal;

    await createInvoice(repairID, order.userid, total.toFixed(2));

    res.redirect(`/repair-orders/${repairID}?success=Invoice+generated+successfully.`);
  } catch (err) {
    console.error(err);
    res.redirect(`/repair-orders/${req.params.id}?error=Failed+to+generate+invoice.`);
  }
});

// ── Payment / My Invoices ─────────────────────────────────────────────────────

app.get('/payment', requiresAuth(), async (req, res) => {
  try {
    const dbUser = req.dbUser;
    let invoices;
    if (dbUser.role === 'Employee' || dbUser.role === 'Owner') {
      invoices = await getAllInvoices();
    } else {
      invoices = await getInvoicesByUser(dbUser.userid);
    }
    res.render('payment', {
      invoices,
      dbUser,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/payment/:transactionID', requiresAuth(), async (req, res) => {
  try {
    const transactionID = parseInt(req.params.transactionID, 10);
    const dbUser = req.dbUser;

    // Verify the invoice belongs to this user (unless Employee/Owner)
    const invoice = await getInvoiceByID(transactionID);
    if (!invoice) return res.status(404).send('Invoice not found.');
    if (
      dbUser.role === 'Customer' &&
      invoice.userid !== dbUser.userid
    ) {
      return res.status(403).send('Access denied.');
    }

    // Don't allow double payment
    if (invoice.paymentmethod) {
      return res.redirect('/my-services?error=This+invoice+has+already+been+paid.');
    }

    await payInvoice(transactionID, 'Credit Card');
    res.redirect('/my-services?success=Payment+recorded+successfully!');
  } catch (err) {
    console.error(err);
    res.redirect('/my-services?error=Payment+failed.+Please+try+again.');
  }
});

// ── My Services (Customer view) ───────────────────────────────────────────────

app.get('/my-services', requiresAuth(), async (req, res) => {
  try {
    const dbUser = req.dbUser;
    const [repairs, invoices] = await Promise.all([
      getRepairOrdersByUser(dbUser.userid),
      getInvoicesByUser(dbUser.userid),
    ]);
    res.render('my-services', {
      repairs,
      invoices,
      dbUser,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * Server Activation
 */

app.listen(port, () => {
  console.log(`Listening to requests on http://localhost:${port}`);
});
