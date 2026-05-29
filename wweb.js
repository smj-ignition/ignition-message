import pkg from "whatsapp-web.js";
const { Client, MessageMedia, LocalAuth } = pkg;
import fs from "fs";
import puppeteer from "puppeteer";
import { Pool } from "pg";
import qrcode from "qrcode-terminal";
import Fuse from "fuse.js";
import { connectDB, getDRData, getDRByPO, formatDesktopRequisition, VALID_SITES } from './maximo-ssms.js';

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
  },
});

const pool = new Pool({
  host: process.env.POSTGRESQL_HOST,
  port: process.env.POSTGRESQL_PORT || 5432,
  database: process.env.POSTGRESQL_NAME,
  user: process.env.POSTGRESQL_USERNAME,
  password: process.env.POSTGRESQL_PASSWORD,
});

// Separate Ignition DB connection — backs the hourly report_data table. The server
// rejects SSL, so no ssl option. Host must be whitelisted in the server's pg_hba.conf.
const ignitionPool = new Pool({
  connectionString: process.env.POSTGRESQL_DATABASE_IGNITION_URL,
});

const TABLE = process.env.POSTGRESQL_TABLE_NAME;

const MAINTAINX_API_KEY = process.env.MAINTAINX_API_KEY;
const MAINTAINX_BASE    = 'https://api.getmaintainx.com/v1';

async function lookupMaintainXUserByWaId(waId) {
  if (!waId) { console.log('[MX assignee] waId is null/undefined, skipping lookup'); return null; }

  console.log('[MX assignee] looking up waId:', waId);

  const { rows: contactRows } = await pool.query(
    `SELECT id_serialized, name, pushname FROM whatsapp_contacts WHERE id_serialized = $1 LIMIT 1`,
    [waId]
  );
  if (!contactRows.length) {
    console.log('[MX assignee] no whatsapp_contacts row found for waId:', waId);
    return null;
  }
  const contact = contactRows[0];
  console.log('[MX assignee] contact found:', { name: contact.name, pushname: contact.pushname });

  const { rows } = await pool.query(
    `SELECT m.id, m.first_name, m.last_name
     FROM whatsapp_contacts w
     JOIN maintainx_user_data m
       ON LOWER(m.first_name || ' ' || m.last_name) = LOWER(w.name)
       OR LOWER(m.first_name || ' ' || m.last_name) = LOWER(w.pushname)
       OR (
         LOWER(m.first_name) = LOWER(SPLIT_PART(w.name, ' ', 1))
         AND LOWER(m.last_name) = LOWER(SPLIT_PART(w.name, ' ', 2))
         AND SPLIT_PART(w.name, ' ', 2) != ''
       )
       OR (
         LOWER(m.first_name) = LOWER(SPLIT_PART(w.pushname, ' ', 1))
         AND LOWER(m.last_name) = LOWER(SPLIT_PART(w.pushname, ' ', 2))
         AND SPLIT_PART(w.pushname, ' ', 2) != ''
       )
     WHERE w.id_serialized = $1
     LIMIT 1`,
    [waId]
  );

  if (!rows.length) {
    console.log('[MX assignee] no maintainx_user_data match for contact name:', contact.name, '/ pushname:', contact.pushname);
    return null;
  }

  console.log('[MX assignee] matched MaintainX user:', { id: rows[0].id, firstName: rows[0].first_name, lastName: rows[0].last_name });
  return rows[0].id;
}

async function getMaintainXWorkOrderSequentialId(globalId) {
  const res = await fetch(`${MAINTAINX_BASE}/workorders/${globalId}`, {
    headers: { 'Authorization': `Bearer ${MAINTAINX_API_KEY}` },
  });
  if (!res.ok) throw new Error(`MaintainX GET WO error ${res.status}`);
  const data = await res.json();
  console.log(data);
  console.log(data.workOrder.sequentialId)
  return data.workOrder.sequentialId ?? data.workOrder.sequentialId ?? null;
}

