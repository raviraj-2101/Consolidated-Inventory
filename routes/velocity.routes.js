
const express = require("express");
const cron = require("node-cron");
const {  fetchShopifyVelocityData } = require("../controller/velocity.controller");
const router = express.Router();


cron.schedule("30 1 * * *", async () => {
  try {
    console.log({
      message: `Shopify Velocity Data Fetching started`,
      log_type: "info",
      time: new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" })
    });

    await fetchShopifyVelocityData();
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



router.get("/", fetchShopifyVelocityData);

module.exports = router;