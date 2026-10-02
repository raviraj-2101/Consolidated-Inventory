const {
  colIndexToA1,
  ensureTimestampSheetExists,
  showAllRowsKeepFilter,
} = require("../helper");
const { default: axios } = require("axios");
const SHEET_AMAZON = process.env.SALES_VELOCITY_SHEET;
const { google } = require("googleapis");
const auth = require("../config/googleAuth");
const { getAccessToken, cronUpdateToken } = require("./configAds.controller");
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN_DELAY_ORDER_METRICS = 2000; // 2000ms for getOrderMetrics

const updateAmazonTimestamp = async (startTime, endTime = null) => {
  try {
    const fmtOpts = { timeZone: "Europe/Brussels" };
    const timestampStr = new Date().toLocaleString("en-US", fmtOpts);

    await ensureTimestampSheetExists();

    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Time Stamp!2:2",
    });

    const headers = headerRes.data.values?.[0] || [];
    const startColIndex = headers.indexOf("Amz. Velocity Start Time");
    const endColIndex = headers.indexOf("Amz. Velocity End Time");
    const tsColIndex = headers.indexOf("Amz. Velocity Time Stamp");

    if (startColIndex === -1 || endColIndex === -1 || tsColIndex === -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: "Time Stamp!A2:C2",
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [
            [
              "Amz. Velocity Start Time",
              "Amz. Velocity Time Stamp",
              "Amz. Velocity End Time",
            ],
          ],
        },
      });
      return await updateAmazonTimestamp(startTime, endTime);
    }

    const dataRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Time Stamp!A:Z",
    });

    const allRows = dataRes.data.values || [];

    // Find last non-empty shipment row
    let lastShipRow = 2;
    for (let i = allRows.length - 1; i >= 2; i--) {
      const row = allRows[i];
      if (
        (row?.[startColIndex] && row[startColIndex] !== "") ||
        (row?.[endColIndex] && row[endColIndex] !== "") ||
        (row?.[tsColIndex] && row[tsColIndex] !== "")
      ) {
        lastShipRow = i + 1;
        break;
      }
    }

    const newRowIndex = lastShipRow + 1;
    const updates = [];

    if (startTime) {
      updates.push({
        range: `Time Stamp!${String.fromCharCode(
          65 + startColIndex,
        )}${newRowIndex}`,
        values: [[startTime.toLocaleString()]],
      });
    }
    if (endTime) {
      updates.push({
        range: `Time Stamp!${String.fromCharCode(
          65 + endColIndex,
        )}${newRowIndex}`,
        values: [[endTime.toLocaleString()]],
      });
    }
    updates.push({
      range: `Time Stamp!${String.fromCharCode(65 + tsColIndex)}${newRowIndex}`,
      values: [[timestampStr]],
    });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: "USER_ENTERED",
          data: updates,
        },
      });
    }
  } catch (err) {
    console.error("Failed to update ship timestamp:", err.message);
    throw err;
  }
};

function getDateRange(daysBack) {
  const currentDate = new Date();
  const pastDate = new Date(currentDate);
  pastDate.setDate(currentDate.getDate() - daysBack);
  const formatDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(date.getDate()).padStart(2, "0")}T00:00:00-07:00`;
  return `${formatDate(pastDate)}--${formatDate(currentDate)}`;
}

async function ensureAmazonSheetExists() {
  try {
    let spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties.title,sheets.properties.sheetId",
    });

    let sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === SHEET_AMAZON,
    );

    if (!sheet) {
      // Create sheet if it does not exist
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: SHEET_AMAZON } } }],
        },
      });

      sheet = addRes.data.replies[0].addSheet.properties;
    }

    return sheet.properties.sheetId;
  } catch (error) {
    console.error("Could not ensure Shopify sheet exists:", error.message);
    throw error;
  }
}

function getSingleDayRange(daysAgo) {
  const currentDate = new Date();

  const startDate = new Date(currentDate);
  startDate.setDate(currentDate.getDate() - daysAgo);

  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 1);

  const formatDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}T00:00:00-07:00`;

  return `${formatDate(startDate)}--${formatDate(endDate)}`;
}