async function updateMaintainXWorkOrderStatus(globalId, status) {
  const res = await fetch(`${MAINTAINX_BASE}/workorders/${globalId}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${MAINTAINX_API_KEY}`,
    },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MaintainX PATCH status error ${res.status}: ${text}`);
  }
}

async function createMaintainXWorkOrder({ title, description, assetId, assigneeId, today, dueDate }) {
  const body = {
    title,
    description,
    priority: 'HIGH',
    dueDate:   dueDate ?? today,
    startDate: today,
  };
  if (assetId)    body.assetId   = assetId;
  if (assigneeId) body.assignees = [{ type: 'USER', id: assigneeId }];

  const res = await fetch(`${MAINTAINX_BASE}/workorders`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${MAINTAINX_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MaintainX API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id ?? data.globalId ?? null;
}

const VALID_LINES = new Set([1, 2, 3, 4, 5, 6, 8]);

// Exact-match aliases — when a user's asset term matches a key (case-insensitive),
// substitute the value as the search term instead.
const ASSET_SEARCH_OVERRIDES = new Map([
  ['khs', 'L4 KHS InnoPET Blowmax'],
]);

// Maps WhatsApp message ID -> event_id for pending (no stop time yet) events
const pendingEvents = new Map();

// Asset list and Fuse.js index — populated on client ready
let allAssets = [];
let assetFuse = null;

import Fastify from "fastify";
const fastify = Fastify({
  logger: true,

});

const ignitionPuppeteerGroupId = "120363402798559455@g.us";
const ignitionGroup            = "120363406811510202@g.us";
const groupToSendReportTo      = ignitionGroup;

// ─────────────────────────────────────────────────────────────────────────────
// EPICOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEpicorPO(poNumber) {
  const baseUrl       = process.env.EPICOR_BASE_URL;
  const apiKey        = process.env.EPICOR_API_KEY;
  const authorization = process.env.EPICOR_AUTHORIZATION;
  const callSettings  = process.env.EPICOR_CALL_SETTINGS;

  const url = `${baseUrl}?$filter=POHeader_PONum eq ${poNumber}`;

  const response = await fetch(url, {
    headers: {
      "Accept":        "application/json",
      "X-API-Key":     apiKey,
      "Authorization": authorization,
      "CallSettings":  callSettings,
      "Content-Type":  "application/json",
    },
  });

  if (!response.ok) throw new Error(`Epicor API responded with ${response.status}`);

  const json = await response.json();
  return json.value?.[0] ?? null;
}

async function fetchEpicorJob(resourceGrpId) {
  const url =
    `https://centralusdtapp35.epicorsaas.com/saas853/api/v2/odata/SMJ-02/BaqSvc/QMSJobs/Data` +
    `?$filter=JobOpDtl_ResourceGrpID eq '${resourceGrpId}' and LaborDtl_ActiveTrans eq true`;

  const response = await fetch(url, {
    headers: {
      "Accept":        "application/json",
      "X-API-Key":     process.env.EPICOR_API_KEY,
      "Authorization": process.env.EPICOR_AUTHORIZATION,
      "CallSettings":  process.env.EPICOR_CALL_SETTINGS,
    },
  });

  if (!response.ok) throw new Error(`Epicor Jobs API responded with ${response.status}`);
  const json = await response.json();
  return json.value?.[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERLAP-BASED "RATED CASES PER HOUR" (validated against real Epicor BAQ dump —
// see handoff-rated-overlap-VALIDATED.md). Pulls a window of FILPAK labor rows per
// line and computes rated by precedence over the hour's interval boundaries, so a
// partial/CIP-split hour scores its scheduled run time instead of a flat rate.
// ─────────────────────────────────────────────────────────────────────────────

// Windowed pull mirroring fetchEpicorJob: same proven base URL + headers, drop the
// ActiveTrans filter, add a 36h lookback. Returns ALL FILPAK rows in the window.
async function fetchEpicorLaborWindow(resourceGrpId) {
  // 36h covers overnight spillover (a row clocked in yesterday evening, out after
  // midnight). Correctness does NOT depend on this bound — the overlap math zeroes
  // out rows outside the target hour — so if the date clause ever errors on the BAQ
  // it is safe to drop.
  const sinceIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

  const url =
    `https://centralusdtapp35.epicorsaas.com/saas853/api/v2/odata/SMJ-02/BaqSvc/QMSJobs/Data` +
    `?$filter=JobOpDtl_ResourceGrpID eq '${resourceGrpId}'` +
    ` and LaborDtl_ClockInDate ge ${sinceIso}`;

  const response = await fetch(url, {
    headers: {
      "Accept":        "application/json",
      "X-API-Key":     process.env.EPICOR_API_KEY,
      "Authorization": process.env.EPICOR_AUTHORIZATION,
      "CallSettings":  process.env.EPICOR_CALL_SETTINGS,
    },
  });

  if (!response.ok) throw new Error(`Epicor Jobs API responded with ${response.status}`);
  const json = await response.json();
  return json.value ?? [];
}

// ── Plant-local "now" as a naive timeline (treat AST wall-clock as if it were UTC) ──
// The Epicor decimal ClockinTime/ClockOutTime are plant-local AST hour-of-day (shift
// boundaries cluster on 7/17/19), so we ignore the -05:00 stamp and line these up
// against Ignition's plant-local hourly buckets.
function plantLocalParts(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port_of_Spain",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return { y: +p.year, m: +p.month, d: +p.day,
           H: +p.hour % 24, M: +p.minute, S: +p.second }; // %24 guards "24" at midnight
}
function plantMs(y, m, d, H = 0, M = 0, S = 0) {
  return Date.UTC(y, m - 1, d, H, M, S); // naive: plant wall-clock interpreted as UTC
}
function nowOnTimeline() {
  const p = plantLocalParts();
  return plantMs(p.y, p.m, p.d, p.H, p.M, p.S);
}
function lastHourStartMs() {
  const p = plantLocalParts();                       // report runs at :02 → report the prior hour
  return plantMs(p.y, p.m, p.d, p.H, 0, 0) - 3600000;
}

// ── Convert an Epicor labor row's clock-hour to the same naive timeline ──
function epicorClockToMs(clockInDateStr, decHour, addDay = false) {
  const [y, m, d] = clockInDateStr.slice(0, 10).split("-").map(Number); // slice avoids the -05:00 offset
  let ms = Date.UTC(y, m - 1, d) + Math.round(decHour * 3600) * 1000;
  if (addDay) ms += 86400000;
  return ms;
}
function recordInterval(rec) {
  const startMs = epicorClockToMs(rec.LaborDtl_ClockInDate, rec.LaborDtl_ClockinTime);
  // STRICT '<' — a row where ClockOut === ClockIn is a zero-length placeholder, NOT a
  // 24h overnight interval. Using '<=' turned 0.0→0.0 rows into phantom full days
  // (+std/hr all day in the real dump). Do not revert to '<='.
  const crossed = rec.LaborDtl_ClockOutTime < rec.LaborDtl_ClockinTime;
  let endMs = epicorClockToMs(rec.LaborDtl_ClockInDate, rec.LaborDtl_ClockOutTime, crossed);
  if (rec.LaborDtl_ActiveTrans) endMs = nowOnTimeline(); // ClockOut=24.0 is a planned EOD sentinel
  return { startMs, endMs };
}

// ── Rated cases for one hour (PRECEDENCE: single physical filler per line; latest
// clock-in wins). Equals the per-job SUM on clean data; stays bounded when labor rows
// for different jobs overlap for hours (loose changeover clocking, common here). ──
const RATED_MODE = "precedence"; // "precedence" (default, single filler) | "sum" (aggregate)

function ratedCasesForHour(records, hourStartMs) {
  const hourEndMs = hourStartMs + 3600000;

  // Clip each FILPAK interval to the hour; drop zero-length placeholders.
  const segs = [];
  for (const r of records) {
    if (r.JobOper_OpCode !== "FILPAK") continue; // load-bearing guard, keep it
    if (!r.LaborDtl_ActiveTrans &&
        r.LaborDtl_ClockOutTime === r.LaborDtl_ClockinTime) continue; // skip 0-length
    const { startMs, endMs } = recordInterval(r);
    const s = Math.max(startMs, hourStartMs);
    const e = Math.min(endMs, hourEndMs);
    if (e <= s) continue;
    segs.push({ s, e, std: r.JobOper_ProdStandard, clockIn: startMs });
  }
  if (!segs.length) return 0;

  if (RATED_MODE === "sum") {
    // Original design: Σ per (job|std) merged overlap. Over-reports on overlapping
    // labor — retained only as documentation of the original approach.
    const groups = new Map();
    for (const sg of segs) {
      const key = sg.std; // std is 1:1 with job here; group concurrent same-job rows
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ startMs: sg.s, endMs: sg.e });
    }
    let rated = 0;
    for (const [std, ivals] of groups) {
      const merged = ivals.sort((a, b) => a.startMs - b.startMs)
        .reduce((out, iv) => {
          const last = out[out.length - 1];
          if (last && iv.startMs <= last.endMs) last.endMs = Math.max(last.endMs, iv.endMs);
          else out.push({ ...iv });
          return out;
        }, []);
      for (const iv of merged) rated += (iv.endMs - iv.startMs) / 3600000 * std;
    }
    return Math.round(rated);
  }

  // PRECEDENCE: sweep boundaries; in each slice the most-recently-clocked-in job runs.
  const pts = [...new Set(segs.flatMap(x => [x.s, x.e]))].sort((a, b) => a - b);
  let rated = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], mid = (a + b) / 2;
    let best = null;
    for (const sg of segs)
      if (sg.s <= mid && mid < sg.e && (!best || sg.clockIn > best.clockIn)) best = sg;
    if (best) rated += (b - a) / 3600000 * best.std;
  }
  return Math.round(rated);
}

