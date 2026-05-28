// maximo.js
import puppeteer from "puppeteer";
import dotenv from "dotenv";
dotenv.config({ path: ".env" });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getDRData(site, number) {
  let browser;

  try {
    browser = await puppeteer.launch({
      args: [
        "--disable-features=HttpsFirstBalancedModeAutoEnable",
        "--start-maximized",
      ],
      defaultViewport: null,
      headless: false,
    });

    const page = await browser.newPage();
    const timeout = 10000;
    page.setDefaultTimeout(timeout);
    await page.goto(process.env.MAXIMO_URL);

    // Login
    await page.type('input[id="username"]', process.env.MAXIMO_USERNAME, {
      delay: 10,
    });
    await page.type('input[id="password"]', process.env.MAXIMO_PASSWORD, {
      delay: 10,
    });

    await Promise.all([
      page.waitForNavigation(),
      page.click('button[id="loginbutton"]'),
    ]);

    // Navigate to DR module
    let selector =
      "#m7f8f3e49_ns_menu_SSDR_MODULE_sub_changeapp_VIEWDRALL_a_tnode";
    await page.waitForSelector(selector, { timeout });
    await page.evaluate((sel) => document.querySelector(sel).click(), selector);

    // DR Number Submission
    let id = "mb68266fb-tb";
    selector = `#${id}`;
    await page.waitForSelector(selector, { timeout, visible: true });
    await delay(1000);
    await page.click(selector);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type(selector, number, { delay: 50 });

    // DR Site Submission
    id = "ma6cefb60-tb";
    selector = `#${id}`;
    await page.waitForSelector(selector, { timeout, visible: true });

    await page.click(selector);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type(selector, "=" + site, { delay: 50 });

    await delay(300);
    await page.keyboard.press("Enter");

    // Wait for results
    const drNumber = `${site}${number}`;

    await page.waitForFunction(
      (dr) => document.body.textContent.includes(dr),
      { timeout: 10000 },
      drNumber
    );

    await page.waitForFunction(
      (dr) => {
        const element = document.querySelector(
          "#m6a7dfd2f_tdrow_\\[C\\:0\\]_ttxt-lb\\[R\\:0\\]"
        );
        return element && element.textContent.includes(dr);
      },
      { timeout: 30000 },
      drNumber
    );

    // Extract row data
    const rowData = await page.evaluate(() => {
      const row = document.querySelector("#m6a7dfd2f_tbod_tdrow-tr\\[R\\:0\\]");
      if (!row) return null;

      const cells = Array.from(row.querySelectorAll("td"));

      return {
        reference: cells[1]?.textContent.trim() || "",
        description: cells[2]?.textContent.trim() || "",
        date: cells[3]?.textContent.trim() || "",
        status: cells[4]?.textContent.trim() || "",
        createdBy: cells[5]?.textContent.trim() || "",
        modifiedBy: cells[6]?.textContent.trim() || "",
        amount: cells[7]?.textContent.trim() || "",
        currency: cells[8]?.textContent.trim() || "",
      };
    });

    if (!rowData) {
      throw new Error("No data found for the given DR number and site.");
    }

    await page.evaluate(() => {
      const element = document.querySelector(
        "span#m6a7dfd2f_tdrow_\\[C\\:0\\]_ttxt-lb\\[R\\:0\\]"
      ); // Get the actual DOM element

      if (element) {
        // Always check if the element was found
        const dispatchMouseEvent = (eventType, el) => {
          const event = new MouseEvent(eventType, {
            view: window,
            bubbles: true,
            cancelable: true,
            isTrusted: false,
          });
          el.dispatchEvent(event);
        };

        dispatchMouseEvent("mousedown", element);
        dispatchMouseEvent("mouseup", element);
        dispatchMouseEvent("click", element);
      }
    });

    const historyTabSelector = "#m27ba704b-tab_anchor";

    await page.waitForSelector(historyTabSelector, { timeout, visible: true });

    await page.evaluate((historyTabSelector) => {
      document.querySelector(historyTabSelector).click();
    }, historyTabSelector);

    const wfMapBtnSelector = "#mcd982496-pb";
    await page.waitForSelector(wfMapBtnSelector, { timeout, visible: true });

    await page.evaluate((wfMapBtnSelector) => {
      document.querySelector(wfMapBtnSelector).click();
    }, wfMapBtnSelector);

    const wfAssignmentButtonSelector = "#m10f7ab9-pb";
    await page.waitForSelector(wfAssignmentButtonSelector, {
      timeout,
      visible: true,
    });
    await page.evaluate((wfAssignmentButtonSelector) => {
      document.querySelector(wfAssignmentButtonSelector).click();
    }, wfAssignmentButtonSelector);
    
    const wfAssignmentTable = "#mfffd2948_tbod-tbd";
    await page.waitForSelector(wfAssignmentTable, {
      timeout,
      visible: true,
    });
    
    const assignmentData = await page.evaluate(() => {
      const table = document.querySelector("#mfffd2948_tbod-tbd");
      const dataRows = table.querySelectorAll("tr.tablerow");

      const data = Array.from(dataRows).map((row) => {
        const cells = row.querySelectorAll("td.cd");
        return {
          name: cells[1]?.textContent?.trim(), // Column 1 = Name
          description: cells[2]?.textContent?.trim(), // Column 2 = Description
        };
      });

   return data
    });

    return { ...rowData, assignments: assignmentData };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/* getDRData("BOT", "4900")
  .then((data) => console.log(data))
  .catch((err) => console.error(err)); */
