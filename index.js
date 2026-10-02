require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const fetchVelocity = require("./routes/velocity.routes")
const fetchAmazon = require("./routes/amazon.routes")
const fetchInventory = require("./routes/inventory.routes")
const configSPRoutes = require("./routes/configAds.routes");
const { startAmazonWarningsJob } = require("./jobs/amazonWarningsJob");
const { startSalesVelocityAlertsJob } = require("./jobs/amazonSalesVelocityAlertsJob");
const salesVelocityAlertsRoutes = require("./routes/amazonSalesVelocityAlerts.routes");

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

//Routes
app.use("/api/fetchVelocity", fetchVelocity);
app.use("/api/fetchAmazon", fetchAmazon);
app.use("/api/createConfig", configSPRoutes);
app.use("/api/fetchInventory", fetchInventory);
app.use("/api/salesVelocityAlerts", salesVelocityAlertsRoutes);


// Start cron jobs
startAmazonWarningsJob();
startSalesVelocityAlertsJob();

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Health check route
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "🚀 Server is running successfully!",
    });
});
