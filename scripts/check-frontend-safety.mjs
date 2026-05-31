import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const warnings = [];

function readText(file) {
  return readFileSync(join(root, file), "utf8");
}

function addFailure(file, line, message) {
  failures.push(`${file}:${line} ${message}`);
}

function lineOf(text, index) {
  return text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function walk(dir, visitor) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git", ".work-backups"].includes(entry.name)) continue;
      walk(fullPath, visitor);
      continue;
    }
    visitor(fullPath);
  }
}

function checkTextPatterns(file, text, patterns, report = addFailure) {
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      report(file, lineOf(text, match.index || 0), pattern.message);
    }
  }
}

function checkAdminShell() {
  const files = [
    "scripts/generate-admin-shell.mjs",
    "public/admin.html"
  ].filter((file) => existsSync(join(root, file)));

  const badTextPatterns = [
    { regex: /[閻ч悥鐠囩槕閸歖]/g, message: "possible mojibake text in admin shell" },
    { regex: /<span>[^<\n]*\?\/span>/g, message: "broken span closing tag" },
    { regex: /placeholder="[^"\n]*(?:\n|$)/g, message: "possibly unterminated placeholder attribute" },
    { regex: /startsWith\(["']#\/login["']\)/g, message: "fallback must not cover the normal Vue login route" }
  ];

  for (const file of files) {
    const text = readText(file);
    checkTextPatterns(file, text, badTextPatterns);
  }

  if (existsSync(join(root, "public/admin.html"))) {
    const html = readText("public/admin.html");
    if (!html.includes('<div id="adminApp"></div>')) {
      addFailure("public/admin.html", 1, "missing stable #adminApp mount element");
    }
    if (!/type="module"\s+src="\/vue-apps\/assets\/admin-view-[^"]+\.js\?v=[^"]+"/.test(html)) {
      addFailure("public/admin.html", 1, "missing versioned admin-view module script");
    }
    if (html.includes("adminStaticLoginForm") || html.includes("/api/auth/login")) {
      addFailure("public/admin.html", 1, "admin shell must not include a second static login form");
    }
    if (!html.includes("admin-static-login-spinner")) {
      addFailure("public/admin.html", 1, "admin shell should show only loading/error fallback UI");
    }
  }
}

function extractTemplateBlocks(text) {
  const blocks = [];
  const regex = /<template\b[^>]*>([\s\S]*?)<\/template>/gi;
  for (const match of text.matchAll(regex)) {
    blocks.push({ start: match.index || 0, content: match[1] || "" });
  }
  return blocks;
}

function checkVueTemplates() {
  const vueRoots = ["frontend/admin", "frontend/orders"].filter((dir) => existsSync(join(root, dir)));
  const riskyTemplatePatterns = [
    {
      regex: /<dl\b[\s\S]*?<button\b[\s\S]*?<\/dl>/gi,
      message: "avoid placing button directly inside dl; browser may rewrite DOM before Vue hydrates"
    },
    {
      regex: /<button\b[\s\S]*?<(?:dl|dt|dd)\b[\s\S]*?<\/button>/gi,
      message: "avoid dl/dt/dd inside button; this can corrupt Vue patch anchors"
    },
    {
      regex: /<table\b[\s\S]*?<button\b[\s\S]*?<\/table>/gi,
      message: "check button placement inside table; invalid table children are browser-reparented"
    }
  ];

  for (const dir of vueRoots) {
    walk(join(root, dir), (fullPath) => {
      if (!fullPath.endsWith(".vue")) return;
      const file = relative(root, fullPath).replaceAll("\\", "/");
      const text = readFileSync(fullPath, "utf8");
      for (const block of extractTemplateBlocks(text)) {
        for (const pattern of riskyTemplatePatterns) {
          for (const match of block.content.matchAll(pattern.regex)) {
            addFailure(file, lineOf(text, block.start + (match.index || 0)), pattern.message);
          }
        }
      }

      const textPatterns = [
        { regex: /<span>[^<\n]*\?\/span>/g, message: "broken span closing tag in Vue source" },
        { regex: /placeholder="[^"\n]*(?:\n|$)/g, message: "possibly unterminated placeholder attribute in Vue source" }
      ];
      if (file.endsWith("/LoginView.vue")) {
        textPatterns.push({ regex: /[閻ч悥鐠囩槕閸歖]/g, message: "possible mojibake text in Vue source" });
      }
      checkTextPatterns(file, text, textPatterns);
    });
  }
}

checkAdminShell();
checkVueTemplates();

for (const warning of warnings.slice(0, 30)) {
  console.warn(`[frontend-safety] warning ${warning}`);
}
if (warnings.length > 30) {
  console.warn(`[frontend-safety] ${warnings.length - 30} more warnings omitted.`);
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`[frontend-safety] ${failure}`);
  }
  console.error(`[frontend-safety] Found ${failures.length} blocking issue(s).`);
  process.exitCode = 1;
} else {
  console.log("[frontend-safety] Admin shell and risky Vue template checks passed.");
}