async function getAmazonSheetStructure() {
  try {
    const sheetId = await ensureAmazonSheetExists();

    // Fetch main headers (row 1)
    const mainHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_AMAZON}!1:1`,
    });
    const mainHeaders = mainHeaderRes.data.values?.[0] || [];

    // Fetch sub headers (row 3)
    const subHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_AMAZON}!2:2`,
    });
    const subHeaders = subHeaderRes.data.values?.[0] || [];

    // Build mapping of mainHeader -> subHeaders
    const structuredHeaders = {};
    let currentMain = null;

    for (let i = 0; i < subHeaders.length; i++) {
      if (mainHeaders[i] && mainHeaders[i].trim() !== "") {
        currentMain = mainHeaders[i].trim();
        if (!structuredHeaders[currentMain]) {
          structuredHeaders[currentMain] = [];
        }
      }
      if (currentMain) {
        structuredHeaders[currentMain].push({
          name: subHeaders[i],
          index: i,
        });
      }
    }

    const columnMap = {
      BRAND_NAME:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Brand Name")
          ?.index ?? -1,
      SKU:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Sku")?.index ??
        -1,
      ASIN:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "ASIN")?.index ??
        -1,
      LAST_ONE_DAYS:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "SV Yesterday")
          ?.index ?? -1,
      LAST_TWO_DAYS:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "SV 2 days ago")
          ?.index ?? -1,
      LAST_SEVEN_DAYS:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "SV 7 days")
          ?.index ?? -1,
      LAST_FOURTEEN_DAYS:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "SV 14 days")
          ?.index ?? -1,
      LAST_THIRTY_DAYS:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "SV 30 days")
          ?.index ?? -1,
    };

    // Filter headers based on the column map
    const filteredHeaders = Object.keys(columnMap)
      .filter((key) => columnMap[key] !== -1)
      .map((key) => subHeaders[columnMap[key]]);

    return {
      headers: filteredHeaders,
      sheetId,
      columnMap,
      lastColumnIndex: subHeaders.length - 1,
    };
  } catch (error) {
    console.error("Failed to get sheet structure:", error.message);
    throw error;
  }
}

