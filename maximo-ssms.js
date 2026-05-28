import mssql from "mssql";
import dotenv from "dotenv";
dotenv.config({ path: ".env" });

// ============================================
// CONSTANTS
// ============================================
export const VALID_SITES = [
    'ADMIN', 'ADM', 'AR', 'BOT', 'BWH', 'CWH', 'EXP', 'GAR',
    'HSE', 'IT', 'PET', 'PMT', 'PROJ', 'QA', 'QS', 'REF',
    'RM', 'SABH', 'SEC', 'TET', 'TS', 'WH', 'ZT'
];

// ============================================
// DATABASE CONFIG
// ============================================
const config = {
    user: process.env.MAXIMO_SSMS_USERNAME,
    password: process.env.MAXIMO_SSMS_PASSWORD,
    server: process.env.MAXIMO_SSMS_IP,
    port: parseInt(process.env.MAXIMO_SSMS_PORT),
    database: process.env.MAXIMO_SSMS_DATABASE,
    options: {
        encrypt: false,
        trustServerCertificate: true,
    },
    pool: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 60000
    },
    connectionTimeout: 30000,
    requestTimeout: 30000
};

// ============================================
// CONNECTION POOL
// ============================================
let pool = null;
let connecting = false;

export async function connectDB() {
    if (pool?.connected) {
        return pool;
    }

    if (connecting) {
        while (connecting) {
            await new Promise(res => setTimeout(res, 100));
        }
        return pool;
    }

    connecting = true;

    try {
        if (pool) {
            await pool.close().catch(() => {});
        }

        pool = await mssql.connect(config);
        console.log('Connected to Maximo DB');

        pool.on('error', (err) => {
            console.error('Pool error:', err.message);
            pool = null;
        });

        return pool;
    } catch (err) {
        console.error('DB Connection failed:', err.message);
        pool = null;
        throw err;
    } finally {
        connecting = false;
    }
}

