import fs from 'fs';
import puppeteer from "puppeteer";
const html = fs.readFileSync('index.html', 'utf8'); // your HTML file

const browser = await puppeteer.launch({
headless: 'new', // modern headless mode
defaultViewport: { width: 1280 , height: 720  },
});

const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });

const element = await page.$('body'); // or any specific element
await element.screenshot({ path: 'report.png' });

await browser.close();