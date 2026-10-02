const cron = require("node-cron");
const { fetchSalesVelocityAlertsAndNotify } = require("../controller/amazonSalesVelocityAlerts.controller");

const startSalesVelocityAlertsJob = () => {
  // Runs every day at 10:30 AM CET (Europe/Brussels)
  cron.schedule(
    "30 10 * * *",
    async () => {
      console.log("⏰ Sales Velocity Alerts cron triggered at 10:30 AM CET");
      try {
        await fetchSalesVelocityAlertsAndNotify();
      } catch (error) {
        console.error("❌ Sales Velocity Alerts cron error:", error.message);
      }
    },
    {
      timezone: "Europe/Brussels",
    }
  );

  console.log("✅ Sales Velocity Alerts cron scheduled (daily 10:30 AM CET)");
};

module.exports = { startSalesVelocityAlertsJob };
