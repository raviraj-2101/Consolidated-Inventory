const { google } = require("googleapis");
const auth = require("./config/googleAuth");
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID.trim();
const SHEET_GET_SHOPIFY_ACCESS_TOKEN = process.env.SHEET_GET_SHOPIFY_ACCESS_TOKEN;


function colIndexToA1(colIdxZeroBased) {
  let n = colIdxZeroBased + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }

  return s;
}

const ensureTimestampSheetExists = async () => {
  try {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties.title",
    });

    const sheetExists = spreadsheet.data.sheets.some(
      (sheet) => sheet.properties.title === "Time Stamp"
    );

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              addSheet: {
                properties: { title: "Time Stamp" },
              },
            },
          ],
        },
      });

      // Add headers to the newly created sheet
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: "Time Stamp!A2:C2",
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [
            ["Shopify Start Time", "Shopify End Time", "Shopify Time Stamp"],
          ],
        },
      });
    }
  } catch (error) {
    console.error("Could not ensure timestamp sheet exists:", error.message);
    throw error;
  }
};


async function showAllRowsKeepFilter(sheetId, headerRowIndexZeroBased, colCount) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: headerRowIndexZeroBased, // row 2 => index 1
              startColumnIndex: 0,
              endColumnIndex: colCount // exclusive
            }
            // no "criteria" => show all rows
          }
        }
      }]
    }
  });
}


const getAllShopApiKeys = async () => {
  try {
    const sheetResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      // Brand | Shop Name | Api Key | Client ID | Client Secret
      range: `${SHEET_GET_SHOPIFY_ACCESS_TOKEN}!A:E`,
    });

    const [headers, ...rows] = sheetResponse.data.values || [];

    if (!rows.length) {
      throw new Error("No data found in sheet");
    }

    // Normalize headers
    const headerIndex = {
      brand: headers.indexOf("Brand"),
      shopName: headers.indexOf("Shop Name"),
      apiKey: headers.indexOf("Api Key"),
      clientId: headers.indexOf("Client ID"),
      clientSecret: headers.indexOf("Client Secret"),
    };

    // Only Brand and Shop Name are mandatory. Api Key / Client ID / Client
    // Secret are optional, so an older sheet (without the new columns) and the
    // existing brands keep working exactly as before.
    for (const key of ["brand", "shopName"]) {
      if (headerIndex[key] === -1) {
        throw new Error(`${key} column not found in sheet`);
      }
    }

    const cell = (row, idx) => (idx !== -1 ? row[idx] : undefined);

    // Convert rows → objects, then keep only rows that carry a usable
    // credential: either a static Api Key (old brands) OR a Client ID + Secret
    // (new brands created in Shopify's 2026 Dev Dashboard).
    const result = rows
      .map((row) => ({
        brand: cell(row, headerIndex.brand),
        shopName: cell(row, headerIndex.shopName),
        apiKey: cell(row, headerIndex.apiKey),
        clientId: cell(row, headerIndex.clientId),
        clientSecret: cell(row, headerIndex.clientSecret),
      }))
      .filter(
        (r) => r.shopName && (r.apiKey || (r.clientId && r.clientSecret))
      );

    return result;
  } catch (error) {
    console.error("Sheet data fetch failed:", error.message);
    throw new Error(`Failed to fetch sheet data: ${error.message}`);
  }
};


module.exports = {
  colIndexToA1,
  ensureTimestampSheetExists,
  showAllRowsKeepFilter,
  getAllShopApiKeys
};
