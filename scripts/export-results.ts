import * as fs from "fs";
import * as path from "path";
import * as ExcelJS from "exceljs";

const OUTPUT_DIR = path.resolve(__dirname, "../output");
const PLAN_FILE = path.join(OUTPUT_DIR, "distribution-plan.json");
const EXCEL_FILE = path.join(OUTPUT_DIR, "distribution-log.xlsx");

interface DistributionEntry {
  index: number;
  address: string;
  amount: number;
  amountWei: string;
  packedHex: string;
  sent: boolean;
  txHash: string | null;
  timestamp: string | null;
}

async function exportToExcel(): Promise<void> {
  if (!fs.existsSync(PLAN_FILE)) {
    console.error(`Error: ${PLAN_FILE} not found.`);
    console.error("Run distribution first to generate the plan file.");
    process.exit(1);
  }

  console.log("Reading distribution plan...");
  const plan: DistributionEntry[] = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
  const sent = plan.filter((e) => e.sent);
  
  if (sent.length === 0) {
    console.error("No sent entries found. Run distribution first.");
    process.exit(1);
  }

  console.log(`Found ${sent.length.toLocaleString()} sent entries. Creating Excel file...`);

  // Create workbook and worksheet
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Token Distribution Log");

  // Define columns
  worksheet.columns = [
    { header: "Index", key: "index", width: 10 },
    { header: "Address", key: "address", width: 45 },
    { header: "Amount (tokens)", key: "amount", width: 15 },
    { header: "Amount (Wei)", key: "amountWei", width: 25 },
    { header: "TX Hash", key: "txHash", width: 70 },
    { header: "Timestamp", key: "timestamp", width: 25 },
  ];

  // Style the header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4472C4" }
  };
  worksheet.getRow(1).font = { color: { argb: "FFFFFFFF" }, bold: true };

  // Add data rows
  for (const entry of sent) {
    worksheet.addRow({
      index: entry.index,
      address: entry.address,
      amount: entry.amount,
      amountWei: entry.amountWei,
      txHash: entry.txHash || "",
      timestamp: entry.timestamp || "",
    });
  }

  // Add summary at the bottom
  const summaryRow = worksheet.rowCount + 2;
  worksheet.getCell(summaryRow, 1).value = "SUMMARY";
  worksheet.getCell(summaryRow, 1).font = { bold: true };
  
  worksheet.getCell(summaryRow + 1, 1).value = "Total Wallets:";
  worksheet.getCell(summaryRow + 1, 2).value = sent.length;
  
  const totalTokens = sent.reduce((sum, e) => sum + e.amount, 0);
  worksheet.getCell(summaryRow + 2, 1).value = "Total Tokens Sent:";
  worksheet.getCell(summaryRow + 2, 2).value = `${totalTokens.toLocaleString()} tokens`;
  
  const uniqueTxHashes = new Set(sent.map(e => e.txHash).filter(Boolean)).size;
  worksheet.getCell(summaryRow + 3, 1).value = "Unique Transactions:";
  worksheet.getCell(summaryRow + 3, 2).value = uniqueTxHashes;

  // Auto-fit columns
  worksheet.columns.forEach((column) => {
    if (column.key === "address" || column.key === "txHash") {
      return; // Keep fixed width for these
    }
    let maxLength = 0;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const columnLength = cell.value ? cell.value.toString().length : 10;
      if (columnLength > maxLength) {
        maxLength = columnLength;
      }
    });
    column.width = Math.max(maxLength + 2, 10);
  });

  // Save the file
  await workbook.xlsx.writeFile(EXCEL_FILE);
  
  console.log(`✅ Excel file created: ${EXCEL_FILE}`);
  console.log(`📊 Exported ${sent.length.toLocaleString()} entries with ${uniqueTxHashes} unique transactions`);
}

exportToExcel().catch((err: unknown) => {
  console.error("Export failed:", err);
  process.exit(1);
});