import {
  calculatePayrollPeriod,
  payrollPeriod,
  payrollSetup,
  saveContributionScheme,
  savePayrollPolicy,
  savePayrollProfile,
  updatePayrollPeriodStatus
} from "../../services/payroll.js";
import { isPlatformAdmin } from "../../shared/permissions.js";
import { tenantIdFromRequest } from "../tenant-context.js";

const payrollReadScope = req => isPlatformAdmin(req?._session) ? null : tenantIdFromRequest(req);

export function createPayrollRoutes({ readJson }) {
  return {
    "GET /api/payroll/setup": (req) => payrollSetup(payrollReadScope(req)),
    "GET /api/payroll/period": (req, url) => payrollPeriod(Object.fromEntries(url.searchParams.entries()), payrollReadScope(req)),
    "POST /api/payroll/contribution-schemes": async (req) => saveContributionScheme(await readJson(req)),
    "POST /api/payroll/policies": async (req) => savePayrollPolicy(await readJson(req)),
    "POST /api/payroll/profiles": async (req) => savePayrollProfile(await readJson(req)),
    "POST /api/payroll/calculate": async (req) => calculatePayrollPeriod(await readJson(req), req._session?.personId),
    "POST /api/payroll/period-status": async (req) => updatePayrollPeriodStatus(await readJson(req), req._session?.personId)
  };
}
