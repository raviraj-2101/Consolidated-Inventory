const {
  colIndexToA1,
  ensureTimestampSheetExists,
  showAllRowsKeepFilter,
} = require("../helper");
const { default: axios } = require("axios");
const INVENTORY_SHEET = process.env.INVENTORY_SHEET;
const { google } = require("googleapis");
const auth = require("../config/googleAuth");
const { getAccessToken, cronUpdateToken } = require("./configAds.controller");
const moment = require("moment");
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN_DELAY_INVENTORY = 500;

const updateAmazonInventoryTimestamp = async (startTime, endTime = null) => {
  try {
    const fmtOpts = { timeZone: "Europe/Brussels" };
    const timestampStr = new Date().toLocaleString("en-US", fmtOpts);

    await ensureTimestampSheetExists();

    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Time Stamp!2:2",
    });

    const headers = headerRes.data.values?.[0] || [];
    const startColIndex = headers.indexOf("Amz. Inventory Start Time");
    const endColIndex = headers.indexOf("Amz. Inventory End Time");
    const tsColIndex = headers.indexOf("Amz. Inventory Time Stamp");

    if (startColIndex === -1 || endColIndex === -1 || tsColIndex === -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: "Time Stamp!A2:C2",
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [
            [
              "Amz. Inventory Start Time",
              "Amz. Inventory Time Stamp",
              "Amz. Inventory End Time",
            ],
          ],
        },
      });
      return await updateAmazonInventoryTimestamp(startTime, endTime);
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

async function ensureAmazonSheetExists() {
  try {
    let spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties.title,sheets.properties.sheetId",
    });

    let sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === INVENTORY_SHEET,
    );

    if (!sheet) {
      // Create sheet if it does not exist
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: INVENTORY_SHEET } } }],
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

