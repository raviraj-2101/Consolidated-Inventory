
const express = require("express");
const cron = require("node-cron");
const { fetchAndUpdateSalesVelocity } = require("../controller/amazon.controller");
const router = express.Router();


cron.schedule("15 1 * * *", async () => {
  try {
    console.log({
      message: `Amazon Velocity Data Fetching started`,
      log_type: "info",
      time: new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" })
    });

    await fetchAndUpdateSalesVelocity();
  } catch (error) {
    console.log({
      message: `Main Catch Error: ${JSON.stringify(error)}`,
      log_type: "error",
      time: new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" })
    });
  }
}, {
  scheduled: true,
  timezone: "Europe/Brussels"
});



router.get("/", fetchAndUpdateSalesVelocity);

module.exports = router;