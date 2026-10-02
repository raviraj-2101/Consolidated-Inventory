const { google } = require("googleapis");
const auth = require("../config/googleAuth");
const axios = require("axios");

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Amazon_Warnings";

// Column indices (0-based): B=1, C=2, G=6, K=10, L=11, M=12
const COL = {
  SKU: 1,
  ASIN: 2,
  MAX_VELOCITY: 6,
  AMZ_ON_HAND_DAYS: 10,
  IN_TRANSIT_DAYS: 11,
  TOTAL_AMAZON_DAYS: 12,
};

const fetchAmazonWarningsAndNotify = async () => {
  try {
    console.log("📋 Fetching Amazon Warnings data...");

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:M`,
    });

    const rows = response.data.values || [];
    // Skip 4 header rows (rows 1-4), data starts from row 5
    const dataRows = rows.slice(4).filter((row) => row[COL.SKU]);

    if (!dataRows.length) {
      console.log("No warning rows found in Amazon_Warnings sheet.");
      return;
    }

    const sheetLink = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

    // Build Slack Block Kit message with native bullet lists
    const blocks = [
      // Header
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "emoji", name: "rotating_light" },
              { type: "text", text: " Low Stock Warning: - " },
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

    // Spacer after header
    blocks.push(spacerBlock);

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const sku = row[COL.SKU] || "-";
      const asin = row[COL.ASIN] || "-";
      const maxVelocity = row[COL.MAX_VELOCITY] || "-";
      const amzOnHand = row[COL.AMZ_ON_HAND_DAYS] || "-";
      const inTransit = row[COL.IN_TRANSIT_DAYS] || "-";
      const totalAmazon = row[COL.TOTAL_AMAZON_DAYS] || "-";

      blocks.push({
        type: "rich_text",
        elements: [
          // SKU — top-level bullet
          {
            type: "rich_text_list",
            style: "bullet",
            indent: 0,
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: `SKU: ${sku}` }],
              },
            ],
          },
          // Sub-fields — indented bullets
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
                elements: [{ type: "text", text: `Max Velocity: ${maxVelocity}` }],
              },
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: `AMZ On Hand Days: ${amzOnHand}` }],
              },
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: `In Transit Days: ${inTransit}` }],
              },
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: `Total Amazon Days: ${totalAmazon}` }],
              },
            ],
          },
        ],
      });

      // Add spacer between SKU blocks (not after the last one)
      if (i < dataRows.length - 1) {
        blocks.push(spacerBlock);
      }
    }

    // Spacer before footer
    blocks.push(spacerBlock);

    // Footer link
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
        text: ":rotating_light: Low Stock Warning",
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
      console.error("❌ Slack API error:", slackResponse.data.error);
    } else {
      console.log("✅ Slack message sent successfully.");
    }
  } catch (error) {
    console.error("❌ Error in fetchAmazonWarningsAndNotify:", error.message);
  }
};

module.exports = { fetchAmazonWarningsAndNotify };
