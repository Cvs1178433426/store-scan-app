import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

export type StoreCountExportEntry = {
  barcodeValue: string;
  quantity: number;
  scannedAt: Date;
  updatedAt: Date;
  location: { code: string; name: string | null };
  product: { name: string; manufacturer: string | null; packageSize: string | null } | null;
};

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Spreadsheet applications may evaluate cells beginning with these characters
  // as formulas even when the CSV field itself is quoted. Prefix untrusted text
  // so exported inventory data remains inert when opened in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildStoreCountCsv(input: {
  session: {
    id: string;
    name: string | null;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    startedBy: { id: string; name: string; email: string } | null;
    site: { id: string; code: string; name: string } | null;
  };
  entries: StoreCountExportEntry[];
}): string {
  const headers = [
    "session_id",
    "session_name",
    "session_status",
    "site_code",
    "site_name",
    "counter_name",
    "counter_email",
    "upc",
    "description",
    "manufacturer",
    "package_size",
    "location_code",
    "location_name",
    "quantity",
    "scanned_at",
    "updated_at",
    "session_started_at",
    "session_completed_at",
    "exception",
  ];

  const rows = input.entries.map((entry) => [
    input.session.id,
    input.session.name ?? "",
    input.session.status,
    input.session.site?.code ?? "",
    input.session.site?.name ?? "",
    input.session.startedBy?.name ?? "",
    input.session.startedBy?.email ?? "",
    entry.barcodeValue,
    entry.product?.name ?? "",
    entry.product?.manufacturer ?? "",
    entry.product?.packageSize ?? "",
    entry.location.code,
    entry.location.name ?? "",
    entry.quantity,
    entry.scannedAt.toISOString(),
    entry.updatedAt.toISOString(),
    input.session.startedAt.toISOString(),
    input.session.completedAt?.toISOString() ?? "",
    entry.product ? "" : "UNKNOWN_UPC",
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export async function storeCountExportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/sessions/:id/export.csv", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: {
        startedBy: { select: { id: true, name: true, email: true } },
        site: { select: { id: true, code: true, name: true } },
        entries: {
          orderBy: [{ locationId: "asc" }, { barcodeValue: "asc" }],
          include: {
            location: { select: { code: true, name: true } },
            product: { select: { name: true, manufacturer: true, packageSize: true } },
          },
        },
      },
    });

    if (!session) return reply.code(404).send({ error: "count session not found" });
    if (session.startedById !== userId && role !== "ADMIN") {
      return reply.code(403).send({ error: "you do not have access to this count session" });
    }

    const csv = buildStoreCountCsv({ session, entries: session.entries });
    const safeName = (session.name || `count-${session.id}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${safeName}.csv"`)
      .send(csv);
  });
}
