import {
  serverPrintJobs,
  serverPrintOrderLabels,
  serverPrintPdf,
  serverPrintPrinters
} from "../../services/server-print.js";

export function createPrintRoutes({ services, readJson }) {
  return {
    "GET /api/print/printers": () => serverPrintPrinters(),
    "GET /api/print/jobs": () => serverPrintJobs(),
    "POST /api/print/jobs": async (req) => serverPrintPdf(await readJson(req), req._session?.personId),
    "POST /api/print/order-labels": async (req) => serverPrintOrderLabels(await readJson(req), req._session?.personId, services)
  };
}