// ── SKU label = most recent FILPAK job (same formatting as the old inline getSku) ──
function buildSkuLabel(j) {
  if (!j) return "-";
  const brandColor = [j.Part_CommercialBrand, j.Part_CommercialColor].filter(Boolean).join(" ");
  const sizes      = [j.Part_CommercialSize1,  j.Part_CommercialSize2].filter(Boolean).join(" ");
  const sku = [brandColor, sizes].filter(Boolean).join("<br>").replace(/X/g, "×");
  return sku || "-";
}
function currentSku(records) {
  let latest = null, latestEnd = -Infinity;
  for (const r of records) {
    if (r.JobOper_OpCode !== "FILPAK") continue;
    if (!r.LaborDtl_ActiveTrans &&
        r.LaborDtl_ClockOutTime === r.LaborDtl_ClockinTime) continue;
    const { endMs } = recordInterval(r);
    if (endMs > latestEnd) { latestEnd = endMs; latest = r; }
  }
  return buildSkuLabel(latest);
}

function formatEpicorPO(data) {
  if (!data) return "*Epicor*: ⚠️ Not found";

  // Epicor ISO strings include their own UTC offset (e.g. -06:00) so new Date()
  // parses them correctly. Display in GMT-4 (America/Port_of_Spain).
  const fmtDateTime = (dateStr) => {
    if (!dateStr) return "N/A";
    return new Date(dateStr).toLocaleString("en-TT", {
      timeZone: "America/Port_of_Spain",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true,
    });
  };

  // Epicor approval status codes:
  //   A = Approved
  //   U = Unapproved (created but not yet submitted for approval)
  //   P = Pending (submitted, awaiting approval)
  //   R = Rejected
  const statusMap = {
    A: "Approved ✅",
    U: "Unapproved ⏸️",
    P: "Pending Approval ⏳",
    R: "Rejected ❌",
  };
  const status   = statusMap[data.POHeader_ApprovalStatus] ?? data.POHeader_ApprovalStatus ?? "N/A";
  const amount   = data.POHeader_ApprovedAmount != null
    ? `$${parseFloat(data.POHeader_ApprovedAmount).toLocaleString("en-TT", { minimumFractionDigits: 2 })}`
    : "N/A";
  const comments = data.POHeader_CommentText
    ? data.POHeader_CommentText.replace(/\r/g, " | ").trim()
    : "N/A";
  const entryPerson = data.POHeader_EntryPerson?.trim()
    ? data.POHeader_EntryPerson.trim().split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ')
    : "N/A";
  const dispatched = data.POHeader_ReadyToPrint === true
    ? "Yes ✅"
    : data.POHeader_ReadyToPrint === false
      ? "No ❌"
      : "N/A";
  const poNum = data.POHeader_PONum;

  return [
    `*Epicor* - PO ${poNum}`,
    `*Status*: ${status}`,
    `*Amount*: ${amount}`,
    `*Approved On*: ${fmtDateTime(data.POHeader_ApprovedDate)}`,
    `*Entered By*: ${entryPerson}`,
    `*Comments*: ${comments}`,
  ].join("\n");
}

/**
 * Post-processes the raw string from formatDesktopRequisition to extract
 * the "Notes:" block and "Generated:" line so they can be placed at the
 * very bottom of the combined reply.
 *
 * Returns { body, notesBlock, generatedLine }
 */
function extractMaximoTrailers(raw) {
  const lines       = raw.split("\n");
  const bodyLines   = [];
  const notesLines  = [];
  let generatedLine = "";
  let inNotes       = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Generated:/i.test(trimmed)) {
      generatedLine = trimmed;
      inNotes = false;
      continue;
    }

    if (/^Notes:$/i.test(trimmed)) {
      inNotes = true;
      notesLines.push(line);
      continue;
    }

    if (inNotes) {
      // Strip lines already covered by the approval banner in buildPoReply
      if (/^✅ \*?Fully Approved\*?$/i.test(trimmed)) continue;
      if (/^PO #:/i.test(trimmed)) continue;
      notesLines.push(line);
      continue;
    }

    bodyLines.push(line);
  }

  return {
    body:          bodyLines.join("\n").trimEnd(),
    notesBlock:    notesLines.join("\n").trim(),
    generatedLine,
  };
}

/**
 * Builds the combined MAXIMO (DR) + Epicor (PO) reply.
 *
 * Message order:
 *   MAXIMO body → Epicor section → approval banner → Notes → Generated
 *
 * IMPORTANT: DR approval in MAXIMO and PO approval in Epicor are two separate
 * steps. A fully approved DR does NOT mean the PO has been approved in Epicor.
 * Even when both are approved, purchasing must still confirm the PO was
 * dispatched to the vendor.
 */
