export type StarterTask = {
  jobTitle: "STORE_MANAGER" | "INVENTORY_MANAGER" | "STOCK_COUNT_ASSOCIATE" | "RECEIVER" | "CASHIER_CUSTOMER_SERVICE" | "PHARMACY_TEAM";
  title: string;
  recurrence: "DAILY" | "WEEKLY" | "MONTHLY";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
};

function roleTasks(jobTitle: StarterTask["jobTitle"], recurrence: StarterTask["recurrence"], titles: string[], priority: StarterTask["priority"] = "NORMAL"): StarterTask[] {
  return titles.map((title) => ({ jobTitle, recurrence, title, priority }));
}

export const STARTER_TASK_CATALOG: StarterTask[] = [
  ...roleTasks("STORE_MANAGER", "DAILY", [
    "Opening store readiness and safety walk",
    "Review staffing, call-outs, and shift coverage",
    "Review overdue and high-priority work",
    "Review receiving, inventory, and count exceptions",
    "Verify cash-office and register exception follow-up",
    "Closing recovery, security, and handoff review",
  ], "HIGH"),
  ...roleTasks("STORE_MANAGER", "WEEKLY", [
    "Review department completion and overdue trends",
    "Review shrink, damage, returns, and inventory adjustments",
    "Review upcoming deliveries, promotions, and staffing",
    "Conduct employee coaching and follow-up",
    "Review facility and maintenance issues",
  ]),
  ...roleTasks("STORE_MANAGER", "MONTHLY", [
    "Review inventory accuracy and shrink results",
    "Review recurring task templates and compliance",
    "Complete safety and compliance review",
    "Review employee access and job-title assignments",
    "Review site performance summary",
  ], "HIGH"),

  ...roleTasks("INVENTORY_MANAGER", "DAILY", [
    "Review open Store Scan assignments and exceptions",
    "Check unidentified UPCs and product or location errors",
    "Review negative, zero, and unusual on-hand exceptions",
    "Coordinate recounts and inventory adjustments",
    "Confirm completed counts are reviewed and exported",
  ], "HIGH"),
  ...roleTasks("INVENTORY_MANAGER", "WEEKLY", [
    "Cycle-count priority departments or locations",
    "Review high-variance products",
    "Review inactive or duplicate products and locations",
    "Review damage, returns, and adjustment activity",
    "Validate upcoming count schedule",
  ]),
  ...roleTasks("INVENTORY_MANAGER", "MONTHLY", [
    "Inventory accuracy and variance report",
    "Product-catalog quality review",
    "Location-directory audit",
    "Count completion and compliance review",
  ]),

  ...roleTasks("STOCK_COUNT_ASSOCIATE", "DAILY", [
    "Review assigned aisles and locations",
    "Complete assigned Store Scan",
    "Report unidentified products and damaged merchandise",
    "Correct obvious shelf and location organization problems",
    "Confirm assigned work before shift end",
  ], "HIGH"),
  ...roleTasks("STOCK_COUNT_ASSOCIATE", "WEEKLY", [
    "Deep count assigned rotating section",
    "Check shelf labels and location codes",
    "Review unresolved exceptions from prior counts",
    "Inspect overstock and reserve locations",
  ]),
  ...roleTasks("STOCK_COUNT_ASSOCIATE", "MONTHLY", [
    "Participate in scheduled full-category count",
    "Review scanner and device condition and supplies",
    "Confirm assigned location map remains accurate",
  ]),

  ...roleTasks("RECEIVER", "DAILY", [
    "Review expected deliveries",
    "Inspect receiving area and equipment",
    "Verify shipment count and visible damage",
    "Record shortages, overages, and refused or damaged cases",
    "Confirm received merchandise is staged or transferred correctly",
    "Close receiving paperwork and unresolved exceptions",
  ], "HIGH"),
  ...roleTasks("RECEIVER", "WEEKLY", [
    "Review open receiving discrepancies",
    "Review return-to-vendor merchandise",
    "Inspect receiving-area organization and safety",
    "Reconcile delivery documents with recorded receipts",
  ]),
  ...roleTasks("RECEIVER", "MONTHLY", [
    "Receiving accuracy review",
    "Vendor and carrier discrepancy summary",
    "Receiving equipment and safety inspection",
    "Review receiving task templates and procedures",
  ]),

  ...roleTasks("CASHIER_CUSTOMER_SERVICE", "DAILY", [
    "Opening register and workstation readiness",
    "Verify supplies, bags, receipt paper, and customer-service materials",
    "Complete assigned front-end recovery and cleanliness checks",
    "Report pricing, product, or register exceptions",
    "Complete closing register and workstation handoff",
  ]),
  ...roleTasks("CASHIER_CUSTOMER_SERVICE", "WEEKLY", [
    "Review recurring customer-service issues",
    "Inspect front-end supplies and reorder needs",
    "Complete assigned front-end product and location count",
    "Review return and damage handling reminders",
  ]),
  ...roleTasks("CASHIER_CUSTOMER_SERVICE", "MONTHLY", [
    "Customer-service and front-end readiness review",
    "Register-area safety and compliance check",
    "Review recurring supply and inventory exceptions",
  ]),

  ...roleTasks("PHARMACY_TEAM", "DAILY", [
    "Opening pharmacy workstation and supply readiness",
    "Review assigned non-patient inventory work",
    "Check designated expiration and return areas",
    "Review receiving and put-away exceptions",
    "Complete assigned pharmacy inventory count",
    "Closing organization and unresolved-work handoff",
  ], "HIGH"),
  ...roleTasks("PHARMACY_TEAM", "WEEKLY", [
    "Cycle count assigned pharmacy inventory section",
    "Review quarantined, damaged, and return-to-vendor inventory",
    "Check packaging, shipping, and general supplies",
    "Review unresolved product and location exceptions",
  ]),
  ...roleTasks("PHARMACY_TEAM", "MONTHLY", [
    "Complete assigned expiration-date audit",
    "Review pharmacy inventory variance trends",
    "Validate pharmacy storage-location directory",
    "Review non-patient inventory task completion",
  ]),
];
