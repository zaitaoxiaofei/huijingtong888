import {
  serverPrintJobs,
  serverPrintOrderLabels,
  serverPrintPdf,
  serverPrintPrinters
} from "../../services/server-print.js";
import { tenantIdFromRequest } from "../tenant-context.js";

export function createPrintRoutes({ services, readJson }) {
  return {
    "GET /api/print/printers": () => serverPrintPrinters(),
    "GET /api/print/jobs": (req) => serverPrintJobs(tenantIdFromRequest(req), { session: req._session, signal: req._abortSignal }),
    "POST /api/print/jobs": async (req) => serverPrintPdf(await readJson(req), req._session?.personId, tenantIdFromRequest(req), { session: req._session, signal: req._abortSignal }),
    "POST /api/print/order-labels": async (req) => serverPrintOrderLabels(await readJson(req), req._session?.personId, services, tenantIdFromRequest(req), { session: req._session, signal: req._abortSignal })
  };
}