function buildPoReply(poNumber, maximoData, epicorData, searchType = "PO") {
  const epicorStatus   = epicorData?.POHeader_ApprovalStatus;
  const epicorApproved = epicorStatus === "A";

  // ── Approval banner ─────────────────────────────────────────────────────────
  let banner;
  if (maximoData && epicorApproved) {
    banner =
      "✅ *DR & PO both approved.*\n" +
      "Please follow up with purchasing to confirm the PO was dispatched to the vendor.";
  } else if (maximoData && epicorStatus === "U") {
    banner =
      "⚠️ *DR approved in MAXIMO but PO has not yet been submitted for approval in Epicor.*\n" +
      "   The PO is currently unapproved. Please follow up with the buyer to submit it.";
  } else if (maximoData && epicorStatus === "P") {
    banner =
      "⏳ *DR approved in MAXIMO but PO is still pending approval in Epicor.*\n" +
      "   Follow up with the approver before processing.";
  } else if (maximoData && epicorStatus === "R") {
    banner =
      "❌ *DR approved in MAXIMO but PO has been rejected in Epicor.*\n" +
      "   Please follow up with purchasing to resolve the rejection.";
  } else if (maximoData && !epicorApproved) {
    banner =
      "⚠️ *DR approved in MAXIMO but PO not yet approved in Epicor.*\n" +
      "   Note: These are separate approval steps — a fully approved DR does not\n" +
      "   mean the PO is approved. Follow up with the buyer before processing.";
  } else if (!maximoData && epicorApproved) {
    banner =
      "⚠️ *PO approved in Epicor but DR not found in MAXIMO.*\n" +
      "   Please verify the DR exists and has been fully approved in MAXIMO.";
  } else {
    banner = "❌ *Could not confirm approval in either system.* Please check both directly.";
  }

  // ── MAXIMO section ───────────────────────────────────────────────────────────
  let maximoBody    = "MAXIMO:  ⚠️ DR not found";
  let notesBlock    = "";
  let generatedLine = "";

  if (maximoData) {
    const raw = formatDesktopRequisition(maximoData, searchType);
    ({ body: maximoBody, notesBlock, generatedLine } = extractMaximoTrailers(raw));
  }

  // ── Epicor section ───────────────────────────────────────────────────────────
  const epicorSection = `\n${formatEpicorPO(epicorData)}`;

  // ── Assemble ─────────────────────────────────────────────────────────────────
  const parts = [
    maximoBody,
    "",
    epicorSection,
    "",
    banner,
  ];

  // Show "Notes: N/A" if the block exists but has no content beyond the label
  const notesContent = notesBlock.replace(/^Notes:\s*/i, "").trim();
  parts.push("", notesContent ? notesBlock : "Notes: N/A");

  if (generatedLine) {
    parts.push("", generatedLine);
  }

  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// FASTIFY ROUTES
// ─────────────────────────────────────────────────────────────────────────────

fastify.post(
  "/sendMachineSpeedUpdateToWhatsAppGroup",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363417974970246@g.us";
    const { speed_sboSixteen, speed_lineFourFiller, speed_lineThreeFiller } = request.body;

    try {
      const message = `
    [Spark - ${new Date().toLocaleString()}]
    Line 3 
    SBO 16 Speed: ${speed_sboSixteen} bph
    Filler Speed: ${speed_lineThreeFiller} bph
    
    Line 4
    Filler Speed: ${speed_lineFourFiller} bph    
    `;

      console.log("Sending machine speed update to group:", groupToSendReportTo);
      await client.sendMessage(groupToSendReportTo, message);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendUtilitiesUpdateToWhatsAppGroup",
  async function handler(request, reply) {
    const ignitionBotUtilitiesGroup = "120363400377094355@g.us";
    const {
      bhAirPressure = -1, bigTankLevel = -1, smallTankLevel = -1,
      wasaWaterPressure = -1, bhWaterPressure = -1, walchemTemperature = -1,
      pH = -1, freeChlorine = -1,
    } = request.body;

    try {
      let message = '';
      message += ` [Spark - ${new Date().toLocaleString('en-TT')}] \n\n`;
      message += ` BH Air Pressure: ${parseFloat(bhAirPressure).toFixed(0)} psi \n`;
      message += ` Big Tank Level: ${parseFloat(bigTankLevel).toFixed(1)} %\n`;
      message += ` Small Tank Level: ${parseFloat(smallTankLevel).toFixed(1)} % \n`;
      message += ` Raw Water Pressure: ${parseFloat(wasaWaterPressure).toFixed(1)} psi \n`;
      message += ` Treated Water Pressure: ${parseFloat(bhWaterPressure).toFixed(1)} psi \n\n`;
      message += ` Water Treatment - Walchem Controller \n`;
      message += ` Free Chlorine: ${parseFloat(freeChlorine).toFixed(2)} ppm \n`;
      message += ` Temperature: ${parseFloat(walchemTemperature).toFixed(1)} °F \n`;
      message += ` pH: ${parseFloat(pH).toFixed(2)} \n`;

      await client.sendMessage(ignitionBotUtilitiesGroup, message);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendUtilitiesUpdateToProductionWhatsAppGroup",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363182559475487@g.us";
    const { bhAirPressure, bigTankLevel, smallTankLevel, wasaWaterPressure } = request.body;

    try {
      let message = '';
      message += `[Spark - ${new Date().toLocaleString('en-TT')}] \n`;
      message += `BH Air Pressure: ${parseFloat(bhAirPressure).toFixed(0)} psi\n`;
      message += `Big Tank Level: ${parseFloat(bigTankLevel).toFixed(1)} %\n`;
      message += `Small Tank Level: ${parseFloat(smallTankLevel).toFixed(1)} %\n`;

      console.info("Sending utilities update to production group:", groupToSendReportTo);
      console.info(message);

      await client.sendMessage(groupToSendReportTo, message);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);


fastify.post(
  "/sendProductivityUpdateToWhatsAppGroup",
  async function handler(request, reply) {
    try {
      const rows = request.body.rows;

      const LINE_COLS = { 2: 2, 3: 5, 4: 8, 5: 11, 6: 14, a: 17 };
      const TIME_SLOTS = [
        "7am-8am",   "8am-9am",   "9am-10am",  "10am-11am", "11am-12pm", "12pm-1pm",
        "1pm-2pm",   "2pm-3pm",   "3pm-4pm",   "4pm-5pm",   "5pm-6pm",   "6pm-7pm",
        "7pm-8pm",   "8pm-9pm",   "9pm-10pm",  "10pm-11pm", "11pm-12am", "12am-1am",
        "1am-2am",   "2am-3am",   "3am-4am",   "4am-5am",   "5am-6am",   "6am-7am",
      ];
      const S1_ROWS = Array.from({ length: 12 }, (_, i) => i);
      const S2_ROWS = Array.from({ length: 12 }, (_, i) => i + 12);
      const sumRows = (indices, col) =>
        indices.reduce((sum, i) => sum + (rows[i][col] || 0), 0);

      const replacements = {};

      TIME_SLOTS.forEach((slot, i) => {
        for (const [line, col] of Object.entries(LINE_COLS)) {
          replacements[`\${l-${line}-r-${slot}}`] = "";
          replacements[`\${l-${line}-a-${slot}}`] = (rows[i][col] || 0).toLocaleString("en-TT");
          replacements[`\${l-${line}-e-${slot}}`] = "";
        }
      });

      for (const [line, col] of Object.entries(LINE_COLS)) {
        const s1 = sumRows(S1_ROWS, col);
        const s2 = sumRows(S2_ROWS, col);
        replacements[`\${l-${line}-r-s1}`] = "";
        replacements[`\${l-${line}-a-s1}`] = s1.toLocaleString("en-TT");
        replacements[`\${l-${line}-e-s1}`] = "";
        replacements[`\${l-${line}-r-s2}`] = "";
        replacements[`\${l-${line}-a-s2}`] = s2.toLocaleString("en-TT");
        replacements[`\${l-${line}-e-s2}`] = "";
        replacements[`\${l-${line}-r-d}`]  = "";
        replacements[`\${l-${line}-a-d}`]  = (s1 + s2).toLocaleString("en-TT");
        replacements[`\${l-${line}-e-d}`]  = "";
      }

      replacements["${currentDate}"] = new Date().toLocaleDateString("en-TT", {
        timeZone: "America/Port_of_Spain",
      });

      let html = fs.readFileSync("index.html", "utf8");
      for (const [placeholder, value] of Object.entries(replacements)) {
        html = html.replace(placeholder, value);
      }

      const browser = await puppeteer.launch({
        headless: "new",
        defaultViewport: { width: 1280, height: 720 },
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });

      const element = await page.$("body");
      await element.screenshot({ path: "report.png" });
      await browser.close();

      const sendToWhatsApp      = true;
      const groupToSendReportTo = "120363417974970246@g.us";

      if (sendToWhatsApp) {
        const data        = fs.readFileSync("report.png");
        const base64Image = Buffer.from(data).toString("base64");
        const media       = new MessageMedia("image/png", base64Image);
        const message     = `[Spark - ${new Date().toLocaleString("en-TT")}] - Hourly production report`;
        console.log("Sending productivity report to group:", groupToSendReportTo);
        await client.sendMessage(groupToSendReportTo, message, { media });
        reply.send({ status: "success", message: "Daily production update sent to WhatsApp group." });
      } else {
        reply.send({ status: "success", message: "Daily production update generated but not sent to WhatsApp because developer flag is enabled." });
      }
    } catch (error) {
      console.error("Error sending daily production update:", error);
      reply.status(500).send({ status: "error", message: "Failed to send daily production update." });
    }
  }
);

fastify.post(
  "/generateProductionReport",
  async function handler(request, reply) {
    try {
      let rows;
      if (request.query.localtest === "true") {
        const ignitionRes = await fetch(
          "http://192.168.164.10:8088/system/webdev/SMJ_Production/getDailyCaseCountByHour"
        );
        if (!ignitionRes.ok) throw new Error(`Ignition responded with ${ignitionRes.status}`);
        rows = await ignitionRes.json();
      } else {
        rows = request.body.rows;
      }

      const LINE_NUMS = [2, 3, 4, 5, 6];
      const LINE_COLS = { 2: 2, 3: 5, 4: 8, 5: 11, 6: 14, a: 17 };
      const TIME_SLOTS = [
        "7am-8am",   "8am-9am",   "9am-10am",  "10am-11am", "11am-12pm", "12pm-1pm",
        "1pm-2pm",   "2pm-3pm",   "3pm-4pm",   "4pm-5pm",   "5pm-6pm",   "6pm-7pm",
        "7pm-8pm",   "8pm-9pm",   "9pm-10pm",  "10pm-11pm", "11pm-12am", "12am-1am",
        "1am-2am",   "2am-3am",   "3am-4am",   "4am-5am",   "5am-6am",   "6am-7am",
      ];
      const S1_ROWS = Array.from({ length: 12 }, (_, i) => i);
      const S2_ROWS = Array.from({ length: 12 }, (_, i) => i + 12);
      const sumRows  = (indices, col) =>
        indices.reduce((sum, i) => sum + (rows[i][col] || 0), 0);

      // Pull a 36h window of FILPAK labor rows per line in parallel, then compute
      // rated from overlap (precedence) so a CIP/changeover-split hour scores its
      // scheduled run time rather than a flat per-hour rate.
      const laborResults = await Promise.allSettled(
        LINE_NUMS.map((line) => fetchEpicorLaborWindow(`FPBHL${line}`))
      );
      const lineLabor = {};
      LINE_NUMS.forEach((line, idx) => {
        lineLabor[line] = laborResults[idx].status === "fulfilled" ? (laborResults[idx].value ?? []) : [];
      });

      const slotStart = lastHourStartMs();                 // the just-completed hour
      const getRated  = (line) => ratedCasesForHour(lineLabor[line], slotStart);
      const getSku    = (line) => currentSku(lineLabor[line]);

      const totalRatedPerHour = LINE_NUMS.reduce((sum, line) => sum + getRated(line), 0);

      const eff = (actual, rated) =>
        rated > 0 ? Math.round((actual / rated) * 100).toLocaleString("en-TT") + "%" : "";

      // The script runs ~2 min past each hour reporting the *just-completed* hour.
      // Shift day runs 7am–7am: hours 7–23 → slots 0–16, hours 0–6 → slots 17–23.
      const nowHour = new Date().toLocaleString("en-TT", {
        timeZone: "America/Port_of_Spain",
        hour: "numeric",
        hour12: false,
      });
      const currentHour = parseInt(nowHour, 10);
      const lastHour = currentHour === 0 ? 23 : currentHour - 1;
      const currentSlotIndex = lastHour >= 7 ? lastHour - 7 : lastHour + 17;

      // ── Persist the just-completed hour to report_data (Ignition DB) ───────────
      // Wide, one-row-per-slot table keyed by id = slot + 1 (rows are id 1–24).
      // Efficiency is an integer percent, NULL when rated is 0. A DB failure here
      // must never block the report, so it is isolated in its own try/catch.
      try {
        const effInt = (rated, actual) =>
          rated > 0 ? Math.round((actual / rated) * 100) : null;
        const ratedFor  = (line) => getRated(line);
        const actualFor = (line) => rows[currentSlotIndex][LINE_COLS[line]] || 0;

        const reportDataId = currentSlotIndex + 1; // 0-based slot → 1-based id
        const totalActual  = rows[currentSlotIndex][LINE_COLS.a] || 0;

        const lineVals = LINE_NUMS.flatMap((line) => {
          const r = ratedFor(line);
          const a = actualFor(line);
          return [r, a, effInt(r, a)];
        });

        await ignitionPool.query(
          `INSERT INTO report_data
             (id, l2_rated,l2_actual,l2_eff, l3_rated,l3_actual,l3_eff, l4_rated,l4_actual,l4_eff,
              l5_rated,l5_actual,l5_eff, l6_rated,l6_actual,l6_eff, total_rated,total_actual,total_eff)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (id) DO UPDATE SET
             l2_rated=EXCLUDED.l2_rated, l2_actual=EXCLUDED.l2_actual, l2_eff=EXCLUDED.l2_eff,
             l3_rated=EXCLUDED.l3_rated, l3_actual=EXCLUDED.l3_actual, l3_eff=EXCLUDED.l3_eff,
             l4_rated=EXCLUDED.l4_rated, l4_actual=EXCLUDED.l4_actual, l4_eff=EXCLUDED.l4_eff,
             l5_rated=EXCLUDED.l5_rated, l5_actual=EXCLUDED.l5_actual, l5_eff=EXCLUDED.l5_eff,
             l6_rated=EXCLUDED.l6_rated, l6_actual=EXCLUDED.l6_actual, l6_eff=EXCLUDED.l6_eff,
             total_rated=EXCLUDED.total_rated, total_actual=EXCLUDED.total_actual, total_eff=EXCLUDED.total_eff`,
          [
            reportDataId,
            ...lineVals,
            totalRatedPerHour, totalActual, effInt(totalRatedPerHour, totalActual),
          ]
        );
        console.info(`[report_data] upserted slot id ${reportDataId}`);
      } catch (err) {
        console.error("[report_data] upsert failed:", err);
      }

      const replacements = {};

      TIME_SLOTS.forEach((slot, i) => {
        const isCurrentSlot = i === currentSlotIndex;
        for (const [line, col] of Object.entries(LINE_COLS)) {
          const rph    = isCurrentSlot ? (line === "a" ? totalRatedPerHour : getRated(Number(line))) : 0;
          const actual = rows[i][col] || 0;
          replacements[`\${l-${line}-r-${slot}}`] = isCurrentSlot && rph ? rph.toLocaleString("en-TT") : "";
          replacements[`\${l-${line}-a-${slot}}`] = actual.toLocaleString("en-TT");
          replacements[`\${l-${line}-e-${slot}}`] = isCurrentSlot ? eff(actual, rph) : "";
        }
      });

      for (const [line, col] of Object.entries(LINE_COLS)) {
        const s1 = sumRows(S1_ROWS, col);
        const s2 = sumRows(S2_ROWS, col);
        replacements[`\${l-${line}-r-s1}`] = "";
        replacements[`\${l-${line}-a-s1}`] = s1.toLocaleString("en-TT");
        replacements[`\${l-${line}-e-s1}`] = "";
        replacements[`\${l-${line}-r-s2}`] = "";
        replacements[`\${l-${line}-a-s2}`] = s2.toLocaleString("en-TT");
        replacements[`\${l-${line}-e-s2}`] = "";
        replacements[`\${l-${line}-r-d}`]  = "";
        replacements[`\${l-${line}-a-d}`]  = (s1 + s2).toLocaleString("en-TT");
        replacements[`\${l-${line}-e-d}`]  = "";
      }

      for (const line of LINE_NUMS) {
        replacements[`\${line-${line}-sku}`] = getSku(line);
      }

      replacements["${currentDate}"] = new Date().toLocaleDateString("en-TT", {
        timeZone: "America/Port_of_Spain",
      });

      let html = fs.readFileSync("index.html", "utf8");
      for (const [placeholder, value] of Object.entries(replacements)) {
        html = html.replace(placeholder, value);
      }

      const browser = await puppeteer.launch({
        headless: "new",
        defaultViewport: { width: 1350, height: 720 },
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const element = await page.$("body");
      await element.screenshot({ path: "report.png" });
      await browser.close();

      const data        = fs.readFileSync("report.png");
      const base64Image = Buffer.from(data).toString("base64");
      const media       = new MessageMedia("image/png", base64Image);
      const message     = `[Spark - ${new Date().toLocaleString("en-TT")}] - Hourly production report`;
      await client.sendMessage("120363410453382826@g.us", message, { media });

      reply.type("image/png").send(data);
    } catch (error) {
      console.error("Error generating production report:", error);
      reply.status(500).send({ status: "error", message: "Failed to generate production report." });
    }
  }
);

fastify.post(
  "/sendMessageToSpeedandEventGroup",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363419212384358@g.us";
    const { message, severity } = request.body;
    const emoji = severity === "Danger" ? "🔴" : severity === "Okay" ? "🟢" : "";
    try {
      await client.sendMessage(groupToSendReportTo, `${emoji} ${message}`);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendWarningMessageToUtilitiesGroup",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363400377094355@g.us";
    const { message, severity } = request.body;
    const emoji = severity === "Danger" ? "🔴" : severity === "Okay" ? "🟢" : "";
    try {
      await client.sendMessage(groupToSendReportTo, `${emoji} ${message}`);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/getAllContactsFromIgnitionPhone",
  async function handler(request, reply) {
    
    try {
      const contacts = await client.getContacts();
      const chats = await client.getChats();
      const chatContacts = chats
  .filter(c => !c.isGroup && c.contact != null)
  .map(c => c.contact);


      // Merge, deduplicate by id._serialized
      const all = [...contacts, ...chatContacts];
      const unique = [...new Map(all.map(c => [c.id._serialized, c])).entries()].map(([, c]) => c);
      return unique;

    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendMessageToUser",
  async function handler(request, reply) {
    const { userWhatsAppId, message, media } = request.body;

    try {
      const images = [];
      if (media && Array.isArray(media) && media.length > 0) {
        // Send all images first
        for (const item of media) {
          const m = new MessageMedia(
            item.mimetype,
            item.data,
            item.filename ?? null
          );
          await client.sendMessage(userWhatsAppId, "", { media: m });
          images.push(m)
        }
      }
      //if(images.length)
      //  await client.sendMessage(userWhatsAppId, "", { media: images});

      // Send text message last
      await client.sendMessage(userWhatsAppId, message);

      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendUtilitiesWarningMessageToProductionGroup",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363182559475487@g.us";
    const { message, severity } = request.body;
    const emoji = severity === "Danger" ? "🔴" : severity === "Okay" ? "🟢" : "";
    try {
      await client.sendMessage(groupToSendReportTo, `${emoji} ${message}`);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendWarningMessageToUtilitiesGroupTest",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363417982248586@g.us";
    const { message, severity } = request.body;
    const emoji = severity === "Danger" ? "🔴" : severity === "Okay" ? "🟢" : "";
    try {
      await client.sendMessage(groupToSendReportTo, `${emoji} ${message}`);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

fastify.post(
  "/sendWarningMessageToBhMaintenance",
  async function handler(request, reply) {
    const groupToSendReportTo = "120363421757336532@g.us";
    const { message, severity } = request.body;
    const emoji = severity === "Danger" ? "🔴" : severity === "Okay" ? "🟢" : "";
    try {
      await client.sendMessage(groupToSendReportTo, `${emoji} ${message}`);
      return { hello: "world" };
    } catch (err) {
      console.error(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP CLIENT EVENTS
// ─────────────────────────────────────────────────────────────────────────────

client.on("qr", (qr) => {
  console.info("QR Code received. Please scan it with your WhatsApp mobile app.");
  qrcode.generate(qr, { small: true });
  console.log(qr);
});

client.once("ready", async () => {
  try {
    await connectDB();
    console.info('Connected to MAXIMO DB successfully');
  } catch (err) {
    console.error('Failed to connect to MAXIMO database on startup');
    process.exit(1);
  }

  try {
    const { rows: assets } = await pool.query(`SELECT id, name FROM maintainx_asset_data`);
    allAssets = assets;
    assetFuse = new Fuse(assets, { keys: ['name'], threshold: 0.5, ignoreLocation: true, minMatchCharLength: 2 });
    console.info(`Asset fuzzy index built with ${assets.length} assets`);
  } catch (err) {
    console.error('Failed to build asset fuzzy index:', err);
  }

  try {
    console.info("WhatsApp client is ready!");
    await fastify.listen({ port: 6500, host: '0.0.0.0'});
    console.info("Fastify server is running on http://localhost:" + fastify.server.address().port);
    const chats = await client.getChats();
    fs.writeFileSync("chats.json", JSON.stringify(chats, null, 2));
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});

client.on("message_create", async (msg) => {
  try {
    if (msg.body === "!ping") {
      msg.reply(`Hello ${msg.from}, you sent: ${msg.body}`);
      return;
    }

    if (msg.body === "!ut") {
      try {
        const response = await fetch("http://192.168.164.10:8088/system/webdev/SMJ_Production/getUtilitiesData");
        const data = await response.json();
        const {
          bhAirPressure = -1, bigTankLevel = -1, smallTankLevel = -1,
          wasaWaterPressure = -1, bhWaterPressure = -1, walchemTemperature = -1,
          pH = -1, freeChlorine = -1,
        } = data;

        let message = '';
        message += ` [Spark - ${new Date().toLocaleString('en-TT')}] \n\n`;
        message += ` BH Air Pressure: ${parseFloat(bhAirPressure).toFixed(0)} psi \n`;
        message += ` Big Tank Level: ${parseFloat(bigTankLevel).toFixed(1)} %\n`;
        message += ` Small Tank Level: ${parseFloat(smallTankLevel).toFixed(1)} % \n`;
        message += ` Raw Water Pressure: ${parseFloat(wasaWaterPressure).toFixed(1)} psi \n`;
        message += ` Treated Water Pressure: ${parseFloat(bhWaterPressure).toFixed(1)} psi \n\n`;
        message += ` Water Treatment - Walchem Controller \n`;
        message += ` Free Chlorine: ${parseFloat(freeChlorine).toFixed(1)} ppm \n`;
        message += ` Temperature: ${parseFloat(walchemTemperature).toFixed(1)} °F \n`;
        message += ` pH: ${parseFloat(pH).toFixed(1)} \n`;

        console.info(msg.from, message);
        msg.reply(message);
      } catch (error) {
        console.error("Utilities fetch error:", error);
        msg.reply("⚠️ Failed to fetch utilities data. Please try again.");
      }
      return;
    }

    handleMessage(msg);
  } catch (error) {
    console.error("Message handler error:", error);
  }
});

client.on("message", async (msg) => {
  // ── Resume reply ────────────────────────────────────────────────────────────
  if (msg.hasQuotedMsg && /^(resume|restart|restarted)$/i.test(msg.body.trim())) {
    const quoted = await msg.getQuotedMessage();
    const meta   = pendingEvents.get(quoted.id._serialized);

    if (!meta) return;

    const { eventId, woGlobalId } = meta;
    const stopTime = new Date(msg.timestamp * 1000);

    try {
      const { rows } = await pool.query(
        `SELECT event_start_timestamp FROM ${TABLE} WHERE event_id = $1`,
        [eventId]
      );

      if (!rows.length) return;

      const startTime          = new Date(rows[0].event_start_timestamp);
      const durationSeconds    = Math.round((stopTime - startTime) / 1000);
      const durationMinutes    = parseFloat((durationSeconds / 60).toFixed(2));
      const durationPrettified = prettifyDuration(durationSeconds);

      await pool.query(
        `UPDATE ${TABLE} SET
          event_stop_timestamp      = $1,
          event_duration_seconds    = $2,
          event_duration_minutes    = $3,
          event_duration_prettified = $4
        WHERE event_id = $5`,
        [stopTime, durationSeconds, durationMinutes, durationPrettified, eventId]
      );

      if (woGlobalId) {
        try {
          await updateMaintainXWorkOrderStatus(woGlobalId, 'DONE');
          console.log('[MX WO] marked DONE, global id:', woGlobalId);
        } catch (err) {
          console.error('[MX WO] failed to mark DONE:', err);
        }
      }

      pendingEvents.delete(quoted.id._serialized);
      await msg.reply(`Downtime resolved (ID: ${eventId})\nDuration: ${durationPrettified}`);
    } catch (err) {
      console.error("DB update error:", err);
      await msg.reply("Failed to record stop time. Please try again.");
    }

    return;
  }

  // ── New downtime entry ──────────────────────────────────────────────────────
  const mentions       = await msg.getMentions();
  const botWid         = client.info.wid._serialized;
  const isBotMentioned = mentions.some((m) => m.id._serialized === botWid);

  if (!isBotMentioned) return;

  const bodyWithoutMentions = msg.body.replace(/@\d+/g, "").trim();
  const singleLineMatch     = bodyWithoutMentions.match(/^(?:[lL]ine\s+|[lL])(\d+)\s+(.+)$/s);

  if (!singleLineMatch) {
    await msg.reply(
      "Invalid format. Expected:\n@bot L[1-6 or 8] [Asset]. [Description]\n\nExample: @bot L4 Filler. Lowfilling and foaming"
    );
    return;
  }

  const lineNumber = parseInt(singleLineMatch[1]);
  const rest       = singleLineMatch[2].trim();

  if (!VALID_LINES.has(lineNumber)) {
    await msg.reply("Invalid line number. Use L1, L2, L3, L4, L5, L6, or L8.");
    return;
  }

  const dotIndex    = rest.indexOf('.');
  const assetName   = dotIndex !== -1 ? rest.slice(0, dotIndex).trim() : rest;
  const description = dotIndex !== -1 ? rest.slice(dotIndex + 1).trim() : "";
  const startTime   = new Date(msg.timestamp * 1000);
  const isPlanned   = isPlannedDowntime(rest);

  try {
    const overrideName = ASSET_SEARCH_OVERRIDES.get(assetName.toLowerCase());
    const lineTag      = `L${lineNumber}`;
    const lineAssets   = allAssets.filter(a => a.name.toUpperCase().includes(lineTag));
    let asset;

    if (overrideName) {
      // Bypass Fuse — find the asset by exact name match
      asset = allAssets.find(a => a.name.toLowerCase() === overrideName.toLowerCase()) ?? null;
    } else {
      const fusePool = lineAssets.length > 0 ? lineAssets : allAssets;
      const fuse     = new Fuse(fusePool, { keys: ['name'], threshold: 0.5, ignoreLocation: true, minMatchCharLength: 2 });
      asset          = fuse.search(assetName)?.[0]?.item ?? null;
      // fallback: search all assets if line-filtered search found nothing
      if (!asset && lineAssets.length > 0) {
        const fuseAll = new Fuse(allAssets, { keys: ['name'], threshold: 0.5, ignoreLocation: true, minMatchCharLength: 2 });
        asset = fuseAll.search(assetName)?.[0]?.item ?? null;
      }
    }

    const shiftResult = await pool.query(
      `SELECT * FROM shift_information ORDER BY updated_at DESC LIMIT 1`
    );
    const si = shiftResult.rows[0] ?? null;

    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (
        event_line_number,
        event_start_timestamp,
        event_description,
        event_asset_maintainx_name,
        event_asset_maintainx_id,
        shift_number,
        shift_time,
        shift_team_lead,
        shift_assistant_lead,
        shift_line_six_lead,
        shift_epicor_assistant,
        shift_maintenance_team_number,
        shift_maintenance_team,
        event_downtime_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING event_id`,
      [
        lineNumber,
        startTime,
        description,
        asset?.name ?? assetName,
        asset?.id ?? 0,
        si?.shift_number ?? null,
        si?.shift_time ?? null,
        si?.shift_team_lead ?? '',
        si?.shift_assistant_lead ?? '',
        si?.shift_line_six_lead ?? '',
        si?.shift_epicor_assistant ?? '',
        si?.shift_maintenance_team_number ?? null,
        si?.shift_maintenance_team ?? [],
        isPlanned ? 'Planned' : 'Unplanned',
      ]
    );

    const eventId    = rows[0].event_id;
    const assetLabel = asset
      ? `${asset.name} (ID: ${asset.id})`
      : `${assetName} (not found in asset list)`;

    // Reply immediately so the user gets instant feedback
    const sentReply = await msg.reply(
      `Downtime logged (ID: ${eventId})\n` +
      `Asset: ${assetLabel}\n` +
      `Desc:  ${description}\n` +
      `Type:  ${isPlanned ? 'Planned' : 'Unplanned'}\n\n` +
      `Reply to this message with "Resume" when the asset is placed into service.`
    );
    const eventMeta = { eventId, woGlobalId: null };
    pendingEvents.set(sentReply.id._serialized, eventMeta);

    if (!isPlanned) {
    // Create MaintainX work order in the background and send a follow-up
    (async () => {
      try {
        const now      = new Date();
        const today    = now.toISOString();
        const endOfDay = new Date(now);
        endOfDay.setUTCHours(23, 59, 59, 999);
        const woTitle = `${asset?.name ?? assetName} - ${description || assetName}`;

        const senderContact = await msg.getContact();
        const senderWaId   = senderContact.number ? `${senderContact.number}@c.us` : (msg.author ?? msg.from);
        const assigneeId   = await lookupMaintainXUserByWaId(senderWaId).catch(() => null);
        const senderName   = senderContact.pushname || senderContact.name || senderWaId;
        const chat         = await msg.getChat();
        const groupName    = chat.name || 'Unknown Group';

        console.log('[MX WO] creating work order:', { title: woTitle, assetId: asset?.id ?? null, assigneeId });

        const woId = await createMaintainXWorkOrder({
          title: woTitle,
          description: `${description}\n\nDowntime Event ID: ${eventId}\nSource - ${senderName} - tagged on group ${groupName}`,
          assetId: asset?.id || null,
          assigneeId,
          today,
          dueDate: endOfDay.toISOString(),
        });

        eventMeta.woGlobalId = woId;
        console.log('[MX WO] created, global id:', woId);
        await updateMaintainXWorkOrderStatus(woId, 'IN_PROGRESS');
        console.log('[MX WO] set to IN_PROGRESS');
        const seqId = await getMaintainXWorkOrderSequentialId(woId);
        console.log('[MX WO] sequential id:', seqId);

        await sentReply.reply(`MaintainX WO #${seqId}`);
      } catch (err) {
        console.error('[MX WO] creation failed:', err);
      }
    })();
    }
  } catch (err) {
    console.error("DB insert error:", err);
    await msg.reply("Failed to log downtime. Please try again.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function isPlannedDowntime(text) {
  const patterns = [
    /flavou?r\s*change/i,
    /\bline\s+change\b/i,
    /\bl\/c\b/i,
    /\blc\b/i,
    /\bf\/c\b/i,
    /\bfc\b/i,
    /\bcip\b/i,
    /\b5\s*step(?:\s+sanitation)?\b/i,
    /\b10\s+hrs?\s+hot\s+(?:water\s+)?rinse\b/i,
    /\bhot\s+water\b/i,
    /\bhot\s+rinse\b/i,
    /\brinse\b/i,
    /\btrial\b/i,
    /\bstock\s*count\b/i,
  ];
  return patterns.some(p => p.test(text));
}

function prettifyDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER (DR / PO lookups)
// ─────────────────────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const text = msg.body.trim().toUpperCase();

  // ── PO lookup ───────────────────────────────────────────────────────────────
  const poPattern = /^PO?(\d{6,8})$/;
  const poMatch   = text.replace(/[^A-Za-z0-9]/g, '').match(poPattern);

  if (poMatch) {
    const poNumber = poMatch[1];

    try {
      await msg.reply(`🔍 Fetching PO ${poNumber}...`);

      // Run both lookups concurrently — one failure never blocks the other
      const [maximoResult, epicorResult] = await Promise.allSettled([
        getDRByPO(poNumber),
        fetchEpicorPO(poNumber),
      ]);

      if (epicorResult.status === "rejected") {
        console.error("Epicor lookup error:", epicorResult.reason);
      }

      const maximoData = maximoResult.status === "fulfilled" ? maximoResult.value : null;
      const epicorData = epicorResult.status === "fulfilled" ? epicorResult.value : null;

      await msg.reply(buildPoReply(poNumber, maximoData, epicorData, 'PO'));
    } catch (error) {
      console.error('PO lookup error:', error);
      await msg.reply(`⚠️ Failed to retrieve PO ${poNumber}. Please try again later.`);
    }
    return;
  }

  // ── DR lookup ───────────────────────────────────────────────────────────────
  const sanitized = text.replace(/[^A-Za-z0-9]/g, '');
  const drPattern = /^([A-Z]{2,8})(\d{4})$/;
  const drMatch   = sanitized.match(drPattern);

  if (drMatch) {
    const site   = drMatch[1];
    const number = drMatch[2];

    if (!VALID_SITES.includes(site)) {
      await msg.reply(`Apologies, the DR site "${site}" is not valid 😞\n\nValid sites: ${VALID_SITES.join(', ')}`);
      return;
    }

    try {
      await msg.reply(`🔍 Fetching ${site}${number}...`);

      const data = await getDRData(site, number);

      if (!data) {
        await msg.reply(`⚠️ DR ${site}${number} not found.`);
        return;
      }

      // If the DR has a linked PO, fetch Epicor and return a combined reply
      if (data.approval_memo) {
        const epicorResult = await fetchEpicorPO(data.approval_memo).catch((err) => {
          console.error("Epicor lookup error (DR path):", err);
          return null;
        });
        await msg.reply(buildPoReply(data.approval_memo, data, epicorResult, 'DR'));
      } else {
        // Strip the Notes/Generated trailer that formatDesktopRequisition appends
        const { body: drBody, notesBlock: drNotes, generatedLine: drGenerated } = extractMaximoTrailers(
          formatDesktopRequisition(data, 'DR')
        );
        const drNotesContent = drNotes.replace(/^Notes:\s*/i, "").trim();
        const drParts = [drBody, "", drNotesContent ? drNotes : "Notes: N/A"];
        if (drGenerated) drParts.push("", drGenerated);
        await msg.reply(drParts.join("\n"));
      }
    } catch (error) {
      console.error('DR lookup error:', error);
      await msg.reply(`⚠️ Failed to retrieve DR ${site}${number}. Please try again later.`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

client.initialize();