const { google } = require("googleapis");
const axios = require("axios");
const auth = require("../config/googleAuth");

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME =
  process.env.AMAZON_SALES_VELOCITY_FLUCTUATIONS_SHEET ||
  "Amazon_Sales_Velocity_Fluctuations";

// Resolve column indices by cross-referencing row 3 group headers with row 4 sub-headers.
// This ensures Change % columns are identified by their group context, not by position,
// so reordering columns in the sheet won't silently swap day/week values.
async function getSheetColumns() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A3:Z4`,
  });

  const [row3 = [], row4 = []] = res.data.values || [];

  // Merged cells return a value only in the first cell of the merge; propagate
  // forward so every column index carries its group header label.
  let currentGroup = "";
  const row3Filled = row3.map((v) => {
    if (v) currentGroup = v;
    return currentGroup;
  });

  // Find the column where the group header (row 3) matches AND the sub-header
  // (row 4) is "Change %"
  const findChangeCol = (groupLabel) =>
    row3Filled.findIndex(
      (group, i) => group === groupLabel && row4[i] === "Change %"
    );

  return {
    SKU: row4.indexOf("Sku"),
    ASIN: row4.indexOf("ASIN"),
    CHANGE_PCT_DAY: findChangeCol("Yesterday vs 2 days ago"),
    CHANGE_PCT_WEEK: findChangeCol("SV 7 days vs SV 14 days"),
    FLAG_DAY: row4.indexOf("Flag -1"),
    FLAG_WEEK: row4.indexOf("Flag -2"),
  };
}

function parseChangePercent(value) {
  if (!value || value === "-") return null;
  const str = String(value).trim();
  if (str.endsWith("%")) return parseFloat(str);
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  // Treat as decimal fraction if absolute value <= 1 (e.g. -0.13 → -13)
  return Math.abs(num) <= 1 ? num * 100 : num;
}

function getEmoji(changePct) {
  if (changePct === null) return null;
  if (changePct < -20) return { type: "emoji", name: "red_circle" };
  if (changePct < 0) return { type: "emoji", name: "large_yellow_circle" };
  return null;
}

const fetchSalesVelocityAlertsAndNotify = async () => {
  console.log("📋 Fetching Amazon Sales Velocity Fluctuations data...");

  const COL = await getSheetColumns();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:M`,
  });

  const rows = response.data.values || [];
  // Skip 4 header rows (rows 1–4), data starts from row 5
  const dataRows = rows.slice(4).filter((row) => row[COL.SKU]);

  if (!dataRows.length) {
    console.log("No data rows found in Sales Velocity Fluctuations sheet.");
    return "No data rows found in Sales Velocity Fluctuations sheet.";
  }

  // Build alert list — one entry per flagged column per row
  const alerts = [];
  for (const row of dataRows) {
    const sku = row[COL.SKU] || "-";
    const asin = row[COL.ASIN] || "-";
    const flagDay = row[COL.FLAG_DAY] || "";
    const flagWeek = row[COL.FLAG_WEEK] || "";

    if (flagDay && flagDay !== "No Issues") {
      const changePct = parseChangePercent(row[COL.CHANGE_PCT_DAY]);
      alerts.push({ sku, asin, changePct, flagMessage: flagDay, emoji: getEmoji(changePct) });
    }

    if (flagWeek && flagWeek !== "No Issues") {
      const changePct = parseChangePercent(row[COL.CHANGE_PCT_WEEK]);
      alerts.push({ sku, asin, changePct, flagMessage: flagWeek, emoji: getEmoji(changePct) });
    }
  }

  if (!alerts.length) {
    console.log("No sales velocity alerts to send.");
    return "No sales velocity alerts to send.";
  }

  const sheetLink = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

  const blocks = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "emoji", name: "rotating_light" },
            { type: "text", text: " Low Sales Velocity Warning: - " },
            { type: "broadcast", range: "channel" },
          ],
        },
      ],
    },
  ];

  const spacerBlock = {
    type: "section",
    text: { type: "mrkdwn", text: " " },
  };

  blocks.push(spacerBlock);

  for (let i = 0; i < alerts.length; i++) {
    const { sku, asin, changePct, flagMessage, emoji } = alerts[i];
    const changePctStr = changePct !== null ? `${changePct}%` : "-";

    const flagLineElements = [{ type: "text", text: `${flagMessage} : ` }];
    if (emoji) flagLineElements.push(emoji);

    blocks.push({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 0,
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: `SKU: ${sku}`, style: { bold: true } }],
            },
          ],
        },
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 1,
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: `ASIN: ${asin}` }],
            },
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: `Change %:  ${changePctStr}` }],
            },
            {
              type: "rich_text_section",
              elements: flagLineElements,
            },
          ],
        },
      ],
    });

    if (i < alerts.length - 1) blocks.push(spacerBlock);
  }

  blocks.push(spacerBlock);

  blocks.push({
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "For complete sheet: " },
          { type: "link", url: sheetLink, text: "Link" },
        ],
      },
    ],
  });

  const slackResponse = await axios.post(
    "https://slack.com/api/chat.postMessage",
    {
      channel: process.env.SLACK_CHANNEL_INVENTORY_WARNINGS,
      text: ":rotating_light: Low Sales Velocity Warning",
      blocks,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!slackResponse.data.ok) {
    throw new Error(`Slack API error: ${slackResponse.data.error}`);
  }

  console.log("✅ Slack sales velocity alert sent successfully.");
  return "Sales velocity alert sent to Slack successfully.";
};

const salesVelocityAlertsApiHandler = async (req, res) => {
  try {
    const message = await fetchSalesVelocityAlertsAndNotify();
    res.json({ success: true, message });
  } catch (error) {
    console.error("❌ Error in fetchSalesVelocityAlertsAndNotify:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { fetchSalesVelocityAlertsAndNotify, salesVelocityAlertsApiHandler };
