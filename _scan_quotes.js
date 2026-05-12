const fs = require('fs');
const lines = fs.readFileSync('c:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.js', 'utf8').split('\n');
const leftQuote = '\u201c';
const rightQuote = '\u201d';
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(leftQuote) || lines[i].includes(rightQuote)) {
    console.log((i + 1) + ': ' + lines[i].trim());
  }
}
