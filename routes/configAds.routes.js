const cron = require("node-cron");
const express = require("express");
const { cronUpdateToken } = require("../controller/configAds.controller");
const router = express.Router();

cron.schedule("*/40 * * * *", async () => {
  try {
    // console.log({
    //   message: `cronUpdateToken`,
    //   log_type: "info",
    // });
    await cronUpdateToken();
  } catch (error) {
    return console.log({
      message: `Main Catch Error: ${JSON.stringify(error)}`,
      log_type: "error",
    });
  }
});



module.exports = router;