const moment = require("moment");
const {
  getAllShopApiKeys,
  colIndexToA1,
  ensureTimestampSheetExists,
  showAllRowsKeepFilter,
} = require("../helper");
const { default: axios } = require("axios");
const SHEET_SHOPIFY = process.env.SALES_VELOCITY_SHEET;
const { google } = require("googleapis");
const auth = require("../config/googleAuth");
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHOPIFY_SKU_SHEET = process.env.SHOPIFY_SKU_SHEET;

/**
 * Resolve the Admin API access token to use for a brand.
 *
 * - New brands (Shopify 2026 Dev Dashboard): Shopify no longer issues a
 *   permanent token, only a Client ID + Secret. Whenever both are present we
 *   exchange them here for a fresh (24h) token on every run — this takes
 *   priority even if a stale value also sits in the "Api Key" column.
 * - Old brands (and Rejuvapaw): no client credentials, just a permanent token
 *   in the "Api Key" column, so we use it directly — unchanged behaviour.
 */
const resolveShopAccessToken = async (shop) => {

  if (shop.clientId && shop.clientSecret) {
    const resp = await axios.post(
      `https://${shop.shopName}.myshopify.com/admin/oauth/access_token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: shop.clientId,
        client_secret: shop.clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return resp.data.access_token;
  }

  if (shop.apiKey) return shop.apiKey;

  throw new Error(`No Api Key or Client ID/Secret for brand: ${shop.brand}`);
};

const updateShopifyTimestamp = async (startTime, endTime = null) => {
  try {
    const fmtOpts = { timeZone: "Europe/Brussels" };
    const timestampStr = new Date().toLocaleString("en-US", fmtOpts);

    await ensureTimestampSheetExists();

    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Time Stamp!2:2",
    });

    const headers = headerRes.data.values?.[0] || [];
    const startColIndex = headers.indexOf("Shopify Start Time");
    const endColIndex = headers.indexOf("Shopify End Time");
    const tsColIndex = headers.indexOf("Shopify Time Stamp");

    if (startColIndex === -1 || endColIndex === -1 || tsColIndex === -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: "Time Stamp!A2:C2",
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [
            ["Shopify Start Time", "Shopify Time Stamp", "Shopify End Time"],
          ],
        },
      });
      return await updateShopifyTimestamp(startTime, endTime);
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
          65 + startColIndex
        )}${newRowIndex}`,
        values: [[startTime.toLocaleString()]],
      });
    }
    if (endTime) {
      updates.push({
        range: `Time Stamp!${String.fromCharCode(
          65 + endColIndex
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

function getDateRangeShopify(currentDate, daysBack) {
  const endDate = new Date(currentDate);
  endDate.setDate(currentDate.getDate() - 1);

  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - (daysBack - 1));

  const formatDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(date.getDate()).padStart(2, "0")}`;

  return {
    start: formatDate(startDate),
    end: formatDate(endDate),
  };
}

function getExactDayShopify(currentDate, daysAgo) {
  const targetDate = moment(currentDate).subtract(daysAgo, "days");

  return {
    start: targetDate.format("YYYY-MM-DD"),
    end: targetDate.format("YYYY-MM-DD"),
  };
}

async function ensureShopifySheetExists() {
  try {
    let spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties.title,sheets.properties.sheetId",
    });

    let sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === SHEET_SHOPIFY
    );

    if (!sheet) {
      // Create sheet if it does not exist
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: SHEET_SHOPIFY } } }],
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


async function getShopifySheetStructure() {
  try {
    const sheetId = await ensureShopifySheetExists();

    // Fetch main headers (row 1)
    const mainHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SHOPIFY}!1:1`,
    });
    const mainHeaders = mainHeaderRes.data.values?.[0] || [];

    // Fetch sub headers (row 3)
    const subHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SHOPIFY}!2:2`,
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
        structuredHeaders["D2C - Shopify"]?.find(
          (h) => h?.name === "Brand Name"
        )?.index ?? -1,
      BASE_SKU:
        structuredHeaders["D2C - Shopify"]?.find(
          (h) => h?.name === "Base Sku"
        )?.index ?? -1,
      SKU:
        structuredHeaders["D2C - Shopify"]?.find((h) => h?.name === "Sku")
          ?.index ?? -1,
      COUNTRY:
        structuredHeaders["D2C - Shopify"]?.find((h) => h?.name === "Country")
          ?.index ?? -1,
      LAST_ONE_DAYS:
        structuredHeaders["D2C - Shopify"]?.find(
          (h) => h?.name === "SV Yesterday"
        )?.index ?? -1,
      LAST_TWO_DAYS:
        structuredHeaders["D2C - Shopify"]?.find(
          (h) => h?.name === "SV 2 days ago"
        )?.index ?? -1,
      LAST_SEVEN_DAYS:
        structuredHeaders["D2C - Shopify"]?.find((h) => h?.name === "SV 7 days")
          ?.index ?? -1,
      LAST_FOURTEEN_DAYS:
        structuredHeaders["D2C - Shopify"]?.find(
          (h) => h?.name === "SV 14 days"
        )?.index ?? -1,
      LAST_THIRTY_DAYS:
        structuredHeaders["D2C - Shopify"]?.find(
          (h) => h?.name === "SV 30 days"
        )?.index ?? -1,
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


async function ensureShopifySKUSheetExists() {
  try {
    let spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties.title,sheets.properties.sheetId",
    });

    let sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === SHOPIFY_SKU_SHEET,
    );

    if (!sheet) {
      // Create sheet if it does not exist
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            { addSheet: { properties: { title: SHOPIFY_SKU_SHEET } } },
          ],
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

