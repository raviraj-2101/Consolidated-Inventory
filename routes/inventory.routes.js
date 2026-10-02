
const express = require("express");
const cron = require("node-cron");
const { fetchAndUpdateInventory } = require("../controller/inventory.controller");
const router = express.Router();


cron.schedule("30 7 * * *", async () => {
  try {
    console.log({
      message: `Amazon Velocity Data Fetching started`,
      log_type: "info",
      time: new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" })
    });

    await fetchAndUpdateInventory();
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



router.get("/", fetchAndUpdateInventory);

module.exports = router;