// ============================================
// QUERIES
// ============================================
export async function getDRData(site, number) {
    const drNumber = `${site}${number}`;

    const query = `
        SELECT 
            a.mrnum,
            a.status,
            a.description AS mrdescr,
            a.requestedby,
            a.requestedfor,
            a.totalcost,
            a.mrla1 AS service_goods_capex,
            a.mrla2 AS reason,
            a.mrla3 AS supplier,
            (SELECT TOP 1 currencycode FROM mrline WHERE mrnum = a.mrnum) AS currencycode,
            a.mrdate,
            a.requireddate,
            a.location,
            a.enterdate,
            a.enterby,
            DATEDIFF(DAY, a.mrdate, GETDATE()) 
                - (DATEDIFF(WEEK, a.mrdate, GETDATE()) * 2)
                - CASE WHEN DATENAME(WEEKDAY, a.mrdate) = 'Sunday' THEN 1 ELSE 0 END
                - CASE WHEN DATENAME(WEEKDAY, GETDATE()) = 'Saturday' THEN 1 ELSE 0 END
            AS business_days_pending,
            STRING_AGG(d.assigncode, ', ') AS pending_with,
            MAX(d.[description]) AS workflow_step,
            ms.memo AS approval_memo,
            CASE WHEN ms.mrnum IS NOT NULL THEN 1 ELSE 0 END AS fully_approved
        FROM mr a
        LEFT JOIN wfassignment d ON a.mrid = d.ownerid AND d.assignstatus = 'ACTIVE'
        LEFT JOIN mrstatus ms ON a.mrnum = ms.mrnum AND ms.status = 'APPR_PROCD'
        WHERE a.mrnum = @mrnum
        GROUP BY 
            a.mrnum,
            a.status,
            a.description,
            a.requestedby,
            a.requestedfor,
            a.totalcost,
            a.mrla1,
            a.mrla2,
            a.mrla3,
            a.mrdate,
            a.requireddate,
            a.location,
            a.enterdate,
            a.enterby,
            ms.memo,
            ms.mrnum
    `;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const currentPool = await connectDB();

            const result = await currentPool.request()
                .input('mrnum', mssql.VarChar, drNumber)
                .query(query);

            return result.recordset[0] || null;
        } catch (err) {
            console.error(`❌ Query attempt ${attempt}/3 failed:`, err.message);
            pool = null;

            if (attempt === 3) {
                return null;
            }

            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

export async function getDRByPO(poNumber) {
    const query = `
        SELECT 
            a.mrnum,
            a.status,
            a.description AS mrdescr,
            a.requestedby,
            a.requestedfor,
            a.totalcost,
            a.mrla1 AS service_goods_capex,
            a.mrla2 AS reason,
            a.mrla3 AS supplier,
            (SELECT TOP 1 currencycode FROM mrline WHERE mrnum = a.mrnum) AS currencycode,
            a.mrdate,
            a.requireddate,
            a.location,
            a.enterdate,
            a.enterby,
            DATEDIFF(DAY, a.mrdate, GETDATE()) 
                - (DATEDIFF(WEEK, a.mrdate, GETDATE()) * 2)
                - CASE WHEN DATENAME(WEEKDAY, a.mrdate) = 'Sunday' THEN 1 ELSE 0 END
                - CASE WHEN DATENAME(WEEKDAY, GETDATE()) = 'Saturday' THEN 1 ELSE 0 END
            AS business_days_pending,
            STRING_AGG(d.assigncode, ', ') AS pending_with,
            MAX(d.[description]) AS workflow_step,
            ms.memo AS approval_memo,
            CASE WHEN ms.mrnum IS NOT NULL THEN 1 ELSE 0 END AS fully_approved
        FROM mr a
        LEFT JOIN wfassignment d ON a.mrid = d.ownerid AND d.assignstatus = 'ACTIVE'
        INNER JOIN mrstatus ms ON a.mrnum = ms.mrnum AND ms.status = 'APPR_PROCD'
        WHERE ms.memo = @poNumber
        GROUP BY 
            a.mrnum,
            a.status,
            a.description,
            a.requestedby,
            a.requestedfor,
            a.totalcost,
            a.mrla1,
            a.mrla2,
            a.mrla3,
            a.mrdate,
            a.requireddate,
            a.location,
            a.enterdate,
            a.enterby,
            ms.memo,
            ms.mrnum
    `;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const currentPool = await connectDB();

            const result = await currentPool.request()
                .input('poNumber', mssql.VarChar, poNumber)
                .query(query);

            return result.recordset[0] || null;
        } catch (err) {
            console.error(`❌ Query attempt ${attempt}/3 failed:`, err.message);
            pool = null;

            if (attempt === 3) {
                return null;
            }

            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// ============================================
// FORMATTERS
// ============================================
export function formatName(name) {
    if (!name) return '';
    return name
        .split('.')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Formats a MSSQL datetime for display.
 *
 * MSSQL datetime columns carry no timezone info. The node-mssql driver returns
 * them as JavaScript Date objects where the UTC value equals the raw digits
 * stored on the server (it does NOT apply any timezone conversion).
 *
 * The SQL Server stores local time (UTC-4). So a value stored as "13:56 local"
 * comes back from the driver as a Date whose UTC time is also 13:56 — meaning
 * if we applied a UTC-4 timezone in toLocaleString we would subtract 4 hours
 * and show 09:56, which is wrong.
 *
 * Fix: format with timeZone 'UTC' so the raw stored digits are displayed
 * exactly as-is, without any further shifting.
 */
export function formatDate(date) {
    if (!date) return null;

    return new Date(date).toLocaleString('en-TT', {
        timeZone: 'UTC', // display raw stored digits — MSSQL local time, no shift needed
        day:    '2-digit',
        month:  '2-digit',
        year:   'numeric',
        hour:   '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
}

export function formatCurrency(amount, currencyCode) {
    if (amount == null) amount = 0;

    try {
        const formatted = new Intl.NumberFormat('en-TT', {
            style: 'currency',
            currency: currencyCode,
            currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(amount);

        return `${formatted} ${currencyCode}`;
    } catch (err) {
        return `${currencyCode} ${amount.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })}`;
    }
}

/**
 * Formats a Desktop Requisition or Purchase Order into a WhatsApp message.
 *
 * Layout order:
 *   Header → core fields → approval status → [trailing Notes] → Generated
 *
 * Note: when called from buildPoReply (index.js), the Notes and Generated
 * lines are extracted and moved to the very bottom of the combined message.
 * The order here still matters for direct DR lookups.
 */
export function formatDesktopRequisition(dr, type) {
    const messageType = type === 'DR' ? 'Desktop Requisition' : 'Purchase Order';

    const message = [
        `*${messageType} Update - ${dr.mrnum}*`,
        '',
        `*Description*: ${dr.mrdescr}`,
        `*Status*: ${dr.status}`,
        // Type (service_goods_capex) intentionally omitted
    ];

    if (dr.supplier) {
        message.push(`*Supplier*: ${dr.supplier}`);
    }

    if (dr.requestedfor === dr.requestedby) {
        message.push(`*Requested By & For*: ${formatName(dr.requestedby)}`);
    } else {
        message.push(`*Requested By*: ${formatName(dr.requestedby)}`);
        message.push(`*Requested For*: ${formatName(dr.requestedfor)}`);
    }

    message.push(`*Total Cost*: ${formatCurrency(dr.totalcost, dr.currencycode)}`);

    if (formatDate(dr.mrdate)) {
        message.push(`*Date Submitted*: ${formatDate(dr.mrdate)}`);
    }

    if (formatDate(dr.requireddate)) {
        message.push(`*Required Date*: ${formatDate(dr.requireddate)}`);
    }

    if (dr.location) {
        message.push(`*Location*: ${dr.location}`);
    }

    message.push(`*Pending*: ${dr.business_days_pending} business day${dr.business_days_pending !== 1 ? 's' : ''}`);

    // ── Approval status (pending only — fully_approved goes into Notes) ─────────
    if (dr.pending_with) {
        const pendingWith = dr.pending_with
            .split(', ')
            .map(formatName)
            .join(', ');

        message.push('');
        message.push('🕥 *Pending Approval*');
        message.push(`With: ${pendingWith}`);
        message.push(`Step: ${dr.workflow_step}`);
    } else if (dr.status === 'VP_APPR') {
        message.push('');
        message.push('⚠️ DR has been approved. Purchase Order needs to be generated. Please follow up with the Purchasing Department.');
    }

    // ── Trailing sections ─────────────────────────────────────────────────────
    // Everything from "Notes:" onward is extracted by buildPoReply (index.js)
    // and moved to the very bottom of the combined PO reply.
    // For standalone DR lookups these appear here at the natural end.
    message.push('');
    message.push('Notes:');

    if (dr.fully_approved) {
        message.push('✅ *Fully Approved*');
        if (dr.approval_memo) {
            message.push(`PO #: ${dr.approval_memo} - Please confirm that the PO was sent to ${dr.supplier}`);
        }
    }

    message.push(`Generated: ${new Date().toLocaleString('en-TT', { timeZone: 'America/Port_of_Spain' })}`);

    return message.join('\n');
}


// Run if executed directly
if (process.argv[1].includes('maximo-smss.js')) {
    (async () => {
        try {
            const site   = process.argv[2] || 'BOT';
            const number = process.argv[3] || '4963';

            const data = await getDRData(site, number);

            if (data) {
                console.log('\n📋 Raw Data:');
                console.log(data);
                console.log('\n📝 Formatted Response:');
                console.log(formatDesktopRequisition(data));
            } else {
                console.log(`DR ${site}${number} not found`);
            }
        } catch (err) {
            console.error('Error:', err.message);
        } finally {
            process.exit(0);
        }
    })();
}