async function getShopifySkuSheetStructure() {
  try {
    const sheetId = await ensureShopifySKUSheetExists();

    // Fetch whatever headers exist in row 2
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHOPIFY_SKU_SHEET}!1:1`,
    });

    const headers = headerRes.data.values?.[0] || [];
    const lastColumnIndex = headers.length - 1;

    return {
      headers,
      sheetId,
      columnMap: {
        SHOPIFY_SKU: headers.indexOf("Shopify SKU"),
        BASE_SKU: headers.indexOf("Base SKU"),
        COUNTRY_CODE: headers.indexOf("Country Code"),
        QUANTITY: headers.indexOf("Quantity of Base SKU"),
      },
      lastColumnIndex,
    };
  } catch (error) {
    console.error("Failed to get sheet structure:", error.message);
    throw error;
  }
}

async function getShopifySkuBaseSkuMap() {
  try {
    const { columnMap, lastColumnIndex } = await getShopifySkuSheetStructure();

    const lastColLetter = colIndexToA1(lastColumnIndex);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHOPIFY_SKU_SHEET}!A2:${lastColLetter}`,
    });

    const rows = res.data.values || [];

    const skuMap = new Map();

    // to track unique sku-baseSku pair
    const uniquePairs = new Set();

    rows.forEach((row) => {
      const shopifySku = row[columnMap.SHOPIFY_SKU];
      const baseSku = row[columnMap.BASE_SKU];

      if (!shopifySku || !baseSku) return;

      const pairKey = `${shopifySku}|${baseSku}`;

      // skip duplicate pair
      if (uniquePairs.has(pairKey)) return;

      uniquePairs.add(pairKey);

      if (!skuMap.has(shopifySku)) {
        skuMap.set(shopifySku, []);
      }

      skuMap.get(shopifySku).push(baseSku);
    });

    return skuMap;
  } catch (error) {
    console.error("Error reading Shopify SKU sheet:", error.message);
    throw error;
  }
}