async function getAmazonSheetStructure() {
  try {
    const sheetId = await ensureAmazonSheetExists();

    // Fetch main headers (row 1)
    const mainHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!1:1`,
    });
    const mainHeaders = mainHeaderRes.data.values?.[0] || [];

    // Fetch sub headers (row 3)
    const subHeaderRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!2:2`,
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
      FULLFILLABLE:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Fulfillable")
          ?.index ?? -1,
      SKU:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Sku")?.index ??
        -1,
      RESERVED:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Reserved")
          ?.index ?? -1,
      UNSELLABLE:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Unsellable")
          ?.index ?? -1,
      INBOUND:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Inbound")
          ?.index ?? -1,
      RESEARCHING:
        structuredHeaders["Amazon"]?.find((h) => h?.name === "Researching")
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

let lastInventoryRequestTime = 0;

const fetchAndUpdateInventory = async (req, res) => {
  const isApiCall = !!res;

  const num = (v, d = 0) => (typeof v === "number" && !Number.isNaN(v) ? v : d);

  const marketplaceId =
    req?.body?.marketplaceId || process.env.MARKET_PLACE_ID || "ATVPDKIKX0DER";
  if (isApiCall && !marketplaceId)
    return res
      .status(400)
      .json({ success: false, message: "Marketplace ID is required" });

  const startTime = new Date().toLocaleString("en-US", {
    timeZone: "Europe/Brussels",
  });

  try {
    // Start timestamp
    try {
      await updateAmazonInventoryTimestamp(startTime);
    } catch (e) {
      console.warn(
        "updateAmazonInventoryTimestamp(start) failed:",
        e?.message || e,
      );
    }

    await cronUpdateToken();
    let tokenMap = await getAccessToken();

    const { headers, columnMap, lastColumnIndex, sheetId } =
      await getAmazonSheetStructure();

    const validIndexes = Object.values(columnMap).filter((i) => i >= 0);

    const maxUsedColIndex = Math.max(...validIndexes);

    // Clear the Basic Filter on this tab (safe even if none is set)
    try {
      await showAllRowsKeepFilter(sheetId, 1, maxUsedColIndex + 1);
      console.log("Basic filter cleared on sheetId:", sheetId);
    } catch (e) {
      console.warn("showAllRowsKeepFilter failed:", e?.message || e);
    }

    // ---- fetch inventory with pagination, spacing, retries ----
    const allItems = [];

    const fetchRecursive = async (
      accessToken,
      nextToken = null,
      retries = 3,
    ) => {
      try {
        const now = Date.now();
        const timeSinceLastCall = now - lastInventoryRequestTime;

        if (timeSinceLastCall < MIN_DELAY_INVENTORY) {
          await new Promise((resolve) =>
            setTimeout(resolve, MIN_DELAY_INVENTORY - timeSinceLastCall),
          );
        }

        const response = await axios.get(
          `${process.env.ROOT_LINK_SELLER}/fba/inventory/v1/summaries`,
          {
            headers: { "x-amz-access-token": accessToken },
            params: {
              granularityType: "Marketplace",
              granularityId: marketplaceId,
              marketplaceIds: marketplaceId,
              details: true,
              ...(nextToken && { nextToken }),
            },
            timeout: 15000,
          },
        );

        lastInventoryRequestTime = Date.now();

        const summaries = response?.data?.payload?.inventorySummaries || [];

        allItems.push(...summaries);

        const next = response?.data?.pagination?.nextToken;
        if (next) {
          await fetchRecursive(accessToken, next, retries);
        }
      } catch (error) {
        // 🔁 Retry logic
        if (
          (error.response?.status === 429 ||
            error.code === "ECONNABORTED" ||
            error.response?.status >= 500) &&
          retries > 0
        ) {
          const backoffTime = Math.min(5000, 500 * Math.pow(2, 3 - retries));
          await new Promise((resolve) => setTimeout(resolve, backoffTime));
          await fetchRecursive(accessToken, nextToken, retries - 1);
        } else {
          // 👇 LOG REAL AMAZON ERROR
          console.error(
            "Amazon inventory error:",
            error.response?.data || error.message,
          );
          throw new Error(`Inventory fetch failed: ${error.message}`);
        }
      }
    };

    for (const [brand, accessToken] of Object.entries(tokenMap)) {
      console.log(`📦 Fetching inventory for ${brand}`);
      await fetchRecursive(accessToken);
    }
    console.log("all data fetched inventory");

    // ---- sheet structure & existing data ----
    const DATA_START_ROW = 3;

    const minUsedColIndex = Math.min(...validIndexes);

    const startCol = colIndexToA1(minUsedColIndex);
    const endCol = colIndexToA1(maxUsedColIndex);

    const readRange = `${INVENTORY_SHEET}!${startCol}${DATA_START_ROW}:${endCol}`;

    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: readRange,
    });

    const existingRowsRaw = existingData?.data?.values || [];

    const existingRows = existingRowsRaw.map((r) => {
      const row = {};
      for (let i = 0; i < r.length; i++) {
        row[minUsedColIndex + i] = r[i];
      }
      return row;
    });

    /* ---------------- UPSERT LOGIC ---------------- */

    const updates = [];
    const inserts = [];

    let nextRowNum = DATA_START_ROW + existingRows.length;

    for (const item of allItems) {
      const sku = item?.sellerSku || "";
      if (!sku) continue;

      const fulfillable = num(item?.inventoryDetails?.fulfillableQuantity);
      const reserved = num(
        item?.inventoryDetails?.reservedQuantity?.totalReservedQuantity,
      );
      const unsellable = num(
        item?.inventoryDetails?.unfulfillableQuantity
          ?.totalUnfulfillableQuantity,
      );
      const researching = num(
        item?.inventoryDetails?.researchingQuantity?.totalResearchingQuantity,
      );

      const existingRowIndex = existingRows.findIndex(
        (row) => row?.[columnMap.SKU] === sku,
      );

      const rowNum =
        existingRowIndex >= 0
          ? existingRowIndex + DATA_START_ROW
          : nextRowNum++;

      const target = existingRowIndex >= 0 ? updates : inserts;

      const pushCell = (colIndex, value) => {
        if (colIndex >= 0) {
          target.push({
            range: `${INVENTORY_SHEET}!${colIndexToA1(colIndex)}${rowNum}`,
            values: [[value]],
          });
        }
      };

      pushCell(columnMap.SKU, sku);
      pushCell(columnMap.FULLFILLABLE, fulfillable);
      pushCell(columnMap.RESERVED, reserved);
      pushCell(columnMap.UNSELLABLE, unsellable);
      pushCell(columnMap.RESEARCHING, researching);
    }

    // ---- apply updates ----
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { valueInputOption: "USER_ENTERED", data: updates },
      });
    }

    if (isApiCall) {
      res.status(200).json({
        status: "processing",
        message:
          "Inventory data is being processed. This may take time — please check the Time Stamp sheet for completion status.",
      });
    }

    try {
      await fetchAndUpdateInboundShipment();
    } catch (e) {
      console.warn("fetchAndUpdateInboundShipment failed:", e?.message || e);
    }

    // end timestamp
    const endTime = new Date().toLocaleString("en-US", {
      timeZone: "Europe/Brussels",
    });
    try {
      await updateAmazonInventoryTimestamp(startTime, endTime);
    } catch (e) {
      console.warn(
        "updateAmazonInventoryTimestamp(end) failed:",
        e?.message || e,
      );
    }
  } catch (error) {
    console.error("Inventory controller error:", error?.message, error?.stack);
    try {
      await updateAmazonInventoryTimestamp(startTime, new Date());
    } catch (_) {}
    if (isApiCall) {
      return res.status(500).json({
        success: false,
        message: error?.message || "Internal server error",
        details: error?.response?.data || null,
      });
    }
  }
};

