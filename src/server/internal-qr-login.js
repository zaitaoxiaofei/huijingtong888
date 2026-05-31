import { randomBytes, randomUUID } from "node:crypto";
import bwipjs from "bwip-js";
import { config } from "../config.js";
import { escapeHtml, parseCookies } from "./access.js";

const QR_TTL_MS = 5 * 60 * 1000;
export const QR_MOBILE_COOKIE_NAME = "erp_qr_mobile";
export const QR_MOBILE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const qrSessions = new Map();
const mobileSessions = new Map();

function now() {
  return Date.now();
}

function pruneExpiredQrSessions() {
  const current = now();
  for (const [sid, item] of qrSessions.entries()) {
    if (item.expiresAt <= current || item.status === "consumed") qrSessions.delete(sid);
  }
  for (const [token, item] of mobileSessions.entries()) {
    if (item.expiresAt <= current) mobileSessions.delete(token);
  }
}

function safeRedirect(input) {
  const value = String(input || "/dashboard").trim() || "/dashboard";
  return value.startsWith("/") ? value.split("?")[0] : "/dashboard";
}

function publicUrl(pathname, params = {}) {
  const url = new URL(pathname, config.appBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function createQrLoginSession(url) {
  pruneExpiredQrSessions();
  const sid = randomUUID();
  const secret = randomBytes(24).toString("hex");
  const redirect = safeRedirect(url.searchParams.get("redirect"));
  const expiresAt = now() + QR_TTL_MS;
  const confirmUrl = publicUrl("/api/auth/qr/confirm-page", { sid, secret });
  qrSessions.set(sid, {
    sid,
    secret,
    redirect,
    confirmUrl,
    status: "pending",
    expiresAt,
    user: null,
    token: ""
  });
  return {
    sid,
    redirect,
    expiresAt: new Date(expiresAt).toISOString(),
    confirmUrl,
    qrImageUrl: `/api/auth/qr/image?sid=${encodeURIComponent(sid)}`
  };
}

function getQrSession(sid) {
  pruneExpiredQrSessions();
  return qrSessions.get(String(sid || ""));
}

export async function renderQrCodePng(sid) {
  const session = getQrSession(sid);
  if (!session) return null;
  return await bwipjs.toBuffer({
    bcid: "qrcode",
    text: session.confirmUrl,
    scale: 6,
    includetext: false,
    backgroundcolor: "FFFFFF"
  });
}

export function consumeConfirmedQrSession(sid) {
  const session = getQrSession(sid);
  if (!session) return { status: "expired" };
  if (session.status !== "confirmed") {
    return {
      status: session.status,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }
  qrSessions.delete(session.sid);
  return {
    status: "confirmed",
    token: session.token,
    user: session.user,
    redirect: session.redirect
  };
}

export function confirmQrLoginSession({ sid, secret, token, user }) {
  const session = getQrSession(sid);
  if (!session) return { ok: false, error: "二维码已过期，请刷新后重试", status: 410 };
  if (session.secret !== String(secret || "")) return { ok: false, error: "二维码无效", status: 403 };
  if (session.status === "confirmed") return { ok: true, redirect: session.redirect };
  session.status = "confirmed";
  session.token = token;
  session.user = user;
  return { ok: true, redirect: session.redirect };
}

export function createQrMobileSession(user) {
  pruneExpiredQrSessions();
  const token = randomBytes(32).toString("hex");
  mobileSessions.set(token, {
    user,
    expiresAt: now() + QR_MOBILE_COOKIE_MAX_AGE_SECONDS * 1000
  });
  return token;
}

export function getQrMobileSession(req) {
  pruneExpiredQrSessions();
  const token = parseCookies(req)[QR_MOBILE_COOKIE_NAME];
  if (!token) return null;
  return mobileSessions.get(token) || null;
}

export function renderQrConfirmPage({ sid, secret, mobileUser = null, error = "" }) {
  const rememberedUser = mobileUser
    ? `<div class="remembered">
        <span>已记住手机账号</span>
        <strong>${escapeHtml(mobileUser.name || mobileUser.username)}</strong>
      </div>`
    : "";
  const passwordFields = mobileUser
    ? ""
    : `<label for="username">登录名</label>
      <div class="field"><input id="username" name="username" autocomplete="username" placeholder="请输入 ERP 登录名" required></div>
      <label for="password">密码</label>
      <div class="field"><input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required></div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>扫码确认登录</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 22px;
      overflow: hidden;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #0f172a;
      background:
        radial-gradient(circle at 18% 18%, rgba(37, 99, 235, .22), transparent 30%),
        radial-gradient(circle at 82% 76%, rgba(239, 68, 68, .16), transparent 32%),
        linear-gradient(135deg, #f7fbff 0%, #ffffff 48%, #eaf4ff 100%);
    }
    .grid {
      position: fixed;
      inset: -80px;
      z-index: 0;
      background:
        linear-gradient(rgba(37, 99, 235, .12) 1px, transparent 1px),
        linear-gradient(90deg, rgba(37, 99, 235, .12) 1px, transparent 1px);
      background-size: 38px 38px;
      mask-image: linear-gradient(to bottom, transparent, #000 16%, #000 82%, transparent);
      opacity: .56;
      transform: perspective(680px) rotateX(58deg) translateY(90px);
    }
    .watermark {
      position: fixed;
      left: 50%;
      top: 45%;
      z-index: 0;
      color: #075eea;
      font-size: clamp(92px, 30vw, 210px);
      font-weight: 950;
      letter-spacing: 0;
      opacity: .07;
      transform: translate(-50%, -50%) rotate(-7deg);
      white-space: nowrap;
      user-select: none;
    }
    main {
      position: relative;
      z-index: 2;
      width: min(420px, 100%);
      padding: 24px;
      border: 1px solid rgba(255, 255, 255, .66);
      border-radius: 24px;
      background: rgba(255, 255, 255, .78);
      box-shadow: 0 24px 70px rgba(15, 23, 42, .18);
      backdrop-filter: blur(18px);
    }
    .brand { display: grid; justify-items: center; gap: 8px; margin-bottom: 20px; }
    .dogzon { color: #075eea; font-size: 38px; font-weight: 950; line-height: .95; }
    .sticker { display: inline-flex; align-items: flex-end; filter: drop-shadow(0 8px 0 rgba(15,23,42,.16)); transform: rotate(-3deg); }
    .sticker span { display: inline-block; font-size: 34px; font-weight: 950; line-height: .95; -webkit-text-stroke: 3px #fff; paint-order: stroke fill; }
    .bao { color: #111827; }
    .dan { color: #ef1f1f; }
    .head { margin-bottom: 20px; text-align: center; }
    .head span { color: #2563eb; font-size: 13px; font-weight: 900; }
    h1 { margin: 7px 0 8px; font-size: 27px; line-height: 1.16; letter-spacing: 0; }
    p { margin: 0; color: #64748b; font-size: 14px; line-height: 1.6; }
    label { display: block; margin: 14px 0 8px; color: #1f2937; font-size: 13px; font-weight: 900; }
    .field {
      height: 48px;
      display: flex;
      align-items: center;
      border-radius: 14px;
      background: rgba(255,255,255,.9);
      box-shadow: 0 0 0 1px rgba(148, 163, 184, .34) inset;
    }
    input {
      width: 100%;
      height: 46px;
      border: 0;
      outline: 0;
      padding: 0 14px;
      background: transparent;
      color: #0f172a;
      font-size: 15px;
    }
    input:focus { box-shadow: none; }
    button {
      width: 100%;
      min-height: 50px;
      margin-top: 18px;
      border: 0;
      border-radius: 16px;
      background: linear-gradient(135deg, #075eea, #2563eb 58%, #ef4444);
      box-shadow: 0 16px 34px rgba(37, 99, 235, .26);
      color: #fff;
      font-size: 15px;
      font-weight: 950;
    }
    button:disabled { opacity: .72; }
    .remembered {
      display: grid;
      gap: 4px;
      margin: 16px 0 2px;
      padding: 14px;
      border: 1px solid rgba(22, 163, 74, .22);
      border-radius: 16px;
      color: #14532d;
      background: rgba(220, 252, 231, .86);
      text-align: center;
    }
    .remembered span { color: #64748b; font-size: 12px; font-weight: 800; }
    .remembered strong { font-size: 18px; }
    .error {
      display: ${error ? "block" : "none"};
      margin-bottom: 12px;
      padding: 11px 12px;
      border: 1px solid #fecaca;
      border-radius: 14px;
      color: #b42318;
      background: rgba(255, 241, 240, .92);
      line-height: 1.45;
    }
    .success {
      display: none;
      margin-top: 14px;
      padding: 13px;
      border-radius: 14px;
      color: #166534;
      background: rgba(220, 252, 231, .92);
      text-align: center;
      font-weight: 800;
    }
    .meta { margin-top: 14px; color: #70819a; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="grid"></div>
  <div class="watermark">狗ZON</div>
  <main>
    <section class="brand" aria-label="狗ZON 爆单单单">
      <div class="dogzon">狗ZON</div>
      <div class="sticker"><span class="bao">爆</span><span class="dan">单</span><span class="dan">单</span><span class="dan">单</span></div>
    </section>
    <section class="head">
      <span>扫码安全确认</span>
      <h1>确认登录爆单系统</h1>
      <p>请确认这是你本人在电脑登录页发起的登录请求。确认后电脑端会自动进入系统。</p>
    </section>
    <div class="error" id="error">${escapeHtml(error)}</div>
    ${rememberedUser}
    <form id="form">
      ${passwordFields}
      <button id="submit" type="submit">确认登录电脑端</button>
    </form>
    <div class="success" id="success">已确认，可以回到电脑继续使用。</div>
    <p class="meta">手机确认状态会保存 30 天，仅用于扫码确认登录。</p>
  </main>
  <script>
    const sid = ${JSON.stringify(String(sid || ""))};
    const secret = ${JSON.stringify(String(secret || ""))};
    const form = document.getElementById("form");
    const errorBox = document.getElementById("error");
    const successBox = document.getElementById("success");
    const submit = document.getElementById("submit");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.style.display = "none";
      submit.disabled = true;
      submit.textContent = "确认中...";
      try {
        const response = await fetch("/api/auth/qr/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sid,
            secret,
            username: form.username ? form.username.value : "",
            password: form.password ? form.password.value : ""
          })
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || "确认失败");
        form.style.display = "none";
        successBox.style.display = "block";
      } catch (error) {
        errorBox.textContent = error.message || "确认失败";
        errorBox.style.display = "block";
        submit.disabled = false;
        submit.textContent = "确认登录电脑端";
      }
    });
  </script>
</body>
</html>`;
}
