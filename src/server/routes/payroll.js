import {
  calculatePayrollPeriod,
  payrollPeriod,
  payrollSetup,
  saveContributionScheme,
  savePayrollPolicy,
  savePayrollProfile,
  updatePayrollPeriodStatus
} from "../../services/payroll.js";

export function createPayrollRoutes({ readJson }) {
  return {
    "GET /api/payroll/setup": () => payrollSetup(),
    "GET /api/payroll/period": (req, url) => payrollPeriod(Object.fromEntries(url.searchParams.entries())),
    "POST /api/payroll/contribution-schemes": async (req) => saveContributionScheme(await readJson(req)),
    "POST /api/payroll/policies": async (req) => savePayrollPolicy(await readJson(req)),
    "POST /api/payroll/profiles": async (req) => savePayrollProfile(await readJson(req)),
    "POST /api/payroll/calculate": async (req) => calculatePayrollPeriod(await readJson(req), req._session?.personId),
    "POST /api/payroll/period-status": async (req) => updatePayrollPeriodStatus(await readJson(req), req._session?.personId)
  };
}