let lastInboundRequestTime = 0;
const MIN_DELAY_INBOUND = 0;

const fetchAndUpdateInboundShipment = async (req, res) => {
  console.log("fetch inbound data start");
  try {
    await cronUpdateToken();
    let tokenMap = await getAccessToken();

    const statuses = ["SHIPPED", "VOIDED", "ACTIVE"];

    // ---- fetch inventory with pagination, spacing, retries ----
    const allInboundPlans = [];
    const fetchInboundPlans = async (
      brand,
      accessToken,
      status,
      nextToken = null,
      retries = 3,
    ) => {
      try {
        const now = Date.now();
        const diff = now - lastInboundRequestTime;
        if (diff < MIN_DELAY_INBOUND) {
          await new Promise((r) => setTimeout(r, MIN_DELAY_INBOUND - diff));
        }

        const response = await axios.get(
          `${process.env.ROOT_LINK_SELLER}/inbound/fba/2024-03-20/inboundPlans`,
          {
            headers: { "x-amz-access-token": accessToken },
            params: {
              pageSize: 10,
              status,
              ...(nextToken && { paginationToken: nextToken }),
            },
            timeout: 2500,
          },
        );

        lastInboundRequestTime = Date.now();

        const plans = response?.data?.inboundPlans || [];
        plans.forEach((p) => (p.brand = brand));
        allInboundPlans.push(...plans);

        const next = response?.data?.pagination?.nextToken;
        if (next) {
          await fetchInboundPlans(brand, accessToken, status, next, retries);
        }
      } catch (err) {
        if (
          (err.response?.status === 429 ||
            err.code === "ECONNABORTED" ||
            err.response?.status >= 500) &&
          retries > 0
        ) {
          await new Promise((r) => setTimeout(r, 1000));
          return fetchInboundPlans(
            brand,
            accessToken,
            status,
            nextToken,
            retries - 1,
          );
        }
        console.log("error: ", err);
        throw err;
      }
    };

    /* ---------------- LOOP BRANDS + STATUS ---------------- */
    for (const brand of Object.keys(tokenMap)) {
      const accessToken = tokenMap[brand];
      for (const status of statuses) {
        await fetchInboundPlans(brand, accessToken, status);
      }
    }

    console.log("Inbound plans fetched:", allInboundPlans.length);

    /* ---------------- FETCH PLAN DETAILS ---------------- */
    const planDetails = [];

    for (const plan of allInboundPlans) {
      try {
        const response = await axios.get(
          `${process.env.ROOT_LINK_SELLER}/inbound/fba/2024-03-20/inboundPlans/${plan.inboundPlanId}`,
          {
            headers: {
              "x-amz-access-token": tokenMap[plan.brand],
            },
            timeout: 10000,
          },
        );

        planDetails.push({
          inboundPlanId: plan.inboundPlanId,
          brand: plan.brand,
          ...response.data,
        });

        console.log(`Fetched plan details: ${plan.inboundPlanId}`);
      } catch (err) {
        console.warn(
          `Failed to fetch plan ${plan.inboundPlanId}:`,
          err.message,
        );
      }

      await new Promise((r) => setTimeout(r, 400));
    }

    /* ---------------- FILTER PLANS WITH SHIPMENTS ---------------- */
    const inboundPlansSummary = planDetails
      .filter((p) => Array.isArray(p.shipments) && p.shipments.length > 0)
      .map((p) => ({
        inboundPlanId: p.inboundPlanId,
        brand: p.brand,
        createdAt: p.createdAt,
        shipmentIds: p.shipments.map((s) => s.shipmentId),
      }));

    /* ---------------- FETCH SHIPMENT DETAILS ---------------- */
    const shipmentDetails = await fetchShipmentDetails(
      inboundPlansSummary,
      tokenMap,
    );

    /* ---------------- FETCH SHIPMENT PRODUCT DETAILS ---------------- */
    const shipmentProductDetails = await fetchShipmentProductDetails(
      inboundPlansSummary,
      tokenMap,
    );

    /* ---------------- MERGE DATA ---------------- */
    const mergedMap = new Map();

    shipmentProductDetails.forEach((product) => {
      const key = `${product.inboundPlanId}|${product.shipmentId}|${product.msku}`;
      mergedMap.set(key, {
        ...product,
        brand: product.brand,
        createdAt:
          inboundPlansSummary.find(
            (p) => p.inboundPlanId === product.inboundPlanId,
          )?.createdAt || "",
      });
    });

    shipmentDetails.forEach((shipment) => {
      mergedMap.forEach((item) => {
        if (
          item.inboundPlanId === shipment.inboundPlanId &&
          item.shipmentId === shipment.shipmentId
        ) {
          Object.assign(item, {
            shipmentConfirmationId: shipment.shipmentConfirmationId || "",
            shipmentName: shipment.shipmentName || "",
            status: shipment.status || "",
          });
        }
      });
    });

    const mergedData = Array.from(mergedMap.values());

    try {
      await fetchInboundQuantity(mergedData);
    } catch (error) {
      console.warn("fetchInboundQuantity failed:", error?.message || error);
    }
  } catch (error) {
    console.error(
      "Inbound Shipment controller error:",
      error?.message,
      error?.stack,
    );
  }
};