const fetchAndUpdateSalesVelocity = async (req, res) => {
  const isApiCall = !!res;
  const startTime = new Date().toLocaleString("en-US", {
    timeZone: "Europe/Brussels",
  });

  const marketplaceId = process.env.MARKET_PLACE_ID || "ATVPDKIKX0DER";
  if (!marketplaceId) {
    console.warn("Marketplace ID is required; skipping sales velocity update.");
    return;
  }

  try {
    console.log("UPDATE AMAZON SALES VELOCITY START");
    try {
      await updateAmazonTimestamp(startTime);
    } catch (e) {
      console.warn("updateAmazonTimestamp(start) failed:", e?.message || e);
    }

    await cronUpdateToken();


    // 🔹 Fetch all brand tokens dynamically
    let tokenMap = await getAccessToken();

    const brandCallCountMap = {};

    Object.keys(tokenMap).forEach((brand) => {
      brandCallCountMap[brand] = 0;
    });

    // === Prepare date ranges ===
    const dateRanges = {
      last1Days: getDateRange(1),
      lastTwoDays: getSingleDayRange(2),
      lastSevenDays: getDateRange(7),
      lastFourteenDays: getDateRange(14),
      lastThirtyDays: getDateRange(30),
    };

    // === Fetch sheet structure ===
    const { headers, columnMap, lastColumnIndex, sheetId } =
      await getAmazonSheetStructure();

    const maxUsedColIndex = Math.max(
      ...Object.values(columnMap).filter((i) => i >= 0),
    );

    // Clear the Basic Filter on this tab (safe even if none is set)
    try {
      await showAllRowsKeepFilter(sheetId, 1, maxUsedColIndex + 1);
      console.log("Basic filter cleared on sheetId:", sheetId);
    } catch (e) {
      console.warn("showAllRowsKeepFilter failed:", e?.message || e);
    }

    // Fetch existing rows (skip 2 header rows)
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_AMAZON}!A:Z`,
    });
    const existingRows = existingData.data.values?.slice(2) || [];

    if (!existingRows.length) {
      console.warn("⚠️ No data rows found; skipping update.");
      return;
    }

    // Determine valid sales columns
    const salesColumns = [
      columnMap.LAST_ONE_DAYS,
      columnMap.LAST_TWO_DAYS,
      columnMap.LAST_SEVEN_DAYS,
      columnMap.LAST_FOURTEEN_DAYS,
      columnMap.LAST_THIRTY_DAYS,
    ].filter((col) => col >= 0);

    if (salesColumns.length === 0) {
      console.warn("No valid sales columns found in sheet; skipping update.");
      return;
    }

    if (isApiCall) {
      res.status(200).json({
        status: "processing",
        message:
          "Amazon sales velocity data is being processed. This may take time — please check the Time Stamp sheet for completion status.",
      });
    }

    const updates = [];
    for (let i = 0; i < existingRows.length; i++) {
      const row = existingRows[i];

      const sku = row[columnMap.SKU];
      const brandName = row[columnMap.BRAND_NAME];

      if (!sku || !brandName) continue;

      let accessToken = tokenMap[brandName];

      if (!accessToken) {
        console.warn(`⚠️ No token found for brand: ${brandName}`);
        continue;
      }

      try {
        const rowNum = i + 3;
        const salesData = {};

        salesData.lastOneDays =
          Number(
            await fetchSalesData(
              sku,
              dateRanges.last1Days,
              accessToken,
              marketplaceId,
              1,
            ),
          ) || 0;
        await delay(3000);

        // === API calls ===
        salesData.lastTwoDays =
          Number(
            await fetchSalesData(
              sku,
              dateRanges.lastTwoDays,
              accessToken,
              marketplaceId,
              1,
            ),
          ) || 0;
        await delay(3000);

        salesData.lastSevenDays =
          Number(
            await fetchSalesData(
              sku,
              dateRanges.lastSevenDays,
              accessToken,
              marketplaceId,
              7,
            ),
          ) || 0;
        await delay(3000);

        salesData.lastFourteenDays =
          Number(
            await fetchSalesData(
              sku,
              dateRanges.lastFourteenDays,
              accessToken,
              marketplaceId,
              14,
            ),
          ) || 0;
        await delay(3000);

        salesData.lastThirtyDays =
          Number(
            await fetchSalesData(
              sku,
              dateRanges.lastThirtyDays,
              accessToken,
              marketplaceId,
              30,
            ),
          ) || 0;
        await delay(3000);

        // === Count calls per brand ===
        brandCallCountMap[brandName]++;

        // 🔄 Refresh token every 50 calls PER BRAND
        if (brandCallCountMap[brandName] % 50 === 0) {
          console.log(`🔄 Refreshing token for ${brandName}`);

          const updatedTokenMap = await getAccessToken();

          if (updatedTokenMap[brandName]) {
            tokenMap[brandName] = updatedTokenMap[brandName];
          }
        }

        if (columnMap.LAST_ONE_DAYS >= 0) {
          updates.push({
            range: `${SHEET_AMAZON}!${colIndexToA1(
              columnMap.LAST_ONE_DAYS,
            )}${rowNum}`,
            values: [[salesData.lastOneDays]],
          });
        }

        // === Sheet updates ===
        if (columnMap.LAST_TWO_DAYS >= 0) {
          updates.push({
            range: `${SHEET_AMAZON}!${colIndexToA1(
              columnMap.LAST_TWO_DAYS,
            )}${rowNum}`,
            values: [[salesData.lastTwoDays]],
          });
        }

        if (columnMap.LAST_SEVEN_DAYS >= 0) {
          updates.push({
            range: `${SHEET_AMAZON}!${colIndexToA1(
              columnMap.LAST_SEVEN_DAYS,
            )}${rowNum}`,
            values: [[salesData.lastSevenDays]],
          });
        }

        if (columnMap.LAST_FOURTEEN_DAYS >= 0) {
          updates.push({
            range: `${SHEET_AMAZON}!${colIndexToA1(
              columnMap.LAST_FOURTEEN_DAYS,
            )}${rowNum}`,
            values: [[salesData.lastFourteenDays]],
          });
        }

        if (columnMap.LAST_THIRTY_DAYS >= 0) {
          updates.push({
            range: `${SHEET_AMAZON}!${colIndexToA1(
              columnMap.LAST_THIRTY_DAYS,
            )}${rowNum}`,
            values: [[salesData.lastThirtyDays]],
          });
        }

        console.log(`✅ ${brandName}  | ${sku}`, salesData);
      } catch (err) {
        console.error(`❌ Failed SKU ${sku}:`, err.message || err);
      }
    }

    // === Batch update Google Sheet (only sales velocity cells) ===
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: "USER_ENTERED",
          data: updates,
        },
      });
    }

    console.log("Amazon Sales velocity data update completed");

    const endTime = new Date().toLocaleString("en-US", {
      timeZone: "Europe/Brussels",
    });

    try {
      await updateAmazonTimestamp(startTime, endTime);
    } catch (e) {
      console.warn("updateAmazonTimestamp(end) failed:", e?.message || e);
    }
  } catch (error) {
    console.error("Sales velocity controller error:", error.message || error);
  }
};

let lastOrderMetricsRequestTime = 0;

const fetchSalesData = async (
  sellerSku,
  interval,
  accessToken,
  marketplaceId,
  days,
  retries = 3,
  isRetryAfter403 = false,
) => {
  try {
    console.log(sellerSku, days, interval);
    const now = Date.now();
    const timeSinceLastCall = now - lastOrderMetricsRequestTime;
    if (timeSinceLastCall < MIN_DELAY_ORDER_METRICS) {
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_DELAY_ORDER_METRICS - timeSinceLastCall),
      );
    }

    const response = await axios.get(
      `${process.env.ROOT_LINK_SELLER}sales/v1/orderMetrics`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-amz-access-token": accessToken,
        },
        params: {
          marketplaceIds: marketplaceId,
          sku: sellerSku,
          granularity: "Total",
          interval,
        },
        timeout: 10000,
      },
    );

    if (response.headers["x-amzn-ratelimit-limit"]) {
      lastOrderMetricsRequestTime = Date.now();
    }

    const unitCount = response.data?.payload?.[0]?.unitCount || 0;
    const velocity = unitCount / days;
    console.log("Completed", sellerSku, days, velocity);
    return velocity.toFixed(2);
  } catch (error) {
    const errorDetails = {
      message: error.message || "Unknown error",
      code: error.code,
      status: error.response?.status,
      data: error.response?.data || null,
      sellerSku,
      retries,
      isRetryAfter403,
    };

    if (
      (error.response?.status === 429 ||
        error.code === "ECONNABORTED" ||
        (error.response?.status && error.response.status >= 500)) &&
      retries > 0
    ) {
      const backoffTime = Math.min(5000, 500 * Math.pow(2, 3 - retries));
      console.warn(
        `Retrying seller SKU ${sellerSku} after ${backoffTime}ms: ${error.message}`,
        errorDetails,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
      return fetchSalesData(
        sellerSku,
        interval,
        accessToken,
        marketplaceId,
        days,
        retries - 1,
        isRetryAfter403,
      );
    }

    console.error(
      `Failed to fetch sales for seller SKU ${sellerSku}:`,
      errorDetails,
    );
    return 0;
  }
};

module.exports = {
  fetchAndUpdateSalesVelocity,
};
