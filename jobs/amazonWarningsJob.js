const cron = require("node-cron");
const { fetchAmazonWarningsAndNotify } = require("../controller/amazonWarnings.controller");

const startAmazonWarningsJob = () => {
  // Runs every day at 9:30 AM CET (Europe/Brussels)
  cron.schedule(
    "30 9 * * *",
    async () => {
      console.log("⏰ Amazon Warnings cron triggered at 9:30 AM CET");
      await fetchAmazonWarningsAndNotify();
    },
    {
      timezone: "Europe/Brussels",
    }
  );

  console.log("✅ Amazon Warnings cron scheduled (daily 9:30 AM CET)");
};

module.exports = { startAmazonWarningsJob };