const fetchShopifyVelocityData = async (req, res) => {
  const isApiCall = !!res;
  const startTime = new Date().toLocaleString("en-US", {
    timeZone: "Europe/Brussels",
  });

  try {
    /* ---------------- TIMESTAMP START ---------------- */

    try {
      await updateShopifyTimestamp(startTime);
    } catch (e) {
      console.warn("updateShipTimestamp(start) failed:", e?.message || e);
    }

    /* ---------------- SHEET STRUCTURE ---------------- */

    const { headers, columnMap, lastColumnIndex, sheetId } =
      await getShopifySheetStructure();

    try {
      await showAllRowsKeepFilter(sheetId, 1, headers.length + 2);
    } catch (e) {
      console.warn("showAllRowsKeepFilter failed:", e?.message || e);
    }

    const shopifydata = await getAllShopApiKeys();

    const columnsToClear = Object.values(columnMap).filter((i) => i >= 0);
    const clearRanges = columnsToClear.map((colIndex) => {
      const colLetter = colIndexToA1(colIndex);
      return `${SHEET_SHOPIFY}!${colLetter}3:${colLetter}`;
    });

    await sheets.spreadsheets.values.batchClear({
      spreadsheetId: SPREADSHEET_ID,
      resource: { ranges: clearRanges },
    });

    console.log("shopify velocity data removed from sheet successfully");

    if (isApiCall) {
      res.status(200).json({
        status: "processing",
        message:
          "Shopify sales velocity data is being processed. Please check the Time Stamp sheet.",
      });
    }

    /* ---------------- HELPERS ---------------- */

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    const getNextPageUrl = (linkHeader) => {
      if (!linkHeader) return null;
      const links = linkHeader.split(",");
      for (const link of links) {
        if (link.includes('rel="next"')) {
          return link.match(/<(.*)>/)[1];
        }
      }
      return null;
    };

    /* ---------------- SHOPIFY FETCH ---------------- */

    const fetchShopifyData = async (shopName, accessToken) => {
      let orders = [];

      const OFFSET = "-05:00";

      const createdAtMin = moment()
        .subtract(31, "days")
        .startOf("day")
        .utcOffset(OFFSET, true)
        .format("YYYY-MM-DDTHH:mm:ss.SSZ");

      const createdAtMax = moment()
        .subtract(1, "days")
        .endOf("day")
        .utcOffset(OFFSET, true)
        .format("YYYY-MM-DDTHH:mm:ss.SSZ");

      let nextUrl = `https://${shopName}.myshopify.com/admin/api/2023-10/orders.json?status=any&fields=created_at,line_items,billing_address&limit=250&created_at_min=${createdAtMin}&created_at_max=${createdAtMax}`;

      const MAX_RETRIES = 4;

      // Fetch one page with exponential-backoff retry. Shopify occasionally
      // resets the connection mid-request (read ECONNRESET), especially for
      // high-volume brands that paginate many times. Retrying transient errors
      // keeps one blip from skipping the entire brand. A bad token (401/403) is
      // NOT retried — it fails fast.
      const fetchPage = async (url) => {
        let attempt = 0;
        while (true) {
          try {
            return await axios.get(url, {
              headers: {
                "X-Shopify-Access-Token": accessToken,
                "Content-Type": "application/json",
              },
              timeout: 30000,
            });
          } catch (err) {
            const code = err.code;
            const status = err.response?.status;
            const transient =
              ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(
                code
              ) ||
              status === 429 ||
              (status >= 500 && status < 600);

            if (!transient || attempt >= MAX_RETRIES) throw err;

            const backoff = Math.min(8000, 1000 * 2 ** attempt);
            console.warn(
              `Shopify fetch retry (${attempt + 1}/${MAX_RETRIES}) for ${shopName} after ${backoff}ms: ${
                code || status
              }`
            );
            await delay(backoff);
            attempt++;
          }
        }
      };

      while (nextUrl) {
        const res = await fetchPage(nextUrl);

        orders.push(...(res.data.orders || []));
        nextUrl = getNextPageUrl(res.headers?.link);
      }

      return orders;
    };

    /* ---------------- COLLECT ORDERS ---------------- */

    let shopifyOrders = [];

    for (const shop of shopifydata) {
      console.log(`Fetching orders for: ${shop.brand}`);
      try {
        const accessToken = await resolveShopAccessToken(shop);
        const orders = await fetchShopifyData(shop.shopName, accessToken);
        orders.forEach((o) => (o.brand = shop.brand));
        shopifyOrders.push(...orders);
      } catch (e) {
        // Don't let one brand's auth/fetch failure abort the whole run.
        console.error(`Skipping ${shop.brand}:`, e?.message || e);
      }
      await delay(1500);
    }

    console.log("shopify data fetched from api");

    /* ---------------- GROUP ORDERS (brand + sku + country + date) ---------------- */

    const grouped = {};
    // const filteredRecords = [];

    shopifyOrders.forEach((order) => {
      const date = order.created_at?.split("T")[0];
      const country = order?.billing_address?.country_code || "NA";

      order.line_items?.forEach((item) => {
        if (!item.sku) return;

        const key = `${order.brand}|${date}|${item.sku}|${country}`;

        if (!grouped[key]) {
          grouped[key] = {
            brand: order.brand,
            sku: item.sku,
            country,
            date,
            qty: 0,
          };
        }

        grouped[key].qty += item.quantity;
      });
    });

    console.log("shopify data grouping completed");

    const last30 = new Date();
    last30.setDate(last30.getDate() - 30);

    const rows = Object.values(grouped).filter(
      (r) => new Date(r.date) >= last30,
    );

    /* ---------------- MAP BY SKU + COUNTRY ---------------- */

    const bySkuCountry = new Map();

    rows.forEach((r) => {
      const mapKey = `${r.sku}|${r.country}`;

      if (!bySkuCountry.has(mapKey)) {
        bySkuCountry.set(mapKey, {
          brand: r.brand,
          sku: r.sku,
          country: r.country,
          data: [],
        });
      }

      bySkuCountry.get(mapKey).data.push({
        date: r.date,
        qty: r.qty,
      });
    });

    for (const v of bySkuCountry.values()) {
      v.data.sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    /* ---------------- VELOCITY ---------------- */

    const today = new Date();

    const r1 = getDateRangeShopify(today, 1);
    const r2 = getExactDayShopify(today, 2);
    const r7 = getDateRangeShopify(today, 7);
    const r14 = getDateRangeShopify(today, 14);
    const r30 = getDateRangeShopify(today, 30);

    const sum = (arr, s, e) =>
      arr.reduce(
        (t, x) =>
          new Date(x.date) >= new Date(s) && new Date(x.date) <= new Date(e)
            ? t + x.qty
            : t,
        0,
      );

    const velocityData = [];

    for (const v of bySkuCountry.values()) {
      velocityData.push({
        brand: v.brand,
        sku: v.sku, // ✅ ONLY SKU
        country: v.country, // ✅ ONLY COUNTRY
        v1: (sum(v.data, r1.start, r1.end) / 1).toFixed(2),
        v2: (sum(v.data, r2.start, r2.end) / 1).toFixed(2),
        v7: (sum(v.data, r7.start, r7.end) / 7).toFixed(2),
        v14: (sum(v.data, r14.start, r14.end) / 14).toFixed(2),
        v30: (sum(v.data, r30.start, r30.end) / 30).toFixed(2),
      });
    }

    console.log("shopify Velocity data calculation completed");

    /* ---------------- EXPAND DATA BASED ON BASE SKU COUNT ---------------- */

    const skuBaseMap = await getShopifySkuBaseSkuMap();

    const expandedVelocityData = [];

    for (const v of velocityData) {
      const baseSkus = skuBaseMap.get(v.sku) || [];

      // if sku exists in mapping sheet
      if (baseSkus.length > 0) {
        for (const base of baseSkus) {
          expandedVelocityData.push({
            ...v,
            baseSku: base,
          });
        }
      } else {
        // if no mapping found keep original
        expandedVelocityData.push({
          ...v,
          baseSku: "",
        });
      }
    }

    console.log("expanded velocity rows:", expandedVelocityData.length);

    /* ---------------- READ EXISTING SHEET DATA ---------------- */

    const DATA_START_ROW = 3;
    const lastColLetter = colIndexToA1(lastColumnIndex);

    const existingRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SHOPIFY}!A${DATA_START_ROW}:${lastColLetter}`,
    });

    const existingRowsRaw = existingRes?.data?.values || [];

    // SKU + Country → rowIndex
    const existingRowMap = new Map();

    existingRowsRaw.forEach((row, index) => {
      const sku = row[columnMap.SKU];
      const baseSku = row[columnMap.BASE_SKU];
      const country = row[columnMap.COUNTRY];
      if (sku && country) {
        existingRowMap.set(`${sku}|${baseSku}|${country}`, index);
      }
    });

    const updates = [];
    const inserts = [];
    let nextRowNum = DATA_START_ROW + existingRowMap.size;

    for (const v of expandedVelocityData) {
      const key = `${v.sku}|${v.baseSku}|${v.country}`;
      const existingRowIndex = existingRowMap.get(key);

      const rowNum =
        existingRowIndex !== undefined
          ? existingRowIndex + DATA_START_ROW
          : nextRowNum++;

      const target = existingRowIndex !== undefined ? updates : inserts;

      const pushCell = (colIndex, value) => {
        if (colIndex >= 0) {
          target.push({
            range: `${SHEET_SHOPIFY}!${colIndexToA1(colIndex)}${rowNum}`,
            values: [[value]],
          });
        }
      };

      pushCell(columnMap.BRAND_NAME, v.brand);
      pushCell(columnMap.SKU, v.sku); // ✅ CLEAN SKU
      pushCell(columnMap.BASE_SKU, v.baseSku);
      pushCell(columnMap.COUNTRY, v.country); // ✅ CLEAN COUNTRY
      pushCell(columnMap.LAST_ONE_DAYS, v.v1);
      pushCell(columnMap.LAST_TWO_DAYS, v.v2);
      pushCell(columnMap.LAST_SEVEN_DAYS, v.v7);
      pushCell(columnMap.LAST_FOURTEEN_DAYS, v.v14);
      pushCell(columnMap.LAST_THIRTY_DAYS, v.v30);
    }

    /* ---------------- APPLY TO SHEET ---------------- */

    // 1️⃣ Update existing rows
    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: "USER_ENTERED",
          data: updates,
        },
      });
    }

    // 2️⃣ Insert new rows
    if (inserts.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: "USER_ENTERED",
          data: inserts,
        },
      });
    }

    console.log("✅ Shopify velocity updated successfully");

    /* ---------------- TIMESTAMP END ---------------- */

    const endTime = new Date().toLocaleString("en-US", {
      timeZone: "Europe/Brussels",
    });

    try {
      await updateShopifyTimestamp(startTime, endTime);
    } catch (e) {
      console.warn("updateShipTimestamp(end) failed:", e?.message || e);
    }
  } catch (err) {
    console.error("❌ Shopify sync failed:", err.message);
  }
};

module.exports = {
  fetchShopifyVelocityData,
};
