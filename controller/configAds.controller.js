
const axios = require("axios");
const { google } = require("googleapis");
const auth = require("../config/googleAuth");
const { colIndexToA1 } = require("../helper");

const sheets = google.sheets({ version: "v4", auth });

// ENV
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.SHEET_GET_AMAZON_ACCESS_TOKEN;

/**
 * Get column indexes dynamically from header row
 */
async function getTokenSheetColumns() {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!1:1`,
    });
  
    const headers = res.data.values?.[0] || [];
  
    return {
      BRAND_NAME: headers.indexOf("Brand Name"),
      ACCESS_TOKEN: headers.indexOf("Access Token"),
      REFRESH_TOKEN: headers.indexOf("Refresh Token"),
      CLIENT_ID: headers.indexOf("clientId"),
      CLIENT_SECRET: headers.indexOf("clientSecret"),
    };
  }
  
  /**
   * Main processor for single sheet
   */
  async function processAmazonTokenSheet() {
    console.log("🔄 Processing Amazon Token Sheet...");
  
    try {
      const COLUMNS = await getTokenSheetColumns();
  
      const sheetData = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:Z`,
      });
  
      const values = sheetData.data.values || [];
  
      if (values.length < 2) {
        console.log("⚠️ No data rows found.");
        return;
      }
  
      const rows = values.slice(1); // skip header
  
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2;
  
        const brandName = row[COLUMNS.BRAND_NAME];
        const clientId = row[COLUMNS.CLIENT_ID];
        const clientSecret = row[COLUMNS.CLIENT_SECRET];
        const refreshToken = row[COLUMNS.REFRESH_TOKEN];
  
        if (!clientId || !clientSecret || !refreshToken) {
          console.warn(
            `⚠️ Missing credentials at row ${rowNumber} (${brandName || "Unknown"})`
          );
          continue;
        }
  
        try {
          console.log(`🔑 Refreshing token for ${brandName} (Row ${rowNumber})`);
  
          const { data: tokenData } = await axios.post(
            process.env.AUTH_LINK,
            new URLSearchParams({
              grant_type: "refresh_token",
              client_id: clientId,
              client_secret: clientSecret,
              refresh_token: refreshToken,
            }),
            {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
            }
          );
  
          const updateValues = [];
  
          if (COLUMNS.ACCESS_TOKEN >= 0) {
            updateValues.push(tokenData.access_token || "");
          }
  
          if (COLUMNS.REFRESH_TOKEN >= 0) {
            updateValues.push(tokenData.refresh_token || refreshToken);
          }
  
          const startCol = colIndexToA1(COLUMNS.ACCESS_TOKEN);
          const endCol = colIndexToA1(COLUMNS.REFRESH_TOKEN);
  
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!${startCol}${rowNumber}:${endCol}${rowNumber}`,
            valueInputOption: "USER_ENTERED",
            resource: {
              values: [updateValues],
            },
          });
  
          console.log(`✅ Updated token for ${brandName}`);
  
          // Rate-limit safety
          await new Promise((r) => setTimeout(r, 500));
        } catch (error) {
          console.error(
            `❌ Token refresh failed at row ${rowNumber} (${brandName})`
          );
          if (error.response) {
            console.error("API response:", error.response.data);
          } else {
            console.error(error.message);
          }
        }
      }
  
      console.log("🎉 Amazon Token Sheet processed successfully.");
    } catch (error) {
      console.error("💥 Fatal error:", error.message);
    }
  }

  exports.getAccessToken = async () => {
  try {
    const COLUMNS = await getTokenSheetColumns();

    if (COLUMNS.BRAND_NAME === -1 || COLUMNS.ACCESS_TOKEN === -1) {
      throw new Error("Required columns not found in token sheet");
    }

    const sheetResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });

    const [, ...rows] = sheetResponse.data.values || [];

    if (!rows.length) {
      throw new Error("No data rows found in token sheet");
    }

    const tokenMap = {};

    for (const row of rows) {
      const brandName = row[COLUMNS.BRAND_NAME]?.trim();
      const accessToken = row[COLUMNS.ACCESS_TOKEN]?.trim();

      if (brandName && accessToken) {
        tokenMap[brandName] = accessToken;
      }
    }

    console.log("✅ Brand tokens loaded:", Object.keys(tokenMap));

    return tokenMap;
  } catch (error) {
    console.error("❌ Failed to fetch brand tokens:", error.message);
    throw error;
  }
};
  
  
  /**
   * CRON entry
   */
  exports.cronUpdateToken = async () => {
    await processAmazonTokenSheet();
  };