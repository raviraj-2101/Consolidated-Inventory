const express = require("express");
const router = express.Router();
const { salesVelocityAlertsApiHandler } = require("../controller/amazonSalesVelocityAlerts.controller");

router.post("/trigger", salesVelocityAlertsApiHandler);

module.exports = router;
