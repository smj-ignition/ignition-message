const puppeteer = require("puppeteer");
const fs        = require("fs");

const LINE_NUMS = [2, 3, 4, 5, 6];
const LINE_COLS = { 2: 2, 3: 5, 4: 8, 5: 11, 6: 14, a: 17 };
const TIME_SLOTS = [
  "7am-8am",  "8am-9am",   "9am-10am",  "10am-11am", "11am-12pm", "12pm-1pm",
  "1pm-2pm",  "2pm-3pm",   "3pm-4pm",   "4pm-5pm",   "5pm-6pm",   "6pm-7pm",
  "7pm-8pm",  "8pm-9pm",   "9pm-10pm",  "10pm-11pm", "11pm-12am", "12am-1am",
  "1am-2am",  "2am-3am",   "3am-4am",   "4am-5am",   "5am-6am",   "6am-7am",
];
const S1_ROWS = Array.from({ length: 12 }, (_, i) => i);
const S2_ROWS = Array.from({ length: 12 }, (_, i) => i + 12);

const RATED = { 2: 700, 3: 1000, 4: 1200, 5: 833, 6: 1125 };
const SKUS  = {
  2: "Fruta 315ml ×24 Fruit Punch",
  3: "Lucozade 360ml ×24 Orange",
  4: "Turbo 370ml ×24 Turbo",
  5: "Caribbean Cool 475ml ×24 Mauby",
  6: "Oasis 330ml ×24 Water",
};

const totalRated = LINE_NUMS.reduce((s, l) => s + RATED[l], 0);
const getRph     = (line) => (line === "a" ? totalRated : RATED[Number(line)] || 0);

const replacements = {};

TIME_SLOTS.forEach((slot) => {
  for (const line of Object.keys(LINE_COLS)) {
    const rph = getRph(line);
    replacements[`\${l-${line}-r-${slot}}`] = rph.toLocaleString("en-TT");
    replacements[`\${l-${line}-a-${slot}}`] = rph.toLocaleString("en-TT");
    replacements[`\${l-${line}-e-${slot}}`] = "100%";
  }
});

for (const line of Object.keys(LINE_COLS)) {
  const rph = getRph(line);
  const s1  = rph * 12;
  const s2  = rph * 12;
  replacements[`\${l-${line}-r-s1}`] = s1.toLocaleString("en-TT");
  replacements[`\${l-${line}-a-s1}`] = s1.toLocaleString("en-TT");
  replacements[`\${l-${line}-e-s1}`] = "100%";
  replacements[`\${l-${line}-r-s2}`] = s2.toLocaleString("en-TT");
  replacements[`\${l-${line}-a-s2}`] = s2.toLocaleString("en-TT");
  replacements[`\${l-${line}-e-s2}`] = "100%";
  replacements[`\${l-${line}-r-d}`]  = (s1 + s2).toLocaleString("en-TT");
  replacements[`\${l-${line}-a-d}`]  = (s1 + s2).toLocaleString("en-TT");
  replacements[`\${l-${line}-e-d}`]  = "100%";
}

for (const line of LINE_NUMS) {
  replacements[`\${line-${line}-sku}`] = SKUS[line];
}

replacements["${currentDate}"] = "Wednesday 2nd January, 2030";

(async () => {
  let html = fs.readFileSync("index.html", "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.replace(placeholder, value);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: 1400, height: 720 },
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => {
    document.getElementById("report-gen-shift-date").textContent = "Wednesday 2nd January, 2030";
    document.getElementById("report-gen-notice").textContent =
      "Generated on 02/01/2030, 07:00:00 am by Ignition & Puppeteer";
  });
  const element = await page.$("body");
  await element.screenshot({ path: "perfect-report.png" });
  await browser.close();
  console.log("Saved → perfect-report.png");
})();