const fetchShipmentDetails = async (inboundPlansSummary, tokenMap) => {
  try {
    console.log("🚀 fetch shipment data started");

    const allShipmentDetails = [];

    for (const plan of inboundPlansSummary) {
      const { inboundPlanId, shipmentIds, brand } = plan;

      if (!tokenMap[brand]) {
        console.warn(`⚠️ No access token found for brand: ${brand}`);
        continue;
      }

      for (const shipmentId of shipmentIds) {
        let attempt = 0;

        while (attempt < 2) {
          try {
            const response = await axios.get(
              `${process.env.ROOT_LINK_SELLER}/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/shipments/${shipmentId}`,
              {
                headers: {
                  "x-amz-access-token": tokenMap[brand],
                },
                timeout: 20000,
              },
            );

            const data = response?.data || {};

            allShipmentDetails.push({
              brand,
              inboundPlanId,
              shipmentId,
              shipmentConfirmationId: data?.shipmentConfirmationId || "",
              shipmentName: data?.name || "",
              status: data?.status || "",
            });

            console.log(
              `✅ Shipment fetched | Brand: ${brand} | Plan: ${inboundPlanId} | Shipment: ${shipmentId}`,
            );

            break; // ✅ success → exit retry loop
          } catch (err) {
            const status = err?.response?.status;

            // 🔐 Token expired → refresh once
            if (
              (status === 401 || status === 403 || status === 429) &&
              attempt === 0
            ) {
              console.warn(
                `🔄 Token expired | Refreshing token for brand: ${brand}`,
              );

              const updatedTokenMap = await getAccessToken();

              if (updatedTokenMap[brand]) {
                tokenMap[brand] = updatedTokenMap[brand];
              }

              attempt++;
              continue;
            }

            console.warn(
              `⚠️ Failed shipment fetch | Brand: ${brand} | Plan: ${inboundPlanId} | Shipment: ${shipmentId}`,
              err.message,
            );
            break;
          }
        }

        // ⏱ throttle to avoid Amazon rate limits
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    console.log("✅ fetch shipment data completed");
    return allShipmentDetails;
  } catch (error) {
    console.error("❌ fetchShipmentDetails error:", error?.message || error);
    throw error;
  }
};

const fetchShipmentProductDetails = async (inboundPlansSummary, tokenMap) => {
  try {
    console.log("🚀 shipment product details started");

    const allShipmentProductDetails = [];

    for (const plan of inboundPlansSummary) {
      const { inboundPlanId, shipmentIds, brand } = plan;

      if (!tokenMap[brand]) {
        console.warn(`⚠️ No access token found for brand: ${brand}`);
        continue;
      }

      for (const shipmentId of shipmentIds) {
        let nextToken = null;

        do {
          let attempt = 0;

          while (attempt < 2) {
            try {
              const response = await axios.get(
                `${process.env.ROOT_LINK_SELLER}/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/items`,
                {
                  headers: {
                    accept: "application/json",
                    "x-amz-access-token": tokenMap[brand],
                  },
                  params: {
                    pageSize: 10,
                    ...(nextToken && { paginationToken: nextToken }),
                  },
                  timeout: 10000,
                },
              );

              const items = response?.data?.items || [];

              // --- Deduplicate items ---
              const uniqueItemsMap = new Map();

              for (const item of items) {
                const key = `${item.msku}|${item.fnsku}|${item.asin}`;

                if (!uniqueItemsMap.has(key)) {
                  uniqueItemsMap.set(key, {
                    brand,
                    inboundPlanId,
                    shipmentId,
                    msku: item.msku,
                    fnsku: item.fnsku,
                    asin: item.asin,
                  });
                }
              }

              allShipmentProductDetails.push(...uniqueItemsMap.values());

              nextToken = response?.data?.pagination?.nextToken || null;

              console.log(
                `✅ Shipment items fetched | Brand: ${brand} | Plan: ${inboundPlanId} | Shipment: ${shipmentId}`,
              );

              break; // ✅ success
            } catch (err) {
              const status = err?.response?.status;

              // 🔄 Token expired → refresh once
              if (
                (status === 401 || status === 403 || status === 429) &&
                attempt === 0
              ) {
                console.warn(
                  `🔄 Token expired | Refreshing token for brand: ${brand}`,
                );

                const updatedTokenMap = await getAccessToken();

                if (updatedTokenMap[brand]) {
                  tokenMap[brand] = updatedTokenMap[brand];
                }

                attempt++;
                continue;
              }

              console.warn(
                `⚠️ Failed shipment items | Brand: ${brand} | Shipment: ${shipmentId}`,
                err.message,
              );
              break;
            }
          }

          // ⏱ Throttle
          await new Promise((r) => setTimeout(r, 500));
        } while (nextToken);
      }
    }

    console.log("✅ shipment product details completed");
    return allShipmentProductDetails;
  } catch (error) {
    console.error(
      "❌ fetchShipmentProductDetails error:",
      error?.message || error,
    );
    return [];
  }
};

const fetchInboundQuantity = async (inboundData) => {
  console.log("📦 inbound quantity data fetch start");

  try {
    await cronUpdateToken();

    let tokenMap = await getAccessToken();

    const shipmentGroups = new Map();

    for (const row of inboundData) {
      const shipmentId = row.shipmentConfirmationId;
      if (!shipmentId) continue;

      if (!shipmentGroups.has(shipmentId)) {
        shipmentGroups.set(shipmentId, {
          brand: row.brand,
          shipmentId,
        });
      }
    }

    /* -------------------------------------------------------
       3) Fetch shipment items from Amazon
    ------------------------------------------------------- */
    const allItems = [];

    const fetchItemsForShipment = async (shipmentId, brand, retries = 3) => {
      let accessToken = tokenMap[brand];
      const collected = [];

      const fetchRecursive = async (nextToken = null, retriesLeft) => {
        try {
          const now = Date.now();
          const diff = now - lastInboundRequestTime;
          if (diff < MIN_DELAY_INBOUND) {
            await delay(MIN_DELAY_INBOUND - diff);
          }

          const url = `${
            process.env.ROOT_LINK_SELLER
          }/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`;

          const params = nextToken ? { NextToken: nextToken } : {};

          const response = await axios.get(url, {
            headers: {
              "x-amz-access-token": accessToken,
            },
            params,
            timeout: 15000,
          });

          lastInboundRequestTime = Date.now();

          const items = response?.data?.payload?.ItemData || [];

          collected.push(
            ...items.map((it) => ({
              ShipmentId: shipmentId,
              SellerSKU: it.SellerSKU,
              QuantityShipped: Number(it.QuantityShipped || 0),
              QuantityReceived: Number(it.QuantityReceived || 0),
            })),
          );
        } catch (err) {
          const status = err.response?.status;

          /* ---------------- TOKEN EXPIRED ---------------- */
          if (
            (status === 401 || status === 403 || status === 429) &&
            retriesLeft > 0
          ) {
            console.warn(`🔑 Token expired for ${brand}, refreshing...`);

            // Fetch new token
            const updatedTokenMap = await getAccessToken();

            if (updatedTokenMap[brand]) {
              tokenMap[brand] = updatedTokenMap[brand];
              accessToken = updatedTokenMap[brand];
            }

            return fetchRecursive(nextToken, retriesLeft - 1);
          }

          /* ---------------- RETRIABLE ERRORS ---------------- */
          const retriable =
            status === 429 || err.code === "ECONNABORTED" || status >= 500;

          if (retriable && retriesLeft > 0) {
            const wait = Math.min(5000, 500 * 2 ** (3 - retriesLeft));
            console.warn(`Retry shipment ${shipmentId} after ${wait}ms`);
            await delay(wait);
            return fetchRecursive(nextToken, retriesLeft - 1);
          }

          throw err;
        }
      };

      await fetchRecursive(null, retries);
      return collected;
    };

    for (const { brand, shipmentId } of shipmentGroups.values()) {
      const accessToken = tokenMap[brand];

      if (!accessToken) {
        console.warn(`No access token for brand ${brand}`);
        continue;
      }

      console.log(`📦 Fetching items for shipment ${shipmentId}`);
      const items = await fetchItemsForShipment(shipmentId, brand);
      await delay(2000);
      allItems.push(...items);
    }

    const groupedMap = new Map();

    for (const item of allItems) {
      const key = `${item.ShipmentId}__${item.SellerSKU}`;

      if (groupedMap.has(key)) {
        const existing = groupedMap.get(key);
        existing.quantityShipped += item.QuantityShipped;
        existing.quantityReceived += item.QuantityReceived;
      } else {
        groupedMap.set(key, {
          shipmentId: item.ShipmentId,
          sku: item.SellerSKU,
          quantityShipped: item.QuantityShipped,
          quantityReceived: item.QuantityReceived,
        });
      }
    }

    const result = Array.from(groupedMap.values()).map((s) => ({
      shipmentId: s.shipmentId,
      sku: s.sku,
      quantityShipped: s.quantityShipped,
      quantityReceived: s.quantityReceived,
      unitsNotLocated: s.quantityShipped - s.quantityReceived,
    }));

    const shipmentQtyMap = new Map();

    for (const r of result) {
      const key = `${r.shipmentId}__${r.sku}`;
      shipmentQtyMap.set(key, {
        quantityShipped: r.quantityShipped,
        quantityReceived: r.quantityReceived,
        unitsNotLocated: r.unitsNotLocated,
      });
    }

    const enrichedInboundData = inboundData.map((row) => {
      const key = `${row.shipmentConfirmationId}__${row.msku}`;
      const qty = shipmentQtyMap.get(key);

      return {
        ...row,
        quantityShipped: qty?.quantityShipped ?? 0,
        quantityReceived: qty?.quantityReceived ?? 0,
        unitsNotLocated: qty?.unitsNotLocated ?? 0,
      };
    });

    const EXCLUDED_STATUSES = ["CANCELLED", "CLOSED", "DELETED"];

    const today = moment().startOf("day");

    const filteredInboundData = enrichedInboundData.map((row) => {
      const status = row.status?.toUpperCase();
      const createdDate = moment(row.createdAt).startOf("day");
      const diffInDays = today.diff(createdDate, "days");

      // Remove only if excluded status OR older than 50 days
      if (EXCLUDED_STATUSES.includes(status) || diffInDays > 50) {
        return {
          ...row,
          unitsNotLocated: 0,
        };
      }

      return row;
    });

    const summedBySku = Object.values(
      filteredInboundData.reduce((acc, row) => {
        acc[row.msku] ??= { msku: row.msku, unitsNotLocated: 0 };
        acc[row.msku].unitsNotLocated += row.unitsNotLocated;
        return acc;
      }, {}),
    );

    const { headers, columnMap, lastColumnIndex, sheetId } =
      await getAmazonSheetStructure();

    const DATA_START_ROW = 3;

    const validIndexes = Object.values(columnMap).filter((i) => i >= 0);
    const minUsedColIndex = Math.min(...validIndexes);
    const maxUsedColIndex = Math.max(...validIndexes);

    const startCol = colIndexToA1(minUsedColIndex);
    const endCol = colIndexToA1(maxUsedColIndex);

    const readRange = `${INVENTORY_SHEET}!${startCol}${DATA_START_ROW}:${endCol}`;

    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: readRange,
    });

    const existingRowsRaw = existingData?.data?.values || [];

    const existingRows = existingRowsRaw.map((r) => {
      const row = {};
      for (let i = 0; i < r.length; i++) {
        row[minUsedColIndex + i] = r[i];
      }
      return row;
    });

    const updates = [];

    const SKU_COL_INDEX = columnMap.SKU;
    const INBOUND_COL_INDEX = columnMap.INBOUND;

    const inboundQtyBySku = new Map(
      summedBySku.map((s) => [s.msku, s.unitsNotLocated]),
    );

    existingRows.forEach((row, idx) => {
      const rowNumber = DATA_START_ROW + idx;
      const sku = row[SKU_COL_INDEX];

      if (!sku) return;

      const inboundQty = inboundQtyBySku.get(sku) ?? 0;

      // Only update if SKU exists in summed data
      if (inboundQty !== undefined) {
        const cellRange = `${INVENTORY_SHEET}!${colIndexToA1(
          INBOUND_COL_INDEX,
        )}${rowNumber}`;

        updates.push({
          range: cellRange,
          values: [[inboundQty]],
        });
      }
    });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: "RAW",
          data: updates,
        },
      });
    }

    console.log("✅ inbound quantity data updated successfully");
  } catch (error) {
    console.error("Inbound shipment controller error:", error);
  }
};

module.exports = {
  fetchAndUpdateInventory,
  fetchAndUpdateInboundShipment,
  fetchInboundQuantity,
};
