import assert from "node:assert/strict";
import test from "node:test";
import { validatePasswordStrength } from "../src/auth-password.js";
import { authorizeApiRequest } from "../src/server/authorization.js";

test("password validation rejects empty, common, and numeric-only passwords", () => {
  assert.throws(() => validatePasswordStrength("", { username: "admin" }), /密码不能为空/);
  assert.throws(() => validatePasswordStrength("123456", { username: "admin" }), /至少需要 8 位|过于简单/);
  assert.throws(() => validatePasswordStrength("12345678", { username: "admin" }), /过于简单|只包含数字/);
  assert.throws(() => validatePasswordStrength("87654321", { username: "admin" }), /只包含数字/);
});

test("password validation rejects passwords containing the username", () => {
  assert.throws(() => validatePasswordStrength("adminPass2026", { username: "admin" }), /不能包含登录名/);
});

test("password validation accepts a reasonable password", () => {
  assert.equal(validatePasswordStrength("ShipOrder#2026", { username: "ops" }), true);
});

test("operator cannot mutate people or system configuration", () => {
  const session = { role: "operator" };
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "people"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "shops"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "scheduled-jobs", "run"]).allowed, false);
});

test("manager can maintain rules but cannot mutate admin-only resources", () => {
  const session = { role: "manager" };
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "logistics-rules"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "exchange-rate"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "people"]).allowed, false);
});

test("admin can mutate protected resources", () => {
  const session = { role: "admin" };
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "people"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "PUT", _session: session }, ["api", "shops", "1"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "scheduled-jobs", "state"]).allowed, true);
});
